/**
 * 作業中の版を始める操作と、変更の印を付ける編集を、配布物（Bike Samples・XSD・既定 BREX）で確かめる。
 * 配布物は再配布できないため（DECISIONS D-03）、`S1000D_SPEC_TESTS=1` のときだけ動かす。
 * 設計: s1000d-stack の docs/design/core-revision.md の「テスト」。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBrexResolver } from '../csdb.js';
import { CsdbIndex } from '../csdb-index.js';
import { editContent } from '../edit/edit.js';
import { findSchemaDirs, verifyDataModule } from '../verify/index.js';
import { scanAttributes, scanElementRanges, type ElementRange } from '../xml/ranges.js';
import { Libxml2SchemaValidator } from '../xsd-libxml2.js';
import { addReasonForUpdate } from './reason.js';
import { startRevision } from './start.js';

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

/** 2026-11-18 の実測（Issue 7 の Bike Samples） */
const BASELINE = {
  /** DMC のファイルの数 */
  dataModules: 106,
  /** issueType が deleted で、断る数 */
  deleted: 3,
  /** 作業中の版を始められた数 */
  started: 103,
  /** 取り除いた reasonForUpdate の数（deleted の 3 件の分を除く） */
  reasonForUpdate: 120,
  /** 印の属性を取り除いた要素の数 */
  markedElements: 14,
};

/** 版と変更の印に関わる、機械で判定する既定 BREX のルール */
const RULES = ['BREX-S1-00030', 'BREX-S1-00032', 'BREX-S1-00033', 'BREX-S1-00036', 'BREX-S1-00038'];

/** 文書に残っている、変更の印の属性・reasonForUpdate・changeInline の数 */
function changeMarkup(xml: string): number {
  let n = 0;
  const walk = (r: ElementRange) => {
    if (r.name === 'reasonForUpdate' || r.name === 'changeInline') n++;
    n += scanAttributes(xml, r).filter((a) =>
      ['changeType', 'changeMark', 'reasonForUpdateRefIds'].includes(a.name),
    ).length;
    r.children.forEach(walk);
  };
  walk(scanElementRanges(xml)!);
  return n;
}

