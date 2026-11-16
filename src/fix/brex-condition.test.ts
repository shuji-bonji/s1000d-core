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
    const b = fixesFor(brexWith(NEEDS_REASON), 'KB-00005', undefined, false).fix;
    expect(b.candidates).toEqual([]);
    expect(b.confidence).toBe('none');
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
