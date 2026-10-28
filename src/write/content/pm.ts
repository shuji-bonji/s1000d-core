/**
 * pm（パブリケーションモジュール）の内容部: `content/pmEntry`。
 *
 * 受け付ける kind: section（pmEntry、title が pmEntryTitle）と entry（dmRef か pmRef を 1 つ）。
 * 最上位に entry だけがあるときは、題名の無い pmEntry 1 つにまとめる（XSD は content の直下に pmEntry を要求する）。
 * 読む側は content/read.ts の `pmEntry → section`、その中の dmRef・pmRef → entry。
 */
import type { Element } from '../../xml/engine.js';
import { DraftInputError } from '../errors.js';
import type { DraftNode } from '../types.js';
import type { Writer } from './common.js';

function entry(w: Writer, node: DraftNode, path: string): Element {
  const refs = node.refs ?? [];
  if (refs.length !== 1 || (refs[0].kind !== 'dmRef' && refs[0].kind !== 'pmRef')) {
    throw new DraftInputError(path, 'an "entry" node needs exactly one dmRef or pmRef in refs');
  }
  return w.inlineRef(refs[0], `${path}/refs[1]`);
}

function pmEntry(w: Writer, node: DraftNode, path: string): Element {
  const e = w.common(w.el('pmEntry'), node);
  if (node.title !== undefined) e.appendChild(w.textEl('pmEntryTitle', node.title));
  const kids = w.childrenOf(node, 'section', path);
  if (kids.length === 0) {
    throw new DraftInputError(
      path,
      'a "section" node in a pm needs at least one child (section or entry)',
    );
  }
  kids.forEach((c, i) => {
    const cp = `${path}/children[${i + 1}]`;
    e.appendChild(c.kind === 'section' ? pmEntry(w, c, cp) : entry(w, c, cp));
  });
  return e;
}

/** `content` 要素を組み立てる */
export function buildPm(w: Writer, body: DraftNode[]): Element {
  if (body.length === 0) {
    throw new DraftInputError('/body', 'a pm data module needs at least one node in body');
  }
  const content = w.el('content');
  let loose: Element | undefined;
  body.forEach((n, i) => {
    const path = `/body[${i + 1}]`;
    w.checkKind(n, 'body', path);
    if (n.kind === 'section') {
      loose = undefined;
      content.appendChild(pmEntry(w, n, path));
    } else {
      if (!loose) {
        loose = w.el('pmEntry');
        content.appendChild(loose);
      }
      loose.appendChild(entry(w, n, path));
    }
  });
  return content;
}
