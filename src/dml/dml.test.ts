import { describe, expect, it } from 'vitest';
import { CsdbIndex } from '../csdb-index.js';
import { MemoryCsdbSource, classifyCsdbFileName } from '../csdb-source.js';
import { formatDmlCode, parseDdnFileName, parseDmlCode, parseDmlFileName } from './code.js';
import { readDdn, readDml } from './read.js';
import { reconcileDdn, reconcileDml } from './reconcile.js';

const DM_CODE = (sys: string, info: string) =>
  `<dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="${sys}" subSystemCode="2" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="${info}" infoCodeVariant="A" itemLocationCode="D"/>`;

const DML = `<?xml version="1.0" encoding="UTF-8"?>
<dml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_7/xml_schema_flat/dml.xsd">
  <identAndStatusSection>
    <dmlAddress>
      <dmlIdent>
        <dmlCode modelIdentCode="KENBAIKI" senderIdent="K0001" dmlType="s" yearOfDataIssue="2026" seqNumber="00001"/>
        <issueInfo issueNumber="001" inWork="00"/>
      </dmlIdent>
      <dmlAddressItems><issueDate year="2026" month="10" day="27"/></dmlAddressItems>
    </dmlAddress>
    <dmlStatus issueType="new">
      <security securityClassification="01"/>
      <brexDmRef><dmRef><dmRefIdent>${DM_CODE('00', '022')}</dmRefIdent></dmRef></brexDmRef>
    </dmlStatus>
  </identAndStatusSection>
  <dmlContent>
    <dmlEntry dmlEntryType="n">
      <dmRef>
        <dmRefIdent>${DM_CODE('10', '040')}<issueInfo issueNumber="002" inWork="01"/><language languageIsoCode="ja" countryIsoCode="JP"/></dmRefIdent>
        <dmRefAddressItems><dmTitle><techName>券売機</techName><infoName>説明</infoName></dmTitle></dmRefAddressItems>
      </dmRef>
      <responsiblePartnerCompany enterpriseCode="K0001"><enterpriseName>KB Works</enterpriseName></responsiblePartnerCompany>
    </dmlEntry>
    <dmlEntry>
      <dmRef><dmRefIdent>${DM_CODE('10', '040')}<issueInfo issueNumber="003" inWork="00"/></dmRefIdent></dmRef>
      <responsiblePartnerCompany enterpriseCode="K0001"/>
    </dmlEntry>
    <dmlEntry>
      <dmRef><dmRefIdent>${DM_CODE('99', '040')}</dmRefIdent></dmRef>
      <responsiblePartnerCompany enterpriseCode="K0001"/>
      <remarks><simplePara>まだ書いていない</simplePara></remarks>
    </dmlEntry>
    <dmlEntry>
      <pmRef><pmRefIdent><pmCode modelIdentCode="KENBAIKI" pmIssuer="K0001" pmNumber="OPM01" pmVolume="00"/></pmRefIdent><pmRefAddressItems><pmTitle>操作説明書</pmTitle></pmRefAddressItems></pmRef>
      <responsiblePartnerCompany enterpriseCode="K0001"/>
    </dmlEntry>
    <dmlEntry>
      <infoEntityRef infoEntityRefIdent="ICN-K0001-00001-001-01"/>
      <responsiblePartnerCompany enterpriseCode="K0001"/>
    </dmlEntry>
    <dmlEntry>
      <infoEntityRef infoEntityRefIdent="ICN-K0001-99999-001-01"/>
      <responsiblePartnerCompany enterpriseCode="K0001"/>
    </dmlEntry>
    <dmlEntry>
      <dmlRef><dmlRefIdent><dmlCode modelIdentCode="KENBAIKI" senderIdent="K0001" dmlType="c" yearOfDataIssue="2026" seqNumber="00002"/></dmlRefIdent></dmlRef>
      <responsiblePartnerCompany enterpriseCode="K0001"/>
    </dmlEntry>
    <dmlEntry>
      <commentRef><commentRefIdent><commentCode modelIdentCode="KENBAIKI" senderIdent="K0001" yearOfDataIssue="2026" seqNumber="00001" commentType="q"/></commentRefIdent></commentRef>
      <responsiblePartnerCompany enterpriseCode="K0001"/>
    </dmlEntry>
  </dmlContent>
</dml>`;

