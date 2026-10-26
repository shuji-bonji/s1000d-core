import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAct, readCct, readPct } from '../applic/read.js';
import { checkAgainstBrexLayers } from '../brex/check.js';
import { readBrex } from '../brex/read.js';
import { CsdbIndex } from '../csdb-index.js';
import { collectReferences } from '../refs/collect.js';
import { resolveReferences } from '../refs/resolve.js';
import { verifyDataModule } from '../verify/verify.js';
import { defaultXmlEngine } from '../xml/index.js';
import { Libxml2SchemaValidator } from '../xsd-libxml2.js';
import { findUndeterminedApplicability, suggestApplicabilityFixes } from './applic.js';
import { suggestBrexFixes } from './brex.js';
import { suggestReferenceFixes } from './refs.js';
import { suggestSchemaFixes } from './schema.js';
import { editDistance, nearMatches } from './similar.js';
import { suggestFixes } from './suggest.js';
import { confidenceOf } from './types.js';
import { XsdIndex } from './xsd-index.js';

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), 'utf8');
const parse = (xml: string) => defaultXmlEngine.parse(xml).document;

const projectBrex = readBrex(fx('kenbaiki-brex.xml'));
if (!projectBrex.ok) throw new Error('fixture BREX failed to parse');
const dmXml = fx('kenbaiki-descript.xml');

/** 自作の最小 XSD（S1000D の XSD の内容は含まない）。名前付きの大域定義と ref で組む、xml_schema_flat と同じ書き方 */
const XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root" type="rootElemType"/>
  <xs:complexType name="rootElemType">
    <xs:sequence>
      <xs:element ref="a"/>
      <xs:group ref="tailElemGroup" minOccurs="0"/>
    </xs:sequence>
    <xs:attribute ref="kind" use="required"/>
    <xs:attributeGroup ref="codeAttGroup"/>
  </xs:complexType>
  <xs:group name="tailElemGroup"><xs:choice><xs:element ref="b"/><xs:element ref="c"/></xs:choice></xs:group>
  <xs:attributeGroup name="codeAttGroup"><xs:attribute ref="code"/><xs:attribute ref="year"/></xs:attributeGroup>
  <xs:element name="a" type="xs:string"/>
  <xs:element name="b" type="xs:string"/>
  <xs:element name="c" type="xs:string"/>
  <xs:attribute name="kind" type="kindAttType"/>
  <xs:simpleType name="kindAttType"><xs:restriction base="xs:string"><xs:enumeration value="x"/><xs:enumeration value="y"/></xs:restriction></xs:simpleType>
  <xs:attribute name="code" type="codeAttType"/>
  <xs:simpleType name="codeAttType"><xs:restriction base="xs:string"><xs:pattern value="[A-Z]{2}"/></xs:restriction></xs:simpleType>
  <xs:attribute name="year" type="xs:gYear"/>
