/**
 * 内容部の組み立ての入口。`DraftNode` の木から、種類ごとの `content` 要素の DOM を作る。
 * reader の `readContent`（content/read.ts）と対になる。読んで書き戻すと同じ木になる（往復のテストで固定）。
 */
import type { Element } from '../../xml/engine.js';
import { DraftInputError } from '../errors.js';
import type { DraftKind, DraftNode } from '../types.js';
import { Writer, type BuildContentContext } from './common.js';
import { buildDescript } from './descript.js';
import { buildFault } from './fault.js';
import { buildPm } from './pm.js';
import { buildProced } from './proced.js';
import { buildProcess } from './process.js';

export { ALLOWED, type AssetUse, type BuildContentContext } from './common.js';

/**
 * `DraftNode` の木から `content` 要素を組み立てる。要素は `ctx.document`（省略時は新しい文書）のもの。
 * kind ごとに受け付ける `DraftNode.kind` を固定し、合わないものは `DraftInputError`（XPath 風の位置付き）を投げる。
 *
 * @throws DraftInputError 置けない kind、足りない必須プロパティ、存在しない参照先 id など
 */
export function buildContent(
  kind: DraftKind,
  body: DraftNode[],
  ctx: BuildContentContext = {},
): Element {
  const w = new Writer(kind, ctx, body);
  switch (kind) {
    case 'descript':
      return buildDescript(w, body);
    case 'proced':
      return buildProced(w, body);
    case 'process':
      return buildProcess(w, body);
    case 'fault':
      return buildFault(w, body);
    case 'pm':
      return buildPm(w, body);
    default:
      throw new DraftInputError('/kind', `unknown data module kind "${String(kind)}"`);
  }
}
