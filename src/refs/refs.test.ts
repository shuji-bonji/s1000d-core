import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CsdbIndex, listCsdbObjects } from '../csdb-index.js';
import { formatPmc, parsePmc, parsePmcFileName } from '../pmc.js';
import { defaultXmlEngine } from '../xml/index.js';
import { verifyDataModule } from '../verify/verify.js';
import { collectReferences, readEntityDeclarations } from './collect.js';
import { resolveReferences } from './resolve.js';

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), 'utf8');

/** 自作の、参照をいろいろ含む説明データモジュール */
const DM_WITH_REFS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE dmodule [
  <!ENTITY ICN-K0001-00001-001-01 SYSTEM "ICN-K0001-00001-001-01.PNG" NDATA png>
  <!ENTITY ICN-K0001-00002-001-01 SYSTEM 'ICN-K0001-00002-001-01.SVG' NDATA svg>
]>
<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_7/xml_schema_flat/descript.xsd">
  <identAndStatusSection>
    <dmAddress><dmIdent>
      <dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="10" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="040" infoCodeVariant="A" itemLocationCode="A"/>
      <language languageIsoCode="ja" countryIsoCode="JP"/><issueInfo issueNumber="001" inWork="00"/>
    </dmIdent><dmAddressItems><issueDate year="2026" month="10" day="25"/><dmTitle><techName>券売機</techName><infoName>参照のテスト</infoName></dmTitle></dmAddressItems></dmAddress>
    <dmStatus issueType="new"><security securityClassification="01"/>
      <responsiblePartnerCompany enterpriseCode="K0001"/><originator enterpriseCode="K0001"/>
      <applicCrossRefTableRef><dmRef><dmRefIdent>
        <dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="00" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="00W" infoCodeVariant="A" itemLocationCode="D"/>
      </dmRefIdent></dmRef></applicCrossRefTableRef>
      <applic><displayText><simplePara>All</simplePara></displayText></applic>
      <brexDmRef><dmRef><dmRefIdent>
        <dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="00" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="022" infoCodeVariant="A" itemLocationCode="D"/>
      </dmRefIdent></dmRef></brexDmRef>
      <qualityAssurance><unverified/></qualityAssurance>
    </dmStatus>
  </identAndStatusSection>
  <content>
    <referencedApplicGroup><applic id="app-0001"><displayText><simplePara>MV-50</simplePara></displayText></applic></referencedApplicGroup>
    <referencedApplicGroupRef><applicRef applicIdentValue="app-0000000A040A-0002" id="app-0002"/></referencedApplicGroupRef>
    <description>
      <levelledPara id="par-0001" applicRefId="app-0001">
        <title>画面</title>
        <para>図 <internalRef internalRefId="fig-0001" internalRefTargetType="irtt01"/> と、無い図 <internalRef internalRefId="fig-9999" internalRefTargetType="irtt01"/>。</para>
        <para>段落 <internalRef internalRefId="par-0001" internalRefTargetType="irtt07"/>。</para>
        <para applicRefId="app-9999">無い適用性。</para>
        <para applicRefId="app-0002">別の DM にある適用性。</para>
        <para>手順は <dmRef><dmRefIdent>
          <dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="10" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="520" infoCodeVariant="A" itemLocationCode="A"/>
          <issueInfo issueNumber="002" inWork="00"/>
        </dmRefIdent></dmRef> と、無い DM <dmRef><dmRefIdent>
          <dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="99" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="040" infoCodeVariant="A" itemLocationCode="A"/>
        </dmRefIdent></dmRef>、出版物 <pmRef><pmRefIdent><pmCode modelIdentCode="KENBAIKI" pmIssuer="K0001" pmNumber="OPM01" pmVolume="00"/></pmRefIdent></pmRef>。</para>
        <figure id="fig-0001"><title>画面</title>
          <graphic infoEntityIdent="ICN-K0001-00001-001-01"/>
          <graphic infoEntityIdent="ICN-K0001-00002-001-01"/>
          <graphic infoEntityIdent="ICN-K0001-00003-001-01"/>
        </figure>
      </levelledPara>
    </description>
  </content>
