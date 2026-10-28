/**
 * 修正提案（`Fix` の候補）を XML に適用する。
 *
 * 設計: s1000d-stack の docs/design/writer-mcp.md「`apply_fixes` の受け付け方」、DECISIONS D-19。
 * 候補を決めるのは `suggestFixes`（core、決定論的）で、ここは「その候補と一致する選択だけ」を DOM で適用する。
 * 候補の外の値は決して適用しない。`options.verify`（または `options.offered`）に `suggestFixes` の元を渡すと、
 * `suggestFixes` を計算し直し、`fix.location` と `candidate` が計算結果の中に一致するときだけ適用する。
 *
 * 適用の方式:
 * - DOM は `@xmldom/xmldom`、場所の特定は `XmlEngine`（fontoxpath）で `fix.location.path` を評価する
 * - `add` で要素を足す位置は XSD（`XsdIndex.allowedChildren` の出現順）から決める。XSD が無ければ末尾
 * - 直列化は文書要素だけを XMLSerializer で行い、文書要素より前（XML 宣言・コメント・DOCTYPE の内部サブセット＝
 *   ICN の ENTITY / NOTATION 宣言）と後ろ（コメント・空白）は元の文字列をそのまま付け直す
 *
 * 対応しない候補（`unsupported-candidate`）: DOCTYPE の宣言を書き換えるもの（ICN の ENTITY の追加・SYSTEM 識別子の変更、
 * NOTATION の変更）。NDATA の NOTATION と図のファイル形式を同時に変える判断が要るため、利用者に委ねる。
 */
