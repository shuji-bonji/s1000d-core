/**
 * 人が読む文を持つ要素を集める（extract と apply が同じ規則を使う）。
 *
 * 方針:
 * - 対象は要素名の対応表で決める（reader の `content/read.ts` と同じ考え方）。属性値・DMC・ICN・`applic` の式・`id` は対象にしない。
 *   識別・状態部（identAndStatusSection）は `dmTitle`（techName / infoName / infoNameVariant）と `applic/displayText/simplePara` だけを読む。
 * - 文を持つ要素の子のうち、ブロック要素（入れ子の段落・リスト・表・図・注記など）は文に含めず、そのまま残して中を辿る。
 *   ブロック要素で区切られた文字の並び（run）が 1 つの文になる。最初の run の `id` は要素の `id`、2 番目以降は `~番号` を付ける。
 * - それ以外の子（emphasis・internalRef・dmRef・acronym・quantity・subScript など）はインライン要素として `{n}` に置き換える。
 *   インライン要素の中の文は辿らない（`footnote` の中の段落なども、訳さずにそのまま残る）。
 */
import { XMLSerializer } from '@xmldom/xmldom';
import { describeLocation } from '../brex/check.js';
import type { NodeLocation } from '../brex/types.js';
import type { Document, Element, Node } from '../xml/index.js';
import type { SegmentCategory, SegmentPlaceholder } from './types.js';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;
const PI_NODE = 7;
const COMMENT_NODE = 8;

/** XML の空白（NBSP などは含めない。訳文の中の NBSP を壊さないため） */
const WS = /[ \t\r\n]+/g;

// ---------------------------------------------------------------------------
// 対応表

/** 文を持つ要素のうち、名前だけで種類が決まるもの */
const ADMONITION_PARAS = new Set(['warningAndCautionPara', 'notePara', 'attentionListItemPara']);
const STEP_TEXT = new Set(['action', 'isolationStepQuestion', 'choice']);
const STEP_NAMES = new Set(['proceduralStep', 'isolationStep', 'isolationProcedureEnd']);
const PLAIN_PARAS = new Set(['para', 'simplePara', 'paraBasic', 'listItemTerm', 'reqCond']);
const TITLES = new Set(['title', 'pmEntryTitle', 'pmTitle', 'termTitle', 'definitionTitle']);
const CAPTION_PARENTS = new Set(['figure', 'table', 'foldout', 'multimedia']);

/** 文に含めず、そのまま残して中を辿る子要素（ブロック要素） */
const BLOCKS = new Set([
  'randomList',
  'sequentialList',
  'definitionList',
  'attentionRandomList',
  'attentionSequentialList',
  'table',
  'figure',
  'foldout',
  'multimedia',
  'warning',
  'caution',
  'note',
  'para',
  'simplePara',
  'paraBasic',
  'notePara',
  'warningAndCautionPara',
  'attentionListItemPara',
  'proceduralStep',
  'isolationStep',
  'levelledPara',
  'listItem',
  'entry',
]);

/** 辿らない要素（参照・図・適用性の式・変数など。文ではない） */
const SKIP = new Set([
  'refs',
  'dmRef',
  'pmRef',
  'externalPubRef',
  'internalRef',
  'referencedApplicGroup',
  'referencedApplicGroupRef',
  'applic',
  'variableDeclarations',
  'variablePreSet',
  'variablePostSet',
  'validate',
  'assertion',
  'graphic',
  'symbol',
  'hotspot',
  'warningRef',
  'cautionRef',
  'warningsAndCautionsRef',
  'colspec',
  'spanspec',
]);

/** 識別・状態部で辿る場所（名前の並び）。それ以外は文として読まない */
const STATUS_PATHS = new Set([
  'identAndStatusSection',
  'identAndStatusSection/dmAddress',
  'identAndStatusSection/dmAddress/dmAddressItems',
  'identAndStatusSection/dmAddress/dmAddressItems/dmTitle',
  'identAndStatusSection/dmAddress/dmAddressItems/dmTitle/techName',
  'identAndStatusSection/dmAddress/dmAddressItems/dmTitle/infoName',
  'identAndStatusSection/dmAddress/dmAddressItems/dmTitle/infoNameVariant',
  'identAndStatusSection/dmStatus',
  'identAndStatusSection/dmStatus/applic',
  'identAndStatusSection/dmStatus/applic/displayText',
  'identAndStatusSection/dmStatus/applic/displayText/simplePara',
]);

/** 文字を含み、プレースホルダーにすると中の文が訳されない書式・用語の要素（`notes` に数を出す） */
const TEXTY_INLINE = new Set([
  'emphasis',
  'acronym',
  'acronymTerm',
  'acronymDefinition',
  'subScript',
  'superScript',
  'verbatimText',
  'footnote',
  'inlineSignificantData',
]);