</xs:schema>`;

describe('similar / confidenceOf', () => {
  it('編集距離と、接頭辞・大文字小文字・距離による近さ', () => {
    expect(editDistance('fig-0001', 'fig-0010')).toBe(2);
    const near = nearMatches('fig-0009', ['fig-0001', 'par-0001', 'FIG-0009', 'tab-0009']);
    // tab-0009 は距離 3 で接頭辞も違うので入らない
    expect(near.map((n) => n.value)).toEqual(['FIG-0009', 'fig-0001']);
    expect(near[0].why).toBe('case');
  });

  it('候補の数と値の書き方から 3 段階を決める', () => {
    expect(confidenceOf([])).toBe('none');
    expect(confidenceOf([{ action: 'replace', value: 'x', description: '' }])).toBe('exact');
    expect(confidenceOf([{ action: 'remove', description: '' }])).toBe('exact');
    expect(confidenceOf([{ action: 'add', description: '' }])).toBe('several');
    expect(
      confidenceOf([{ action: 'replace', value: '[A-Z]', valueForm: 'pattern', description: '' }]),
    ).toBe('several');
  });
});

describe('XsdIndex', () => {
  const xsd = XsdIndex.fromString(XSD, 'test.xsd');
  it('group・attributeGroup をたどって子要素と属性を返す', () => {
    expect(xsd.allowedChildren('root')).toEqual(['a', 'b', 'c']);
    expect(xsd.allowedAttributes('root')).toEqual(['kind', 'code', 'year']);
    expect(xsd.allowedChildren('a')).toEqual([]);
    expect(xsd.allowedChildren('nowhere')).toBeUndefined();
  });
  it('属性の型から列挙・正規表現・組み込み型を返し、定義の場所を説明する', () => {
    expect(xsd.attributeConstraint('kind', 'root')).toMatchObject({
      typeName: 'kindAttType',
      enumerations: ['x', 'y'],
    });
    expect(xsd.attributeConstraint('code')).toMatchObject({ patterns: ['[A-Z]{2}'] });
    expect(xsd.attributeConstraint('year')).toMatchObject({
      builtin: 'xs:gYear',
      enumerations: [],
    });
    expect(xsd.describe('simpleTypes', 'kindAttType')).toBe(
      'test.xsd xs:simpleType name="kindAttType"',
    );
  });
});

describe('suggestSchemaFixes', () => {
  const xsd = XsdIndex.fromString(XSD, 'test.xsd');
  // libxml2-wasm 0.7.2 が実際に出した文章（2026-10-27 に VM で確認）
  const err = (message: string, xpath: string) => ({
    message: `${message}\n`,
    line: 1,
    column: 0,
    level: 2,
    xpath,
  });

  it('列挙・正規表現の違反は文章の値を候補にし、XSD の定義を出どころにする', () => {
    const fixes = suggestSchemaFixes(
      [
        err(
          "Element 'root', attribute 'kind': [facet 'enumeration'] The value 'z' is not an element of the set {'x', 'y'}.",
          '/root',
        ),
        err(
          "Element 'root', attribute 'kind': 'z' is not a valid value of the atomic type 'kindAttType'.",
          '/root',
        ),
        err(
          "Element 'root', attribute 'code': [facet 'pattern'] The value 'abc' is not accepted by the pattern '[A-Z]{2}'.",
          '/root',
        ),
      ],
      { xsd },
    );
    expect(fixes).toHaveLength(2); // 型の不一致は facet の違反と重なるので 1 件にまとめる
    expect(fixes[0]).toMatchObject({
      kind: 'schema',
      location: { path: '/root/@kind', line: 1 },
      confidence: 'several',
      source: 'test.xsd xs:simpleType name="kindAttType"',
    });
    expect(fixes[0].candidates.map((c) => c.value)).toEqual(['x', 'y']);
    expect(fixes[1].candidates).toEqual([
      expect.objectContaining({
        action: 'replace',
        value: '[A-Z]{2}',
        valueForm: 'pattern',
        target: '@code',
      }),
    ]);
  });

  it('要素の過不足・属性の過不足を候補にする', () => {
    const fixes = suggestSchemaFixes(
      [
        err("Element 'c': This element is not expected. Expected is ( b ).", '/root/c'),
        err("Element 'root': The attribute 'kind' is required but missing.", '/root'),
        err("Element 'root', attribute 'kinf': The attribute 'kinf' is not allowed.", '/root'),
        err("Element 'b': This element is not expected.", '/root/b[2]'),
        err("Element 'root': Missing child element(s). Expected is ( a ).", '/root'),
        err('Something libxml2 says that we do not parse.', '/root'),
      ],
      { xsd },
    );
    expect(fixes.map((f) => f.candidates.map((c) => `${c.action}:${c.value ?? c.target}`))).toEqual(
      [
        ['remove:c', 'replace:b'],
        ['add:x', 'add:y'],
        ['remove:@kinf', 'replace:kind'],
        ['remove:b'],
        ['add:a'],
        [],
      ],
    );
    expect(fixes[3].confidence).toBe('several');
    expect(fixes[3].note).toContain('b is allowed in root, but not at this position');
    expect(fixes[2].note).toBe('Attributes allowed on root: kind, code, year');
    expect(fixes[4].confidence).toBe('exact');
    expect(fixes[5].confidence).toBe('none');
  });

  it('XSD が無ければ文章にある候補だけを返す', () => {
    const fixes = suggestSchemaFixes([
      err("Element 'root': The attribute 'kind' is required but missing.", '/root'),
    ]);
    expect(fixes[0].candidates).toEqual([
      expect.objectContaining({ action: 'add', target: '@kind' }),
    ]);
    expect(fixes[0].source).toBe('libxml2 message');
  });
});

describe('suggestBrexFixes', () => {
  it('value / forbidden の違反に、ルールの objectValue と objectUse から候補を付ける', () => {
    const report = checkAgainstBrexLayers(dmXml, [projectBrex.value]);
    const fixes = suggestBrexFixes(report, { layers: [projectBrex.value] });
    const value = fixes.find((f) => f.kind === 'brex-value')!;
    expect(value).toMatchObject({
      confidence: 'exact',
      brSeverityLevel: 'brsl02',
      source: 'BREX KENBAIKI-A-00-00-00-00A-022A-D rule KB-00004',
      location: {
        path: '/dmodule/identAndStatusSection/dmStatus/responsiblePartnerCompany/@enterpriseCode',
      },
    });
    expect(value.candidates).toEqual([
      { action: 'replace', value: 'K0002', target: '@enterpriseCode', description: '本社' },
    ]);
    expect(value.problem).toContain('"K0001"');
    const forbidden = fixes.find((f) => f.kind === 'brex-forbidden')!;
    expect(forbidden.candidates[0]).toMatchObject({ action: 'remove', target: 'title' });
    expect(forbidden.confidence).toBe('exact');
  });

  it('range / pattern の objectValue は書き方を付けて渡し、missing・notation も候補にする', () => {
    const xml = dmXml
      .replace('infoCode="040"', 'infoCode="041"')
      .replace('<security securityClassification="01"/>', '')
      .replace('NDATA png', 'NDATA jpg');
    const report = checkAgainstBrexLayers(xml, [projectBrex.value]);
    const fixes = suggestBrexFixes(report, { layers: [projectBrex.value] });
    const info = fixes.find((f) => f.source.endsWith('KB-00003'))!;
    expect(info.candidates.map((c) => [c.value, c.valueForm, c.description])).toEqual([
      ['040', undefined, '説明'],
      ['500~599', 'range', '手順'],
      ['[0-9]{2}[A-Z]', 'pattern', 'プロジェクト拡張'],
    ]);
    const missing = fixes.find((f) => f.kind === 'brex-missing')!;
    expect(missing.candidates).toEqual([
      expect.objectContaining({ action: 'add', target: '//dmStatus/security' }),
    ]);
    const notation = fixes.find((f) => f.kind === 'brex-notation')!;
    const allowed = report.layers[0].violations.find((v) => v.kind === 'notation')!.allowedValues;
    expect(allowed!.length).toBeGreaterThan(0);
    expect(notation.candidates.map((c) => c.value)).toEqual(allowed);
  });

  it('層が無ければ許可値の文字列だけで候補を作り、注記を付ける。場所の無い forbidden は several', () => {
    const xml = dmXml.replace(/<applic>[\s\S]*?<\/applic>/, '');
    const report = checkAgainstBrexLayers(xml, [projectBrex.value]);
    const fixes = suggestBrexFixes(report);
    expect(fixes.find((f) => f.kind === 'brex-value')!.note).toContain('not given');
    expect(fixes.find((f) => f.source.endsWith('KB-00006'))!.confidence).toBe('several');
  });
});

/** 自作の、参照の誤りを含む説明 DM */
const DM_WITH_BAD_REFS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE dmodule [
  <!ENTITY ICN-K0001-00001-001-01 SYSTEM "ICN-K0001-00001-001-01.PNG" NDATA png>
]>
<dmodule>
  <identAndStatusSection><dmStatus><applic><displayText><simplePara>All</simplePara></displayText></applic></dmStatus></identAndStatusSection>
  <content>
    <referencedApplicGroup><applic id="app-0001"><displayText><simplePara>MV-50</simplePara></displayText></applic></referencedApplicGroup>
    <description>
      <levelledPara id="par-0001">
        <para><internalRef internalRefId="fig-0009" internalRefTargetType="irtt01"/></para>
        <para applicRefId="app-0010">x</para>
        <para><dmRef><dmRefIdent>
          <dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="10" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="520" infoCodeVariant="B" itemLocationCode="A"/>
        </dmRefIdent></dmRef>
        <dmRef><dmRefIdent>
          <dmCode modelIdentCode="KENBAIKI" systemDiffCode="B" systemCode="10" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="040" infoCodeVariant="A" itemLocationCode="A"/>
          <issueInfo issueNumber="005" inWork="00"/>
        </dmRefIdent></dmRef>
        <dmRef><dmRefIdent>
          <dmCode modelIdentCode="S1000D" systemDiffCode="H" systemCode="04" subSystemCode="1" subSubSystemCode="0" assyCode="0301" disassyCode="00" disassyCodeVariant="A" infoCode="022" infoCodeVariant="A" itemLocationCode="D"/>
        </dmRefIdent></dmRef></para>
        <figure id="fig-0001"><title>t</title>
          <graphic infoEntityIdent="ICN-K0001-00001-001-01"/>
          <graphic infoEntityIdent="ICN-K0001-00002-001-01"/>
        </figure>
      </levelledPara>
    </description>
  </content>
</dmodule>`;