import { XMLSerializer } from '@xmldom/xmldom';
import type { Text } from '@xmldom/xmldom';
import { matchesPattern, matchesRange } from '../brex/values.js';
import type { NodeLocation } from '../brex/types.js';
import { formatDmc, parseDmc } from '../dmc.js';
import { formatPmc, parsePmc } from '../pmc.js';
import type { VerifyResult } from '../verify/verify.js';
import type { Document, Element, Node, XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import { suggestFixes, type SuggestFixesOptions } from './suggest.js';
import type { Fix, FixCandidate } from './types.js';
import { loadXsdIndex, type XsdIndex } from './xsd-index.js';

const ELEMENT_NODE = 1;
const ATTRIBUTE_NODE = 2;
const TEXT_NODE = 3;

/** 適用しなかった理由 */
export type ApplyFixReason =
  /** `provide` は文書ではなく製品の値を与える候補 */
  | 'provide-is-not-a-document-change'
  /** 計算し直した候補の中に、場所と候補が一致するものが無い */
  | 'candidate-not-offered'
  /** 候補は range / pattern だが、値がその範囲・正規表現に合わない */
  | 'value-not-allowed'
  | 'xml-not-well-formed'
  /** 場所が無い（`fix.location` が無い）か、候補が場所を必要としている */
  | 'no-location'
  | 'xpath-error'
  | 'location-not-found'
  | 'location-ambiguous'
  /** 候補の `target` が場所の節点と食い違う */
  | 'target-mismatch'
  | 'target-not-found'
  | 'target-exists'
  | 'value-required'
  | 'value-malformed'
  | 'element-has-children'
  | 'cannot-remove-root'
  | 'parent-not-found'
  | 'unsupported-candidate';

export interface ApplyFixOptions {
  /** `suggestFixes` の元になった検証結果。候補を計算し直して照合する */
  verify?: VerifyResult;
  /** `suggestFixes` に渡した追加の情報（csdb・brexLayers・applicability など）。`xml` は省略すると適用する XML */
  suggest?: Omit<SuggestFixesOptions, 'engine'>;
  /** 計算済みの `Fix[]`（`verify` の代わり。`suggestFixes` の結果をそのまま渡せる） */
  offered?: Fix[];
  /** `add` で要素を足す位置を決める XSD の定義。省略すると `verify.schema.xsdPath` から読む。false なら XSD を使わず末尾 */
  xsd?: XsdIndex | false;
  engine?: XmlEngine;
}

export interface ApplyFixResult {
  applied: boolean;
  /** 適用後の XML。適用しなかったときは渡された XML のまま */
  xml: string;
  /** 適用しなかった理由 */
  reason?: ApplyFixReason;
  changed?: { xpath: string; before?: string; after?: string };
  notes: string[];
}

export interface FixSelection {
  fix: Fix;
  candidate: FixCandidate;
}

export interface ApplyFixItemResult extends Omit<ApplyFixResult, 'xml'> {
  /** `selections` の何番目か */
  index: number;
}

export interface ApplyFixesResult {
  /** 1 件でも適用していれば適用後の XML、無ければ渡された XML */
  xml: string;
  /** 適用できた件数 */
  appliedCount: number;
  /** 選択ごとの結果（`selections` と同じ順） */
  results: ApplyFixItemResult[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// 候補の照合

function sameLocation(a: NodeLocation | undefined, b: NodeLocation | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.path !== b.path) return false;
  if (a.line !== undefined && b.line !== undefined && a.line !== b.line) return false;
  return true;
}

type MatchResult =
  | { state: 'match'; fix: Fix; candidate: FixCandidate }
  | { state: 'value-not-allowed' }
  | { state: 'none' };

/**
 * 選択された候補が、提案された候補のどれかと一致するか。
 * action・target は一致、value は single なら同じ文字列、range / pattern なら提案の範囲・正規表現に合う値。
 */
function matchOffered(offered: Fix[], fix: Fix, selected: FixCandidate): MatchResult {
  let valueMiss = false;
  for (const o of offered) {
    if (!sameLocation(o.location, fix.location)) continue;
    for (const c of o.candidates) {
      if (c.action !== selected.action) continue;
      if ((c.target ?? '') !== (selected.target ?? '')) continue;
      if (c.valueForm === 'range' || c.valueForm === 'pattern') {
        const v = selected.value;
        if (v === undefined || c.value === undefined) {
          valueMiss = true;
          continue;
        }
        const ok = c.valueForm === 'range' ? matchesRange(v, c.value) : matchesPattern(v, c.value);
        if (ok)
          return { state: 'match', fix: o, candidate: { ...c, value: v, valueForm: undefined } };
        valueMiss = true;
        continue;
      }
      if (
        (c.value ?? '') !== (selected.value ?? '') ||
        (c.value === undefined) !== (selected.value === undefined)
      )
        continue;
      return { state: 'match', fix: o, candidate: c };
    }
  }
  return valueMiss ? { state: 'value-not-allowed' } : { state: 'none' };
}

// ---------------------------------------------------------------------------
// 直列化（文書要素より前・後ろは元の文字列を保つ）

/** 文書要素の開始位置。XML 宣言・コメント・PI・DOCTYPE（内部サブセットを含む）を読み飛ばす。見つからなければ -1 */
function findRootStart(xml: string): number {
  const n = xml.length;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < n && /\s/.test(xml[i]!)) i++;
    if (xml.startsWith('<?', i)) {
      const e = xml.indexOf('?>', i + 2);
      if (e < 0) return -1;
      i = e + 2;
    } else if (xml.startsWith('<!--', i)) {
      const e = xml.indexOf('-->', i + 4);
      if (e < 0) return -1;
      i = e + 3;
    } else if (xml.startsWith('<!DOCTYPE', i)) {
      let depth = 0;
      let quote = '';
      i += 9;
      for (; i < n; i++) {
        const ch = xml[i]!;
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (xml.startsWith('<!--', i)) {
          const e = xml.indexOf('-->', i + 4);
          if (e < 0) return -1;
          i = e + 2;
        } else if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '>' && depth <= 0) {
          i++;
          break;
        }
      }
    } else return xml[i] === '<' ? i : -1;
  }
}

/** 文書要素の後ろに続く、コメント・PI・空白だけの末尾 */
function findEpilog(xml: string): string {
  const m = /(?:\s*(?:<!--[\s\S]*?-->|<\?[\s\S]*?\?>))*\s*$/.exec(xml);
  return m ? m[0] : '';
}

function serialize(doc: Document, original: string, notes: string[]): string {
  const serializer = new XMLSerializer();
  const root = doc.documentElement;
  const start = findRootStart(original);
  if (!root || start < 0) {
    notes.push(
      'The prolog of the original could not be located; the whole document was serialized.',
    );
    return serializer.serializeToString(doc);
  }
  const epilog = findEpilog(original.slice(start));
  return original.slice(0, start) + serializer.serializeToString(root) + epilog;
}

// ---------------------------------------------------------------------------
// DOM の補助

const NAME_RE = /^[\p{L}_][\p{L}\p{N}._-]*(?::[\p{L}_][\p{L}\p{N}._-]*)?$/u;
const localName = (n: { nodeName: string }) => n.nodeName.replace(/^[^:]+:/, '');
const isWsText = (n: Node | null): n is Text & Node =>
  !!n && n.nodeType === TEXT_NODE && /^\s*$/.test((n as Text).data);
const elementChildren = (el: Element): Element[] =>
  Array.from(el.childNodes).filter((c): c is Element => c.nodeType === ELEMENT_NODE);

