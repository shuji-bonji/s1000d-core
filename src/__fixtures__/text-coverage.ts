/**
 * 本文（content）の文字が、`readContentFromXml` の結果に残っているかを数える（テスト用）。
 *
 * 読む側は内容を落とさない、という方針（s1000d-stack の DECISIONS D-31）を、数で確かめるためのもの。
 * 本文のテキスト節点を 1 つずつ取り出し、空白をそろえた文字列が、読み取りの結果（節点の木を JSON にしたもの）の
 * どこかに含まれているかを見る。含まれていないテキスト節点を「読み取りの結果に無い」と数える。
 * 文字列が含まれるかどうかだけを見るので、別の場所に同じ文があれば見逃す。少なめに数える測り方である。
 *
 * 本文の先頭の `referencedApplicGroup`（適用性の文）は、`readContentFromXml` ではなく `readApplicStatements` が読む。
 * 節点は `applicRefId` で指すだけなので、こちらの結果も「読み取りの結果」に含めて数える。
 */
import { readApplicStatements } from '../applic/read.js';
import { readContentFromXml } from '../content/read.js';
import type { Element } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';

export interface TextCoverage {
  /** 本文のテキスト節点の数（空白だけのものを除く） */
  total: number;
  /** 読み取りの結果に無いテキスト節点の数 */
  lost: number;
  /**
   * そのうち、reader が知らせていないもの（先祖の要素のどれも `notReadElements` に入っていない）の数。
   * 0 でなければ、reader が黙って落としている文がある
   */
  lostSilent: number;
  /** 読み取りの結果に無いテキスト節点を、「親の親/親」の要素名ごとに数えたもの */
  lostByParent: Record<string, number>;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 構造化していない種類（`structured: false`）と、content の無い文書は undefined */
export function measureTextCoverage(xml: string): TextCoverage | undefined {
  const content = readContentFromXml(xml);
  if (!content.structured) return undefined;
  const { document } = defaultXmlEngine.parse(xml);
  const haystack = norm(
    JSON.stringify([content.blocks, readApplicStatements(document)], (k, v: unknown) =>
      k === 'location' ? undefined : v,
    )
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\'),
  );
  const root = defaultXmlEngine.selectNodes('/*/content', document)[0] as Element | undefined;
  if (!root) return undefined;
  const result: TextCoverage = { total: 0, lost: 0, lostSilent: 0, lostByParent: {} };
  const reported = new Set(Object.keys(content.notReadElements));
  const walk = (el: Element, known = false) => {
    const underReported = known || reported.has(el.nodeName);
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) {
        const text = norm(n.nodeValue ?? '');
        if (!text) continue;
        result.total++;
        if (!haystack.includes(text)) {
          result.lost++;
          if (!underReported) result.lostSilent++;
          const key = `${(el.parentNode as Element | null)?.nodeName ?? ''}/${el.nodeName}`;
          result.lostByParent[key] = (result.lostByParent[key] ?? 0) + 1;
        }
      } else if (n.nodeType === 1) walk(n as Element, underReported);
    }
  };
  walk(root);
  return result;
}
