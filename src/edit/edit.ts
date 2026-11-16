/**
 * 既にあるデータモジュールの構造を変える編集。節点を足す（insert）・取り除く（remove）・移す（move）。
 *
 * 設計: s1000d-stack の docs/design/core-structural-edit.md、DECISIONS D-31。
 *
 * - 場所は、編集の前の文書の `location.path`（`readContent` が返すもの）で指す
 * - 1 つでも断る理由があれば、1 つも適用しない
 * - 元の文字列の、編集した範囲だけを書き換える（`xml/ranges.ts`）。触っていない部分は 1 文字も変わらない。
 *   移した要素の中身も変わらない
 * - 文字列を書き換えた結果を読み直し、DOM で同じ操作をした結果と比べる。合わなければ適用しない
 * - 版（`issueInfo`）も変更の印（`changeType`・`changeMark`・`reasonForUpdate`）も変えない。
 *   発行済みの版（`inWork` が "00"）は、`allowReleasedIssue` が無ければ断る
 * - 親がその位置にその要素を取れるか（XSD の内容モデルの順序）は確かめない。`options.xsd` があるときに、
 *   親がその名前の子を取れるかだけを確かめる。順序の誤りは、適用の後の XSD の検証で見つかる
 */
import { XMLSerializer } from '@xmldom/xmldom';
import { describeLocation } from '../brex/check.js';
import type { NodeLocation } from '../brex/types.js';
import { ALLOWED, Writer, newDocument } from '../write/content/common.js';
import { DraftInputError } from '../write/errors.js';
import type { DraftKind, DraftNode, DraftNodeKind } from '../write/types.js';
import type { Document, Element, Node, XmlEngine } from '../xml/engine.js';
import { XPathError } from '../xml/engine.js';
import {
  rangeOfElement,
  rangesMatchDocument,
  scanElementRanges,
  type ElementRange,
} from '../xml/ranges.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import type {
  AppliedEdit,
  ContentEdit,
  EditContentOptions,
  EditContentResult,
  EditPosition,
  EditRefusal,
  EditRefusalReason,
} from './types.js';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;

/** 最初の版で、取り除く・移す・足す対象にできる要素 */
export const EDITABLE_ELEMENTS: readonly string[] = [
  'proceduralStep',
  'para',
  'warning',
  'caution',
  'note',
  'listItem',
];

type DraftParent = DraftNodeKind | 'body';

/** insert の基準の親（要素名）を、下書きの親の種類に読み替える。ここに無い親には足せない */
const DRAFT_PARENT: Record<string, DraftParent> = {
  mainProcedure: 'body',
  description: 'body',
  levelledPara: 'section',
  proceduralStep: 'step',
  listItem: 'listItem',
  sequentialList: 'list',
  randomList: 'list',
};

/** id を指す属性の名前（internalRefId・applicRefId・warningRefs・cautionRefs・reasonForUpdateRefIds など） */
const ID_REFERENCE_ATTRIBUTE = /(Refs?|RefIds?)$/;

const isElement = (n: Node | null | undefined): n is Element => !!n && n.nodeType === ELEMENT_NODE;

const elementChildren = (n: Node): Element[] =>
  Array.from(n.childNodes).filter(isElement) as unknown as Element[];

function descendantsAndSelf(el: Element): Element[] {
  const out: Element[] = [el];
  for (const c of elementChildren(el)) out.push(...descendantsAndSelf(c));
  return out;
}

const isInside = (node: Node, ancestor: Node): boolean => {
  for (let n: Node | null = node; n; n = n.parentNode) if (n === ancestor) return true;
  return false;
};

// ---- 文字列の上の位置 ----

interface Layout {
  xml: string;
  nl: string;
  /** 字下げ 1 段分 */
  unit: string;
}

const lineStart = (xml: string, pos: number) => xml.lastIndexOf('\n', pos - 1) + 1;

/** 要素が行の先頭（前に空白だけ）から始まっているか。そうならその空白 */
function indentOf(xml: string, r: ElementRange): string | undefined {
  const lead = xml.slice(lineStart(xml, r.start), r.start);
  return /^[ \t]*$/.test(lead) ? lead : undefined;
}