/** 節点を取り除く。字下げだけの直前の空白があれば一緒に取り除く（空行を残さない） */
function removeNode(node: Node): void {
  const parent = node.parentNode;
  if (!parent) return;
  const prev = node.previousSibling;
  if (node.nodeType === ELEMENT_NODE && isWsText(prev) && /\n/.test((prev as Text).data)) {
    parent.removeChild(prev);
  }
  parent.removeChild(node);
}

/**
 * 子要素を足す。`ref` の前に入れる（null なら末尾）。親が字下げされていれば、同じ字下げを付ける。
 */
function insertChild(parent: Element, child: Element, ref: Node | null): void {
  const doc = parent.ownerDocument!;
  const firstEl = elementChildren(parent)[0];
  let indent: string | undefined;
  const before = firstEl?.previousSibling ?? null;
  if (isWsText(before) && /^\s*\n[ \t]*$/.test((before as Text).data))
    indent = (before as Text).data;
  if (indent === undefined) {
    if (ref) parent.insertBefore(child, ref);
    else parent.appendChild(child);
    return;
  }
  if (ref) {
    parent.insertBefore(child, ref);
    parent.insertBefore(doc.createTextNode(indent), ref);
    return;
  }
  const last = parent.lastChild;
  if (isWsText(last)) {
    parent.insertBefore(doc.createTextNode(indent), last);
    parent.insertBefore(child, last);
  } else {
    parent.appendChild(doc.createTextNode(indent));
    parent.appendChild(child);
  }
}

/** 足す要素の位置（これの前に入れる要素。null なら末尾）を XSD の出現順から決める */
function chooseRef(
  parent: Element,
  name: string,
  xsd: XsdIndex | undefined,
  notes: string[],
): Node | null {
  if (!xsd) {
    notes.push(`No XSD was available, so <${name}> was added at the end of <${parent.nodeName}>.`);
    return null;
  }
  const order = xsd.allowedChildren(localName(parent));
  if (!order) {
    notes.push(
      `<${parent.nodeName}> is not defined in the XSD, so <${name}> was added at the end.`,
    );
    return null;
  }
  const at = order.indexOf(localName({ nodeName: name }));
  if (at < 0) {
    notes.push(
      `<${name}> is not a child of <${parent.nodeName}> in the XSD, so it was added at the end.`,
    );
    return null;
  }
  for (const c of elementChildren(parent)) {
    const i = order.indexOf(localName(c));
    if (i > at) {
      notes.push(
        `Position decided from the XSD order of <${parent.nodeName}>: before <${c.nodeName}>.`,
      );
      return c;
    }
  }
  notes.push(
    `Position decided from the XSD order of <${parent.nodeName}>: after the last existing child.`,
  );
  return null;
}

/** 要素の名前を置き換える（属性と子はそのまま移す） */
function renameElement(el: Element, name: string): Element {
  const doc = el.ownerDocument!;
  const next = doc.createElementNS(el.namespaceURI, name);
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i)!;
    next.setAttributeNS(a.namespaceURI, a.name, a.value);
  }
  while (el.firstChild) next.appendChild(el.firstChild);
  el.parentNode!.replaceChild(next, el);
  return next;
}

/** objectPath の最後の段と、その手前（親を選ぶ式）に分ける。角括弧・丸括弧・引用符の中の `/` では分けない */
function splitLastStep(path: string): { parent: string; step: string } | undefined {
  let depth = 0;
  let quote = '';
  let cut = -1;
  for (let i = 0; i < path.length; i++) {
    const ch = path[i]!;
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === '/' && depth === 0) cut = i;
  }
  if (cut <= 0) return undefined;
  const parent = path.slice(0, cut);
  if (parent.endsWith('/')) return undefined;
  return { parent, step: path.slice(cut + 1) };
}

// ---------------------------------------------------------------------------
// 適用

interface Ctx {
  doc: Document;
  engine: XmlEngine;
  xsd: XsdIndex | undefined;
}

type Outcome =
  | {
      ok: true;
      changed: { xpath: string; before?: string; after?: string };
      notes?: string[];
    }
  | { ok: false; reason: ApplyFixReason; note?: string };

const fail = (reason: ApplyFixReason, note?: string): Outcome => ({ ok: false, reason, note });

// 候補の説明文で見分けるもの。説明文は suggestSchemaFixes が決める（fix.test.ts と apply.test.ts が実物の出力で固定している）
/** 要素の名前を置き換える候補（schema.ts: 'use the element the XSD expects here'） */
const RENAME_ELEMENT_RE = /expects here/;
/** 要素の中の子要素を取り除く候補（schema.ts: 'remove the child elements of this element'） */
const REMOVE_CHILDREN_RE = /child elements of this element/;
/** 要素の直下の文字を取り除く候補（schema.ts: 'remove the text directly inside this element'） */
const REMOVE_TEXT_RE = /text directly inside this element/;

