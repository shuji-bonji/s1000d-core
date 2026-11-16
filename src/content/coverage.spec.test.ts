/**
 * 利用者が入手した S1000D の配布物（Bike Samples）で、本文の文字が読み取りの結果に残っているかを数える。
 * 配布物は再配布できないため（DECISIONS D-03）、`S1000D_SPEC_TESTS=1` のときだけ動かす。
 *
 * 読む側は内容を落とさない（s1000d-stack の DECISIONS D-31）。まだ落としているものを数で固定し、
 * 減らす方向にだけ動かす。数が減ったら、下の上限を新しい数に下げる。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { measureTextCoverage } from '../__fixtures__/text-coverage.js';

const enabled = process.env.S1000D_SPEC_TESTS === '1';
const specDir = resolve(process.env.S1000D_SPEC_DIR ?? '../../specs/s1000d/issue-7');

function findBikeDir(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(dir, e.name);
    if (/bike/i.test(e.name) && readdirSync(p).some((n) => /^DMC-.*\.XML$/i.test(n))) return p;
    const inner = findBikeDir(p);
    if (inner) return inner;
  }
  return undefined;
}

/**
 * 2026-11-15 の実測（本文を構造化して読む DM、59 件、テキスト節点 1,587 個）。
 * - core 0.9.0: 読み取りの結果に無いテキスト節点 193 個、1 つも落とさずに読めた DM 28 件
 *   （多かったのは、段落の中のリスト。`para` の中の `randomList`・`definitionList` などを読んでいなかった）
 * - 段落の中のブロック要素を子として読むようにした後: 66 個、39 件
 *
 * 2026-11-16 の実測:
 * - 適用性の文（referencedApplicGroup。`readApplicStatements` が読む）を読み取りの結果に含めて数え、
 *   不具合の説明・メニューの選択肢・知らせ・図の凡例・定義リストの見出し・折り込みの図・
 *   外部の文書の版と発行日・入れ子の品目を読むようにした後: 13 個、55 件。
 *   残りの 13 個は、どれも reader が `notReadElements` で知らせている要素の中にある
 *   （hazards 4、productionMaintData 4、variableDeclarations / variablePreSet 2、supplyRef・reasonForAmendment・footnote が各 1）
 * - 品目の危険性・ほかの識別子・脚注、作業の場所と所要時間、変数の宣言・代入・検査、図の改訂の理由を
 *   読むようにした後: 0 個、59 件（本文を構造化して読む DM のすべて）
 */
const BASELINE = {
  /** 本文を構造化して読む DM の数 */
  measured: 59,
  /** テキスト節点の数 */
  total: 1587,
  /** 読み取りの結果に無いテキスト節点の数の上限 */
  lost: 0,
  /** そのうち、reader が知らせていない（`notReadElements` に入っていない要素の中の）テキスト節点の数 */
  lostSilent: 0,
  /** 1 つも落とさずに読めた DM の数の下限 */
  clean: 59,
};

const bikeDir = findBikeDir(specDir);

describe.skipIf(!enabled || !bikeDir)(
  '本文の文字が読み取りの結果に残っているか（Bike Samples）',
  () => {
    it('読み取りの結果に無いテキスト節点の数が、記録した上限を超えない', () => {
      let measured = 0;
      let total = 0;
      let lost = 0;
      let lostSilent = 0;
      let clean = 0;
      const byParent: Record<string, number> = {};
      for (const f of readdirSync(bikeDir!).filter((n) => /^DMC-.*\.XML$/i.test(n))) {
        const r = measureTextCoverage(readFileSync(join(bikeDir!, f), 'utf8'));
        if (!r) continue;
        measured++;
        total += r.total;
        lost += r.lost;
        lostSilent += r.lostSilent;
        if (r.lost === 0) clean++;
        for (const [k, v] of Object.entries(r.lostByParent)) byParent[k] = (byParent[k] ?? 0) + v;
      }
      const detail = Object.entries(byParent)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${v} ${k}`)
        .join(', ');
      expect(measured).toBe(BASELINE.measured);
      expect(total).toBe(BASELINE.total);
      expect(lost, `読み取りの結果に無いテキスト節点: ${detail}`).toBeLessThanOrEqual(
        BASELINE.lost,
      );
      expect(lostSilent, `知らせていないテキスト節点: ${detail}`).toBe(BASELINE.lostSilent);
      expect(clean).toBeGreaterThanOrEqual(BASELINE.clean);
    });
  },
);