const DDN = `<?xml version="1.0" encoding="UTF-8"?>
<ddn xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_7/xml_schema_flat/ddn.xsd">
  <identAndStatusSection>
    <ddnAddress>
      <ddnIdent><ddnCode modelIdentCode="KENBAIKI" senderIdent="K0001" receiverIdent="K0002" yearOfDataIssue="2026" seqNumber="00001"/></ddnIdent>
      <ddnAddressItems>
        <issueDate year="2026" month="10" day="27"/>
        <dispatchTo><dispatchAddress><enterprise><enterpriseName>受け手</enterpriseName></enterprise></dispatchAddress></dispatchTo>
        <dispatchFrom><dispatchAddress><enterprise><enterpriseName>KB Works</enterpriseName></enterprise></dispatchAddress></dispatchFrom>
      </ddnAddressItems>
    </ddnAddress>
    <ddnStatus><security securityClassification="01"/></ddnStatus>
  </identAndStatusSection>
  <ddnContent>
    <mediaIdent label="delivery-1"/>
    <deliveryList>
      <deliveryListItem><dispatchFileName>DMC-KENBAIKI-A-10-20-00-00A-040A-D_002-01_JA-JP.XML</dispatchFileName><issueInfo issueNumber="002" inWork="01"/></deliveryListItem>
      <deliveryListItem><dispatchFileName>DMC-KENBAIKI-A-10-20-00-00A-040A-D_003-00_JA-JP.XML</dispatchFileName></deliveryListItem>
      <deliveryListItem><dispatchFileName>DMC-KENBAIKI-A-99-20-00-00A-040A-D_001-00_JA-JP.XML</dispatchFileName></deliveryListItem>
      <deliveryListItem><dispatchFileName>ICN-K0001-00001-001-01.SVG</dispatchFileName><entityControlNumber>ICN-K0001-00001-001-01</entityControlNumber></deliveryListItem>
      <deliveryListItem><dispatchFileName>readme.txt</dispatchFileName></deliveryListItem>
    </deliveryList>
  </ddnContent>
</ddn>`;

const csdb = () =>
  CsdbIndex.fromSource(
    new MemoryCsdbSource([
      { fileName: 'DMC-KENBAIKI-A-10-20-00-00A-040A-D_002-01_JA-JP.XML', xml: '<dmodule/>' },
      { fileName: 'DMC-KENBAIKI-A-10-20-00-00A-520A-A_001-00_JA-JP.XML', xml: '<dmodule/>' },
      { fileName: 'DMC-OTHER-A-10-20-00-00A-040A-D_001-00_JA-JP.XML', xml: '<dmodule/>' },
      { fileName: 'PMC-KENBAIKI-K0001-OPM01-00_001-00_JA-JP.XML', xml: '<pm/>' },
      { fileName: 'PMC-KENBAIKI-K0001-OPM02-00_001-00_JA-JP.XML', xml: '<pm/>' },
      { fileName: 'ICN-K0001-00001-001-01.SVG' },
      { fileName: 'DML-KENBAIKI-K0001-C-2026-00002_001-00.XML', xml: '<dml/>' },
    ]),
  );

describe('DML・DDN のコードとファイル名', () => {
  it('parseDmlCode / parseDmlFileName / formatDmlCode', () => {
    const r = parseDmlFileName('DML-S1000DBIKE-B6865-S-2026-00001_001-00.XML');
    expect(r.ok && r.value.dmlCode).toEqual({
      modelIdentCode: 'S1000DBIKE',
      senderIdent: 'B6865',
      dmlType: 's',
      yearOfDataIssue: '2026',
      seqNumber: '00001',
    });
    expect(r.ok && r.value.issueInfo).toEqual({ issueNumber: '001', inWork: '00' });
    expect(r.ok && formatDmlCode(r.value.dmlCode)).toBe('S1000DBIKE-B6865-S-2026-00001');
    expect(parseDmlCode('DML-S1000DBIKE-B6865-s-2026-00001').ok).toBe(true);
    expect(parseDmlCode('S1000DBIKE-B6865-2026-00001').ok).toBe(false);
    expect(parseDmlFileName('DML-notes.txt').ok).toBe(false);
  });
  it('parseDdnFileName', () => {
    const r = parseDdnFileName('DDN-S1000DBIKE-B6865-B6865-2026-00001.XML');
    expect(r.ok && r.value.ddnCode.receiverIdent).toBe('B6865');
    expect(parseDdnFileName('DDN-S1000DBIKE-B6865-2026-00001.XML').ok).toBe(false);
  });
  it('classifyCsdbFileName は dml / ddn のコードも読む', () => {
    expect(
      classifyCsdbFileName('DML-S1000DBIKE-B6865-S-2026-00001_001-00.XML')?.dml?.dmlCode.seqNumber,
    ).toBe('00001');
    expect(
      classifyCsdbFileName('DDN-S1000DBIKE-B6865-B6865-2026-00001.XML')?.ddn?.ddnCode.seqNumber,
    ).toBe('00001');
    expect(classifyCsdbFileName('DML-odd-name.XML')?.dml).toBeUndefined();
  });
});