type Located =
  | { type: 'attr'; owner: Element; name: string }
  | { type: 'element'; el: Element }
  | { type: 'error'; outcome: Outcome };

function locate(ctx: Ctx, path: string): Located {
  let nodes: Node[];
  try {
    nodes = ctx.engine.selectNodes(path, ctx.doc);
  } catch (e) {
    return { type: 'error', outcome: fail('xpath-error', (e as Error).message) };
  }
  if (nodes.length === 0) return { type: 'error', outcome: fail('location-not-found', path) };
  if (nodes.length > 1)
    return {
      type: 'error',
      outcome: fail('location-ambiguous', `${path} selects ${nodes.length} nodes`),
    };
  const n = nodes[0]!;
  if (n.nodeType === ATTRIBUTE_NODE) {
    const owner = (n as unknown as { ownerElement?: Element | null }).ownerElement;
    if (!owner) return { type: 'error', outcome: fail('location-not-found', path) };
    return { type: 'attr', owner, name: n.nodeName };
  }
  if (n.nodeType === ELEMENT_NODE) return { type: 'element', el: n as Element };
  return {
    type: 'error',
    outcome: fail('location-not-found', `${path} is not an element or attribute`),
  };
}

const attrTarget = (target: string | undefined): string | undefined =>
  target?.startsWith('@') ? target.slice(1) : undefined;

/** 場所が要素のとき、target（要素名）が食い違っていないか */
function targetMatchesElement(el: Element, target: string | undefined): boolean {
  if (target === undefined) return true;
  return target === el.nodeName || target === localName(el);
}

const DM_CODE_ATTRS = [
  'modelIdentCode',
  'systemDiffCode',
  'systemCode',
  'subSystemCode',
  'subSubSystemCode',
  'assyCode',
  'disassyCode',
  'disassyCodeVariant',
  'infoCode',
  'infoCodeVariant',
  'itemLocationCode',
] as const;
const DM_CODE_OPTIONAL = ['learnCode', 'learnEventCode'] as const;
const PM_CODE_ATTRS = ['modelIdentCode', 'pmIssuer', 'pmNumber', 'pmVolume'] as const;

/** dmRef / pmRef の下の、向け直す対象の要素（dmCode / pmCode / issueInfo） */
function findRefPart(ctx: Ctx, node: Element, rel: string): Element | undefined {
  const own = rel.split('/').pop()!;
  if (node.nodeName === own) return node;
  const found = ctx.engine.selectNodes(rel, node)[0] as Element | undefined;
  if (found) return found;
  if (/Ident$/.test(node.nodeName))
    return ctx.engine.selectNodes(own, node)[0] as Element | undefined;
  return undefined;
}

