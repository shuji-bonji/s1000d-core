/**
 * 元の XML の文字列の中で、要素 1 つが占める範囲（開始タグの `<` から、終了タグの `>` の次まで）を求める。
 *
 * 設計: s1000d-stack の docs/design/core-structural-edit.md「文字列の保ち方」、DECISIONS D-31。
 * `XMLSerializer` で文書要素の全体を直列化し直すと、触っていない開始タグの属性の改行なども変わる。
 * 構造を変える編集（`editContent`）は、ここで求めた範囲だけを元の文字列の上で書き換える。
 *
 * 方式:
 * - 文書要素の開始位置は `findRootStart`（XML 宣言・コメント・PI・DOCTYPE を読み飛ばす）で求める
 * - 文書要素の中は、開始タグ・終了タグ・空要素タグ・コメント・CDATA・PI だけを見分ける小さな走査で読む。
 *   属性の値は引用符の中を読み飛ばす（値の中の `>` をタグの終わりと取り違えない）
 * - DOM の要素との対応は、行・列ではなく「文書要素から数えた、子要素の番号の列」で取る。
 *   要素の名前が食い違ったら対応は無いものとして `undefined` を返す
 *
 * 実体参照が要素を展開する文書（内部サブセットの ENTITY に要素を書いたもの）では、文字列と DOM の要素の数が合わない。
 * そのときは名前か数の食い違いで `undefined` になる。
 */
import type { Element, Node } from './engine.js';
import { findRootStart } from './serialize.js';

const ELEMENT_NODE = 1;

/** 要素 1 つの、元の文字列の中の範囲 */
export interface ElementRange {
  /** 要素名（接頭辞があれば付いたまま） */
  name: string;
  /** 開始タグの `<` の位置 */
  start: number;
  /** 開始タグ（または空要素タグ）の `>` の次の位置 */
  openEnd: number;
  /** 終了タグの `<` の位置。空要素タグでは `openEnd` と同じ */
  closeStart: number;
  /** 終了タグ（または空要素タグ）の `>` の次の位置 */
  end: number;
  /** `<a/>` の形か */
  selfClosing: boolean;
  /** 子要素（文書の順） */
  children: ElementRange[];
}

const isNameChar = (ch: string) => /[^\s<>/=]/.test(ch);

/** 開始タグを `<` の位置から読む。タグの終わりが無ければ undefined */
function readStartTag(
  xml: string,
  at: number,
): { name: string; end: number; selfClosing: boolean } | undefined {
  const n = xml.length;
  let i = at + 1;
  const nameStart = i;
  while (i < n && isNameChar(xml[i]!)) i++;
  const name = xml.slice(nameStart, i);
  if (name === '') return undefined;
  let quote = '';
  for (; i < n; i++) {
    const ch = xml[i]!;
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') {
      return { name, end: i + 1, selfClosing: xml[i - 1] === '/' };
    } else if (ch === '<') return undefined;
  }
  return undefined;
}

/**
 * 文書要素とその子孫の範囲を求める。整形式でないなど、最後まで読めなければ undefined。
 */
