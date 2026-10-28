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
import { readDdn, readDml, reconcileDdn, reconcileDml } from './dml/index.js';
import { measureContent, outlineContent } from './content/outline.js';
import { collectReferences, resolveReferences } from './refs/index.js';
import { ApplicEvaluator, productFromPct, readAct, readCct, readPct } from './applic/index.js';
import { countNodes, readContentFromXml } from './content/index.js';
import { Libxml2SchemaValidator } from './xsd-libxml2.js';
import { resolveBrexChain } from './brex/chain.js';
import { suggestFixes } from './fix/index.js';

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

  it('サンプル CSDB の ACT・CCT・PCT を読み、PCT の各製品で全データモジュールの適用性を判定できる', () => {
    const bikeDir = dirname(dmFiles.find((f) => /bike/i.test(f))!);
    const index = CsdbIndex.fromDirs([bikeDir]);
    const docOf = (infoCode: string, model = 'S1000DBIKE') => {
      const o = index.objects.find(
        (x) => x.dm && x.dm.dmCode.modelIdentCode === model && x.dm.dmCode.infoCode === infoCode,
      );
      expect(o, `${model} ${infoCode}`).toBeDefined();
      return defaultXmlEngine.parse(readFileSync(o!.path, 'utf8')).document;
    };
    const act = readAct(docOf('00W'))!;
    const cct = readCct(docOf('00Q'))!;
    const pct = readPct(docOf('00P'))!;
    expect(act.productAttributes.map((a) => a.id)).toContain('model');
    expect(act.condCrossRefTableRef?.dmCode.infoCode).toBe('00Q');
    expect(act.productCrossRefTableRef?.dmCode.infoCode).toBe('00P');
    expect(cct.condTypes.length).toBeGreaterThan(0);
    expect(cct.conds.length).toBeGreaterThan(0);
    expect(pct.products.length).toBeGreaterThan(0);

    const dms = index.objects.filter((o) => o.kind === 'dm');
    const tally: Record<string, number> = { applicable: 0, notApplicable: 0, undetermined: 0 };
    let elementsChecked = 0;
    const undeterminedReasons = new Set<string>();
    for (const row of pct.products) {
      const product = productFromPct(row);
      for (const o of dms) {
        const doc = defaultXmlEngine.parse(readFileSync(o.path, 'utf8')).document;
        const ev = new ApplicEvaluator(doc);
        const dm = ev.dmLevel(product);
        tally[dm.state]++;
        if (dm.state === 'undetermined' && dm.reason) undeterminedReasons.add(dm.reason);
        for (const n of defaultXmlEngine.selectNodes('//*[@applicRefId]', doc)) {
          const r = ev.forElement(n as never, product);
          tally[r.state]++;
          elementsChecked++;
          if (r.state === 'undetermined' && r.reason)
            undeterminedReasons.add(r.reason.replace(/"[^"]*"/g, '"…"'));
        }
      }
    }
    expect(elementsChecked).toBeGreaterThan(300);
    // どの製品でも判定が出る DM があり、外れる DM もある
    expect(tally.applicable).toBeGreaterThan(0);
    expect(tally.notApplicable).toBeGreaterThan(0);
    // undetermined の理由は「製品に無い属性」か「リポジトリに無い applicIdentValue」だけで、構文の読めなさは無い
    for (const r of undeterminedReasons) {
      expect(r).toMatch(
        /product has no value for|not found in the applicability repository|no applic with id/,
      );
    }
  });

  it('サンプル CSDB の本文を 5 種（descript / proced / process / fault / pm）とも例外なく読める', () => {
    const bikeDir = dirname(dmFiles.find((f) => /bike/i.test(f))!);
    const index = CsdbIndex.fromDirs([bikeDir]);
    const files: Record<string, number> = {};
    const nodes: Record<string, Record<string, number>> = {};
    const unknown: Record<string, Set<string>> = {};
    for (const o of index.objects.filter((x) => x.kind === 'dm' || x.kind === 'pm')) {
      const c = readContentFromXml(readFileSync(o.path, 'utf8'));
      files[c.kind] = (files[c.kind] ?? 0) + 1;
      nodes[c.kind] ??= {};
      for (const [k, v] of Object.entries(countNodes(c.blocks)))
        nodes[c.kind][k] = (nodes[c.kind][k] ?? 0) + v;
      for (const k of Object.keys(c.unknownElements)) (unknown[c.kind] ??= new Set()).add(k);
    }
    expect(files).toMatchObject({ descript: 14, proced: 39, process: 1, fault: 5, pm: 4 });
    // 2026-10-25 の実測。読み取り部分を広げたら更新する
    expect(nodes.descript).toMatchObject({ section: 29, para: 72, figure: 20, table: 1 });
    expect(nodes.proced).toMatchObject({ requirements: 78, step: 330, figure: 26 });
    expect(nodes.pm).toEqual({ section: 4, entry: 110 });
    expect(nodes.fault.step).toBe(6);
    expect(nodes.process).toMatchObject({ sequence: 4, if: 1 });
    // descript と pm には知らない要素が無い。proced の未知は回路遮断器（circuitBreaker…）の群だけ
    expect(unknown.descript).toBeUndefined();
    expect(unknown.pm).toBeUndefined();
    expect(
      [...(unknown.proced ?? [])].every((n) => /^circuitBreaker|^name$|^accessPointRef$/.test(n)),
    ).toBe(true);
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
  }, 60000);

  it('XSD 違反の修正候補を公式 XSD の定義（xml_schema_flat）から作る', async () => {
    const schemaDirs = findSchemaDirs([specDir]).filter((d) => !/data_dictionary/i.test(d.dir));
    const validator = new Libxml2SchemaValidator();
    try {
      const file = dmFiles.find(
        (f) =>
          /bike/i.test(f) &&
          /descript\.xsd/.test(readFileSync(f, 'utf8')) &&
          readFileSync(f, 'utf8').includes('securityClassification="01"'),
      )!;
      const xml = readFileSync(file, 'utf8')
        .replace('securityClassification="01"', 'securityClassification="XX"')
        .replace('<para>', '<para bogusAttr="1">');
      const r = await verifyDataModule(xml, { path: file, schema: { validator, schemaDirs } });
      expect(r.status.schema.state).toBe('invalid');
      const fixes = suggestFixes(r, { xml });
      const sec = fixes.find((f) => f.location?.path.endsWith('@securityClassification'));
      expect(sec?.source).toMatch(/xs:simpleType name="securityClassificationAttType"/);
      expect(sec?.candidates.map((c) => c.value)).toContain('01');
      const bogus = fixes.find((f) => f.problem.includes("'bogusAttr'"));
      expect(bogus?.candidates[0]).toMatchObject({ action: 'remove', target: '@bogusAttr' });
      expect(bogus?.note).toMatch(/^Attributes allowed on para: /);
      expect(bogus?.source).toBe('descript.xsd xs:element name="para"');
    } finally {
      validator.dispose();
    }
  });

  it('サンプル CSDB の BREX 違反と未解決の参照のすべてに修正提案が付く', async () => {
    const resolver = createDirectoryBrexResolver([specDir]);
    const bikeFiles = dmFiles.filter((f) => /Bike Samples/.test(f));
    const csdb = CsdbIndex.fromDirs([dirname(bikeFiles[0])]);
    let expected = 0;
    let got = 0;
    let withCandidates = 0;
    for (const f of bikeFiles) {
      const xml = readFileSync(f, 'utf8');
      const r = await verifyDataModule(xml, { path: f, brex: { resolver }, references: { csdb } });
      const info = readDataModuleInfo(xml);
      const chain = await resolveBrexChain(info.identAndStatus?.brexDmRef, resolver);
      const fixes = suggestFixes(r, { xml, csdb, brexLayers: chain.layers });
      expected +=
        r.status.brex.violationCount +
        (r.references?.unresolved.length ?? 0) +
        (r.references?.resolved.filter((x) => x.issueMismatch && x.foundIssueInfo).length ?? 0);
      got += fixes.length;
      withCandidates += fixes.filter((x) => x.candidates.length > 0).length;
      for (const x of fixes) expect(['exact', 'several', 'none']).toContain(x.confidence);
    }
    expect(got).toBe(expected);
    expect(withCandidates).toBeGreaterThan(0);
  }, 60000);

  it('Bike Samples の DML と DDN を読み、CSDB と照合できる', () => {
    const bikeFile = dmFiles.find((f) => /bike/i.test(f))!;
    const bikeDir = dirname(bikeFile);
    const index = CsdbIndex.fromDirs([bikeDir]);
    const dmlObj = index.objects.find((o) => o.kind === 'dml');
    const ddnObj = index.objects.find((o) => o.kind === 'ddn');
    expect(dmlObj?.dml?.dmlCode.modelIdentCode).toBe('S1000DBIKE');
    expect(ddnObj?.ddn?.ddnCode.modelIdentCode).toBe('S1000DBIKE');
    const dml = readDml(index.read(dmlObj!));
    expect(dml.ok).toBe(true);
    if (!dml.ok) return;
    expect(dml.value.entries.length).toBeGreaterThan(100);
    expect(dml.value.entries.every((e) => e.kind === 'dm' || e.kind === 'pm')).toBe(true);
    const rec = reconcileDml(dml.value, index);
    // Bike Samples の DML は CSDB の DM・PM をすべて挙げ、版も一致する（配布物の実測）
    expect(rec.counts['not-found']).toBe(0);
    expect(rec.counts['issue-mismatch']).toBe(0);
    expect(rec.counts.found).toBe(rec.entryCount);
    const ddn = readDdn(index.read(ddnObj!));
    expect(ddn.ok).toBe(true);
    if (!ddn.ok) return;
    expect(ddn.value.items.length).toBeGreaterThan(100);
    const drec = reconcileDdn(ddn.value, index);
    // 配布物の実測: DDN が挙げる 184 件のうち、IMF-C0419-S1000D0392-002-01 は版違い（DDN は _000-01、CSDB は _001-00）、
    // ICN-C0419-S1000D0NNN-001-01（.SVG と IMF 2 件）は配布物に無い。DME-（拡張 DMC）の 2 件は索引が kind dme で拾う
    expect(drec.counts['issue-mismatch']).toBe(1);
    expect(drec.counts['not-found']).toBe(3);
    expect(
      drec.items
        .filter((i) => i.state === 'not-found')
        .every((i) => /S1000D0NNN/.test(i.item.fileName)),
    ).toBe(true);
    expect(index.objects.filter((o) => o.kind === 'dme')).toHaveLength(2);
  });

  it('サンプル CSDB の全データモジュールの概要（outline）と大きさを例外なく作れる', () => {
    const bikeFile = dmFiles.find((f) => /bike/i.test(f))!;
    const files = dmFiles.filter((f) => dirname(f) === dirname(bikeFile));
    let outlined = 0;
    let withSecurity = 0;
    for (const f of files) {
      const c = readContentFromXml(readFileSync(f, 'utf8'));
      if (!c.structured) continue;
      const size = measureContent(c.blocks);
      const o = outlineContent(c.blocks);
      expect(o.reduce((a, n) => a + n.size.nodes, 0)).toBeLessThanOrEqual(size.nodes);
      // 概要は全文より小さい（節点の数で）
      const count = (ns: typeof o): number => ns.reduce((a, n) => a + 1 + count(n.children), 0);
      expect(count(o)).toBeLessThanOrEqual(size.nodes);
      if (o.some((n) => n.securityClassification)) withSecurity++;
      outlined++;
    }
    // Bike Samples 106 件のうち構造化できる 5 種（descript / proced / process / fault / pm）は 59 件
    expect(outlined).toBeGreaterThan(50);
    expect(withSecurity).toBeGreaterThanOrEqual(0);
  });
});