function applyReplace(ctx: Ctx, fix: Fix, c: FixCandidate, path: string | undefined): Outcome {
  const { value, target } = c;
  if (value === undefined) return fail('value-required');
  if (path === undefined) return fail('no-location');
  const at = locate(ctx, path);
  if (at.type === 'error') return at.outcome;

  // 参照先の版（dmRefIdent/issueInfo, pmRefIdent/issueInfo）
  if (target !== undefined && /^(dmRefIdent|pmRefIdent)\/issueInfo$/.test(target)) {
    if (at.type !== 'element') return fail('target-mismatch', 'The location is an attribute.');
    const m = /^(\d{3})-(\d{2})$/.exec(value);
    if (!m) return fail('value-malformed', `"${value}" is not issueNumber-inWork (e.g. 002-00)`);
    let issue = findRefPart(ctx, at.el, target);
    const before = issue
      ? `${issue.getAttribute('issueNumber') ?? ''}-${issue.getAttribute('inWork') ?? ''}`
      : undefined;
    const notes: string[] = [];
    if (!issue) {
      const ident = ctx.engine.selectNodes(target.split('/')[0]!, at.el)[0] as Element | undefined;
      if (!ident) return fail('target-not-found', target);
      issue = ctx.doc.createElement('issueInfo');
      insertChild(ident, issue, chooseRef(ident, 'issueInfo', ctx.xsd, notes));
    }
    issue.setAttribute('issueNumber', m[1]!);
    issue.setAttribute('inWork', m[2]!);
    return { ok: true, changed: { xpath: `${path}/${target}`, before, after: value }, notes };
  }

  const tgtAttr = attrTarget(target);
  if (at.type === 'attr') {
    if (target !== undefined && tgtAttr !== at.name)
      return fail('target-mismatch', `${target} is not the attribute at ${path}`);
    const before = at.owner.getAttribute(at.name) ?? undefined;
    at.owner.setAttribute(at.name, value);
    return { ok: true, changed: { xpath: path, before, after: value } };
  }

  // 場所が要素で、target が属性: その属性の名前を置き換える（許される属性への付け替え）
  if (tgtAttr !== undefined) {
    if (!at.el.hasAttribute(tgtAttr)) return fail('target-not-found', `${path}/${target}`);
    if (!NAME_RE.test(value)) return fail('value-malformed', `"${value}" is not an attribute name`);
    if (value !== tgtAttr && at.el.hasAttribute(value)) return fail('target-exists', `@${value}`);
    const v = at.el.getAttribute(tgtAttr) ?? '';
    at.el.removeAttribute(tgtAttr);
    at.el.setAttribute(value, v);
    return {
      ok: true,
      changed: { xpath: `${path}/@${tgtAttr}`, before: `@${tgtAttr}`, after: `@${value}` },
    };
  }

  if (!targetMatchesElement(at.el, target))
    return fail('target-mismatch', `${target} is not the element at ${path}`);
  if (fix.kind === 'schema' && RENAME_ELEMENT_RE.test(c.description)) {
    if (!NAME_RE.test(value)) return fail('value-malformed', `"${value}" is not an element name`);
    const before = at.el.nodeName;
    renameElement(at.el, value);
    return { ok: true, changed: { xpath: path, before: `<${before}>`, after: `<${value}>` } };
  }
  // 要素の文字列を置き換える
  if (elementChildren(at.el).length > 0)
    return fail('element-has-children', `${path} has child elements; only text can be replaced`);
  const before = (at.el.textContent ?? '').replace(/\s+/g, ' ').trim();
  while (at.el.firstChild) at.el.removeChild(at.el.firstChild);
  at.el.appendChild(ctx.doc.createTextNode(value));
  return { ok: true, changed: { xpath: path, before, after: value } };
}

function applyRemove(ctx: Ctx, c: FixCandidate, path: string | undefined): Outcome {
  if (path === undefined) return fail('no-location');
  const at = locate(ctx, path);
  if (at.type === 'error') return at.outcome;
  const { target } = c;
  const tgtAttr = attrTarget(target);

  if (at.type === 'attr') {
    if (target !== undefined && tgtAttr !== at.name)
      return fail('target-mismatch', `${target} is not the attribute at ${path}`);
    const before = at.owner.getAttribute(at.name) ?? undefined;
    at.owner.removeAttribute(at.name);
    return { ok: true, changed: { xpath: path, before } };
  }
  // 場所が要素で target が属性: その要素の属性を取り除く
  if (tgtAttr !== undefined) {
    if (!at.el.hasAttribute(tgtAttr)) return fail('target-not-found', `${path}/${target}`);
    const before = at.el.getAttribute(tgtAttr) ?? undefined;
    at.el.removeAttribute(tgtAttr);
    return { ok: true, changed: { xpath: `${path}/@${tgtAttr}`, before } };
  }
  if (!targetMatchesElement(at.el, target))
    return fail('target-mismatch', `${target} is not the element at ${path}`);

  if (REMOVE_CHILDREN_RE.test(c.description)) {
    const kids = elementChildren(at.el);
    if (kids.length === 0) return fail('target-not-found', `${path} has no child elements`);
    for (const k of kids) removeNode(k);
    return {
      ok: true,
      changed: { xpath: path, before: kids.map((k) => `<${k.nodeName}>`).join('') },
    };
  }
  if (REMOVE_TEXT_RE.test(c.description)) {
    const texts = Array.from(at.el.childNodes).filter(
      (n) => n.nodeType === TEXT_NODE && !isWsText(n),
    );
    if (texts.length === 0) return fail('target-not-found', `${path} has no text`);
    const before = texts.map((t) => (t as Text).data.trim()).join(' ');
    for (const t of texts) at.el.removeChild(t);
    return { ok: true, changed: { xpath: path, before } };
  }
  if (at.el === ctx.doc.documentElement) return fail('cannot-remove-root');
  removeNode(at.el);
  return { ok: true, changed: { xpath: path, before: `<${at.el.nodeName}>` } };
}

function addAttribute(el: Element, name: string, value: string | undefined, path: string): Outcome {
  if (!NAME_RE.test(name)) return fail('value-malformed', `"${name}" is not an attribute name`);
  if (el.hasAttribute(name)) return fail('target-exists', `${path}/@${name}`);
  if (value === undefined)
    return fail('value-required', `The value of @${name} is not decided by the candidate.`);
  el.setAttribute(name, value);
  return { ok: true, changed: { xpath: `${path}/@${name}`, after: value } };
}