/** 同じ親の下に 1 つしかない要素（`id` に番号を付けない） */
const UNIQUE = new Set([
  'identAndStatusSection',
  'dmAddress',
  'dmAddressItems',
  'dmTitle',
  'techName',
  'infoName',
  'infoNameVariant',
  'dmStatus',
  'applic',
  'displayText',
  'description',
  'procedure',
  'mainProcedure',
  'preliminaryRqmts',
  'closeRqmts',
  'faultIsolation',
  'process',
  'isolationProcedure',
  'isolationMainProcedure',
  'tbody',
  'thead',
  'tfoot',
]);

/** `id` の短縮。値は重複しないこと（segments.test.ts で確かめる） */
export const ID_ABBREVIATIONS: Readonly<Record<string, string>> = {
  identAndStatusSection: 'ias',
  dmAddress: 'da',
  dmAddressItems: 'dai',
  dmTitle: 'dt',
  techName: 'tn',
  infoName: 'in',
  infoNameVariant: 'inv',
  dmStatus: 'ds',
  applic: 'ap',
  displayText: 'dx',
  description: 'd',
  procedure: 'pr',
  mainProcedure: 'mp',
  levelledPara: 'lp',
  proceduralStep: 'st',
  isolationStep: 'ist',
  isolationProcedureEnd: 'ipe',
  isolationProcedure: 'ip',
  isolationMainProcedure: 'imp',
  faultIsolation: 'fi',
  isolationStepAnswer: 'isa',
  yesNoAnswer: 'yna',
  listOfChoices: 'loc',
  choice: 'ch',
  isolationStepQuestion: 'isq',
  action: 'ac',
  para: 'p',
  simplePara: 'sp',
  paraBasic: 'pb',
  title: 'ti',
  pmEntryTitle: 'pet',
  pmEntry: 'pe',
  pmTitle: 'pt',
  warning: 'w',
  caution: 'c',
  note: 'n',
  warningAndCautionPara: 'wcp',
  notePara: 'np',
  attentionRandomList: 'arl',
  attentionRandomListItem: 'arli',
  attentionSequentialList: 'asl',
  attentionSequentialListItem: 'asli',
  attentionListItemPara: 'alp',
  randomList: 'rl',
  sequentialList: 'sl',
  listItem: 'li',
  definitionList: 'dl',
  definitionListItem: 'dli',
  definitionListHeader: 'dlh',
  listItemTerm: 'lit',
  listItemDefinition: 'lid',
  termTitle: 'tt',
  definitionTitle: 'dft',
  table: 'tb',
  tgroup: 'tg',
  thead: 'th',
  tbody: 'tbd',
  tfoot: 'tf',
  row: 'r',
  entry: 'e',
  figure: 'f',
  foldout: 'fo',
  captionLine: 'cl',
  caption: 'cp',
  preliminaryRqmts: 'prq',
  closeRqmts: 'crq',
  reqCondGroup: 'rcg',
  reqCondNoRef: 'rcn',
  reqCondDm: 'rcd',
  reqCondExternalPub: 'rce',
  reqCond: 'rc',
  commonInfo: 'ci',
  process: 'ps',
  dmNode: 'dn',
  dmSeq: 'dsq',
  dmIf: 'dif',
  dialog: 'dg',
  prompt: 'pmt',
};

// ---------------------------------------------------------------------------
// 結果の形

export interface RunPlaceholder extends SegmentPlaceholder {
  /** 元の節点（差し戻しのときに再利用する） */
  node: Node;
}

/** 文 1 つ分（要素のなかの、ブロック要素で区切られた文字の並び 1 つ） */
export interface Run {
  id: string;
  xpath: string;
  element: Element;
  category: SegmentCategory;
  context: string;
  text: string;
  placeholders: RunPlaceholder[];
  location: NodeLocation;
  /** この run を作っている節点（要素の子の連続した範囲） */
  nodes: Node[];
  /** run の直後のブロック要素。最後の run は null */
  anchor: Node | null;
}

// ---------------------------------------------------------------------------
// 補助

function elementChildren(el: Node): Element[] {
  return Array.from(el.childNodes).filter((n): n is Element => n.nodeType === ELEMENT_NODE);
}

function isBlank(s: string | null): boolean {
  return !s || s.replace(WS, '') === '';
}

function norm(s: string): string {
  return s.replace(WS, ' ').trim();
}

function hasDirectText(el: Element): boolean {
  return Array.from(el.childNodes).some(
    (n) => (n.nodeType === TEXT_NODE || n.nodeType === CDATA_NODE) && !isBlank(n.nodeValue),
  );
}

