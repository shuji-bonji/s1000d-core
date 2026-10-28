/**
 * 本文の概要（outline）と大きさ。
 *
 * LLM が全文を読む前に当たりを付けられるように、見出し・手順の番号・最初の 1 文・警告の数だけを返す
 * （design/agent-platform.md「LLM 活用時の注意点」の「概要モード」）。節点ごとの大きさ（節点数・文字数）も返し、
 * LLM 側が読む量の予算を立てられるようにする。
 */
import type { ContentNode, ContentNodeKind, ContentSize, OutlineNode } from './types.js';

export interface OutlineOptions {
  /** 概要の節点として残す種類。既定は section / step / requirements / sequence / if / dialog / entry */
  keep?: ContentNodeKind[];
  /** 最初の 1 文の最大文字数。既定 120 */
  maxSentenceLength?: number;
  /** 残す深さ（1 = 最上位だけ）。省略時は制限しない */
  maxDepth?: number;
}

const DEFAULT_KEEP: ContentNodeKind[] = [
  'section',
  'step',
  'requirements',
  'sequence',
  'if',
  'dialog',
  'entry',
];

function emptySize(): ContentSize {
  return { nodes: 0, chars: 0, byKind: {}, admonitions: { warning: 0, caution: 0, note: 0 } };
}

function addSize(into: ContentSize, from: ContentSize): void {
  into.nodes += from.nodes;
  into.chars += from.chars;
  for (const [k, v] of Object.entries(from.byKind) as Array<[ContentNodeKind, number]>)
    into.byKind[k] = (into.byKind[k] ?? 0) + v;
  into.admonitions.warning += from.admonitions.warning;
  into.admonitions.caution += from.admonitions.caution;
  into.admonitions.note += from.admonitions.note;
}

function ownChars(n: ContentNode): number {
  let c = (n.title?.length ?? 0) + (n.text?.length ?? 0) + (n.question?.length ?? 0);
  if (n.rows) for (const row of n.rows) for (const cell of row) c += cell.length;
  if (n.choices) for (const ch of n.choices) c += ch.text.length;
  return c;
}

/** 1 つの節点を含む部分木の大きさ */
export function measureContent(nodes: ContentNode[]): ContentSize {
  const total = emptySize();
  for (const n of nodes) addSize(total, measureNode(n));
  return total;
}

function measureNode(n: ContentNode): ContentSize {
  const size = emptySize();
  size.nodes = 1;
  size.chars = ownChars(n);
  size.byKind[n.kind] = 1;
  if (n.kind === 'admonition' && n.level) size.admonitions[n.level] += 1;
  for (const c of n.children) addSize(size, measureNode(c));
  return size;
}

/** 文の最初の 1 文。句点（。．.!?）か改行で切り、長ければ切り詰めて … を付ける */
export function firstSentence(text: string | undefined, max = 120): string | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  const m = /^(.*?[。．！？]|.*?[.!?](?=\s|$))/.exec(t);
  let s = m ? m[1]! : t;
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

function outlineNode(
  n: ContentNode,
  keep: Set<ContentNodeKind>,
  opts: Required<Pick<OutlineOptions, 'maxSentenceLength'>> & { maxDepth?: number },
  depth: number,
): OutlineNode | undefined {
  const size = measureNode(n);
  if (!keep.has(n.kind)) return undefined;
  const out: OutlineNode = {
    kind: n.kind,
    element: n.element,
    size,
    location: n.location,
    children: [],
  };
  if (n.id) out.id = n.id;
  if (n.title) out.title = n.title;
  if (n.number) out.number = n.number;
  if (n.level) out.level = n.level;
  if (n.applicRefId) out.applicRefId = n.applicRefId;
  if (n.securityClassification) out.securityClassification = n.securityClassification;
  const sentence = firstSentence(n.text ?? n.question ?? firstParaText(n), opts.maxSentenceLength);
  if (sentence) out.firstSentence = sentence;
  if (opts.maxDepth === undefined || depth < opts.maxDepth) {
    for (const c of n.children) {
      const o = outlineNode(c, keep, opts, depth + 1);
      if (o) out.children.push(o);
    }
  }
  return out;
}

/** 節点自身に文が無いとき（levelledPara など）、最初の段落の文を代わりに使う */
function firstParaText(n: ContentNode): string | undefined {
  for (const c of n.children) {
    if (c.kind === 'para' && c.text) return c.text;
    if (c.kind === 'section' || c.kind === 'step') return undefined;
  }
  return undefined;
}

/**
 * 本文の木を概要にする。残す種類以外（段落・リスト・表・図・警告）は節点にせず、親の `size` に数えるだけにする。
 * 最上位に残す種類の節点が無いとき（段落だけの説明 DM など）は、最上位の段落を 1 つの `para` として残す
 */
export function outlineContent(nodes: ContentNode[], options: OutlineOptions = {}): OutlineNode[] {
  const keep = new Set<ContentNodeKind>(options.keep ?? DEFAULT_KEEP);
  const opts = { maxSentenceLength: options.maxSentenceLength ?? 120, maxDepth: options.maxDepth };
  const out: OutlineNode[] = [];
  for (const n of nodes) {
    const o = outlineNode(n, keep, opts, 1);
    if (o) out.push(o);
  }
  if (out.length === 0 && nodes.length > 0) {
    const first = nodes.find((n) => n.text) ?? nodes[0]!;
    out.push({
      kind: first.kind,
      element: first.element,
      size: measureContent(nodes),
      location: first.location,
      firstSentence: firstSentence(first.text, opts.maxSentenceLength),
      children: [],
    });
  }
  return out;
}