let csdbDir: string;
beforeAll(() => {
  csdbDir = mkdtempSync(join(tmpdir(), 's1000d-core-fix-'));
  const stub = '<dmodule><identAndStatusSection/><content/></dmodule>';
  writeFileSync(join(csdbDir, 'DMC-KENBAIKI-A-10-00-00-00A-520A-A_001-00_JA-JP.XML'), stub);
  writeFileSync(join(csdbDir, 'DMC-KENBAIKI-A-10-00-00-00A-040A-A_001-00_JA-JP.XML'), stub);
  writeFileSync(join(csdbDir, 'DMC-KENBAIKI-B-10-00-00-00A-040A-A_002-00_JA-JP.XML'), stub);
  writeFileSync(join(csdbDir, 'ICN-K0001-00001-001-01.SVG'), '<svg/>');
  writeFileSync(join(csdbDir, 'ICN-K0001-00002-001-01.PNG'), 'png');
});
afterAll(() => rmSync(csdbDir, { recursive: true, force: true }));

describe('suggestReferenceFixes', () => {
  it('参照の種類ごとに CSDB と文書内の id から候補を作る', () => {
    const csdb = CsdbIndex.fromDirs([csdbDir]);
    const collected = collectReferences(parse(DM_WITH_BAD_REFS));
    const report = resolveReferences(collected, { csdb });
    const fixes = suggestReferenceFixes(report, { csdb, collected });
    const byTarget = (s: string) => fixes.find((f) => f.problem.includes(s))!;

    const dm = byTarget('KENBAIKI-A-10-00-00-00A-520B-A');
    // バリアントだけ違うもの（520A）が先、情報コードが違うもの（040A）が後
    expect(dm.candidates.map((c) => c.value)).toEqual([
      'KENBAIKI-A-10-00-00-00A-520A-A',
      'KENBAIKI-A-10-00-00-00A-040A-A',
    ]);
    expect(dm.candidates[0]).toMatchObject({ action: 'retarget', target: 'dmRefIdent/dmCode' });
    expect(dm.confidence).toBe('several');
    // 仕様書の章への参照は説明だけ
    const spec = byTarget('S1000D-H-04-10-0301-00A-022A-D');
    expect(spec).toMatchObject({ confidence: 'none', candidates: [] });
    expect(spec.note).toContain('S1000D specification');
    // 版の食い違い
    const issue = fixes.find((f) => f.problem.includes('issue 005-00'))!;
    expect(issue.candidates).toEqual([
      expect.objectContaining({
        action: 'replace',
        value: '002-00',
        target: 'dmRefIdent/issueInfo',
      }),
    ]);
    expect(issue.confidence).toBe('exact');
    // ICN: 宣言の拡張子違い、宣言の無い実体
    const png = fixes.find((f) => f.problem.includes('ICN-K0001-00001-001-01.PNG'))!;
    expect(png.candidates[0]).toMatchObject({
      action: 'replace',
      value: 'ICN-K0001-00001-001-01.SVG',
    });
    expect(png.candidates[0].description).toContain('NDATA notation (png)');
    const noDecl = fixes.find((f) => f.problem.includes('<!ENTITY ICN-K0001-00002-001-01'))!;
    expect(noDecl.candidates[0]).toMatchObject({
      action: 'add',
      value: 'ICN-K0001-00002-001-01.PNG',
    });
    // 文書内の id
    expect(byTarget('fig-0009').candidates[0]).toMatchObject({
      action: 'retarget',
      value: 'fig-0001',
      target: '@internalRefId',
    });
    expect(byTarget('app-0010').candidates[0]).toMatchObject({
      value: 'app-0001',
      target: '@applicRefId',
    });
  });

  it('CSDB が無ければ候補なしで理由を書く', () => {
    const collected = collectReferences(parse(DM_WITH_BAD_REFS));
    const fixes = suggestReferenceFixes(resolveReferences(collected), { collected });
    const noCsdb = fixes.filter((f) => f.note?.includes('No CSDB folders'));
    expect(noCsdb.length).toBeGreaterThan(0);
    expect(noCsdb.every((f) => f.confidence === 'none')).toBe(true);
  });
});

