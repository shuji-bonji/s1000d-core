/**
 * 骨組みのハッシュ: すべての対象の文を空にした XML の SHA-256。
 *
 * 文の中身（訳す部分）以外が変わっていないことを、差し戻しの前に確かめるために使う。
 * - 空白だけの文字列の節点は取り除く（インデントの変更では変わらない）
 * - `include` や `maxSegments` に左右されない（常に全部の文を空にする）
 * - 文書要素より前（XML 宣言・DOCTYPE）は空白を 1 つにまとめて含める
 */
import { XMLSerializer } from '@xmldom/xmldom';
import { createHash } from 'node:crypto';
import { prologOf } from '../xml/serialize.js';
import type { Document, Node } from '../xml/index.js';
import { collectRuns } from './collect.js';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function dropBlankText(node: Node): void {
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType === TEXT_NODE) {
      if (/^[ \t\r\n]*$/.test(c.nodeValue ?? '')) node.removeChild(c);
    } else if (c.nodeType === ELEMENT_NODE) dropBlankText(c);
  }
}

/** 文書を読み直した直後のもの（この関数が書き換える）から骨組みのハッシュを計算する */
export function skeletonHashOfDocument(document: Document, original: string): string {
  const root = document.documentElement;
  if (!root) return createHash('sha256').update('').digest('hex');
  for (const run of collectRuns(document)) {
    for (const n of run.nodes) run.element.removeChild(n);
  }
  dropBlankText(root);
  const prolog = (prologOf(original) ?? '').replace(/\s+/g, ' ').trim();
  const body = new XMLSerializer().serializeToString(root);
  return createHash('sha256').update(prolog).update('\n').update(body).digest('hex');
}
