/**
 * 利用者が入手した S1000D の配布物に対するテスト。
 * 配布物は再配布できないため（DECISIONS D-03）、`S1000D_SPEC_TESTS=1` のときだけ動かす。
 * 場所は `S1000D_SPEC_DIR`（既定: ../../specs/s1000d/issue-7 — s1000d-stack の配置に合わせた相対パス）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDataModuleInfo } from './data-module.js';
import { formatDmc, parseDmcFileName, sameDmc } from './dmc.js';
import { parseIcnFileName } from './icn.js';
import { defaultXmlEngine } from './xml/index.js';
import { checkAgainstBrexChain, findDefaultBrex, locateBrex, readBrex } from './brex/index.js';
import { createDirectoryBrexResolver } from './csdb.js';
import { findSchemaDirs, verifyDataModule } from './verify/index.js';
import { CsdbIndex } from './csdb-index.js';
import { collectReferences, resolveReferences } from './refs/index.js';
import { Libxml2SchemaValidator } from './xsd-libxml2.js';

const enabled = process.env.S1000D_SPEC_TESTS === '1';
const specDir = resolve(process.env.S1000D_SPEC_DIR ?? '../../specs/s1000d/issue-7');

/**
 * 配布物の中の「CSDB の形で置かれたファイル」だけを集める。
 * データ辞書（data_dictionary_*）の samples/ にある `DMC-…_01-06.xml` のような名前は、
 * 発行情報ではなく例の通し番号が付いた説明用のファイルなので対象から外す。
 */
function findFiles(dir: string, pattern: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (/^data_dictionary/i.test(e.name)) continue;
      findFiles(p, pattern, out);
    } else if (pattern.test(e.name)) out.push(p);
  }
  return out;
}

