/**
 * proced（手順）の内容部: `content/procedure`（preliminaryRqmts → mainProcedure → closeRqmts）。
 *
 * 受け付ける kind: step（proceduralStep）・requirements・figure・table。
 * - `requirements` は本体（step・figure・table）より前なら前提条件、後なら事後条件。条件の文（text と子の para）を受け取る
 * - 前の `requirements` の子の admonition は、作業全体にかかる安全の要件（reqSafety/safetyRqmts の warning / caution / note）になる
 * - XSD が要求する preliminaryRqmts の残り（支援機材・消耗品・予備品。安全の要件が無ければ安全も）は「なし」で埋め、notes に書く
 * 読む側は content/read.ts の `proceduralStep → step`（番号は読み取り時に付く）。
 */
import type { Element } from '../../xml/engine.js';
import { DraftInputError } from '../errors.js';
import type { DraftNode } from '../types.js';
import type { Writer } from './common.js';

/** `content` 要素を組み立てる */
export function buildProced(w: Writer, body: DraftNode[]): Element {
  body.forEach((n, i) => w.checkKind(n, 'body', `/body[${i + 1}]`));
  const main = body
    .map((n, i) => ({ n, path: `/body[${i + 1}]` }))
    .filter((x) => x.n.kind !== 'requirements');
  if (!main.some((x) => x.n.kind === 'step')) {
    throw new DraftInputError(
      '/body',
      'a proced data module needs at least one "step" node in body',
    );
  }
  const req = w.splitRequirements(body, (n) => n.kind !== 'requirements');

  const procedure = w.el('procedure');
  procedure.appendChild(w.preliminaryRqmts(req.pre));
  const mainProcedure = w.el('mainProcedure');
  for (const { n, path } of main) {
    mainProcedure.appendChild(n.kind === 'step' ? w.proceduralStep(n, path) : w.ncp(n, path));
  }
  procedure.appendChild(mainProcedure);
  procedure.appendChild(w.closeRqmts(req.close));
  const content = w.el('content');
  content.appendChild(procedure);
  return content;
}