function escapeBraces(s: string): string {
  return s.replace(/\{/g, '{{').replace(/\}/g, '}}');
}

function parentElement(el: Node): Element | undefined {
  const p = el.parentNode;
  return p && p.nodeType === ELEMENT_NODE ? (p as Element) : undefined;
}

function hasAncestor(el: Element, name: string): boolean {
  for (let p = parentElement(el); p; p = parentElement(p)) if (p.nodeName === name) return true;
  return false;
}

/** 同じ名前の兄弟の中の位置（1 から）と、その数 */
function siblingIndex(el: Element): { idx: number; count: number } {
  const parent = el.parentNode;
  if (!parent) return { idx: 1, count: 1 };
  const same = elementChildren(parent).filter((c) => c.nodeName === el.nodeName);
  return { idx: same.indexOf(el) + 1, count: same.length };
}

function categoryOf(el: Element): SegmentCategory | undefined {
  const name = el.nodeName;
  const parent = parentElement(el)?.nodeName;
  if (name === 'techName' || name === 'infoName' || name === 'infoNameVariant') {
    return parent === 'dmTitle' ? 'title' : undefined;
  }
  if (TITLES.has(name)) {
    return name === 'title' && parent && CAPTION_PARENTS.has(parent) ? 'caption' : 'title';
  }
  if (name === 'captionLine') return 'caption';
  if (ADMONITION_PARAS.has(name)) return 'admonition';
  if (name === 'entry') return hasDirectText(el) ? 'table' : undefined;
  if (STEP_TEXT.has(name)) return 'step';
  if (PLAIN_PARAS.has(name)) {
    if (hasAncestor(el, 'entry')) return 'table';
    if (parent && STEP_NAMES.has(parent) && (name === 'para' || name === 'simplePara')) {
      return 'step';
    }
    return 'para';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// xpath・id・context

function pathSteps(
  el: Element,
  root: Element,
): Array<{ name: string; idx: number; count: number }> {
  const steps: Array<{ name: string; idx: number; count: number }> = [];
  for (let n: Element | undefined = el; n && n !== root; n = parentElement(n)) {
    steps.unshift({ name: n.nodeName, ...siblingIndex(n) });
  }
  return steps;
}

function makeXpath(steps: Array<{ name: string; idx: number }>): string {
  return steps.map((s) => `${s.name}[${s.idx}]`).join('/');
}

function makeId(steps: Array<{ name: string; idx: number; count: number }>): string {
  const parts = steps
    .filter((s, i) => !(i === 0 && s.name === 'content'))
    .map((s) => {
      const abbr = ID_ABBREVIATIONS[s.name] ?? s.name;
      return UNIQUE.has(s.name) && s.count === 1 ? abbr : `${abbr}${s.idx}`;
    });
  return parts.join('.');
}

function titleText(el: Element): string | undefined {
  const t = elementChildren(el).find(
    (c) => c.nodeName === 'title' || c.nodeName === 'pmEntryTitle',
  );
  if (!t) return undefined;
  const s = norm(t.textContent ?? '');
  if (!s) return undefined;
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

function stepNumber(step: Element): string {
  const parent = parentElement(step);
  const siblings = parent ? elementChildren(parent).filter((c) => STEP_NAMES.has(c.nodeName)) : [];
  const own = String(siblings.indexOf(step) + 1);
  for (let p = parent; p; p = parentElement(p)) {
    if (STEP_NAMES.has(p.nodeName)) return `${stepNumber(p)}.${own}`;
  }
  return own;
}

function cellLabel(entry: Element): string {
  const row = parentElement(entry);
  const col = row
    ? elementChildren(row)
        .filter((c) => c.nodeName === 'entry')
        .indexOf(entry) + 1
    : 0;
  let table: Element | undefined = row;
  while (table && table.nodeName !== 'table') table = parentElement(table);
  let r = 0;
  if (table && row) {
    const rows = Array.from(table.getElementsByTagName('row'));
    r = rows.indexOf(row) + 1;
  }
  return `cell r${r}c${col}`;
}

function makeContext(el: Element, root: Element): string {
  const first = pathSteps(el, root)[0]?.name;
  if (first === 'identAndStatusSection') {
    return el.nodeName === 'simplePara' ? 'applic displayText' : `dmTitle/${el.nodeName}`;
  }
  const chain: Element[] = [];
  for (let p = parentElement(el); p && p !== root; p = parentElement(p)) chain.unshift(p);
  const parts: string[] = [];
  for (const a of chain) {
    // 自分が title のときは、親の題名は文脈に入れない（自分自身になる）
    const skipTitle = el.nodeName === 'title' && a === parentElement(el);
    const t = skipTitle ? undefined : titleText(a);
    const name = a.nodeName;
    if (STEP_NAMES.has(name)) parts.push(`step ${stepNumber(a)}${t ? `: ${t}` : ''}`);
    else if (name === 'warning' || name === 'caution' || name === 'note') parts.push(name);
    else if (name === 'table' || name === 'figure') parts.push(t ? `${name}: ${t}` : name);
    else if (name === 'entry') parts.push(cellLabel(a));
    else if (t) parts.push(t);
    else if (skipTitle) parts.push(`${name} title`);
  }
  if (el.nodeName === 'entry') parts.push(cellLabel(el));
  if (parts.length === 0) parts.push(el.nodeName);
  return parts.join(' > ');
}

// ---------------------------------------------------------------------------
// run

function serializeNode(n: Node): string {
  return new XMLSerializer().serializeToString(n);
}

function buildRun(
  el: Element,
  root: Element,
  category: SegmentCategory,
  nodes: Node[],
  anchor: Node | null,
  runNo: number,
  ids: Set<string>,
): Run {
  const steps = pathSteps(el, root);
  let id = makeId(steps);
  if (runNo > 0) id += `~${runNo}`;
  // 起こらないはずだが、衝突したら番号を足して一意にする
  let unique = id;
  for (let n = 2; ids.has(unique); n++) unique = `${id}-${n}`;
  ids.add(unique);

  let s = '';
  const placeholders: RunPlaceholder[] = [];
  for (const n of nodes) {
    if (n.nodeType === TEXT_NODE || n.nodeType === CDATA_NODE) {
      s += escapeBraces(n.nodeValue ?? '');
    } else {
      const element =
        n.nodeType === ELEMENT_NODE
          ? n.nodeName
          : n.nodeType === COMMENT_NODE
            ? '#comment'
            : n.nodeType === PI_NODE
              ? '#processing-instruction'
              : '#node';
      const index = placeholders.length + 1;
      placeholders.push({ index, element, xml: serializeNode(n), node: n });
      s += `{${index}}`;
    }
  }
  return {
    id: unique,
    xpath: makeXpath(steps),
    element: el,
    category,
    context: makeContext(el, root),
    text: norm(s),
    placeholders,
    location: describeLocation(el),
    nodes,
    anchor,
  };
}

/** 文を持つ要素の子を、ブロック要素で区切って run にする。文字（または要素）を含む run だけ返す */
function runsOf(
  el: Element,
  root: Element,
  category: SegmentCategory,
  ids: Set<string>,
): { runs: Run[]; blocks: Element[] } {
  const runs: Run[] = [];
  const blocks: Element[] = [];
  let cur: Node[] = [];
  let runNo = 0;
  const flush = (anchor: Node | null) => {
    const hasContent = cur.some(
      (n) =>
        n.nodeType === ELEMENT_NODE ||
        ((n.nodeType === TEXT_NODE || n.nodeType === CDATA_NODE) && !isBlank(n.nodeValue)),
    );
    if (hasContent) runs.push(buildRun(el, root, category, cur, anchor, runNo, ids));
    cur = [];
    runNo++;
  };
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === ELEMENT_NODE && BLOCKS.has(n.nodeName)) {
      flush(n);
      blocks.push(n as Element);
    } else cur.push(n);
  }
  flush(null);
  return { runs, blocks };
}

/** 文書の対象の文をすべて集める（文書の順） */
export function collectRuns(document: Document): Run[] {
  const root = document.documentElement;
  if (!root) return [];
  const out: Run[] = [];
  const ids = new Set<string>();

  const walk = (el: Element, namePath: string) => {
    if (namePath.startsWith('identAndStatusSection')) {
      if (!STATUS_PATHS.has(namePath)) return;
    } else if (SKIP.has(el.nodeName)) return;

    const category = categoryOf(el);
    if (category) {
      const { runs, blocks } = runsOf(el, root, category, ids);
      out.push(...runs);
      for (const b of blocks) walk(b, `${namePath}/${b.nodeName}`);
      return;
    }
    for (const c of elementChildren(el)) walk(c, `${namePath}/${c.nodeName}`);
  };
  for (const c of elementChildren(root)) walk(c, c.nodeName);
  return out;
}

/** プレースホルダーにされた、文字を含む書式・用語の要素の数（`notes` 用） */
export function countTextyPlaceholders(runs: Run[]): number {
  let n = 0;
  for (const r of runs) {
    for (const p of r.placeholders) {
      if (TEXTY_INLINE.has(p.element) && !isBlank(p.node.textContent)) n++;
    }
  }
  return n;
}
