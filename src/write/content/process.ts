/**
 * process（画面遷移などの処理の流れ）の内容部: `content/process`（variableDeclarations → dmSeq）。
 *
 * 受け付ける kind:
 * - sequence（dmSeq）: 最上位に 1 つだけ置くか、省略して section・if を最上位に並べる（暗黙の dmSeq に入れる）
 * - section（dmNode）: step・figure・table、最後に dialog を 1 つ。または `refs` に dmRef を 1 つだけ（他の DM を呼ぶ節）
 * - if（dmIf）: `id`（真偽値の変数名）と `question`（条件を人が読める文にしたもの）が要る。
 *   子の sequence 1 つ目が dmThenSeq、2 つ目（あれば）が dmElseSeq
 * - dialog: `id`（変数名）と `text`（問い）が要る。`choices` があれば選択（menu、選んだ文を変数に入れる）、無ければ文字入力
 * - step（proceduralStep）は section の中に置く
 * 変数（dialog の文字列、if の真偽値）は variableDeclarations に宣言する。条件の中身は組み立てない
 * （`if` は変数 1 つを参照するだけで、`question` を humanReadableForm に入れる）。
 * 読む側は content/read.ts の `dmSeq → sequence`・`dmNode → section`・`dmIf → if`・`dialog → dialog`。
 */
import type { Element } from '../../xml/engine.js';
import { DraftInputError } from '../errors.js';
import type { DraftNode } from '../types.js';
import type { Writer } from './common.js';

function declare(w: Writer, name: string, type: 'string' | 'boolean', path: string): void {
  if (w.variables.has(name)) {
    throw new DraftInputError(
      path,
      `variable name "${name}" is used more than once (dialog and if ids are variable names)`,
    );
  }
  w.variables.set(name, type);
}

/** prompt（paraBasic に文を入れる） */
function prompt(w: Writer, text: string): Element {
  const p = w.el('prompt');
  p.appendChild(w.textEl('paraBasic', text));
  return p;
}

function dialog(w: Writer, node: DraftNode, path: string): Element {
  if (node.id === undefined || node.text === undefined) {
    throw new DraftInputError(
      path,
      'a "dialog" node needs id (the variable name) and text (the prompt)',
    );
  }
  declare(w, node.id, 'string', path);
  const e = w.common(w.el('dialog'), node);
  if (node.title !== undefined) e.appendChild(w.textEl('title', node.title));
  const variableRef = () => w.el('variableRef', { variableName: node.id });
  if (node.choices && node.choices.length > 0) {
    const menu = w.el('menu', { choiceSelection: 'single', choiceType: 'select' });
    menu.appendChild(prompt(w, node.text));
    for (const c of node.choices) {
      const mc = w.el('menuChoice');
      mc.appendChild(prompt(w, c.text));
      const assertion = w.el('assertion');
      assertion.appendChild(variableRef());
      const expr = w.el('expression');
      expr.appendChild(w.textEl('stringValue', c.text));
      assertion.appendChild(expr);
      mc.appendChild(assertion);
      menu.appendChild(mc);
    }
    e.appendChild(menu);
  } else {
    const entry = w.el('userEntry');
    entry.appendChild(prompt(w, node.text));
    entry.appendChild(variableRef());
    e.appendChild(entry);
  }
  return e;
}

function dmNode(w: Writer, node: DraftNode, path: string): Element {
  const e = w.common(w.el('dmNode'), node);
  if (node.title !== undefined) e.appendChild(w.textEl('title', node.title));
  const refs = node.refs ?? [];
  const kids = w.childrenOf(node, 'section', path);
  if (refs.length > 0) {
    if (refs.length !== 1 || refs[0].kind !== 'dmRef' || kids.length > 0) {
      throw new DraftInputError(
        path,
        'a "section" node in a process takes either one dmRef in refs (and no children) or child nodes',
      );
    }
    e.appendChild(w.inlineRef(refs[0], `${path}/refs[1]`));
    return e;
  }
  if (kids.length === 0) {
    throw new DraftInputError(
      path,
      'a "section" node in a process needs child nodes or one dmRef in refs',
    );
  }
  kids.forEach((c, i) => {
    const cp = `${path}/children[${i + 1}]`;
    if (c.kind === 'dialog') {
      if (i !== kids.length - 1) {
        throw new DraftInputError(cp, 'a "dialog" node must be the last child of a "section"');
      }
      e.appendChild(dialog(w, c, cp));
    } else if (c.kind === 'step') e.appendChild(w.proceduralStep(c, cp));
    else e.appendChild(w.ncp(c, cp));
  });
  return e;
}

/** dmSeq / dmThenSeq / dmElseSeq の中身（section と if） */
function seqChildren(w: Writer, parent: Element, kids: DraftNode[], path: string): void {
  kids.forEach((c, i) => {
    const cp = `${path}/children[${i + 1}]`;
    parent.appendChild(c.kind === 'if' ? dmIf(w, c, cp) : dmNode(w, c, cp));
  });
}

function sequence(w: Writer, node: DraftNode, path: string, name: string): Element {
  const e = w.common(w.el(name), node);
  const kids = w.childrenOf(node, 'sequence', path);
  if (kids.length === 0)
    throw new DraftInputError(path, 'a "sequence" node needs at least one child');
  seqChildren(w, e, kids, path);
  return e;
}

function dmIf(w: Writer, node: DraftNode, path: string): Element {
  if (node.id === undefined || node.question === undefined) {
    throw new DraftInputError(
      path,
      'an "if" node needs id (the name of a boolean variable) and question (the condition as a sentence)',
    );
  }
  const kids = w.childrenOf(node, 'if', path);
  if (kids.length < 1 || kids.length > 2) {
    throw new DraftInputError(
      path,
      'an "if" node needs one or two "sequence" children (then, else)',
    );
  }
  declare(w, node.id, 'boolean', path);
  const e = w.common(w.el('dmIf'), node);
  const expr = w.el('expression', { humanReadableForm: node.question });
  expr.appendChild(w.el('variableRef', { variableName: node.id }));
  e.appendChild(expr);
  e.appendChild(sequence(w, kids[0], `${path}/children[1]`, 'dmThenSeq'));
  if (kids[1]) e.appendChild(sequence(w, kids[1], `${path}/children[2]`, 'dmElseSeq'));
  return e;
}

/** `content` 要素を組み立てる */
export function buildProcess(w: Writer, body: DraftNode[]): Element {
  if (body.length === 0) {
    throw new DraftInputError('/body', 'a process data module needs at least one node in body');
  }
  body.forEach((n, i) => w.checkKind(n, 'body', `/body[${i + 1}]`));
  let dmSeq: Element;
  if (body.some((n) => n.kind === 'sequence')) {
    if (body.length !== 1) {
      throw new DraftInputError(
        '/body',
        'a top-level "sequence" node must be the only node in body',
      );
    }
    dmSeq = sequence(w, body[0], '/body[1]', 'dmSeq');
  } else {
    dmSeq = w.el('dmSeq');
    body.forEach((n, i) => {
      const path = `/body[${i + 1}]`;
      dmSeq.appendChild(n.kind === 'if' ? dmIf(w, n, path) : dmNode(w, n, path));
    });
  }
  const process = w.el('process');
  if (w.variables.size > 0) {
    const decls = w.el('variableDeclarations');
    for (const [name, type] of w.variables) {
      decls.appendChild(w.el('variable', { valueType: type, variableName: name }));
    }
    process.appendChild(decls);
  }
  process.appendChild(dmSeq);
  const content = w.el('content');
  content.appendChild(process);
  return content;
}
