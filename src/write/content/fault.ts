/**
 * fault（故障の探求）の内容部: `content/faultIsolation/faultIsolationProcedure/isolationProcedure`
 * （preliminaryRqmts → isolationMainProcedure → closeRqmts）。
 *
 * 受け付ける kind: step・requirements・figure・table。
 * - step は `id` が要る。`question` があれば isolationStep（`choices` が要り、各 `next` は同じ DM の step の id）、
 *   無ければ isolationProcedureEnd（`text` が要る）。手順は入れ子にせず、`next` でつなぐ
 * - step の `text` と para の子は action になる。警告・注意は先頭、注記・図・表は入力の順
 * - 前提・事後条件と「なし」で埋める要素は proced と同じ
 * 読む側は content/read.ts の `isolationStep`・`isolationProcedureEnd` → step（question・choices）。
 */
import type { Element } from '../../xml/engine.js';
import { DraftInputError } from '../errors.js';
import type { DraftNode } from '../types.js';
import type { Writer } from './common.js';

function faultStep(w: Writer, node: DraftNode, path: string, stepIds: Set<string>): Element {
  if (node.id === undefined) {
    throw new DraftInputError(
      path,
      'a "step" node in a fault data module needs id (steps are linked by id)',
    );
  }
  const hasText = node.text !== undefined || (node.refs?.length ?? 0) > 0;
  const hasQuestion = node.question !== undefined;
  if (hasQuestion) {
    if (!node.choices || node.choices.length === 0) {
      throw new DraftInputError(path, 'a "step" node with question needs choices');
    }
  } else {
    if (node.choices && node.choices.length > 0) {
      throw new DraftInputError(path, 'choices need a question');
    }
    if (!hasText) {
      throw new DraftInputError(
        path,
        'a "step" node in a fault data module needs question or text',
      );
    }
  }
  node.choices?.forEach((c, i) => {
    const cp = `${path}/choices[${i + 1}]`;
    if (c.next === undefined) {
      throw new DraftInputError(
        cp,
        'a choice in a fault data module needs next (the id of a step)',
      );
    }
    if (!stepIds.has(c.next)) {
      throw new DraftInputError(cp, `next "${c.next}" is not the id of a step in this data module`);
    }
  });

  const e = w.common(w.el(hasQuestion ? 'isolationStep' : 'isolationProcedureEnd'), node);
  const kids = w.childrenOf(node, 'step', path);
  const p = w.partition(kids, path, 'step');
  const at = (i: number) => `${path}/children[${i + 1}]`;
  if (node.title !== undefined) e.appendChild(w.textEl('title', node.title));
  for (const i of p.warnings) e.appendChild(w.admonition(kids[i], at(i)));
  for (const i of p.cautions) e.appendChild(w.admonition(kids[i], at(i)));
  if (hasText) {
    e.appendChild(w.textBlock('action', { kind: 'para', text: node.text, refs: node.refs }, path));
  }
  for (const i of p.blocks) {
    const c = kids[i];
    if (c.kind === 'para') {
      w.childrenOf(c, 'para', at(i));
      e.appendChild(w.textBlock('action', c, at(i)));
    } else e.appendChild(w.ncp(c, at(i)));
  }
  if (hasQuestion) {
    e.appendChild(w.textEl('isolationStepQuestion', node.question!));
    const answer = w.el('isolationStepAnswer');
    const choices = w.el('listOfChoices');
    for (const c of node.choices!) {
      choices.appendChild(w.textEl('choice', c.text, { nextActionRefId: c.next }));
    }
    answer.appendChild(choices);
    e.appendChild(answer);
  }
  return e;
}

/** `content` 要素を組み立てる */
export function buildFault(w: Writer, body: DraftNode[]): Element {
  body.forEach((n, i) => w.checkKind(n, 'body', `/body[${i + 1}]`));
  const main = body
    .map((n, i) => ({ n, path: `/body[${i + 1}]` }))
    .filter((x) => x.n.kind !== 'requirements');
  if (!main.some((x) => x.n.kind === 'step')) {
    throw new DraftInputError(
      '/body',
      'a fault data module needs at least one "step" node in body',
    );
  }
  const stepIds = new Set(main.filter((x) => x.n.kind === 'step' && x.n.id).map((x) => x.n.id!));
  const req = w.splitRequirements(body, (n) => n.kind !== 'requirements');

  const procedure = w.el('isolationProcedure');
  procedure.appendChild(w.preliminaryRqmts(req.pre));
  const mainProcedure = w.el('isolationMainProcedure');
  for (const { n, path } of main) {
    mainProcedure.appendChild(n.kind === 'step' ? faultStep(w, n, path, stepIds) : w.ncp(n, path));
  }
  procedure.appendChild(mainProcedure);
  procedure.appendChild(w.closeRqmts(req.close));
  const fip = w.el('faultIsolationProcedure');
  fip.appendChild(procedure);
  const fi = w.el('faultIsolation');
  fi.appendChild(fip);
  const content = w.el('content');
  content.appendChild(fi);
  return content;
}
