import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAgainstBrexLayers } from '../brex/check.js';
import { readBrex } from '../brex/read.js';
import { createBrexResolver } from '../csdb.js';
import { CsdbIndex } from '../csdb-index.js';
import { MemoryCsdbSource } from '../csdb-source.js';
import { collectReferences } from '../refs/collect.js';
import { resolveReferences } from '../refs/resolve.js';
import { findSchemaDirs, verifyDataModule } from '../verify/index.js';
import { defaultXmlEngine } from '../xml/index.js';
import { Libxml2SchemaValidator } from '../xsd-libxml2.js';
import { applyFix, applyFixes } from './apply.js';
import { suggestBrexFixes } from './brex.js';
import { suggestReferenceFixes } from './refs.js';
import { suggestSchemaFixes } from './schema.js';
import { suggestFixes } from './suggest.js';
import type { Fix, FixCandidate } from './types.js';
import { XsdIndex } from './xsd-index.js';

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), 'utf8');
const parse = (xml: string) => defaultXmlEngine.parse(xml).document;

const projectBrex = readBrex(fx('kenbaiki-brex.xml'));
const baseBrex = readBrex(fx('kenbaiki-base-brex.xml'));
if (!projectBrex.ok || !baseBrex.ok) throw new Error('fixture BREX failed to parse');
const layers = [projectBrex.value];
const dmXml = fx('kenbaiki-descript.xml');

/** BREX の違反（ルール ID の末尾と場所）。適用の前後で比べる */
const violations = (xml: string) =>
  checkAgainstBrexLayers(xml, layers).layers.flatMap((l) =>
    l.violations.map((v) => `${v.ruleId ?? v.objectPath}@${v.location?.path ?? ''}`),
  );
const brexFixes = (xml: string) =>
  suggestBrexFixes(checkAgainstBrexLayers(xml, layers), { layers });
const pick = (
  fixes: Fix[],
  pred: (f: Fix) => boolean,
  i = 0,
): { fix: Fix; candidate: FixCandidate } => {
  const fix = fixes.find(pred);
  if (!fix) throw new Error('fix not found');
  return { fix, candidate: fix.candidates[i]! };
};
const byRule = (rule: string) => (f: Fix) => f.source.endsWith(rule);

// 直列化は開始タグの中の改行・空白を 1 つの空白にそろえる。タグの外の空白（字下げ・改行）は元のまま
const squash = (x: string) => x.replace(/<[^<>]*>/g, (t) => t.replace(/\s+/g, ' '));