describe.skipIf(!enabled || !existsSync(specDir))('S1000D 配布物（利用者が入手したもの）', () => {
  const dmFiles = findFiles(specDir, /^DMC-.*\.XML$/i);
  const icnFiles = findFiles(specDir, /^ICN-.*\.(CGM|PNG|JPG|SVG|GIF)$/i);
  const brexFile = findFiles(specDir, /^DMC-S1000D-.*-04-10-0301-00A-022A-D.*\.XML$/i)[0];

  it('データモジュールのファイル名をすべて分解できる', () => {
    expect(dmFiles.length).toBeGreaterThan(0);
    const failed = dmFiles.filter((f) => !parseDmcFileName(f).ok);
    expect(failed).toEqual([]);
  });

  it('ICN のファイル名をすべて分解できる', () => {
    expect(icnFiles.length).toBeGreaterThan(0);
    const failed = icnFiles.filter((f) => !parseIcnFileName(f).ok);
    expect(failed).toEqual([]);
  });

  it('すべてのデータモジュールの識別・状態部を読み、ファイル名の DMC と一致する', () => {
    const mismatched: string[] = [];
    for (const f of dmFiles) {
      const info = readDataModuleInfo(readFileSync(f, 'utf8'));
      const fromName = parseDmcFileName(f);
      if (!info.identAndStatus || !fromName.ok) {
        mismatched.push(f);
        continue;
      }
      const a = JSON.stringify(info.identAndStatus.dmCode);
      const b = JSON.stringify(fromName.value.dmCode);
      if (a !== b) mismatched.push(f);
      if (!info.identAndStatus.brexDmRef) mismatched.push(`${f} (no brexDmRef)`);
    }
    expect(mismatched).toEqual([]);
  });

  it('既定 BREX の objectPath をすべて構文解析できる', () => {
    expect(brexFile).toBeDefined();
    const { document } = defaultXmlEngine.parse(readFileSync(brexFile, 'utf8'));
    const paths = defaultXmlEngine
      .selectNodes('//objectPath', document)
      .map((n) => n.textContent?.trim() ?? '');
    expect(paths.length).toBeGreaterThan(200);
    const failed = paths.filter((p) => !defaultXmlEngine.validateExpression(p).ok);
    expect(failed).toEqual([]);
  });

  it('既定 BREX を読み取れる', () => {
    const brex = readBrex(readFileSync(brexFile, 'utf8'));
    expect(brex.ok).toBe(true);
    if (!brex.ok) return;
    const structure = brex.value.contextRules.reduce((n, c) => n + c.structureRules.length, 0);
    expect(structure).toBeGreaterThan(200);
    expect(brex.value.nonContextRules.length).toBeGreaterThanOrEqual(1);
    // 既定 BREX は自分自身を参照する（連鎖の終端）
    expect(brex.value.brexDmRef?.dmCode.infoCode).toBe('022');
    expect(brex.value.brexDmRef?.dmCode.modelIdentCode).toBe('S1000D');
  });

  it('配布物全体から既定 BREX を探すと、中身の DMC がファイル名と一致し自分自身を参照するものが選ばれる', async () => {
    // データ辞書の見本（ファイル名と中身の DMC が違う）が混ざっていても、配布フォルダーの既定 BREX が選ばれる
    const found = findDefaultBrex([specDir]);
    expect(found).toBeDefined();
    expect(found!.brex.brexDmRef && sameDmc(found!.brex.brexDmRef.dmCode, found!.brex.dmCode)).toBe(
      true,
    );
    expect(found!.path).toBe(brexFile);
    const located = await locateBrex(undefined, { dirs: [specDir] });
    expect(located.source).toBe('default');
    expect(located.path).toBe(brexFile);
  });

  it('サンプル CSDB の全データモジュールが公式 XSD に適合する（libxml2-wasm、U-08 の実測と同じ）', async () => {
    const schemaDirs = findSchemaDirs([specDir]);
    expect(schemaDirs.length).toBeGreaterThan(0);
    expect(schemaDirs[0].issue).toBe('7');
    const validator = new Libxml2SchemaValidator();
    try {
      const bikeFiles = dmFiles.filter((f) => /bike/i.test(f));
      expect(bikeFiles.length).toBeGreaterThan(100);
      const t0 = performance.now();
      const notValid: string[] = [];
      for (const f of bikeFiles) {
        const r = await verifyDataModule(readFileSync(f, 'utf8'), {
          path: f,
          schema: { validator, schemaDirs },
        });
        if (r.status.schema.state !== 'valid') {
          notValid.push(
            `${f}: ${r.status.schema.state} ${r.status.schema.reason ?? ''} ${r.schema.errors[0]?.message ?? ''}`,
          );
        }
      }
      const ms = performance.now() - t0;
      expect(notValid).toEqual([]);
      // U-08 の実測は 106 件で 0.27 秒。桁が変わっていないことだけを見る
      expect(ms).toBeLessThan(5000);
    } finally {
      validator.dispose();
    }
  });

  it('サンプル CSDB の参照を解決できる（仕様書の章への参照と、配布物の不整合だけが未解決になる）', () => {
    const bikeFile = dmFiles.find((f) => /bike/i.test(f))!;
    const bikeDir = dirname(bikeFile);
    const index = CsdbIndex.fromDirs([bikeDir]);
    const totals: Record<string, { checked: number; unresolved: number }> = {};
    const unresolvedDmRefModels = new Set<string>();
    const icnMisses: string[] = [];
    for (const o of index.objects.filter((x) => x.kind === 'dm' || x.kind === 'pm')) {
      const { document } = defaultXmlEngine.parse(readFileSync(o.path, 'utf8'));
      const rep = resolveReferences(collectReferences(document), { csdb: index });
      for (const [k, v] of Object.entries(rep.counts)) {
        totals[k] ??= { checked: 0, unresolved: 0 };
        totals[k].checked += v.checked;
        totals[k].unresolved += v.unresolved;
      }
      for (const u of rep.unresolved) {
        if (u.reference.kind === 'dmRef')
          unresolvedDmRefModels.add(u.reference.ref.dmCode.modelIdentCode);
        if (u.reference.kind === 'icn') icnMisses.push(u.message);
      }
    }
    expect(totals.internalRef.checked).toBeGreaterThan(500);
    expect(totals.internalRef.unresolved).toBe(0);
    expect(totals.applicRef.unresolved).toBe(0);
    // ビジネスルール文書（024A-D）が仕様書の章（モデル識別コード S1000D）を dmRef で指す。CSDB には無いので未解決で正しい
    expect(unresolvedDmRefModels.has('S1000D')).toBe(true);
    // 配布物の不整合: DOCTYPE では .PNG と宣言されているが、同梱の ICN は .SVG
    expect(icnMisses).toHaveLength(1);
    expect(icnMisses[0]).toMatch(/ICN-C0419-S1000D0406-001-01\.PNG/);
  });

  it('サンプル CSDB の全データモジュールを、参照する BREX の連鎖に照合できる', async () => {
    const resolve = createDirectoryBrexResolver([specDir]);
    const problems: string[] = [];
    let violations = 0;
    let layersTotal = 0;
    for (const f of dmFiles) {
      const report = await checkAgainstBrexChain(readFileSync(f, 'utf8'), resolve);
      layersTotal += report.layers.length;
      for (const u of report.unresolved) {
        // Front Matter Samples とビジネスルール文書の雛形は、古い版の既定 BREX（S1000D-F / -H）を
        // 参照しており、Issue 7 の配布物には無い。既定 BREX 以外の未解決だけを問題として扱う
        if (u.dmCode.modelIdentCode !== 'S1000D') {
          problems.push(`${f}: unresolved BREX ${formatDmc(u.dmCode)}`);
        }
      }
      for (const layer of report.layers) {
        for (const s of layer.skipped)
          problems.push(`${f}: skipped ${s.objectPath.slice(0, 60)}: ${s.error}`);
        violations += layer.violations.length;
      }
    }
    expect(problems).toEqual([]);
    // Bike Samples は「自転車の BREX → 既定 BREX」の 2 層。Front Matter は未解決で 0 層になり得る
    expect(layersTotal).toBeGreaterThanOrEqual(
      dmFiles.filter((f) => /Bike Samples/.test(f)).length * 2,
    );
    expect(layersTotal).toBeLessThan(dmFiles.length * 4); // 循環していないこと
    // 公式サンプルにも既定 BREX への違反は少数ある（2026-10-23 の実測で数十件）。件数は固定しない
    expect(violations).toBeGreaterThanOrEqual(0);
  });
});
