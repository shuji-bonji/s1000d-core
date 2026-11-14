/**
 * 利用者が入手した S1000D の配布物（Bike Samples）で、preliminaryRqmts を「読んで、書いて、失われるものを数える」。
 * 配布物は再配布できないため（DECISIONS D-03）、`S1000D_SPEC_TESTS=1` のときだけ動かす。
 *
 * core の読み書きは S1000D の部分集合である。どこまで往復できるかを数で固定し、減らす方向にだけ動かす
 * （s1000d-stack の docs/design/core-preliminary-rqmts.md）。数が減ったら、下の上限を新しい数に下げる。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findSilentlyDroppedElements,
  measureRequirementsRoundTrip,
} from '../__fixtures__/requirements-roundtrip.js';

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
 * 2026-11-15 の実測。
 * - 最初（`requirements` の子に person・document・equipment・supply・spare・admonition を足した時点）: 失われた数 898、失わずに往復できた DM 3 件
 * - 人員の `man`・区分・技能・見積もり時間、文書の区分、条件の参照（reqCondDm / reqCondPm）を足した後: 631、26 件
 */
const BASELINE = {
  /** preliminaryRqmts を持つ DM */
  withPreliminaryRqmts: 44,
  /** reader が `requirements` として返した DM（手順・故障探求）。残りは checklist 2 件と schedul 1 件 */
  measured: 41,
  /** 要素と属性の数（元） */
  originalTotal: 2527,
  /** 往復で失われた要素と属性の数の上限 */
  lostTotal: 631,
  /** 何も失わずに往復できた DM の数の下限 */
  clean: 26,
};

const bikeDir = findBikeDir(specDir);

describe.skipIf(!enabled || !bikeDir)('preliminaryRqmts の往復（Bike Samples）', () => {
  it('失われる要素・属性の数が、記録した上限を超えない', () => {
    const files = readdirSync(bikeDir!).filter((f) => /^DMC-.*\.XML$/i.test(f));
    const original: Record<string, number> = {};
    const lost: Record<string, number> = {};
    const dropped: Record<string, number> = {};
    let withPre = 0;
    let measured = 0;
    let clean = 0;
    for (const f of files) {
      const xml = readFileSync(join(bikeDir!, f), 'utf8');
      if (!/<preliminaryRqmts/.test(xml)) continue;
      withPre++;
      const r = measureRequirementsRoundTrip(xml);
      if (!r) continue;
      measured++;
      if (Object.keys(r.lost).length === 0) clean++;
      for (const [k, v] of Object.entries(r.original)) original[k] = (original[k] ?? 0) + v;
      for (const [k, v] of Object.entries(r.lost)) lost[k] = (lost[k] ?? 0) + v;
      for (const d of r.dropped) dropped[d] = (dropped[d] ?? 0) + 1;
    }
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    const report = JSON.stringify(
      { lost: Object.entries(lost).sort((a, b) => b[1] - a[1]), dropped },
      null,
      1,
    );
    expect(withPre).toBe(BASELINE.withPreliminaryRqmts);
    expect(measured).toBeGreaterThanOrEqual(BASELINE.measured);
    expect(sum(original)).toBeGreaterThanOrEqual(BASELINE.originalTotal);
    expect(sum(lost), report).toBeLessThanOrEqual(BASELINE.lostTotal);
    expect(clean).toBeGreaterThanOrEqual(BASELINE.clean);
    // 安全の要件（warning / caution / note）と、その参照（@warningRefs / @cautionRefs）は読めていること
    // （書く側が参照を受け取らないので、往復では失われる。読む側が返すことは content.test.ts で確かめる）
    expect(lost['warning'] ?? 0).toBe(0);
    expect(lost['caution'] ?? 0).toBe(0);
    expect(lost['note'] ?? 0).toBe(0);
    // 人員は、要素の種類（person / personnel）と中身をすべて往復できること
    for (const k of [
      'person',
      'personnel',
      'personCategory',
      'personSkill',
      'trade',
      'estimatedTime',
    ])
      expect(lost[k] ?? 0, k).toBe(0);
  });

  it('reader は、読んでいない要素を黙って落とさない（読むか、notReadElements で知らせる）', () => {
    const files = readdirSync(bikeDir!).filter((f) => /^DMC-.*\.XML$/i.test(f));
    const silent: Record<string, string[]> = {};
    for (const f of files) {
      const dropped = findSilentlyDroppedElements(readFileSync(join(bikeDir!, f), 'utf8'));
      if (dropped.length > 0) silent[f] = dropped;
    }
    expect(silent).toEqual({});
  });
});