function applyAdd(ctx: Ctx, c: FixCandidate, path: string | undefined): Outcome {
  const { target, value } = c;
  if (target !== undefined && target.startsWith('<'))
    return fail(
      'unsupported-candidate',
      'Declarations in the DOCTYPE are not changed by applyFix.',
    );

  if (path !== undefined) {
    const at = locate(ctx, path);
    if (at.type === 'error') return at.outcome;
    if (at.type === 'attr')
      return fail('target-mismatch', 'Nothing can be added under an attribute.');
    const tgtAttr = attrTarget(target);
    if (tgtAttr !== undefined) return addAttribute(at.el, tgtAttr, value, path);
    // 子要素を足す（schema.ts の 'Missing child element(s)': target は親、value は足す子の名前）
    if (target !== undefined && targetMatchesElement(at.el, target) && value !== undefined) {
      if (!NAME_RE.test(value)) return fail('value-malformed', `"${value}" is not an element name`);
      const notes: string[] = [];
      const child = ctx.doc.createElementNS(at.el.namespaceURI, value);
      insertChild(at.el, child, chooseRef(at.el, value, ctx.xsd, notes));
      return { ok: true, changed: { xpath: `${path}/${value}`, after: `<${value}>` }, notes };
    }
    return fail('unsupported-candidate', `Cannot add ${target ?? '(no target)'} at ${path}.`);
  }

  // 場所が無い（BREX の missing）: target が objectPath。最後の段を、その手前が選ぶ親に足す
  if (target === undefined) return fail('no-location');
  const split = splitLastStep(target);
  if (!split || !/^@?[\p{L}_][\p{L}\p{N}._:-]*$/u.test(split.step))
    return fail('unsupported-candidate', `The objectPath cannot be added: ${target}`);
  let parents: Node[];
  try {
    parents = ctx.engine.selectNodes(split.parent, ctx.doc);
  } catch (e) {
    return fail('xpath-error', (e as Error).message);
  }
  if (parents.length === 0) return fail('parent-not-found', split.parent);
  if (parents.length > 1)
    return fail('location-ambiguous', `${split.parent} selects ${parents.length} nodes`);
  const parent = parents[0]!;
  if (parent.nodeType !== ELEMENT_NODE)
    return fail('parent-not-found', `${split.parent} is not an element`);
  const parentEl = parent as Element;
  if (split.step.startsWith('@'))
    return addAttribute(parentEl, split.step.slice(1), value, split.parent);
  const notes: string[] = [];
  const child = ctx.doc.createElementNS(parentEl.namespaceURI, split.step);
  if (value !== undefined) child.appendChild(ctx.doc.createTextNode(value));
  insertChild(parentEl, child, chooseRef(parentEl, split.step, ctx.xsd, notes));
  return { ok: true, changed: { xpath: target, after: value ?? `<${split.step}>` }, notes };
}

function applyRetarget(ctx: Ctx, c: FixCandidate, path: string | undefined): Outcome {
  const { target, value } = c;
  if (value === undefined) return fail('value-required');
  if (path === undefined) return fail('no-location');
  const at = locate(ctx, path);
  if (at.type === 'error') return at.outcome;
  const tgtAttr = attrTarget(target);

  // internalRef の @internalRefId、applicRefId、infoEntityIdent など、参照を持つ属性
  if (tgtAttr !== undefined || at.type === 'attr') {
    const owner = at.type === 'attr' ? at.owner : at.type === 'element' ? at.el : undefined;
    const name = tgtAttr ?? (at.type === 'attr' ? at.name : undefined);
    if (!owner || !name) return fail('target-mismatch');
    if (at.type === 'attr' && at.name !== name)
      return fail('target-mismatch', `${target} is not the attribute at ${path}`);
    if (!owner.hasAttribute(name)) return fail('target-not-found', `${path}/@${name}`);
    const before = owner.getAttribute(name) ?? undefined;
    owner.setAttribute(name, value);
    return {
      ok: true,
      changed: { xpath: at.type === 'attr' ? path : `${path}/@${name}`, before, after: value },
    };
  }
  if (at.type !== 'element') return fail('target-mismatch');

  if (target === 'dmRefIdent/dmCode') {
    const parsed = parseDmc(value);
    if (!parsed.ok) return fail('value-malformed', parsed.error);
    const code = findRefPart(ctx, at.el, target);
    if (!code) return fail('target-not-found', `${path}/${target}`);
    const before = formatDmcFromElement(code);
    for (const k of DM_CODE_ATTRS) code.setAttribute(k, parsed.value[k]);
    for (const k of DM_CODE_OPTIONAL) {
      const v = parsed.value[k];
      if (v) code.setAttribute(k, v);
      else code.removeAttribute(k);
    }
    return {
      ok: true,
      changed: { xpath: `${path}/${target}`, before, after: formatDmc(parsed.value) },
      notes: [
        'Only the dmCode was changed. Check the issueInfo next to it: it still names the issue of the previous target.',
      ],
    };
  }
  if (target === 'pmRefIdent/pmCode') {
    const parsed = parsePmc(value);
    if (!parsed.ok) return fail('value-malformed', parsed.error);
    const code = findRefPart(ctx, at.el, target);
    if (!code) return fail('target-not-found', `${path}/${target}`);
    const before = PM_CODE_ATTRS.map((k) => code.getAttribute(k) ?? '').join('-');
    for (const k of PM_CODE_ATTRS) code.setAttribute(k, parsed.value[k]);
    return {
      ok: true,
      changed: { xpath: `${path}/${target}`, before, after: formatPmc(parsed.value) },
      notes: ['Only the pmCode was changed. Check the issueInfo next to it.'],
    };
  }
  return fail('unsupported-candidate', `Cannot retarget ${target ?? '(no target)'}.`);
}

