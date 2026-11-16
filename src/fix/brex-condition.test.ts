import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkAgainstBrexLayers } from '../brex/check.js';
import { readBrex } from '../brex/read.js';
import { defaultXmlEngine } from '../xml/index.js';
import { applyFix } from './apply.js';
import { suggestBrexFixes } from './brex.js';
import { XsdIndex } from './xsd-index.js';

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), 'utf8');
const dmXml = fx('kenbaiki-descript.xml');

// 自作の、条件付きで禁止するルール（S1000D の既定 BREX の式の複製ではない）
/** 変更した版（issueType が changed）には、更新の理由（reasonForUpdate）が要る */
const NEEDS_REASON =
  '//dmodule[descendant::dmStatus[@issueType = "changed"] and not(descendant::reasonForUpdate)]';
/** 002 版は、issueType が new であってはならない…の逆（new でなければ違反）。識別の属性も条件に入る例 */
const ISSUE_TYPE =
  '//identAndStatusSection[dmStatus/@issueType != "new" and dmAddress/dmIdent/issueInfo/@issueNumber = "002"]';
/** 条件に、値を決められないもの（属性が無いこと）しか無い例 */
const NO_APPLIC_ID = '//levelledPara[not(@applicRefId)]';

function brexWith(pathOf5: string, pathOf1 = '//title/internalRef') {
  const xml = fx('kenbaiki-brex.xml')
    .replace('>//levelledPara/title<', `>${pathOf5.replace(/</g, '&lt;')}<`)
    .replace('>//title/internalRef<', `>${pathOf1.replace(/</g, '&lt;')}<`);
  const brex = readBrex(xml);
  if (!brex.ok) throw new Error('fixture BREX failed to parse');
  return brex.value;
}

/** 自作の最小 XSD（S1000D の XSD の内容は含まない） */
const XSD = XsdIndex.fromString(
  `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
    <xs:element name="dmStatus"><xs:complexType><xs:sequence>
      <xs:element ref="security"/><xs:element ref="responsiblePartnerCompany"/><xs:element ref="originator"/>
      <xs:element ref="applic"/><xs:element ref="brexDmRef"/><xs:element ref="qualityAssurance"/>
      <xs:element ref="reasonForUpdate" minOccurs="0"/>
    </xs:sequence><xs:attribute ref="issueType"/></xs:complexType></xs:element>
    <xs:element name="security"/><xs:element name="responsiblePartnerCompany"/><xs:element name="originator"/>
    <xs:element name="applic"/><xs:element name="brexDmRef"/><xs:element name="qualityAssurance"/>
    <xs:element name="reasonForUpdate"/>
    <xs:attribute name="issueType" type="issueTypeAttType"/>
    <xs:simpleType name="issueTypeAttType"><xs:restriction base="xs:string">
      <xs:enumeration value="new"/><xs:enumeration value="changed"/><xs:enumeration value="revised"/>
    </xs:restriction></xs:simpleType>
  </xs:schema>`,
  'test.xsd',
);

function fixesFor(brex: ReturnType<typeof brexWith>, rule: string, xsd?: XsdIndex, withDoc = true) {
  const report = checkAgainstBrexLayers(dmXml, [brex]);
  const fixes = suggestBrexFixes(report, {
    layers: [brex],
    ...(withDoc
      ? { document: defaultXmlEngine.parse(dmXml).document, engine: defaultXmlEngine, xsd }
      : {}),
  });
  return { fixes, fix: fixes.find((f) => f.source.endsWith(rule))! };
}
const violates = (xml: string, brex: ReturnType<typeof brexWith>, rule: string) =>
  checkAgainstBrexLayers(xml, [brex]).layers[0].violations.some((v) => v.ruleId === rule);