/** 自作の ACT / CCT / PCT と、判定不能になる説明 DM（券売機） */
const ACT = `<dmodule><content><applicCrossRefTable><productAttributeList>
  <productAttribute id="model"><name>機種</name><enumeration applicPropertyValues="MV-50"/><enumeration applicPropertyValues="MV-60"/></productAttribute>
  <productAttribute id="serial" valuePattern="K\\d{4}"><name>製造番号</name></productAttribute>
</productAttributeList></applicCrossRefTable></content></dmodule>`;
const CCT = `<dmodule><content><condCrossRefTable>
  <condTypeList><condType id="SB"><name>改修</name><enumeration applicPropertyValues="PRE"/><enumeration applicPropertyValues="POST"/></condType></condTypeList>
  <condList><cond condTypeRefId="SB" id="SB-001"><name>改修 001</name></cond></condList>
</condCrossRefTable></content></dmodule>`;
const PCT = `<dmodule><content><productCrossRefTable>
  <product id="p1"><assign applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValue="MV-50"/><assign applicPropertyIdent="SB-001" applicPropertyType="condition" applicPropertyValue="PRE"/></product>
  <product id="p2"><assign applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValue="MV-70"/></product>
</productCrossRefTable></content></dmodule>`;
const APPLIC_DM = `<dmodule><identAndStatusSection><dmStatus>
  <applic><displayText><simplePara>MV-50</simplePara></displayText><assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="MV-50"/></applic>
</dmStatus></identAndStatusSection><content>
  <referencedApplicGroup>
    <applic id="app-sb"><displayText><simplePara>改修後</simplePara></displayText><assert applicPropertyIdent="SB-001" applicPropertyType="condition" applicPropertyValues="POST"/></applic>
    <applic id="app-sn"><displayText><simplePara>K0001</simplePara></displayText><assert applicPropertyIdent="serial" applicPropertyType="prodattr" applicPropertyValues="K0001"/></applic>
  </referencedApplicGroup>
  <description><levelledPara applicRefId="app-sb"><para applicRefId="app-sn">x</para></levelledPara><levelledPara applicRefId="app-sb"/></description>
</content></dmodule>`;