describe('applyFix: BREX の違反', () => {
  it('value 違反の replace: 属性値を直し、違反が消える。宣言・DOCTYPE・コメントは元のまま', () => {
    const fixes = brexFixes(dmXml);
    const { fix, candidate } = pick(fixes, byRule('KB-00004'));
    expect(violations(dmXml).some((v) => v.startsWith('KB-00004'))).toBe(true);
    const r = applyFix(dmXml, fix, candidate, { offered: fixes });
    expect(r.applied).toBe(true);
    expect(r.changed).toMatchObject({ before: 'K0001', after: 'K0002' });
    expect(r.xml).toContain('<responsiblePartnerCompany enterpriseCode="K0002">');
    expect(violations(r.xml).some((v) => v.startsWith('KB-00004'))).toBe(false);
    // 文書要素より前（XML 宣言・DOCTYPE の ENTITY / NOTATION・コメント）は一字も変わらない
    const prolog = (x: string) => x.slice(0, x.indexOf('<dmodule'));
    expect(prolog(r.xml)).toBe(prolog(dmXml));
    expect(prolog(r.xml)).toContain('<!ENTITY ICN-KENBAIKI-A-000000-0-K0001-00001-A-01-1 SYSTEM');
    expect(prolog(r.xml)).toContain('<!NOTATION png PUBLIC');
    expect(() => parse(r.xml)).not.toThrow();
    expect(defaultXmlEngine.parse(r.xml).hasEntityDeclarations).toBe(true);
    // 直したのは 1 か所だけ
    expect(squash(r.xml.replace('K0002', 'K0001'))).toBe(squash(dmXml));
  });

  it('forbidden 違反の remove: 要素を取り除き、字下げの空白も一緒に消す', () => {
    const fixes = brexFixes(dmXml);
    const { fix, candidate } = pick(fixes, byRule('KB-00005'));
    expect(fix.kind).toBe('brex-forbidden');
    const r = applyFix(dmXml, fix, candidate, { offered: fixes });
    expect(r.applied).toBe(true);
    expect(r.xml).not.toContain('<title>画面の構成</title>');
    expect(r.xml).not.toMatch(/<levelledPara>\s*\n\s*\n/);
    expect(violations(r.xml).some((v) => v.startsWith('KB-00005'))).toBe(false);
  });

  it('missing 違反の add: objectPath の親に足す。XSD があれば出現順の位置、無ければ末尾', () => {
    const xsd = XsdIndex.fromString(
      `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
        <xs:element name="dmStatus"><xs:complexType><xs:sequence>
          <xs:element ref="security"/><xs:element ref="responsiblePartnerCompany"/><xs:element ref="originator"/>
          <xs:element ref="applic"/><xs:element ref="brexDmRef"/><xs:element ref="qualityAssurance"/>
        </xs:sequence></xs:complexType></xs:element>
        <xs:element name="security"/><xs:element name="responsiblePartnerCompany"/><xs:element name="originator"/>
        <xs:element name="applic"/><xs:element name="brexDmRef"/><xs:element name="qualityAssurance"/>
      </xs:schema>`,
      'test.xsd',
    );
    const xml = dmXml.replace('<security securityClassification="01"/>', '');
    const fixes = brexFixes(xml);
    const { fix, candidate } = pick(fixes, (f) => f.kind === 'brex-missing');
    expect(fix.location).toBeUndefined();
    expect(violations(xml).some((v) => v.startsWith('KB-00002'))).toBe(true);

    const withXsd = applyFix(xml, fix, candidate, { offered: fixes, xsd });
    expect(withXsd.applied).toBe(true);
    expect(withXsd.xml).toMatch(
      /<dmStatus issueType="changed">\s*<security\/>\s*<responsiblePartnerCompany/,
    );
    expect(withXsd.notes.join(' ')).toContain('before <responsiblePartnerCompany>');
    expect(violations(withXsd.xml).some((v) => v.startsWith('KB-00002'))).toBe(false);

    const noXsd = applyFix(xml, fix, candidate, { offered: fixes, xsd: false });
    expect(noXsd.applied).toBe(true);
    expect(noXsd.xml).toMatch(/<\/qualityAssurance>\s*<security\/>\s*<\/dmStatus>/);
    expect(noXsd.notes.join(' ')).toContain('No XSD was available');
    expect(violations(noXsd.xml).some((v) => v.startsWith('KB-00002'))).toBe(false);
  });

  it('range / pattern の候補は、値がその範囲・正規表現に合うときだけ適用する', () => {
    const xml = dmXml.replace('infoCode="040"', 'infoCode="041"');
    const fixes = brexFixes(xml);
    const fix = fixes.find(byRule('KB-00003'))!;
    const [single, range, pattern] = fix.candidates as [FixCandidate, FixCandidate, FixCandidate];
    expect(range.valueForm).toBe('range');
    const apply = (c: FixCandidate) => applyFix(xml, fix, c, { offered: fixes });

    expect(apply(single).xml).toContain('infoCode="040"');
    const ok = apply({ ...range, value: '510' });
    expect(ok).toMatchObject({ applied: true, changed: { before: '041', after: '510' } });
    expect(violations(ok.xml).some((v) => v.startsWith('KB-00003'))).toBe(false);
    expect(apply({ ...pattern, value: '12B' }).applied).toBe(true);

    for (const bad of [
      apply({ ...range, value: '600' }),
      apply({ ...pattern, value: '1B2' }),
      apply(range), // 範囲そのもの（500~599）は値ではない
      apply(pattern),
    ]) {
      expect(bad).toMatchObject({ applied: false, reason: 'value-not-allowed' });
      expect(bad.xml).toBe(xml);
    }
  });

  it('候補に無い値・別の場所・別の操作は candidate-not-offered で、XML を変えない', () => {
    const fixes = brexFixes(dmXml);
    const { fix, candidate } = pick(fixes, byRule('KB-00004'));
    const reject = (f: Fix, c: FixCandidate) => applyFix(dmXml, f, c, { offered: fixes });
    for (const r of [
      reject(fix, { ...candidate, value: 'K9999' }),
      reject(fix, { action: 'remove', target: candidate.target, description: '' }),
      reject(fix, { ...candidate, target: '@originator' }),
      reject(
        {
          ...fix,
          location: { path: '/dmodule/identAndStatusSection/dmStatus/originator/@enterpriseCode' },
        },
        candidate,
      ),
      reject({ ...fix, location: undefined }, candidate),
    ]) {
      expect(r).toMatchObject({ applied: false, reason: 'candidate-not-offered', xml: dmXml });
    }
    // fix が偽の候補を持っていても、照合は計算し直した候補で行う
    const forged: Fix = { ...fix, candidates: [{ ...candidate, value: 'K9999' }] };
    expect(applyFix(dmXml, forged, forged.candidates[0]!, { offered: fixes }).applied).toBe(false);
  });

  it('provide は文書を変えない', () => {
    const fix: Fix = {
      kind: 'applicability',
      problem: 'undetermined',
      candidates: [{ action: 'provide', value: 'MV-50', target: 'model', description: '' }],
      confidence: 'exact',
      source: 'ACT',
    };
    const r = applyFix(dmXml, fix, fix.candidates[0]!, { offered: [fix] });
    expect(r).toEqual({
      applied: false,
      xml: dmXml,
      reason: 'provide-is-not-a-document-change',
      notes: [],
    });
  });

  it('verify（検証結果）から候補を計算し直して照合し、適用後に再検証すると違反が減る', async () => {
    const csdb = new MemoryCsdbSource([
      {
        fileName: 'DMC-KENBAIKI-A-00-00-00-00A-022A-D_001-00_JA-JP.XML',
        xml: fx('kenbaiki-brex.xml'),
      },
      {
        fileName: 'DMC-KBWORKS-A-00-00-00-00A-022A-D_001-00_JA-JP.XML',
        xml: fx('kenbaiki-base-brex.xml'),
      },
    ]);
    const brex = { resolver: createBrexResolver(CsdbIndex.fromSource(csdb)) };
    const r = await verifyDataModule(dmXml, { brex });
    const suggest = { brexLayers: [projectBrex.value, baseBrex.value] };
    const fixes = suggestFixes(r, { xml: dmXml, ...suggest });
    const target = fixes.find((f) => f.kind === 'brex-value' && f.confidence === 'exact')!;
    const done = applyFix(dmXml, target, target.candidates[0]!, { verify: r, suggest });
    expect(done.applied).toBe(true);
    const after = await verifyDataModule(done.xml, { brex });
    expect(after.status.brex.violationCount).toBe(r.status.brex.violationCount - 1);
    // verify が元の結果と食い違う候補は通らない
    const other = await applyFix(
      dmXml,
      target,
      { ...target.candidates[0]!, value: 'K9999' },
      { verify: r, suggest },
    );
    expect(other.reason).toBe('candidate-not-offered');
  });

  it('照合の元（verify / offered）が無いときは fix 自身の候補とだけ照合し、注記する', () => {
    const fixes = brexFixes(dmXml);
    const { fix, candidate } = pick(fixes, byRule('KB-00004'));
    const ok = applyFix(dmXml, fix, candidate);
    expect(ok.applied).toBe(true);
    expect(ok.notes.join(' ')).toContain('No verify result or offered fixes');
    expect(applyFix(dmXml, fix, { ...candidate, value: 'K9999' }).reason).toBe(
      'candidate-not-offered',
    );
  });

  it('整形式でない XML、場所が見つからない・複数ある XML は適用しない', () => {
    const fixes = brexFixes(dmXml);
    const { fix, candidate } = pick(fixes, byRule('KB-00004'));
    expect(applyFix('<a>', fix, candidate, { offered: fixes }).reason).toBe('xml-not-well-formed');
    const moved = dmXml.replace('<responsiblePartnerCompany', '<responsiblePartnerCompanyX');
    expect(
      applyFix(
        moved.replace('</responsiblePartnerCompany>', '</responsiblePartnerCompanyX>'),
        fix,
        candidate,
        { offered: fixes },
      ).reason,
    ).toBe('location-not-found');
    const twice = fixes.find((f) => f.location && /\/dmCode\/@infoCode$/.test(f.location.path));
    expect(twice).toBeUndefined();
  });
});

