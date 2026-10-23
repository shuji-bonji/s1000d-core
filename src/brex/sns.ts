/**
 * BREX の snsRules からシステム番号（SNS）の意味を引く。
 */
import type { BrexDocument, SnsNode } from './types.js';

export interface SnsLookupResult {
  /** 一致した階層。先頭がシステム、以降サブシステム・サブサブシステム・組立 */
  levels: { snsCode: string; snsTitle: string }[];
  /** 完全に一致したか（部分一致なら false） */
  exact: boolean;
}

function walk(nodes: SnsNode[], codes: string[], acc: SnsNode[]): SnsNode[] {
  if (codes.length === 0) return acc;
  const hit = nodes.find((n) => n.snsCode === codes[0]);
  if (!hit) return acc;
  return walk(hit.children, codes.slice(1), [...acc, hit]);
}

/**
 * DMC の構成要素（systemCode / subSystemCode / subSubSystemCode / assyCode）で SNS を引く。
 * 途中までしか一致しないときは一致した階層だけを返し、exact を false にする。
 */
export function lookupSns(
  brex: BrexDocument,
  code: {
    systemCode: string;
    subSystemCode?: string;
    subSubSystemCode?: string;
    assyCode?: string;
  },
): SnsLookupResult | undefined {
  const codes = [code.systemCode, code.subSystemCode, code.subSubSystemCode, code.assyCode].filter(
    (c): c is string => c !== undefined,
  );
  for (const descr of brex.snsRules) {
    const found = walk(descr.systems, codes, []);
    if (found.length > 0) {
      return {
        levels: found.map((n) => ({ snsCode: n.snsCode, snsTitle: n.snsTitle })),
        exact: found.length === codes.length,
      };
    }
  }
  return undefined;
}
