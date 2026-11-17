/**
 * 利用者が入手した S1000D の配布物（Bike Samples）で、更新の理由・変更の印・手順の段落の場所が
 * 読み取りの結果に入っていることを数える。配布物は再配布できないため（DECISIONS D-03）、`S1000D_SPEC_TESTS=1` のときだけ動かす。
 *
 * 比べる相手は、元の文字列を正規表現で数えた数（読み取りの実装と別の数え方）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDataModuleInfo } from '../data-module.js';
import { editContent } from '../edit/index.js';
import { readContentFromXml } from './read.js';
import type { ContentNode } from './types.js';

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
 * 2026-11-17 の実測（Bike Samples の DMC 106 件）。
 * - `reasonForUpdate` は 97 件に 124 個（すべて `dmStatus` の直下）
 * - 変更の印の属性を持つ要素は 3 件に 14 個（wrngdata の DM 2 件に `wire` 10・`electricalEquip` 2、descript の DM 1 件に `graphic` 2）。
 *   `changeInline` は 0 個
 * - 手順（`text` に段落をまとめた節点）のうち、まとめた段落が 2 つ以上のものは 7 件の DM に 11 個
 */
const BASELINE = {
  reasonForUpdates: 124,
  filesWithReason: 97,
  changeMarks: { wire: 10, electricalEquip: 2, graphic: 2 } as Record<string, number>,
  filesWithChangeMark: 3,
  stepsWithTwoOrMoreParas: 11,
  filesWithSuchStep: 7,
};

const bikeDir = findBikeDir(specDir);
const walk = (ns: ContentNode[]): ContentNode[] => ns.flatMap((n) => [n, ...walk(n.children)]);

describe.skipIf(!enabled || !bikeDir)(
  '更新の理由・変更の印・手順の段落の場所（Bike Samples）',
  () => {
    const files = bikeDir
      ? readdirSync(bikeDir)
          .filter((n) => /^DMC-.*\.XML$/i.test(n))
          .sort()
          .map((name) => ({ name, xml: readFileSync(join(bikeDir, name), 'utf8') }))
      : [];

    it('reasonForUpdate を、元の文字列にある数だけ返す（id と文も落とさない）', () => {
      let total = 0;
      let withReason = 0;
      for (const { name, xml } of files) {
        const expected = (xml.match(/<reasonForUpdate[\s>/]/g) ?? []).length;
        const reasons = readDataModuleInfo(xml).identAndStatus?.reasonForUpdates ?? [];
        expect(reasons.length, name).toBe(expected);
        for (const r of reasons) {
          // 段落の数と、id の有無が元の文字列と合う
          expect(
            r.paragraphs.every((p) => p.length > 0),
            name,
          ).toBe(true);
          if (r.id) expect(xml.includes(`id="${r.id}"`), name).toBe(true);
        }
        total += reasons.length;
        if (reasons.length > 0) withReason++;
      }
      expect(total).toBe(BASELINE.reasonForUpdates);
      expect(withReason).toBe(BASELINE.filesWithReason);
    });

    it('変更の印を持つ要素を、本文を構造化して読まない DM も含めて、すべて changeMarks に返す', () => {
      const byElement: Record<string, number> = {};
      let withMark = 0;
      for (const { name, xml } of files) {
        const expected = (
          xml.match(
            /<[A-Za-z][\w.-]*(?=[^<>]*\s(?:changeType|changeMark|reasonForUpdateRefIds)=)[^<>]*>/g,
          ) ?? []
        ).length;
        const c = readContentFromXml(xml);
        expect(c.changeMarks.length, name).toBe(expected);
        for (const m of c.changeMarks) {
          byElement[m.element] = (byElement[m.element] ?? 0) + 1;
          // 指している更新の理由が、識別・状態部にある
          const ids = new Set(
            (readDataModuleInfo(xml).identAndStatus?.reasonForUpdates ?? []).map((r) => r.id),
          );
          for (const id of m.reasonForUpdateRefIds ?? []) expect(ids.has(id), name).toBe(true);
        }
        if (c.changeMarks.length > 0) withMark++;
        // 節点になる要素・参照の印は、節点の側にも入る（graphic は図の参照）
        if (c.structured) {
          const onRefs = walk(c.blocks)
            .flatMap((n) => n.refs ?? [])
            .filter((r) => r.change);
          const onNodes = walk(c.blocks).filter((n) => n.change);
          const marked = c.changeMarks.filter((m) => m.path.includes('/content/'));
          expect(onRefs.length + onNodes.length, name).toBe(marked.length);
        }
      }
      expect(byElement).toEqual(BASELINE.changeMarks);
      expect(withMark).toBe(BASELINE.filesWithChangeMark);
    });

    it('手順の textLocations は、まとめた段落と 1 対 1 で、その場所の para を取り除ける・移せる', () => {
      let stepsWithTwo = 0;
      const filesWithTwo = new Set<string>();
      for (const { name, xml } of files) {
        const c = readContentFromXml(xml);
        if (!c.structured) continue;
        for (const step of walk(c.blocks).filter((n) => n.kind === 'step')) {
          const locations = step.textLocations ?? [];
          // text があるときだけ付き、場所は互いに違う
          expect(locations.length > 0, name).toBe(step.text !== undefined);
          expect(new Set(locations.map((l) => l.path)).size, name).toBe(locations.length);
          if (locations.length < 2) continue;
          stepsWithTwo++;
          filesWithTwo.add(name);
          const [first, second] = locations;
          // 2 つ目の段落だけを取り除く
          const removed = editContent(xml, [{ op: 'remove', at: second!.path }], {
            allowReleasedIssue: true,
          });
          expect(removed.refusals, name).toEqual([]);
          expect(removed.applied, name).toBe(true);
          expect(removed.changes[0]!.element, name).toBe('para');
          const after = walk(readContentFromXml(removed.xml).blocks).find(
            (n) => n.location.path === step.location.path,
          );
          expect(after!.textLocations!.length, name).toBe(locations.length - 1);
          // 2 つ目の段落を 1 つ目の前に移すと、まとめた文の先頭が入れ替わる
          const moved = editContent(
            xml,
            [{ op: 'move', at: second!.path, to: first!.path, position: 'before' }],
            { allowReleasedIssue: true },
          );
          expect(moved.refusals, name).toEqual([]);
          const movedStep = walk(readContentFromXml(moved.xml).blocks).find(
            (n) => n.location.path === step.location.path,
          );
          expect(movedStep!.text, name).not.toBe(step.text);
          expect(movedStep!.textLocations!.length, name).toBe(locations.length);
        }
      }
      expect(stepsWithTwo).toBe(BASELINE.stepsWithTwoOrMoreParas);
      expect(filesWithTwo.size).toBe(BASELINE.filesWithSuchStep);
    });
  },
);