describe('applyFixes: まとめて適用', () => {
  it('後ろの位置から適用するので、同名の兄弟の添字がずれても正しい要素に当たる', () => {
    const xml = dmXml.replace(
      '</levelledPara>',
      '</levelledPara>\n      <levelledPara>\n        <title>二つ目</title>\n        <para>本文</para>\n      </levelledPara>',
    );
    const fixes = brexFixes(xml);
    const titles = fixes.filter((f) => f.kind === 'brex-forbidden' && f.location);
    expect(titles.map((f) => f.location!.path)).toEqual([
      '/dmodule/content/description/levelledPara[1]/title',
      '/dmodule/content/description/levelledPara[2]/title',
    ]);
    const code = pick(fixes, byRule('KB-00004'));
    const selections = [
      { fix: titles[0]!, candidate: titles[0]!.candidates[0]! },
      code,
      { fix: titles[1]!, candidate: titles[1]!.candidates[0]! },
      { fix: titles[1]!, candidate: { ...titles[1]!.candidates[0]!, value: 'x' } }, // 候補に無い
    ];
    const r = applyFixes(xml, selections, { offered: fixes });
    expect(r.appliedCount).toBe(3);
    expect(r.results.map((x) => [x.index, x.applied, x.reason])).toEqual([
      [0, true, undefined],
      [1, true, undefined],
      [2, true, undefined],
      [3, false, 'candidate-not-offered'],
    ]);
    expect(r.xml).not.toContain('画面の構成');
    expect(r.xml).not.toContain('二つ目');
    expect(r.xml).toContain('<para>本文</para>');
    expect(violations(r.xml).filter((v) => /^(KB-00004|KB-00005)/.test(v))).toEqual([]);
  });

  it('1 件も適用できなければ XML はそのまま', () => {
    const fixes = brexFixes(dmXml);
    const { fix, candidate } = pick(fixes, byRule('KB-00004'));
    const r = applyFixes(dmXml, [{ fix, candidate: { ...candidate, value: 'nope' } }], {
      offered: fixes,
    });
    expect(r).toMatchObject({ appliedCount: 0, xml: dmXml });
  });
});