describe('applicability', () => {
  it('製品の値が足りない判定不能を集め、ACT・CCT・PCT の値を候補にする', () => {
    const findings = findUndeterminedApplicability(APPLIC_DM, { attributes: {}, conditions: {} });
    expect(findings.map((f) => f.result.missingProperties)).toEqual([
      ['model'],
      ['SB-001'],
      ['serial'],
    ]);
    const fixes = suggestApplicabilityFixes(findings, {
      act: readAct(parse(ACT)),
      cct: readCct(parse(CCT)),
      pct: readPct(parse(PCT)),
    });
    expect(fixes[0].candidates.map((c) => [c.value, c.description])).toEqual([
      ['MV-50', 'a value of model (機種): ACT enumeration; PCT product p1'],
      ['MV-60', 'a value of model (機種): ACT enumeration'],
      ['MV-70', 'a value of model (機種): PCT product p2'],
    ]);
    expect(fixes[0]).toMatchObject({
      kind: 'applicability',
      confidence: 'several',
      source: 'ACT, CCT, PCT',
    });
    expect(fixes[1].candidates.map((c) => c.value)).toEqual(['PRE', 'POST']);
    expect(fixes[2].candidates).toEqual([
      expect.objectContaining({
        action: 'provide',
        value: 'K\\d{4}',
        valueForm: 'pattern',
        target: 'serial',
      }),
    ]);
  });

  it('表が無ければ候補なしで、利用者に聞くよう注記する', () => {
    const findings = findUndeterminedApplicability(APPLIC_DM, {
      attributes: { model: 'MV-50' },
      conditions: {},
    });
    const fixes = suggestApplicabilityFixes(findings);
    expect(fixes.every((f) => f.confidence === 'none' && f.note?.includes('ask'))).toBe(true);
  });
});

