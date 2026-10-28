/**
 * descript（概念の説明）の内容部: `content/description`。
 *
 * 受け付ける kind: para・admonition・section（levelledPara）・figure・table・list。
 * section の中は 見出し → 警告 → 注意 → 本文（入力の順）→ 入れ子の section の順に並べる。
 * 読む側は content/read.ts の `levelledPara → section`、`para → para`、`warning` など → `admonition`。
 */
import type { Element } from '../../xml/engine.js';
import { DraftInputError } from '../errors.js';
import type { DraftNode } from '../types.js';
import type { Writer } from './common.js';

/** levelledPara 1 つ。見出し → 警告 → 注意 → 本文 → 入れ子の levelledPara */
function section(w: Writer, node: DraftNode, path: string): Element {
  const e = w.common(w.el('levelledPara'), node);
  const kids = w.childrenOf(node, 'section', path);
  const p = w.partition(kids, path, 'section');
  const at = (i: number) => `${path}/children[${i + 1}]`;
  if (node.title !== undefined) e.appendChild(w.textEl('title', node.title));
  for (const i of p.warnings) e.appendChild(w.admonition(kids[i], at(i)));
  for (const i of p.cautions) e.appendChild(w.admonition(kids[i], at(i)));
  for (const i of p.blocks) e.appendChild(w.ncp(kids[i], at(i)));
  for (const i of p.nested) e.appendChild(section(w, kids[i], at(i)));
  return e;
}

/** `content` 要素を組み立てる */
export function buildDescript(w: Writer, body: DraftNode[]): Element {
  if (body.length === 0) {
    throw new DraftInputError('/body', 'a descript data module needs at least one node in body');
  }
  const content = w.el('content');
  const description = w.el('description');
  body.forEach((n, i) => {
    const path = `/body[${i + 1}]`;
    w.checkKind(n, 'body', path);
    description.appendChild(n.kind === 'section' ? section(w, n, path) : w.ncp(n, path));
  });
  content.appendChild(description);
  return content;
}