/** 自作の最小 XSD（S1000D の XSD の内容は含まない）。fix.test.ts と同じ書き方 */
const XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root" type="rootElemType"/>
  <xs:complexType name="rootElemType">
    <xs:sequence>
      <xs:element ref="a" minOccurs="0"/>
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

describe('applyFix: XSD 違反（libxml2 の文章から作った候補）', () => {
  const xsd = XsdIndex.fromString(XSD, 'test.xsd');
  const err = (message: string, xpath: string) => ({
    message,
    line: 1,
    column: 0,
    level: 2,
    xpath,
  });
  const run = (xml: string, message: string, xpath: string, pred: (c: FixCandidate) => boolean) => {
    const fixes = suggestSchemaFixes([err(message, xpath)], { xsd });
    const fix = fixes[0]!;
    const candidate = fix.candidates.find(pred);
    if (!candidate) throw new Error('candidate not found');
    return applyFix(xml, fix, candidate, { offered: fixes, xsd });
  };

  it('列挙の replace、必須属性の add、許されない属性の remove / 名前の付け替え', () => {
    expect(
      run(
        `<root kind="z"/>`,
        "Element 'root', attribute 'kind': [facet 'enumeration'] The value 'z' is not an element of the set {'x', 'y'}.",
        '/root',
        (c) => c.value === 'y',
      ).xml,
    ).toBe('<root kind="y"/>');
    expect(
      run(
        `<root/>`,
        "Element 'root': The attribute 'kind' is required but missing.",
        '/root',
        (c) => c.value === 'x',
      ).xml,
    ).toBe('<root kind="x"/>');
    const msg = "Element 'root', attribute 'kinf': The attribute 'kinf' is not allowed.";
    expect(run(`<root kinf="x"/>`, msg, '/root', (c) => c.action === 'remove').xml).toBe('<root/>');
    const renamed = run(`<root kinf="x"/>`, msg, '/root', (c) => c.action === 'replace');
    expect(renamed.xml).toBe('<root kind="x"/>');
    expect(renamed.changed).toMatchObject({ before: '@kinf', after: '@kind' });
  });

  it('許されない位置の要素は取り除くか、期待される名前に付け替える', () => {
    const xml = `<root kind="x">\n  <a>1</a>\n  <c>2</c>\n</root>`;
    const msg = "Element 'c': This element is not expected. Expected is ( b ).";
    expect(run(xml, msg, '/root/c', (c) => c.action === 'remove').xml).toBe(
      `<root kind="x">\n  <a>1</a>\n</root>`,
    );
    expect(run(xml, msg, '/root/c', (c) => c.action === 'replace').xml).toBe(
      `<root kind="x">\n  <a>1</a>\n  <b>2</b>\n</root>`,
    );
  });

  it('足りない子要素の add: XSD の出現順の位置に、同じ字下げで入る', () => {
    const xml = `<root kind="x">\n  <b>2</b>\n</root>`;
    const r = run(
      xml,
      "Element 'root': Missing child element(s). Expected is ( a ).",
      '/root',
      (c) => c.value === 'a',
    );
    expect(r.xml).toBe(`<root kind="x">\n  <a/>\n  <b>2</b>\n</root>`);
    expect(r.notes.join(' ')).toContain('before <b>');
    const end = run(
      `<root kind="x">\n  <a/>\n</root>`,
      "Element 'root': Missing child element(s). Expected is ( b ).",
      '/root',
      (c) => c.value === 'b',
    );
    expect(end.xml).toBe(`<root kind="x">\n  <a/>\n  <b/>\n</root>`);
  });

  it('pattern の候補は値が正規表現に合うときだけ', () => {
    const xml = `<root kind="x" code="abc"/>`;
    const fixes = suggestSchemaFixes(
      [
        err(
          "Element 'root', attribute 'code': [facet 'pattern'] The value 'abc' is not accepted by the pattern '[A-Z]{2}'.",
          '/root',
        ),
      ],
      { xsd },
    );
    const fix = fixes[0]!;
    const c = fix.candidates[0]!;
    expect(applyFix(xml, fix, { ...c, value: 'AB' }, { offered: fixes }).xml).toBe(
      `<root kind="x" code="AB"/>`,
    );
    expect(applyFix(xml, fix, { ...c, value: 'ABC' }, { offered: fixes }).reason).toBe(
      'value-not-allowed',
    );
  });

  it('値の決まらない属性の add、子要素ごと・文字だけを取り除く候補', () => {
    const noValue = suggestSchemaFixes([
      err("Element 'root': The attribute 'extra' is required but missing.", '/root'),
    ]);
    expect(
      applyFix('<root/>', noValue[0]!, noValue[0]!.candidates[0]!, { offered: noValue }).reason,
    ).toBe('value-required');
    const children = suggestSchemaFixes([
      err(
        "Element 'a': Element content is not allowed, because the content type is a simple type definition.",
        '/root/a',
      ),
    ]);
    expect(
      applyFix('<root><a>t<x/></a></root>', children[0]!, children[0]!.candidates[0]!, {
        offered: children,
      }).xml,
    ).toBe('<root><a>t</a></root>');
    const text = suggestSchemaFixes([
      err(
        "Element 'root': Character content other than whitespace is not allowed because the content type is 'element-only'.",
        '/root',
      ),
    ]);
    expect(
      applyFix('<root>t<a/></root>', text[0]!, text[0]!.candidates[0]!, { offered: text }).xml,
    ).toBe('<root><a/></root>');
  });
});

