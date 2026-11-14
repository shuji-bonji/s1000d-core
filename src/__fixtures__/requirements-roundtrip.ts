/**
 * preliminaryRqmts を「読んで、書いて、失われるものを数える」ための道具（テスト用。配布物には入れない）。
 *
 * reader（readContent）が返した `requirements` の節点を、writer の下書き（DraftNode）に写して組み立て直し、
 * 元の preliminaryRqmts と、組み立て直した preliminaryRqmts の要素・属性の数を比べる。
 * 数が減ったものが、いまの core では往復できない構造である（読めない、下書きで表せない、書けない、のどれか）。
 * 値（文の中身）は比べない。構造が残るかだけを見る。
 */
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { readContentFromXml } from '../content/index.js';
import type { ContentNode } from '../content/types.js';
import { buildContent } from '../write/content/index.js';
import type { DraftNode } from '../write/types.js';

export interface RequirementsRoundTrip {
  /** 元の preliminaryRqmts の要素（`name`）と属性（`name/@attr`）の数 */
  original: Record<string, number>;
  /** 組み立て直した後に減った数 */
  lost: Record<string, number>;
  /** 下書きに写せなかった・組み立てられなかった節点（種類と理由） */
  dropped: string[];
}

function inventory(xml: string): Record<string, number> {
  const out: Record<string, number> = {};
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const walk = (n: { nodeType: number; nodeName: string; childNodes: ArrayLike<unknown> }) => {
    if (n.nodeType !== 1) return;
    const e = n as unknown as {
      nodeName: string;
      attributes: ArrayLike<{ name: string }>;
      childNodes: ArrayLike<never>;
    };
    out[e.nodeName] = (out[e.nodeName] ?? 0) + 1;
    for (const a of Array.from(e.attributes)) {
      const k = `${e.nodeName}/@${a.name}`;
      out[k] = (out[k] ?? 0) + 1;
    }
    for (const c of Array.from(e.childNodes)) walk(c);
  };
  walk(doc.documentElement as never);
  return out;
}

const fragment = (xml: string) => /<preliminaryRqmts[\s\S]*?<\/preliminaryRqmts>/.exec(xml)?.[0];

/** reader の節点を下書きに写す。写せないものは undefined と理由 */
function toDraft(n: ContentNode): { node?: DraftNode; reason?: string } {
  const id = n.id ? { id: n.id } : {};
  switch (n.kind) {
    case 'para':
      // 下書きの条件は文だけ（参照は受け取らない）
      return n.text ? { node: { kind: 'para', text: n.text } } : { reason: 'para without text' };
    case 'person':
      return n.text !== undefined || n.count !== undefined
        ? {
            node: {
              kind: 'person',
              ...(n.text !== undefined ? { text: n.text } : {}),
              ...(n.count !== undefined ? { count: n.count } : {}),
            },
          }
        : { reason: 'person without trade or numRequired' };
    case 'document': {
      const r = n.refs?.[0];
      if (r && (r.kind === 'dmRef' || r.kind === 'pmRef'))
        return {
          node: { kind: 'document', refs: [{ kind: r.kind, target: r.target, title: r.title }] },
        };
      if (n.title !== undefined || n.text !== undefined)
        return {
          node: {
            kind: 'document',
            ...(n.title !== undefined ? { title: n.title } : {}),
            ...(n.text !== undefined ? { text: n.text } : {}),
          },
        };
      return { reason: 'document without ref, title or code' };
    }
    case 'equipment':
    case 'supply':
    case 'spare':
      if (!n.manufacturerCode) return { reason: `${n.kind} without identNumber/manufacturerCode` };
      if (!n.quantity) return { reason: `${n.kind} without reqQuantity text` };
      return {
        node: {
          kind: n.kind,
          ...id,
          ...(n.title !== undefined ? { title: n.title } : {}),
          ...(n.text !== undefined ? { text: n.text } : {}),
          quantity: n.quantity,
          ...(n.unit !== undefined ? { unit: n.unit } : {}),
          ...(n.partNumber !== undefined ? { partNumber: n.partNumber } : {}),
          manufacturerCode: n.manufacturerCode,
        },
      };
    case 'admonition': {
      if (n.attrs?.referencedId) return { reason: `admonition by reference (${n.element})` };
      const paras = n.children
        .filter((c) => c.kind === 'para' && c.text)
        .map((c) => ({ kind: 'para' as const, text: c.text! }));
      if (!n.level || paras.length === 0) return { reason: 'admonition without text' };
      return { node: { kind: 'admonition', ...id, level: n.level, children: paras } };
    }
    default:
      return { reason: `kind ${n.kind}` };
  }
}

/**
 * データモジュール 1 件の preliminaryRqmts を往復させて、失われた要素・属性を数える。
 * preliminaryRqmts が無い、または reader が `requirements` として返さないときは undefined
 */
export function measureRequirementsRoundTrip(xml: string): RequirementsRoundTrip | undefined {
  const source = fragment(xml);
  if (!source) return undefined;
  const pre = readContentFromXml(xml).blocks.find(
    (b) => b.kind === 'requirements' && b.element === 'preliminaryRqmts',
  );
  if (!pre) return undefined;
  const dropped: string[] = [];
  const children: DraftNode[] = [];
  const build = (kids: DraftNode[]) =>
    new XMLSerializer().serializeToString(
      buildContent('proced', [
        { kind: 'requirements', children: kids },
        { kind: 'step', text: 'x' },
      ]) as never,
    );
  for (const c of pre.children) {
    const d = toDraft(c);
    if (!d.node) {
      dropped.push(d.reason!);
      continue;
    }
    try {
      build([d.node]);
      children.push(d.node);
    } catch (e) {
      dropped.push(`${c.kind}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120));
    }
  }
  const original = inventory(source);
  const rebuilt = inventory(fragment(build(children))!);
  const lost: Record<string, number> = {};
  for (const [k, v] of Object.entries(original)) {
    const diff = v - (rebuilt[k] ?? 0);
    if (diff > 0) lost[k] = diff;
  }
  return { original, lost, dropped };
}