describe('readDml', () => {
  it('識別・状態部と行を読む', () => {
    const r = readDml(DML);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(formatDmlCode(r.value.dmlCode)).toBe('KENBAIKI-K0001-S-2026-00001');
    expect(r.value.issueInfo).toEqual({ issueNumber: '001', inWork: '00' });
    expect(r.value.issueDate).toBe('2026-10-27');
    expect(r.value.issueType).toBe('new');
    expect(r.value.securityClassification).toBe('01');
    expect(r.value.brexDmRef?.dmCode.infoCode).toBe('022');
    expect(r.value.entries.map((e) => e.kind)).toEqual([
      'dm',
      'dm',
      'dm',
      'pm',
      'icn',
      'icn',
      'dml',
      'comment',
    ]);
    const first = r.value.entries[0]!;
    expect(first.target).toBe('KENBAIKI-A-10-20-00-00A-040A-D');
    expect(first.dmRef?.issueInfo).toEqual({ issueNumber: '002', inWork: '01' });
    expect(first.dmRef?.language).toEqual({ languageIsoCode: 'ja', countryIsoCode: 'JP' });
    expect(first.title).toBe('券売機 - 説明');
    expect(first.dmlEntryType).toBe('n');
    expect(first.responsiblePartnerCompany).toEqual({
      enterpriseCode: 'K0001',
      enterpriseName: 'KB Works',
    });
    expect(first.location.path).toContain('dmlEntry');
    expect(r.value.entries[2]!.remarks).toBe('まだ書いていない');
    expect(r.value.entries[3]!.title).toBe('操作説明書');
    expect(r.value.entries[6]!.target).toBe('KENBAIKI-K0001-C-2026-00002');
    expect(r.value.entries[7]!.target).toBe('KENBAIKI-K0001-2026-00001-q');
  });
  it('dml 以外のルートは失敗', () => {
    const r = readDml('<dmodule/>');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Not a data module list/);
  });
});

describe('readDdn', () => {
  it('納入物の一覧を読む', () => {
    const r = readDdn(DDN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ddnCode.receiverIdent).toBe('K0002');
    expect(r.value.issueDate).toBe('2026-10-27');
    expect(r.value.dispatchTo).toBe('受け手');
    expect(r.value.dispatchFrom).toBe('KB Works');
    expect(r.value.mediaIdent).toBe('delivery-1');
    expect(r.value.items).toHaveLength(5);
    expect(r.value.items[0]!.issueInfo).toEqual({ issueNumber: '002', inWork: '01' });
    expect(r.value.items[3]!.entityControlNumber).toBe('ICN-K0001-00001-001-01');
  });
});

describe('reconcileDml', () => {
  it('found / issue-mismatch / not-found / not-checked と、DML に無い DM・PM を返す', () => {
    const dml = readDml(DML);
    if (!dml.ok) throw new Error(dml.error);
    const r = reconcileDml(dml.value, csdb());
    expect(r.dmlCode).toBe('KENBAIKI-K0001-S-2026-00001');
    expect(r.entryCount).toBe(8);
    expect(r.entries.map((e) => e.state)).toEqual([
      'found',
      'issue-mismatch',
      'not-found',
      'found',
      'found',
      'not-found',
      'found',
      'not-checked',
    ]);
    expect(r.counts).toEqual({ found: 4, 'issue-mismatch': 1, 'not-found': 2, 'not-checked': 1 });
    expect(r.entries[1]!.foundIssueInfo).toEqual({ issueNumber: '002', inWork: '01' });
    expect(r.entries[1]!.reason).toMatch(/lists issue 003-00; the CSDB has 002-01/);
    expect(r.entries[0]!.path).toBe('DMC-KENBAIKI-A-10-20-00-00A-040A-D_002-01_JA-JP.XML');
    // KENBAIKI の 520A の DM と OPM02 の PM は DML に無い。OTHER の DM は別のモデルなので対象外
    expect(r.notListed.map((o) => o.target).sort()).toEqual([
      'KENBAIKI-A-10-20-00-00A-520A-A',
      'KENBAIKI-K0001-OPM02-00',
    ]);
  });
  it('includeNotListed: false と modelIdentCodes', () => {
    const dml = readDml(DML);
    if (!dml.ok) throw new Error(dml.error);
    expect(reconcileDml(dml.value, csdb(), { includeNotListed: false }).notListed).toEqual([]);
    const other = reconcileDml(dml.value, csdb(), { modelIdentCodes: ['OTHER'] });
    expect(other.notListed.map((o) => o.target)).toEqual(['OTHER-A-10-20-00-00A-040A-D']);
  });
});

describe('reconcileDdn', () => {
  it('ファイル名で照合し、版違いは issue-mismatch', () => {
    const ddn = readDdn(DDN);
    if (!ddn.ok) throw new Error(ddn.error);
    const r = reconcileDdn(ddn.value, csdb());
    expect(r.ddnCode).toBe('KENBAIKI-K0001-K0002-2026-00001');
    expect(r.items.map((i) => i.state)).toEqual([
      'found',
      'issue-mismatch',
      'not-found',
      'found',
      'not-found',
    ]);
    expect(r.items[1]!.foundIssueInfo).toEqual({ issueNumber: '002', inWork: '01' });
    expect(r.counts.found).toBe(2);
  });
});