function formatDmcFromElement(code: Element): string {
  const parts: string[] = [];
  for (const k of DM_CODE_ATTRS) parts.push(code.getAttribute(k) ?? '');
  const [mic, sdc, sys, sub, subsub, assy, dis, disv, info, infov, loc] = parts;
  const learn = code.getAttribute('learnCode');
  const event = code.getAttribute('learnEventCode');
  return (
    `${mic}-${sdc}-${sys}${sub}${subsub}-${assy}-${dis}${disv}-${info}${infov}-${loc}` +
    (learn ? `-${learn}${event ?? ''}` : '')
  );
}

/** 照合を済ませた 1 件を DOM に適用する */
function applyOne(ctx: Ctx, fix: Fix, candidate: FixCandidate): Outcome {
  const path = fix.location?.path ? fix.location.path : undefined;
  switch (candidate.action) {
    case 'replace':
      return applyReplace(ctx, fix, candidate, path);
    case 'remove':
      return applyRemove(ctx, candidate, path);
    case 'add':
      return applyAdd(ctx, candidate, path);
    case 'retarget':
      return applyRetarget(ctx, candidate, path);
    case 'provide':
      return fail('provide-is-not-a-document-change');
  }
}

// ---------------------------------------------------------------------------
// 入口

interface Prepared {
  offered?: Fix[];
  xsd?: XsdIndex;
}

function prepare(xml: string, options: ApplyFixOptions, engine: XmlEngine): Prepared {
  let offered = options.offered;
  if (!offered && options.verify) {
    offered = suggestFixes(options.verify, {
      xml,
      ...options.suggest,
      engine,
    });
  }
  let xsd: XsdIndex | undefined;
  if (options.xsd !== false) {
    xsd =
      options.xsd ??
      (options.verify?.schema.xsdPath
        ? loadXsdIndex(options.verify.schema.xsdPath, engine)
        : undefined);
  }
  return { offered, xsd };
}

/** 照合して適用する（DOM を直接変える）。結果の xml は呼び出し側が入れる */
function applyChecked(
  ctx: Ctx,
  offered: Fix[] | undefined,
  fix: Fix,
  candidate: FixCandidate,
): Omit<ApplyFixResult, 'xml'> {
  const notes: string[] = [];
  const no = (reason: ApplyFixReason, note?: string) => {
    if (note) notes.push(note);
    return { applied: false, reason, notes };
  };
  if (candidate.action === 'provide') return no('provide-is-not-a-document-change');

  let useFix = fix;
  let useCandidate = candidate;
  if (offered) {
    const m = matchOffered(offered, fix, candidate);
    if (m.state === 'value-not-allowed') return no('value-not-allowed');
    if (m.state === 'none') return no('candidate-not-offered');
    useFix = m.fix;
    useCandidate = m.candidate;
  } else {
    // 照合の元が無い: 渡された fix 自身の候補との一致だけを確かめる
    const m = matchOffered([fix], fix, candidate);
    if (m.state === 'value-not-allowed') return no('value-not-allowed');
    if (m.state === 'none') return no('candidate-not-offered');
    useCandidate = m.candidate;
    notes.push(
      'No verify result or offered fixes were given; only the candidates of the given fix were checked.',
    );
  }

  const out = applyOne(ctx, useFix, useCandidate);
  if (!out.ok) return no(out.reason, out.note);
  notes.push(...(out.notes ?? []));
  return { applied: true, changed: out.changed, notes };
}