describe('suggestFixes', () => {
  let root: string;
  const validator = new Libxml2SchemaValidator();
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 's1000d-core-fix-xsd-'));
    writeFileSync(
      join(root, 'brex.xsd'),
      `<?xml version="1.0"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:annotation id="version"><xs:documentation>Issue number: 7</xs:documentation></xs:annotation><xs:element name="dmodule"/></xs:schema>`,
    );
    writeFileSync(join(root, 'root.xsd'), XSD);
  });
  afterAll(() => {
    validator.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('verifyDataModule の結果から XSD・参照の候補をまとめて作る（XSD の定義は xsdPath から読む）', async () => {
    const xml = `<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://example.test/S1000D_7/xml_schema_flat/root.xsd" kind="z" year="20x6"><a/><internalRef internalRefId="a-1"/></root>`;
    const r = await verifyDataModule(xml, {
      schema: {
        validator,
        schemaDirs: [{ dir: root, issue: '7', xsdCount: 2, schemaNames: ['brex', 'root'] }],
      },
      references: {},
    });
    expect(r.status.schema.state).toBe('invalid');
    const fixes = suggestFixes(r, { xml });
    const kinds = fixes.map((f) => f.kind);
    expect(kinds.filter((k) => k === 'schema').length).toBeGreaterThan(0);
    const kind = fixes.find((f) => f.location?.path.endsWith('@kind'))!;
    expect(kind.source).toBe('root.xsd xs:simpleType name="kindAttType"');
    const year = fixes.find((f) => f.location?.path.endsWith('@year'))!;
    expect(year.note).toBe('The value must be a valid xs:gYear.');
    // 参照（internalRef は文書内の id から探す。id が無いので候補なし）
    expect(kinds).toContain('reference');
  });
});