</dmodule>`;

let csdbDir: string;

beforeAll(() => {
  csdbDir = mkdtempSync(join(tmpdir(), 's1000d-core-refs-'));
  // 参照先: 手順 DM は 001 と 002 の 2 版、ACT、BREX、PMC、ICN は PNG だけ（SVG は宣言はあるがファイルが無い）
  const stub = () => `<dmodule><identAndStatusSection/><content/></dmodule>`;
  writeFileSync(join(csdbDir, 'DMC-KENBAIKI-A-10-00-00-00A-520A-A_001-00_JA-JP.XML'), stub());
  writeFileSync(join(csdbDir, 'DMC-KENBAIKI-A-10-00-00-00A-520A-A_002-00_JA-JP.XML'), stub());
  writeFileSync(join(csdbDir, 'DMC-KENBAIKI-A-00-00-00-00A-00WA-D_001-00_JA-JP.XML'), stub());
  writeFileSync(
    join(csdbDir, 'DMC-KENBAIKI-A-00-00-00-00A-022A-D_002-00_JA-JP.XML'),
    fx('kenbaiki-brex.xml'),
  );
  writeFileSync(join(csdbDir, 'PMC-KENBAIKI-K0001-OPM01-00_001-00_JA-JP.XML'), '<pm/>');
  writeFileSync(join(csdbDir, 'ICN-K0001-00001-001-01.PNG'), 'not really a png');
  writeFileSync(join(csdbDir, 'DML-KENBAIKI-K0001-C-2026-00001_001-00.XML'), '<dml/>');
  writeFileSync(join(csdbDir, 'README.txt'), 'ignored');
});

afterAll(() => {
  rmSync(csdbDir, { recursive: true, force: true });
});

describe('PMC', () => {
  it('PMC とファイル名を分解できる', () => {
    const r = parsePmcFileName('PMC-S1000DBIKE-B6865-EPWG1-00_006-00_EN-US.XML');
    expect(r.ok && r.value.pmCode).toEqual({
      modelIdentCode: 'S1000DBIKE',
      pmIssuer: 'B6865',
      pmNumber: 'EPWG1',
      pmVolume: '00',
    });
    expect(r.ok && r.value.issueInfo).toEqual({ issueNumber: '006', inWork: '00' });
    expect(r.ok && r.value.language).toEqual({ languageIsoCode: 'en', countryIsoCode: 'US' });
    const p = parsePmc('PMC-KENBAIKI-K0001-OPM01-00');
    expect(p.ok && formatPmc(p.value)).toBe('KENBAIKI-K0001-OPM01-00');
    expect(parsePmc('KENBAIKI-K0001').ok).toBe(false);
  });
});

describe('listCsdbObjects / CsdbIndex', () => {
  it('DMC 以外（PMC・DML・ICN）も拾い、XML でないものは ICN だけ', () => {
    const objs = listCsdbObjects([csdbDir]);
    const kinds = objs.map((o) => o.kind).sort();
    expect(kinds).toEqual(['dm', 'dm', 'dm', 'dm', 'dml', 'icn', 'pm']);
    const index = new CsdbIndex(objs);
    const found = index.findDataModules({
      modelIdentCode: 'KENBAIKI',
      systemDiffCode: 'A',
      systemCode: '10',
      subSystemCode: '0',
      subSubSystemCode: '0',
      assyCode: '00',
      disassyCode: '00',
      disassyCodeVariant: 'A',
      infoCode: '520',
      infoCodeVariant: 'A',
      itemLocationCode: 'A',
    });
    expect(found.map((o) => o.dm?.issueInfo?.issueNumber)).toEqual(['002', '001']);
    expect(index.findByFileName('icn-k0001-00001-001-01.png')).toHaveLength(1);
    expect(index.findByFileName('/some/where/ICN-K0001-00001-001-01.PNG')).toHaveLength(1);
  });
});

describe('collectReferences / resolveReferences', () => {
  it('ENTITY 宣言を読む（SYSTEM の引用符は両方、PUBLIC も）', () => {
    const m = readEntityDeclarations(
      `<!ENTITY a SYSTEM "a.png" NDATA png> <!ENTITY b SYSTEM 'b.svg'> <!ENTITY c PUBLIC "-//X//EN" "c.cgm" NDATA cgm> <!ENTITY % p SYSTEM "p.ent">`,
    );
    expect(m.get('a')).toEqual({ name: 'a', systemId: 'a.png', notation: 'png' });
    expect(m.get('b')).toEqual({ name: 'b', systemId: 'b.svg' });
    expect(m.get('c')).toEqual({
      name: 'c',
      publicId: '-//X//EN',
      systemId: 'c.cgm',
      notation: 'cgm',
    });
    expect(m.has('p')).toBe(false);
  });

  it('5 種類の参照を集め、文脈と場所を付ける', () => {
    const { document } = defaultXmlEngine.parse(DM_WITH_REFS);
    const c = collectReferences(document);
    const byKind = (k: string) => c.references.filter((r) => r.kind === k);
    expect(byKind('dmRef')).toHaveLength(4);
    expect(
      byKind('dmRef')
        .map((r) => r.context)
        .sort(),
    ).toEqual(['applicCrossRefTableRef', 'brexDmRef', 'para', 'para']);
    expect(byKind('pmRef')).toHaveLength(1);
    expect(byKind('icn')).toHaveLength(3);
    expect(byKind('internalRef')).toHaveLength(3);
    expect(byKind('applicRef')).toHaveLength(3);
    expect(c.applicRefIds.get('app-0002')).toBe('app-0000000A040A-0002');
    expect(c.entities.size).toBe(2);
    expect([...c.applicIds]).toEqual(['app-0001']);
    expect(c.ids.has('fig-0001')).toBe(true);
    const fig = byKind('icn')[0];
    expect(fig.location.path).toMatch(/figure\/graphic\[1\]$/);
    expect(fig.location.line).toBeGreaterThan(1);
  });

  it('参照先の有無を判定し、理由を分ける', () => {
    const { document } = defaultXmlEngine.parse(DM_WITH_REFS);
    const report = resolveReferences(collectReferences(document), {
      csdb: CsdbIndex.fromDirs([csdbDir]),
    });
    expect(report.checked).toBe(14);
    expect(report.resolved.find((r) => r.target === 'app-0002')?.externalApplic).toBe(
      'app-0000000A040A-0002',
    );
    const reasons = report.unresolved
      .map((u) => `${u.reference.kind}:${u.target}:${u.reason}`)
      .sort();
    expect(reasons).toEqual([
      'applicRef:app-9999:no-such-id',
      'dmRef:KENBAIKI-A-99-00-00-00A-040A-A:not-found',
      'icn:ICN-K0001-00002-001-01:file-not-found',
      'icn:ICN-K0001-00003-001-01:no-entity-declaration',
      'internalRef:fig-9999:no-such-id',
    ]);
    // issueInfo 002 を指す dmRef は 002 のファイルに解決し、版は一致
    const proc = report.resolved.find((r) => r.target === 'KENBAIKI-A-10-00-00-00A-520A-A');
    expect(proc?.path).toMatch(/_002-00_/);
    expect(proc?.issueMismatch).toBeUndefined();
    const icn = report.resolved.find((r) => r.target === 'ICN-K0001-00001-001-01');
    expect(icn?.notation).toBe('png');
    expect(icn?.path).toMatch(/\.PNG$/);
    expect(report.counts.dmRef).toEqual({ checked: 4, unresolved: 1 });
    expect(report.counts.icn).toEqual({ checked: 3, unresolved: 2 });
  });

  it('issueInfo が合う版が無ければ、見つかった版に issueMismatch を付ける', () => {
    const xml = DM_WITH_REFS.replace(
      '<issueInfo issueNumber="002" inWork="00"/>',
      '<issueInfo issueNumber="005" inWork="00"/>',
    );
    const { document } = defaultXmlEngine.parse(xml);
    const report = resolveReferences(collectReferences(document), {
      csdb: CsdbIndex.fromDirs([csdbDir]),
    });
    const proc = report.resolved.find((r) => r.target === 'KENBAIKI-A-10-00-00-00A-520A-A');
    expect(proc?.issueMismatch).toBe(true);
    expect(proc?.foundIssueInfo?.issueNumber).toBe('002');
  });

  it('CSDB を渡さなければ文書内の参照だけ判定し、他は no-csdb', () => {
    const { document } = defaultXmlEngine.parse(DM_WITH_REFS);
    const report = resolveReferences(collectReferences(document));
    expect(report.unresolved.filter((u) => u.reason === 'no-csdb')).toHaveLength(4 + 1 + 2); // dmRef 4、pmRef 1、宣言のある icn 2
    expect(report.resolved.map((r) => r.reference.kind).sort()).toEqual([
      'applicRef',
      'applicRef',
      'internalRef',
      'internalRef',
    ]);
  });

  it('verifyDataModule の references に反映される', async () => {
    const r = await verifyDataModule(DM_WITH_REFS, { references: { csdb: [csdbDir] } });
    expect(r.status.references).toEqual({ state: 'unresolved', checked: 14, unresolvedCount: 5 });
    expect(r.references?.unresolved).toHaveLength(5);
    const skipped = await verifyDataModule(DM_WITH_REFS, {});
    expect(skipped.status.references.state).toBe('not-run');
    expect(skipped.status.references.reason).toBe('skipped');
    const ok = await verifyDataModule(fx('kenbaiki-descript.xml'), { references: {} });
    // 自作の説明 DM: brexDmRef 1 件（CSDB 無しなので no-csdb）と ICN 1 件（宣言あり、CSDB 無し）
    expect(ok.status.references.checked).toBe(2);
    expect(ok.status.references.state).toBe('unresolved');
  });
});