describe.skipIf(!enabled)('startRevision と marking: Bike Samples', () => {
  const bike = findBikeDir(specDir);
  const files = bike
    ? readdirSync(bike)
        .filter((n) => /^DMC-.*\.XML$/i.test(n))
        .sort()
        .map((n) => ({ name: n, xml: readFileSync(join(bike, n), 'utf8') }))
    : [];
  const validator = new Libxml2SchemaValidator();
  const schemaDirs = findSchemaDirs([specDir]);
  const resolver = createBrexResolver(CsdbIndex.fromDirs([specDir]));
  const verify = (xml: string, path: string) =>
    verifyDataModule(xml, { path, schema: { validator, schemaDirs }, brex: { resolver } });
  const ruleIds = (v: Awaited<ReturnType<typeof verify>>) =>
    (v.brex?.layers ?? [])
      .flatMap((l) => l.violations)
      .map((x) => x.ruleId)
      .filter((id): id is string => !!id && RULES.includes(id))
      .sort();

  afterAll(() => validator.dispose());

  it('すべての DM で作業中の版を始め、前の版の印が無くなる', () => {
    expect(files.length).toBe(BASELINE.dataModules);
    const results = files.map((f) => ({ ...f, r: startRevision(f.xml, { issueType: 'changed' }) }));
    const refused = results.filter((x) => !x.r.started);
    expect(refused.map((x) => x.r.refusals[0]?.reason)).toEqual(
      Array.from({ length: BASELINE.deleted }, () => 'deleted-issue'),
    );
    const started = results.filter((x) => x.r.started);
    expect(started.length).toBe(BASELINE.started);
    for (const { r, name } of started) {
      // 文の中に要素名が出てくる DM（BREX の DM など）があるので、要素と属性を数える
      expect(changeMarkup(r.xml), name).toBe(0);
      expect(r.fileName, name).toBe(name.replace(/_(\d{3})-00_/, '_$1-01_'));
    }
    const sum = (f: (r: (typeof started)[number]['r']) => number) =>
      started.reduce((n, x) => n + f(x.r), 0);
    expect(sum((r) => r.removed.reasonForUpdate)).toBe(BASELINE.reasonForUpdate);
    expect(sum((r) => r.removed.markedElements)).toBe(BASELINE.markedElements);
  });

  it('作業中の版は XSD のエラーが増えず、版と印の BREX のルールの違反が増えない（issueType は changed）', async () => {
    const problems: string[] = [];
    for (const f of files) {
      const r = startRevision(f.xml, { issueType: 'changed' });
      if (!r.started) continue;
      const before = await verify(f.xml, f.name);
      const after = await verify(r.xml, r.fileName!);
      if ((after.status.schema.errorCount ?? 0) > (before.status.schema.errorCount ?? 0)) {
        problems.push(`${f.name}: schema ${JSON.stringify(after.schema.errors.slice(0, 2))}`);
      }
      const was = ruleIds(before);
      const added = ruleIds(after).filter((id) => !was.includes(id));
      if (added.length > 0) problems.push(`${f.name}: ${added.join(', ')}`);
    }
    expect(problems).toEqual([]);
  }, 600_000);

  it('手順 DM で、印を付けて手順を足す・取り除く編集が XSD に通り、版と印の BREX のルールに当たらない', async () => {
    const marking = {
      reason: { text: 'Procedure updated.', updateReasonType: 'urt02' },
      changeMark: '1' as const,
    };
    const step = (n: number) => `/dmodule/content/procedure/mainProcedure/proceduralStep[${n}]`;
    const problems: string[] = [];
    let edited = 0;
    for (const f of files) {
      if (!/<mainProcedure[\s>]/.test(f.xml)) continue;
      const r = startRevision(f.xml, { issueType: 'changed' });
      if (!r.started || (r.xml.match(/<proceduralStep[\s>]/g) ?? []).length < 2) continue;
      const before = await verify(r.xml, r.fileName!);
      const e = editContent(
        r.xml,
        [
          {
            op: 'insert',
            to: step(1),
            position: 'before',
            node: { kind: 'step', text: 'Added step.' },
          },
        ],
        { marking },
      );
      if (!e.applied) {
        problems.push(`${f.name}: insert ${JSON.stringify(e.refusals[0])}`);
        continue;
      }
      // 足した手順の次（元の 1 つ目）に delete の印を付ける。id を指されていれば断られるので、その DM は数えない
      const d = editContent(e.xml, [{ op: 'remove', at: step(2) }], {
        marking: { ...marking, reason: { ...marking.reason, text: 'Step removed.' } },
      });
      const out = d.applied ? d.xml : e.xml;
      if (!d.applied && d.refusals[0]?.reason !== 'id-referenced') {
        problems.push(`${f.name}: remove ${JSON.stringify(d.refusals[0])}`);
      }
      const after = await verify(out, r.fileName!);
      if ((after.status.schema.errorCount ?? 0) > (before.status.schema.errorCount ?? 0)) {
        problems.push(`${f.name}: schema ${JSON.stringify(after.schema.errors.slice(0, 2))}`);
      }
      const was = ruleIds(before);
      const added = ruleIds(after).filter((id) => !was.includes(id));
      if (added.length > 0) problems.push(`${f.name}: ${added.join(', ')}`);
      edited++;
    }
    expect(problems).toEqual([]);
    expect(edited).toBeGreaterThan(30);
  }, 600_000);

  it('issueType を status にして始めた版は BREX-S1-00038 に当たり、addReasonForUpdate の後は当たらない', async () => {
    const problems: string[] = [];
    let hit = 0;
    let checked = 0;
    // 時間を抑えるため、5 件に 1 件を見る
    for (const f of files.filter((_, i) => i % 5 === 0)) {
      const r = startRevision(f.xml, { issueType: 'status' });
      if (!r.started) continue;
      checked++;
      const started = await verify(r.xml, r.fileName!);
      const later = !/^0*[01]$/.test(r.issueInfo!.issueNumber);
      const has38 = ruleIds(started).includes('BREX-S1-00038');
      if (has38) hit++;
      if (has38 !== later) problems.push(`${f.name}: 00038 after start is ${has38}`);
      const a = addReasonForUpdate(r.xml, { text: 'Status updated.', updateReasonType: 'urt01' });
      if (!a.added) {
        problems.push(`${f.name}: ${JSON.stringify(a.refusals[0])}`);
        continue;
      }
      const after = await verify(a.xml, r.fileName!);
      if (ruleIds(after).includes('BREX-S1-00038')) problems.push(`${f.name}: 00038 remains`);
      if ((after.status.schema.errorCount ?? 0) > (started.status.schema.errorCount ?? 0)) {
        problems.push(`${f.name}: schema ${JSON.stringify(after.schema.errors.slice(0, 2))}`);
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(15);
    expect(hit).toBeGreaterThan(10);
  }, 600_000);
});