/** 自作の、参照の誤りを含む説明 DM（fix.test.ts と同じ形） */
const DM_WITH_BAD_REFS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE dmodule [
  <!ENTITY ICN-K0001-00001-001-01 SYSTEM "ICN-K0001-00001-001-01.PNG" NDATA png>
]>
<dmodule>
  <content>
    <description>
      <levelledPara id="par-0001">
        <para><internalRef internalRefId="fig-0009" internalRefTargetType="irtt01"/></para>
        <para><dmRef><dmRefIdent>
          <dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="10" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="520" infoCodeVariant="B" itemLocationCode="A"/>
        </dmRefIdent></dmRef>
        <dmRef><dmRefIdent>
          <dmCode modelIdentCode="KENBAIKI" systemDiffCode="B" systemCode="10" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="040" infoCodeVariant="A" itemLocationCode="A"/>
          <issueInfo issueNumber="005" inWork="00"/>
        </dmRefIdent></dmRef></para>
        <figure id="fig-0001"><title>t</title>
          <graphic infoEntityIdent="ICN-K0001-00001-001-01"/>
        </figure>
      </levelledPara>
    </description>
  </content>
</dmodule>`;

describe('applyFix: 参照の retarget / 版の replace', () => {
  let csdbDir: string;
  beforeAll(() => {
    csdbDir = mkdtempSync(join(tmpdir(), 's1000d-core-apply-'));
    const stub = '<dmodule><identAndStatusSection/><content/></dmodule>';
    writeFileSync(join(csdbDir, 'DMC-KENBAIKI-A-10-00-00-00A-520A-A_001-00_JA-JP.XML'), stub);
    writeFileSync(join(csdbDir, 'DMC-KENBAIKI-B-10-00-00-00A-040A-A_002-00_JA-JP.XML'), stub);
    writeFileSync(join(csdbDir, 'ICN-K0001-00001-001-01.PNG'), 'png');
  });
  afterAll(() => rmSync(csdbDir, { recursive: true, force: true }));

  const unresolved = (xml: string, csdb: CsdbIndex) =>
    resolveReferences(collectReferences(parse(xml)), { csdb }).unresolved.map((u) => u.message);

  it('internalRef の @internalRefId、dmRef の dmCode を向け直し、版を直すと参照が解決する', () => {
    const csdb = CsdbIndex.fromDirs([csdbDir]);
    const collected = collectReferences(parse(DM_WITH_BAD_REFS));
    const fixes = suggestReferenceFixes(resolveReferences(collected, { csdb }), {
      csdb,
      collected,
    });
    const before = unresolved(DM_WITH_BAD_REFS, csdb);
    expect(before.length).toBeGreaterThanOrEqual(1);

    const idFix = fixes.find((f) => f.problem.includes('fig-0009'))!;
    expect(idFix.candidates[0]).toMatchObject({ action: 'retarget', value: 'fig-0001' });
    const dmFix = fixes.find((f) => f.problem.includes('520B'))!;
    const issueFix = fixes.find((f) => f.problem.includes('issue 005-00'))!;
    const sel = (f: Fix) => ({ fix: f, candidate: f.candidates[0]! });
    const r = applyFixes(DM_WITH_BAD_REFS, [sel(idFix), sel(dmFix), sel(issueFix)], {
      offered: fixes,
    });
    expect(r.results.map((x) => x.applied)).toEqual([true, true, true]);
    expect(r.xml).toContain('internalRefId="fig-0001"');
    expect(r.xml).toContain('infoCode="520" infoCodeVariant="A"');
    expect(r.xml).toContain('<issueInfo issueNumber="002" inWork="00"/>');
    expect(r.results[1]!.notes.join(' ')).toContain('issueInfo');
    // 3 件の未解決は消える（残るのは ICN 宣言の拡張子の食い違い。この XML では PNG があるので解決済み）
    expect(unresolved(r.xml, csdb)).toEqual([]);
    // DOCTYPE の宣言は残る
    expect(r.xml.slice(0, r.xml.indexOf('<dmodule'))).toBe(
      DM_WITH_BAD_REFS.slice(0, DM_WITH_BAD_REFS.indexOf('<dmodule')),
    );
  });

  it('DOCTYPE の宣言を書き換える候補（ICN の SYSTEM 識別子など）は対応しない', () => {
    const fix: Fix = {
      kind: 'reference',
      location: { path: '/dmodule/content/description/levelledPara/figure/graphic' },
      problem: 'x',
      candidates: [
        {
          action: 'replace',
          value: 'ICN-K0001-00001-001-01.SVG',
          target: 'SYSTEM identifier of <!ENTITY ICN-K0001-00001-001-01>',
          description: '',
        },
        {
          action: 'add',
          value: 'ICN-K0001-00001-001-01.PNG',
          target: '<!ENTITY ICN-K0001-00001-001-01 SYSTEM "…" NDATA …>',
          description: '',
        },
      ],
      confidence: 'several',
      source: 'CsdbIndex and DOCTYPE',
    };
    for (const c of fix.candidates) {
      const r = applyFix(DM_WITH_BAD_REFS, fix, c, { offered: [fix] });
      expect(r).toMatchObject({ applied: false, xml: DM_WITH_BAD_REFS });
      expect(['unsupported-candidate', 'target-mismatch']).toContain(r.reason);
    }
  });
});

describe('直列化', () => {
  it('文書要素の前後のコメント・空白と DOCTYPE の内部サブセットを保つ', () => {
    const xml = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- 先頭のコメント -->\n<!DOCTYPE root [\n  <!ENTITY ICN-A SYSTEM "ICN-A.PNG" NDATA png>\n  <!-- ] > の入ったコメント -->\n  <!NOTATION png PUBLIC "-//W3C//NOTATION Portable Network Graphics//EN">\n]>\n<root kind="z"/>\n<!-- 末尾のコメント -->\n`;
    const xsd = XsdIndex.fromString(XSD, 'test.xsd');
    const fixes = suggestSchemaFixes(
      [
        {
          message:
            "Element 'root', attribute 'kind': [facet 'enumeration'] The value 'z' is not an element of the set {'x', 'y'}.",
          xpath: '/root',
          line: 1,
          column: 0,
          level: 2,
        },
      ],
      { xsd },
    );
    const r = applyFix(xml, fixes[0]!, fixes[0]!.candidates[0]!, { offered: fixes });
    expect(r).toMatchObject({ applied: true, notes: [] });
    expect(r.xml).toBe(xml.replace('kind="z"', 'kind="x"'));
  });
});