/** 要素の後ろが行末（空白だけ）か。そうなら次の行の先頭の位置 */
function lineEndAfter(
  xml: string,
  r: ElementRange,
): { next: number; hasNewline: boolean } | undefined {
  const idx = xml.indexOf('\n', r.end);
  const rest = xml.slice(r.end, idx < 0 ? xml.length : idx);
  if (!/^[ \t\r]*$/.test(rest)) return undefined;
  return { next: idx < 0 ? xml.length : idx + 1, hasNewline: idx >= 0 };
}

/** 文字列への操作 1 つ。`pos` から `del` 文字を取り除き、`ins` を入れる */
interface Splice {
  pos: number;
  del: number;
  ins: string;
}

/** 取り除く範囲。要素だけの行なら行ごと、そうでなければ要素の範囲だけ */
function removalSpan(xml: string, r: ElementRange): { from: number; to: number } {
  const indent = indentOf(xml, r);
  const eol = lineEndAfter(xml, r);
  if (indent !== undefined && eol) return { from: lineStart(xml, r.start), to: eol.next };
  return { from: r.start, to: r.end };
}

interface Placement {
  pos: number;
  /** 足す要素の行の字下げ（要素の中の行の字下げの元にもなる） */
  indent: string;
  lead: string;
  tail: string;
}

function placeBeside(layout: Layout, ref: ElementRange, side: 'before' | 'after'): Placement {
  const { xml, nl } = layout;
  const indent = indentOf(xml, ref);
  if (side === 'before') {
    if (indent !== undefined) {
      return { pos: lineStart(xml, ref.start), indent, lead: indent, tail: nl };
    }
    return { pos: ref.start, indent: '', lead: '', tail: '' };
  }
  const eol = lineEndAfter(xml, ref);
  if (indent !== undefined && eol) {
    if (eol.hasNewline) return { pos: eol.next, indent, lead: indent, tail: nl };
    return { pos: ref.end, indent, lead: nl + indent, tail: '' };
  }
  return { pos: ref.end, indent: '', lead: '', tail: '' };
}

function placeInside(
  layout: Layout,
  parent: ElementRange,
  side: 'first-child' | 'last-child',
): Placement | undefined {
  const { xml, nl, unit } = layout;
  if (parent.children.length > 0) {
    return side === 'first-child'
      ? placeBeside(layout, parent.children[0]!, 'before')
      : placeBeside(layout, parent.children[parent.children.length - 1]!, 'after');
  }
  if (parent.selfClosing) return undefined;
  const inner = xml.slice(parent.openEnd, parent.closeStart);
  const parentIndent = indentOf(xml, parent);
  if (/^\s*$/.test(inner) && parentIndent !== undefined) {
    const indent = parentIndent + unit;
    return {
      pos: parent.openEnd,
      indent,
      lead: nl + indent,
      tail: inner.includes('\n') ? '' : nl + parentIndent,
    };
  }
  return {
    pos: side === 'first-child' ? parent.openEnd : parent.closeStart,
    indent: '',
    lead: '',
    tail: '',
  };
}

function place(layout: Layout, ref: ElementRange, position: EditPosition): Placement | undefined {
  return position === 'before' || position === 'after'
    ? placeBeside(layout, ref, position)
    : placeInside(layout, ref, position);
}

/** 操作を位置の順に適用する。同じ位置では、足す文字列（編集の順）→ 取り除く範囲、の順 */
function applySplices(xml: string, splices: Splice[]): string {
  const sorted = splices
    .map((s, order) => ({ ...s, order }))
    .sort((a, b) => a.pos - b.pos || a.del - b.del || a.order - b.order);
  let out = '';
  let cursor = 0;
  for (const s of sorted) {
    if (s.pos > cursor) out += xml.slice(cursor, s.pos);
    out += s.ins;
    cursor = Math.max(cursor, s.pos + s.del);
  }
  return out + xml.slice(cursor);
}

// ---- 足す要素の直列化 ----

