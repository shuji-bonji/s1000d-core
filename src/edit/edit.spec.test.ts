/**
 * 利用者が入手した S1000D の配布物（Bike Samples）で、構造を変える編集が元の文字列を保つことを確かめる。
 * 配布物は再配布できないため（DECISIONS D-03）、`S1000D_SPEC_TESTS=1` のときだけ動かす。
 *
 * 確かめること（s1000d-stack の docs/design/core-structural-edit.md「テスト」）:
 * - 要素の範囲（`scanElementRanges`）が、DMC・PMC のすべてで DOM の要素と対応する
 * - 対象の要素を 1 つ取り除く編集が、文字列の上の操作と DOM の上の操作で同じ結果になる
 *   （`editContent` が自分で比べ、合わなければ `internal-mismatch` で断る）
 * - 手順 DM で、最後の手順を 1 つ前の要素の前に移し、元の位置に戻すと、元の文字列に戻る
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeLocation } from '../brex/check.js';
import type { Element } from '../xml/engine.js';
import { rangesMatchDocument, scanElementRanges } from '../xml/ranges.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import { EDITABLE_ELEMENTS, editContent } from './edit.js';

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

/** 2026-11-17 の実測（Issue 7 の Bike Samples） */
const BASELINE = {
  /** DMC と PMC のファイルの数 */
  files: 110,
  /** トップレベルの手順が 2 つ以上ある手順 DM の数 */
  procedWithSteps: 39,
  /** そのうち、移して戻すと元の文字列と同じになる数（残りは、2 つの要素の間にコメントがある） */
  exactRoundTrips: 37,
  /** トップレベルの手順が 1 つ以上ある手順 DM の数 */
  procedWithFirstStep: 39,
};

describe.skipIf(!enabled)('editContent: Bike Samples', () => {
  const bike = findBikeDir(specDir);
  const files = bike
    ? readdirSync(bike)
        .filter((n) => /^(DMC|PMC)-.*\.XML$/i.test(n))
        .sort()
        .map((n) => ({ name: n, xml: readFileSync(join(bike, n), 'utf8') }))
    : [];

  it('要素の範囲が、すべてのファイルで DOM の要素と対応する', () => {
    expect(files.length).toBe(BASELINE.files);
    const unmatched = files.filter(({ xml }) => {
      const root = scanElementRanges(xml);
      const doc = defaultXmlEngine.parse(xml).document;
      return !root || !rangesMatchDocument(root, doc.documentElement!);
    });
    expect(unmatched.map((f) => f.name)).toEqual([]);
  });

  it('対象の要素を 1 つ取り除く編集は、文字列と DOM で同じ結果になる（各ファイルで、種類ごとに最初・中央・最後の 1 つ）', () => {
    const reasons: Record<string, number> = {};
    let tried = 0;
    for (const { name, xml } of files) {
      const doc = defaultXmlEngine.parse(xml).document;
      for (const elementName of EDITABLE_ELEMENTS) {
        const all = defaultXmlEngine.selectNodes(`//${elementName}`, doc) as unknown as Element[];
        const picks = [...new Set([all[0], all[Math.floor(all.length / 2)], all[all.length - 1]])];
        for (const el of picks) {
          if (!el) continue;
          tried++;
          const at = describeLocation(el).path;
          const r = editContent(xml, [{ op: 'remove', at }], { allowReleasedIssue: true });
          if (r.applied) {
            expect(r.xml.length, `${name} ${at}`).toBeLessThan(xml.length);
            continue;
          }
          for (const x of r.refusals) reasons[x.reason] = (reasons[x.reason] ?? 0) + 1;
          expect(
            r.refusals.map((x) => x.reason),
            `${name} ${at}`,
          ).toEqual(['id-referenced']);
        }
      }
    }
    expect(tried).toBeGreaterThan(300);
    expect(Object.keys(reasons).filter((k) => k !== 'id-referenced')).toEqual([]);
  }, 600_000);

  it('手順 DM で、最後の手順を 1 つ前の要素の前に移し、元の位置に戻すと、元の文字列に戻る', () => {
    const main = '/dmodule/content/procedure/mainProcedure';
    let count = 0;
    let exact = 0;
    for (const { name, xml } of files) {
      const doc = defaultXmlEngine.parse(xml).document;
      const steps = defaultXmlEngine.selectNodes(
        `${main}/proceduralStep`,
        doc,
      ) as unknown as Element[];
      if (steps.length < 2) continue;
      count++;
      const n = steps.length;
      const last = steps[n - 1]!;
      let prev = last.previousSibling;
      while (prev && prev.nodeType !== 1) prev = prev.previousSibling;
      const prevPath = describeLocation(prev!).path;
      const prevIsStep = prev === steps[n - 2];
      const moved = editContent(
        xml,
        [{ op: 'move', at: `${main}/proceduralStep[${n}]`, to: prevPath, position: 'before' }],
        { allowReleasedIssue: true },
      );
      expect(moved.refusals, name).toEqual([]);
      expect(moved.xml, name).not.toBe(xml);
      expect(moved.xml.length, name).toBe(xml.length);
      // 1 つ前が手順なら、移した後は番号が入れ替わる
      const back = editContent(
        moved.xml,
        [
          {
            op: 'move',
            at: `${main}/proceduralStep[${prevIsStep ? n - 1 : n}]`,
            to: prevIsStep ? `${main}/proceduralStep[${n}]` : prevPath,
            position: 'after',
          },
        ],
        { allowReleasedIssue: true },
      );
      expect(back.refusals, name).toEqual([]);
      // 2 つの要素の間にコメントがあると、コメントの位置だけが入れ替わる。行の集まりは必ず同じ
      if (back.xml === xml) exact++;
      expect(back.xml.split('\n').sort(), name).toEqual(xml.split('\n').sort());
    }
    expect(count).toBe(BASELINE.procedWithSteps);
    expect(exact).toBe(BASELINE.exactRoundTrips);
  }, 600_000);

  it('手順 DM のすべてで、最初の手順の後ろに手順を足せる（足した行のほかは変わらない）', () => {
    const first = '/dmodule/content/procedure/mainProcedure/proceduralStep[1]';
    let count = 0;
    for (const { name, xml } of files) {
      const doc = defaultXmlEngine.parse(xml).document;
      if (defaultXmlEngine.selectNodes(first, doc).length === 0) continue;
      count++;
      const r = editContent(
        xml,
        [
          {
            op: 'insert',
            to: first,
            position: 'after',
            node: { kind: 'step', text: 'Added step.' },
          },
        ],
        { allowReleasedIssue: true },
      );
      expect(r.refusals, name).toEqual([]);
      const added = r.xml.split('\n').filter((l) => l.includes('Added step.'));
      expect(added, name).toHaveLength(1);
      // 足した手順の 3 行（開始タグ、段落、終了タグ）を除くと、元の文字列に戻る
      const lines = r.xml.split('\n');
      const at = lines.findIndex((l) => l.includes('Added step.'));
      lines.splice(at - 1, 3);
      expect(lines.join('\n') === xml, name).toBe(true);
    }
    expect(count).toBe(BASELINE.procedWithFirstStep);
  });
});