export function scanElementRanges(xml: string): ElementRange | undefined {
  const rootStart = findRootStart(xml);
  if (rootStart < 0) return undefined;
  const n = xml.length;
  const stack: ElementRange[] = [];
  let root: ElementRange | undefined;
  let i = rootStart;
  while (i < n) {
    if (xml[i] !== '<') {
      const next = xml.indexOf('<', i);
      if (next < 0) break;
      i = next;
      continue;
    }
    if (xml.startsWith('<!--', i)) {
      const e = xml.indexOf('-->', i + 4);
      if (e < 0) return undefined;
      i = e + 3;
    } else if (xml.startsWith('<![CDATA[', i)) {
      const e = xml.indexOf(']]>', i + 9);
      if (e < 0) return undefined;
      i = e + 3;
    } else if (xml.startsWith('<?', i)) {
      const e = xml.indexOf('?>', i + 2);
      if (e < 0) return undefined;
      i = e + 2;
    } else if (xml.startsWith('</', i)) {
      const e = xml.indexOf('>', i + 2);
      const top = stack.pop();
      if (e < 0 || !top) return undefined;
      if (xml.slice(i + 2, e).trim() !== top.name) return undefined;
      top.closeStart = i;
      top.end = e + 1;
      i = e + 1;
      if (stack.length === 0) return root;
    } else {
      const tag = readStartTag(xml, i);
      if (!tag) return undefined;
      const range: ElementRange = {
        name: tag.name,
        start: i,
        openEnd: tag.end,
        closeStart: tag.end,
        end: tag.end,
        selfClosing: tag.selfClosing,
        children: [],
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(range);
      else if (root) return undefined;
      else root = range;
      if (!tag.selfClosing) stack.push(range);
      else if (stack.length === 0) return root;
      i = tag.end;
    }
  }
  return undefined;
}

const elementChildren = (node: Node): Element[] =>
  Array.from(node.childNodes).filter((c) => c.nodeType === ELEMENT_NODE) as unknown as Element[];

/**
 * DOM の要素に対応する範囲を返す。`root` は `scanElementRanges` の結果、`element` は同じ文字列を読んだ文書の要素。
 * 途中で要素名か子要素の数が食い違ったら undefined。
 */
export function rangeOfElement(root: ElementRange, element: Element): ElementRange | undefined {
  const chain: Element[] = [];
  let n: Node | null = element;
  while (n && n.nodeType === ELEMENT_NODE) {
    chain.unshift(n as unknown as Element);
    n = n.parentNode;
  }
  let range = root;
  if (chain[0]?.nodeName !== range.name) return undefined;
  for (let d = 1; d < chain.length; d++) {
    const siblings = elementChildren(chain[d - 1]!);
    if (siblings.length !== range.children.length) return undefined;
    const next = range.children[siblings.indexOf(chain[d]!)];
    if (!next || next.name !== chain[d]!.nodeName) return undefined;
    range = next;
  }
  return range;
}

/** 範囲の木と DOM の木で、要素の名前と数がすべて合っているか（配布物のテストと、編集の前の確認に使う） */
export function rangesMatchDocument(root: ElementRange, documentElement: Element): boolean {
  const walk = (range: ElementRange, el: Element): boolean => {
    if (range.name !== el.nodeName) return false;
    const kids = elementChildren(el);
    if (kids.length !== range.children.length) return false;
    return kids.every((k, i) => walk(range.children[i]!, k));
  };
  return walk(root, documentElement);
}

// ---- 開始タグの中の属性 ----

/** 開始タグの中の属性 1 つの範囲 */
export interface AttributeRange {
  /** 属性名（接頭辞があれば付いたまま） */
  name: string;
  /** 属性の前の空白の先頭の位置（属性を取り除くときは、ここから `end` までを取り除く） */
  start: number;
  /** 属性名の先頭の位置 */
  nameStart: number;
  /** 値の先頭（引用符の次）の位置 */
  valueStart: number;
  /** 値の末尾（閉じる引用符）の位置 */
  valueEnd: number;
  /** 閉じる引用符の次の位置 */
  end: number;
}

/** 要素の開始タグの中の属性を、書かれている順に返す */
export function scanAttributes(xml: string, range: ElementRange): AttributeRange[] {
  const out: AttributeRange[] = [];
  let i = range.start + 1 + range.name.length;
  const limit = range.openEnd;
  while (i < limit) {
    const start = i;
    while (i < limit && /\s/.test(xml[i]!)) i++;
    const nameStart = i;
    while (i < limit && /[^\s=/>]/.test(xml[i]!)) i++;
    if (i === nameStart) break;
    const name = xml.slice(nameStart, i);
    while (i < limit && /\s/.test(xml[i]!)) i++;
    if (xml[i] !== '=') break;
    i++;
    while (i < limit && /\s/.test(xml[i]!)) i++;
    const quote = xml[i];
    if (quote !== '"' && quote !== "'") break;
    const valueStart = i + 1;
    const valueEnd = xml.indexOf(quote, valueStart);
    if (valueEnd < 0 || valueEnd >= limit) break;
    i = valueEnd + 1;
    out.push({ name, start, nameStart, valueStart, valueEnd, end: i });
  }
  return out;
}

/** 開始タグの末尾（`>` か `/>`）の前で、属性を書き足す位置。末尾の前の空白は残す */
export function attributeInsertPosition(xml: string, range: ElementRange): number {
  const attrs = scanAttributes(xml, range);
  const last = attrs[attrs.length - 1];
  return last ? last.end : range.start + 1 + range.name.length;
}

/** 属性の値を、二重引用符で囲む値として書く */
export function escapeAttributeValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** 文字列への操作 1 つ。`pos` から `del` 文字を取り除き、`ins` を入れる */
export interface TextSplice {
  pos: number;
  del: number;
  ins: string;
}

/**
 * 属性 1 つを書く操作を返す。属性があれば値だけを書き換え（引用符の種類に合わせて書く）、無ければ最後の属性の後ろに足す。
 * 同じ開始タグに続けて足すときは、呼んだ順に並ぶ（操作を位置の順・渡した順に適用する前提）。
 */
export function setAttributeSplice(
  xml: string,
  range: ElementRange,
  name: string,
  value: string,
): TextSplice {
  const existing = scanAttributes(xml, range).find((a) => a.name === name);
  if (existing) {
    const quote = xml[existing.valueStart - 1];
    const escaped =
      quote === "'"
        ? value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&apos;')
        : escapeAttributeValue(value);
    return {
      pos: existing.valueStart,
      del: existing.valueEnd - existing.valueStart,
      ins: escaped,
    };
  }
  return {
    pos: attributeInsertPosition(xml, range),
    del: 0,
    ins: ` ${name}="${escapeAttributeValue(value)}"`,
  };
}

/** 属性 1 つを、前の空白ごと取り除く操作を返す。属性が無ければ undefined */
export function removeAttributeSplice(
  xml: string,
  range: ElementRange,
  name: string,
): TextSplice | undefined {
  const existing = scanAttributes(xml, range).find((a) => a.name === name);
  return existing
    ? { pos: existing.start, del: existing.end - existing.start, ins: '' }
    : undefined;
}