// ---------------------------------------------------------------------------
// 利用者が入手した配布物（S1000D_SPEC_TESTS=1 のときだけ。配布物は再配布できない: D-03）

const enabled = process.env.S1000D_SPEC_TESTS === '1';
const specDir = resolve(process.env.S1000D_SPEC_DIR ?? '../../specs/s1000d/issue-7');

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

describe.skipIf(!enabled || !existsSync(specDir))(
  'applyFix: 公式 XSD で valid に戻る（配布物）',
  () => {
    const validator = new Libxml2SchemaValidator();
    afterAll(() => validator.dispose());

    const setup = () => {
      const schemaDirs = findSchemaDirs([specDir]).filter((d) => !/data_dictionary/i.test(d.dir));
      const file = findFiles(specDir, /^DMC-.*\.XML$/i).find((f) => {
        if (!/bike/i.test(f)) return false;
        const t = readFileSync(f, 'utf8');
        return /descript\.xsd/.test(t) && t.includes('securityClassification="01"');
      })!;
      const original = readFileSync(file, 'utf8');
      const check = (xml: string) =>
        verifyDataModule(xml, { path: file, schema: { validator, schemaDirs } });
      return { file, original, check };
    };

    it('securityClassification を不正な値にした DM に、XSD 列挙の候補を適用すると valid に戻る', async () => {
      const { original, check } = setup();
      expect((await check(original)).status.schema.state).toBe('valid');
      const xml = original.replace('securityClassification="01"', 'securityClassification="XX"');
      const r = await check(xml);
      expect(r.status.schema.state).toBe('invalid');
      const fixes = suggestFixes(r, { xml });
      const fix = fixes.find((f) => f.location?.path.endsWith('@securityClassification'))!;
      const candidate = fix.candidates.find((c) => c.value === '01')!;
      const done = applyFix(xml, fix, candidate, { verify: r, suggest: { xml } });
      expect(done.applied).toBe(true);
      expect((await check(done.xml)).status.schema.state).toBe('valid');
      expect(squash(done.xml)).toBe(squash(original));
      // 候補の外の値は適用しない
      const out = applyFix(
        xml,
        fix,
        { ...candidate, value: 'ZZ' },
        { verify: r, suggest: { xml } },
      );
      expect(out).toMatchObject({ applied: false, reason: 'candidate-not-offered', xml });
    });

    it('必須の属性を消した DM に、列挙の候補を add すると valid に戻る', async () => {
      const { original, check } = setup();
      const xml = original.replace(' securityClassification="01"', '');
      const r = await check(xml);
      expect(r.status.schema.state).toBe('invalid');
      const fixes = suggestFixes(r, { xml });
      const fix = fixes.find((f) =>
        f.candidates.some((c) => c.action === 'add' && c.target === '@securityClassification'),
      )!;
      const candidate = fix.candidates.find((c) => c.value === '01')!;
      const done = applyFix(xml, fix, candidate, { verify: r, suggest: { xml } });
      expect(done.applied).toBe(true);
      expect((await check(done.xml)).status.schema.state).toBe('valid');
    });

    it('許されない属性を消した候補（remove）と、XSD の順序での要素 add', async () => {
      const { original, check } = setup();
      const xml = original.replace('<para>', '<para bogusAttr="1">');
      const r = await check(xml);
      const fixes = suggestFixes(r, { xml });
      const fix = fixes.find((f) => f.problem.includes("'bogusAttr'"))!;
      const done = applyFix(
        xml,
        fix,
        fix.candidates.find((c) => c.action === 'remove')!,
        { verify: r, suggest: { xml } },
      );
      expect(done.applied).toBe(true);
      expect((await check(done.xml)).status.schema.state).toBe('valid');
    });
  },
);