/**
 * 組み立てた要素を文字列にする。子が要素だけなら 1 行に 1 つずつ字下げし、文を含む要素は 1 行で書く。
 * 返す文字列の 1 行目に字下げは付けない（呼ぶ側が付ける）。
 */
function render(el: Element, indent: string, layout: Layout): string {
  const serializer = new XMLSerializer();
  const kids = Array.from(el.childNodes);
  const hasText = kids.some(
    (k) =>
      (k.nodeType === TEXT_NODE || k.nodeType === CDATA_NODE) && (k.nodeValue ?? '').trim() !== '',
  );
  const elements = kids.filter(isElement) as unknown as Element[];
  if (hasText || elements.length === 0) return serializer.serializeToString(el);
  const open = serializer.serializeToString(el.cloneNode(false)).replace(/\s*\/>$/, '>');
  const inner = indent + layout.unit;
  const lines = elements.map((c) => inner + render(c, inner, layout));
  return [open, ...lines, `${indent}</${el.nodeName}>`].join(layout.nl);
}

// ---- 結果の照合 ----

/** 要素・属性・文だけの署名。空白だけの文、コメント、処理命令は入れない */
function signature(node: Node): string {
  if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) {
    const t = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
    return t === '' ? '' : JSON.stringify(t);
  }
  if (!isElement(node)) return '';
  const attrs = Array.from(node.attributes)
    .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
    .sort()
    .join(' ');
  const kids = Array.from(node.childNodes).map(signature).join('');
  return `<${node.nodeName} ${attrs}>${kids}</>`;
}

// ---- 本体 ----

interface Target {
  index: number;
  element: Element;
  range: ElementRange;
  location: NodeLocation;
}

interface Insertion {
  index: number;
  /** 足す・移す要素（insert では組み立てた要素、move では文書の要素） */
  element: Element;
  /** 入れる文字列（字下げと改行を除いた本体）を、字下げから作る */
  text: (indent: string) => string;
  ref: Element;
  refRange: ElementRange;
  position: EditPosition;
}

function contentKindOf(doc: Document): DraftKind | undefined {
  const root = doc.documentElement;
  if (!root || root.nodeName !== 'dmodule') return undefined;
  const content = elementChildren(root).find((c) => c.nodeName === 'content');
  const first = content ? elementChildren(content)[0] : undefined;
  if (first?.nodeName === 'procedure') return 'proced';
  if (first?.nodeName === 'description') return 'descript';
  return undefined;
}

/**
 * 既にあるデータモジュール（または PM）の XML に、構造を変える編集を適用する。
 * すべて適用できたときだけ `applied: true` と新しい XML を返す。1 つでも断ったら、渡された XML のまま返す。
 */