function parseOrFail(xml: string, engine: XmlEngine): { doc: Document } | { error: string } {
  try {
    // xmldom は XML 宣言の前の BOM を受け付けない。読むときだけ外し、直列化では元の文字列の先頭（BOM を含む）を使う
    return { doc: engine.parse(xml.replace(/^\uFEFF/, '')).document };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * 候補 1 件を XML に適用する。
 *
 * `options.verify`（または `options.offered`）があれば、`fix.location` と `candidate` が計算し直した候補の中に
 * 一致するときだけ適用する（一致しなければ `candidate-not-offered`）。range / pattern の候補は `candidate.value` を
 * その範囲・正規表現で確かめる（合わなければ `value-not-allowed`）。
 */
export function applyFix(
  xml: string,
  fix: Fix,
  candidate: FixCandidate,
  options: ApplyFixOptions = {},
): ApplyFixResult {
  const engine = options.engine ?? defaultXmlEngine;
  if (candidate.action === 'provide')
    return { applied: false, xml, reason: 'provide-is-not-a-document-change', notes: [] };
  const parsed = parseOrFail(xml, engine);
  if ('error' in parsed)
    return { applied: false, xml, reason: 'xml-not-well-formed', notes: [parsed.error] };
  const { offered, xsd } = prepare(xml, options, engine);
  const r = applyChecked({ doc: parsed.doc, engine, xsd }, offered, fix, candidate);
  if (!r.applied) return { ...r, xml };
  return { ...r, xml: serialize(parsed.doc, xml, r.notes) };
}

/** 位置の並べ替えに使う、元の文書での節点の行・桁 */
function sortKey(ctx: Ctx, fix: Fix): [number, number] | undefined {
  const path = fix.location?.path;
  if (!path) return undefined;
  try {
    const nodes = ctx.engine.selectNodes(path, ctx.doc);
    if (nodes.length === 1) {
      let n: Node = nodes[0]!;
      const owner = (n as unknown as { ownerElement?: Element | null }).ownerElement;
      if (n.nodeType === ATTRIBUTE_NODE && owner) n = owner;
      const p = n as unknown as { lineNumber?: number; columnNumber?: number };
      if (typeof p.lineNumber === 'number') return [p.lineNumber, p.columnNumber ?? 0];
    }
  } catch {
    // 評価できない場所は fix.location の行を使う
  }
  const loc = fix.location;
  return loc?.line !== undefined ? [loc.line, loc.column ?? 0] : undefined;
}

/**
 * 複数の選択をまとめて適用する。
 *
 * 文書を 1 回だけ読み、元の文書での位置が後ろのものから順に適用する（前の適用で XPath の添字がずれないため）。
 * 場所を持たない選択（BREX の missing）は最後に適用する。適用できなかった選択は `results` に理由が残り、他の選択は続ける。
 */
export function applyFixes(
  xml: string,
  selections: FixSelection[],
  options: ApplyFixOptions = {},
): ApplyFixesResult {
  const engine = options.engine ?? defaultXmlEngine;
  const results: ApplyFixItemResult[] = [];
  const parsed = parseOrFail(xml, engine);
  if ('error' in parsed) {
    selections.forEach((_, index) =>
      results.push({ index, applied: false, reason: 'xml-not-well-formed', notes: [parsed.error] }),
    );
    return { xml, appliedCount: 0, results, notes: [parsed.error] };
  }
  const { offered, xsd } = prepare(xml, options, engine);
  const ctx: Ctx = { doc: parsed.doc, engine, xsd };

  const keyed = selections.map((s, index) => ({ s, index, key: sortKey(ctx, s.fix) }));
  const order = [...keyed].sort((a, b) => {
    if (a.key && b.key) return b.key[0] - a.key[0] || b.key[1] - a.key[1] || a.index - b.index;
    if (a.key) return -1;
    if (b.key) return 1;
    return a.index - b.index;
  });
  const byIndex: ApplyFixItemResult[] = [];
  for (const { s, index } of order) {
    byIndex[index] = { index, ...applyChecked(ctx, offered, s.fix, s.candidate) };
  }
  results.push(...byIndex);
  const appliedCount = results.filter((r) => r.applied).length;
  const notes: string[] = [];
  const out = appliedCount > 0 ? serialize(parsed.doc, xml, notes) : xml;
  return { xml: out, appliedCount, results, notes };
}