describe('条件付きで禁止する BREX ルールの候補', () => {
  it('文書要素を取り除く候補は出さず、条件を成り立たなくする変更を several で返す', () => {
    const brex = brexWith(NEEDS_REASON);
    const { fix } = fixesFor(brex, 'KB-00005', XSD);
    expect(fix.kind).toBe('brex-forbidden');
    expect(fix.location?.path).toBe('/dmodule');
    expect(fix.confidence).toBe('several');
    expect(fix.note).toContain('only while the condition');
    expect(fix.candidates.map((c) => [c.action, c.target, c.value])).toEqual([
      // XSD の列挙値のうち、いまの値（changed）以外で、条件が成り立たなくなるもの
      ['replace', 'identAndStatusSection/dmStatus/@issueType', 'new'],
      ['replace', 'identAndStatusSection/dmStatus/@issueType', 'revised'],
      // XSD が reasonForUpdate を子に持てると言う要素に足す
      ['add', 'identAndStatusSection/dmStatus', 'reasonForUpdate'],
    ]);
    expect(fix.candidates.some((c) => c.action === 'remove')).toBe(false);
  });

  it('XSD が無ければ objectPath に書いてある値だけを試し、要素は違反の要素に足す', () => {
    const brex = brexWith(NEEDS_REASON);
    const { fix } = fixesFor(brex, 'KB-00005');
    // objectPath の値は "changed" だけで、いまの値と同じなので、属性の候補は無い
    expect(fix.candidates.map((c) => [c.action, c.target, c.value])).toEqual([
      ['add', 'dmodule', 'reasonForUpdate'],
    ]);
    expect(fix.confidence).toBe('several');
  });

  it('対象そのものの識別（dmAddress の下の issueNumber）は候補にしない', () => {
    const brex = brexWith('//levelledPara/title', ISSUE_TYPE);
    const { fix } = fixesFor(brex, 'KB-00001');
    expect(fix.location?.path).toBe('/dmodule/identAndStatusSection');
    expect(fix.candidates.map((c) => [c.action, c.target, c.value])).toEqual([
      ['replace', 'dmStatus/@issueType', 'new'],
    ]);
    // 候補が 1 つでも、自動で適用される exact にはしない
    expect(fix.confidence).toBe('several');
  });

  it('候補を決められないときは候補なし（none）にし、取り除く候補は出さない。文書が無いときも同じ', () => {
    const brex = brexWith(NO_APPLIC_ID);
    const a = fixesFor(brex, 'KB-00005', XSD).fix;
    expect(a.candidates).toEqual([]);
    expect(a.confidence).toBe('none');
    expect(a.note).toContain('no single change');
    // 属性が無い場所と、値の出どころが無いことを注記する
    expect(a.note).toContain('@applicRefId is absent on <levelledPara>');
    expect(a.note).toContain('No source for its value was found');
    const b = fixesFor(brexWith(NEEDS_REASON), 'KB-00005', undefined, false).fix;
    expect(b.candidates).toEqual([]);
    expect(b.confidence).toBe('none');
  });

  it('属性が無いことが条件のルール: 1 か所に足せば違反が消え、値の出どころがあるときだけ候補にする', () => {
    // 文書の中に applic の id があるとき、applicRefId の値の候補にする
    const withApplic = dmXml
      .replace(
        '<content>',
        '<content><referencedApplicGroup><applic id="app1"/><applic id="app2"/></referencedApplicGroup>',
      )
      .replace(
        '</levelledPara>',
        '</levelledPara><levelledPara><title>追加の節</title><para>本文</para></levelledPara>',
      );
    expect(withApplic).toContain('追加の節');
    expect(withApplic).toContain('<applic id="app1"/>');
    const suggest = (brex: ReturnType<typeof brexWith>, xml: string) => {
      const fixes = suggestBrexFixes(checkAgainstBrexLayers(xml, [brex]), {
        layers: [brex],
        document: defaultXmlEngine.parse(xml).document,
        engine: defaultXmlEngine,
      });
      return { fixes, mine: fixes.filter((f) => f.source.endsWith('KB-00005')) };
    };

    // 違反の要素そのものに属性が無い: その要素に足す候補（値は applic の id）
    const own = brexWith(NO_APPLIC_ID);
    const a = suggest(own, withApplic);
    expect(a.mine.length).toBeGreaterThan(0);
    const fix = a.mine[0]!;
    expect(fix.candidates.map((c) => [c.action, c.target, c.value])).toEqual([
      ['add', '@applicRefId', 'app1'],
      ['add', '@applicRefId', 'app2'],
    ]);
    // どの適用性を付けるかは内容の判断なので、自動で適用される exact にはしない
    expect(fix.confidence).toBe('several');
    const before = checkAgainstBrexLayers(withApplic, [own]).layers[0].violations.length;
    const done = applyFix(withApplic, fix, fix.candidates[1]!, { offered: a.fixes });
    expect(done).toMatchObject({ applied: true, changed: { after: 'app2' } });
    expect(done.changed?.xpath).toBe(`${fix.location!.path}/@applicRefId`);
    expect(checkAgainstBrexLayers(done.xml, [own]).layers[0].violations.length).toBe(before - 1);

    // 属性が無い場所が複数あって、1 か所に足しても違反が消えない: 候補なしにして、場所の数と使える値を注記する
    const many = brexWith('//content[descendant::levelledPara[not(attribute::applicRefId)]]');
    const places = (withApplic.match(/<levelledPara\b/g) ?? []).length;
    expect(places).toBeGreaterThan(1);
    const b = suggest(many, withApplic).mine[0]!;
    expect(b.candidates).toEqual([]);
    expect(b.confidence).toBe('none');
    expect(b.note).toContain(`@applicRefId is absent on ${places} <levelledPara> element(s)`);
    expect(b.note).toContain('every place must get a value');
    expect(b.note).toContain('ids of the applic elements in the document): app1, app2');

    // 属性が無い場所が子孫の 1 か所だけ: その場所への道を target にした候補
    const onlyFirst = withApplic.replace(
      /<levelledPara\b(?![^>]*applicRefId)/g,
      (m, offset: number) =>
        offset === withApplic.indexOf('<levelledPara') ? m : `${m} applicRefId="app1"`,
    );
    const c = suggest(many, onlyFirst);
    const cf = c.mine[0]!;
    expect(cf.candidates.map((x) => x.value)).toEqual(['app1', 'app2']);
    expect(cf.candidates[0]!.target).toMatch(/levelledPara(\[1\])?\/@applicRefId$/);
    const applied = applyFix(onlyFirst, cf, cf.candidates[0]!, { offered: c.fixes });
    expect(applied.applied).toBe(true);
    expect(violates(applied.xml, many, 'KB-00005')).toBe(false);
  });

  it('述語の無い objectPath は、これまでどおり「取り除く」を exact で返す', () => {
    const brex = brexWith('//levelledPara/title');
    const { fix } = fixesFor(brex, 'KB-00005', XSD);
    expect(fix.candidates.map((c) => c.action)).toEqual(['remove']);
    expect(fix.confidence).toBe('exact');
    expect(fix.note).toBeUndefined();
  });

  it('applyFix: 別の場所の属性を置き換え、子孫に要素を足す', () => {
    const brex = brexWith(NEEDS_REASON);
    const { fixes, fix } = fixesFor(brex, 'KB-00005', XSD);
    expect(violates(dmXml, brex, 'KB-00005')).toBe(true);

    const replace = fix.candidates.find((c) => c.value === 'revised')!;
    const r1 = applyFix(dmXml, fix, replace, { offered: fixes, xsd: XSD });
    expect(r1.applied).toBe(true);
    expect(r1.changed).toMatchObject({
      xpath: '/dmodule/identAndStatusSection/dmStatus/@issueType',
      before: 'changed',
      after: 'revised',
    });
    expect(r1.xml).toContain('<dmStatus issueType="revised">');
    expect(violates(r1.xml, brex, 'KB-00005')).toBe(false);

    const add = fix.candidates.find((c) => c.action === 'add')!;
    const r2 = applyFix(dmXml, fix, add, { offered: fixes, xsd: XSD });
    expect(r2.applied).toBe(true);
    expect(r2.changed?.xpath).toBe('/dmodule/identAndStatusSection/dmStatus/reasonForUpdate');
    expect(r2.xml).toMatch(/<reasonForUpdate\/>\s*<\/dmStatus>/);
    expect(r2.notes.join(' ')).toContain('added empty');
    expect(violates(r2.xml, brex, 'KB-00005')).toBe(false);

    // 候補に無い値は適用しない
    const r3 = applyFix(dmXml, fix, { ...replace, value: 'deleted' }, { offered: fixes });
    expect(r3).toMatchObject({ applied: false, reason: 'candidate-not-offered' });
  });
});