export function editContent(
  xml: string,
  edits: ContentEdit[],
  options: EditContentOptions = {},
): EditContentResult {
  const engine: XmlEngine = options.engine ?? defaultXmlEngine;
  const notes: string[] = [];
  const refusals: EditRefusal[] = [];
  const fail = (): EditContentResult => ({ applied: false, xml, refusals, changes: [], notes });
  const refuse = (
    index: number | undefined,
    reason: EditRefusalReason,
    message: string,
    extra: Partial<EditRefusal> = {},
  ) => {
    refusals.push({ ...(index === undefined ? {} : { index }), reason, message, ...extra });
  };

  let doc: Document;
  try {
    doc = engine.parse(xml).document;
  } catch (e) {
    refuse(undefined, 'xml-not-well-formed', (e as Error).message);
    return fail();
  }
  const rootRange = scanElementRanges(xml);
  if (!rootRange || !rangesMatchDocument(rootRange, doc.documentElement!)) {
    refuse(
      undefined,
      'ranges-unavailable',
      'The elements of the parsed document could not be matched to positions in the original text.',
    );
    return fail();
  }

  const issueInfo = engine.selectNodes('/*/identAndStatusSection/*/*/issueInfo', doc)[0];
  const inWork = isElement(issueInfo) ? issueInfo.getAttribute('inWork') : null;
  if (inWork === '00' && !options.allowReleasedIssue) {
    refuse(
      undefined,
      'released-issue',
      'The document is a released issue (issueInfo/@inWork is "00"). editContent changes neither the issue information nor change markup, so a released issue is edited only when allowReleasedIssue is true.',
    );
    return fail();
  }
  if (inWork === '00') {
    notes.push(
      'A released issue (issueInfo/@inWork "00") was edited in place because allowReleasedIssue is true. The issue information and change markup (changeType, changeMark, reasonForUpdate) were not changed.',
    );
  } else {
    notes.push(
      'The issue information and change markup (changeType, changeMark, reasonForUpdate) were not changed.',
    );
  }

  const xsd = options.xsd || undefined;
  if (!xsd && edits.some((e) => e.op !== 'remove')) {
    notes.push(
      'No XSD definitions were given; whether the parent accepts the element was not checked.',
    );
  }

  const layout: Layout = {
    xml,
    nl: xml.includes('\r\n') ? '\r\n' : '\n',
    unit: (() => {
      const first = rootRange.children[0];
      const a = indentOf(xml, rootRange);
      const b = first ? indentOf(xml, first) : undefined;
      return a !== undefined && b !== undefined && b.startsWith(a) && b.length > a.length
        ? b.slice(a.length)
        : '  ';
    })(),
  };

  /** 場所を 1 つの要素に決める。決まらなければ断って undefined */
  const locate = (index: number, path: string, what: string): Element | undefined => {
    let nodes: Node[];
    try {
      nodes = engine.selectNodes(path, doc);
    } catch (e) {
      const message = e instanceof XPathError ? e.message : (e as Error).message;
      refuse(index, 'xpath-error', `${what} "${path}": ${message}`);
      return undefined;
    }
    if (nodes.length === 0) {
      refuse(index, 'location-not-found', `${what} "${path}" selects no node.`);
      return undefined;
    }
    if (nodes.length > 1) {
      refuse(index, 'location-ambiguous', `${what} "${path}" selects ${nodes.length} nodes.`);
      return undefined;
    }
    if (!isElement(nodes[0])) {
      refuse(index, 'not-an-element', `${what} "${path}" does not select an element.`);
      return undefined;
    }
    return nodes[0];
  };

  const documentIds = new Set<string>();
  for (const el of descendantsAndSelf(doc.documentElement!)) {
    const id = el.getAttribute('id');
    if (id) documentIds.add(id);
  }

  const targets: Target[] = [];
  const insertions: Insertion[] = [];
  const changes: AppliedEdit[] = [];
  const removed: Target[] = [];
  const contentKind = contentKindOf(doc);

  edits.forEach((edit, index) => {
    // 取り除く・移す対象
    let target: Target | undefined;
    if (edit.op === 'remove' || edit.op === 'move') {
      const el = locate(index, edit.at, 'at');
      if (!el) return;
      const location = describeLocation(el);
      if (!EDITABLE_ELEMENTS.includes(el.nodeName)) {
        refuse(
          index,
          'unsupported-node',
          `<${el.nodeName}> cannot be ${edit.op === 'remove' ? 'removed' : 'moved'} by editContent (supported: ${EDITABLE_ELEMENTS.join(', ')}).`,
          { location },
        );
        return;
      }
      const range = rangeOfElement(rootRange, el);
      if (!range) {
        refuse(index, 'ranges-unavailable', `The position of "${edit.at}" was not found.`, {
          location,
        });
        return;
      }
      target = { index, element: el, range, location };
    }

    // 足す・移す先
    if (edit.op === 'insert' || edit.op === 'move') {
      const ref = locate(index, edit.to, 'to');
      if (!ref) return;
      const refLocation = describeLocation(ref);
      const refRange = rangeOfElement(rootRange, ref);
      if (!refRange) {
        refuse(index, 'ranges-unavailable', `The position of "${edit.to}" was not found.`, {
          location: refLocation,
        });
        return;
      }
      const beside = edit.position === 'before' || edit.position === 'after';
      const parent = beside ? ref.parentNode : ref;
      if (!isElement(parent)) {
        refuse(
          index,
          'unsupported-destination',
          `Nothing can be placed ${edit.position} the document element.`,
          { location: refLocation },
        );
        return;
      }
      if (!beside && refRange.selfClosing) {
        refuse(
          index,
          'unsupported-destination',
          `<${ref.nodeName}/> is an empty-element tag; editContent does not open it to add a child.`,
          { location: refLocation },
        );
        return;
      }

      let element: Element;
      let text: (indent: string) => string;
      if (edit.op === 'move') {
        if (!target) return;
        if (isInside(ref, target.element)) {
          refuse(index, 'move-into-self', `"${edit.to}" is inside the node being moved.`, {
            location: target.location,
          });
          return;
        }
        element = target.element;
        const moved = xml.slice(target.range.start, target.range.end);
        text = () => moved;
      } else {
        const draftParent = DRAFT_PARENT[parent.nodeName];
        if (!contentKind || !draftParent || !ALLOWED[contentKind][draftParent]) {
          refuse(
            index,
            'unsupported-destination',
            contentKind
              ? `editContent does not add a node to <${parent.nodeName}> (supported parents: ${Object.keys(DRAFT_PARENT).join(', ')}).`
              : 'editContent adds nodes only to procedural and descriptive data modules.',
            { location: refLocation },
          );
          return;
        }
        const path = `/edits[${index + 1}]/node`;
        try {
          element = buildNode(contentKind, draftParent, edit.node, path, documentIds, options);
        } catch (e) {
          if (!(e instanceof DraftInputError)) throw e;
          refuse(index, 'draft-input-error', e.message, { location: refLocation });
          return;
        }
        const duplicate = descendantsAndSelf(element)
          .map((d) => d.getAttribute('id'))
          .find((id) => id && documentIds.has(id));
        if (duplicate) {
          refuse(index, 'id-duplicate', `id "${duplicate}" is already used in the document.`, {
            location: refLocation,
          });
          return;
        }
        const built = element;
        text = (indent) => render(built, indent, layout);
      }

      const allowed = xsd?.allowedChildren(parent.nodeName);
      if (allowed && !allowed.includes(element.nodeName)) {
        refuse(
          index,
          'not-allowed-here',
          `<${parent.nodeName}> does not accept <${element.nodeName}> as a child (XSD).`,
          { location: refLocation },
        );
        return;
      }
      insertions.push({ index, element, text, ref, refRange, position: edit.position });
      changes.push({
        index,
        op: edit.op,
        ...(target ? { at: target.location } : {}),
        to: refLocation,
        position: edit.position,
        element: element.nodeName,
      });
    } else if (target) {
      removed.push(target);
      changes.push({ index, op: 'remove', at: target.location, element: target.element.nodeName });
    }
    if (target) targets.push(target);
  });

  // 編集どうしの食い違い
  for (const t of targets) {
    const other = targets.find(
      (o) => o !== t && (o.element === t.element || isInside(t.element, o.element)),
    );
    if (other) {
      refuse(
        t.index,
        'conflicting-edits',
        other.element === t.element
          ? `The same node is the target of edits ${other.index + 1} and ${t.index + 1}.`
          : `The node is inside the node that edit ${other.index + 1} removes or moves.`,
        { location: t.location },
      );
    }
  }
  for (const ins of insertions) {
    const other = targets.find((t) => t.element !== ins.element && isInside(ins.ref, t.element));
    if (other) {
      refuse(
        ins.index,
        'conflicting-edits',
        `The destination is, or is inside, the node that edit ${other.index + 1} removes or moves.`,
        { location: describeLocation(ins.ref) },
      );
    }
  }

  // 取り除く節点の id を、残る部分が指していないか
  if (removed.length > 0) {
    const gone = (el: Element) => removed.some((r) => isInside(el, r.element));
    const rest = descendantsAndSelf(doc.documentElement!).filter((el) => !gone(el));
    for (const r of removed) {
      const ids = new Set(
        descendantsAndSelf(r.element)
          .map((d) => d.getAttribute('id'))
          .filter((id): id is string => !!id),
      );
      if (ids.size === 0) continue;
      const by = rest.filter((el) =>
        Array.from(el.attributes).some(
          (a) =>
            a.name !== 'id' &&
            ID_REFERENCE_ATTRIBUTE.test(a.name) &&
            a.value.split(/\s+/).some((v) => ids.has(v)),
        ),
      );
      if (by.length > 0) {
        refuse(
          r.index,
          'id-referenced',
          `The node (or a descendant) has an id that ${by.length} element(s) in the rest of the document refer to (${[...ids].join(', ')}).`,
          { location: r.location, referencedBy: by.map((el) => describeLocation(el)) },
        );
      }
    }
  }

  if (refusals.length > 0) return fail();
  if (edits.length === 0) return { applied: true, xml, refusals, changes, notes };

  // 文字列への操作
  const splices: Splice[] = [];
  for (const t of targets) {
    const span = removalSpan(xml, t.range);
    splices.push({ pos: span.from, del: span.to - span.from, ins: '' });
  }
  for (const ins of insertions) {
    const p = place(layout, ins.refRange, ins.position);
    if (!p) {
      refuse(ins.index, 'unsupported-destination', 'The destination cannot take a child.');
      return fail();
    }
    splices.push({ pos: p.pos, del: 0, ins: p.lead + ins.text(p.indent) + p.tail });
  }
  const deletions = splices.filter((s) => s.del > 0);
  for (const s of splices) {
    if (s.del === 0 && deletions.some((d) => s.pos > d.pos && s.pos < d.pos + d.del)) {
      refuse(
        undefined,
        'conflicting-edits',
        'A destination falls inside the text that another edit removes.',
      );
      return fail();
    }
  }
  const out = applySplices(xml, splices);

  // DOM で同じ操作をして、結果を比べる
  const isTarget = (n: Node | null) => !!n && targets.some((t) => t.element === n);
  const anchors = insertions.map((ins) => {
    const beside = ins.position === 'before' || ins.position === 'after';
    const parent = (beside ? ins.ref.parentNode : ins.ref) as unknown as Element;
    let before: Node | null;
    if (ins.position === 'before') before = ins.ref;
    else if (ins.position === 'after') before = ins.ref.nextSibling;
    else if (ins.position === 'first-child') {
      before = elementChildren(ins.ref)[0] ?? ins.ref.firstChild;
    } else before = null;
    while (before && isTarget(before)) before = before.nextSibling;
    return { parent, before };
  });
  for (const t of targets) t.element.parentNode?.removeChild(t.element);
  insertions.forEach((ins, i) => {
    const node =
      ins.element.ownerDocument === doc ? ins.element : doc.importNode(ins.element, true);
    anchors[i]!.parent.insertBefore(node, anchors[i]!.before);
  });
  let reparsed: Document;
  try {
    reparsed = engine.parse(out).document;
  } catch (e) {
    refuse(
      undefined,
      'internal-mismatch',
      `The edited text is not well-formed: ${(e as Error).message}`,
    );
    return fail();
  }
  if (signature(reparsed.documentElement!) !== signature(doc.documentElement!)) {
    refuse(
      undefined,
      'internal-mismatch',
      'The edited text does not match the result of the same edits on the DOM. Nothing was applied.',
    );
    return fail();
  }
  return { applied: true, xml: out, refusals, changes, notes };
}

/** insert の節点 1 つを、下書きの組み立て役（`Writer`）で要素にする */
function buildNode(
  kind: DraftKind,
  parent: DraftParent,
  node: DraftNode,
  path: string,
  documentIds: Set<string>,
  options: EditContentOptions,
): Element {
  const w = new Writer(kind, { ...options.build, document: newDocument(), notes: [] }, [node]);
  // 文書に既にある id への internalRef を受け付ける
  for (const id of documentIds) w.ids.add(id);
  w.checkKind(node, parent, path);
  switch (node.kind) {
    case 'step':
      return w.proceduralStep(node, path);
    case 'para':
      return w.para(node, path);
    case 'admonition':
      return w.admonition(node, path);
    case 'listItem':
      return w.listItem(node, path);
    default:
      throw new DraftInputError(
        path,
        `node kind "${node.kind}" cannot be inserted by editContent (supported: step, para, admonition, listItem)`,
      );
  }
}
