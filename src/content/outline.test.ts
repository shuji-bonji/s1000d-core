import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { firstSentence, measureContent, outlineContent } from './outline.js';
import { readContentFromXml } from './read.js';

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), 'utf8');

const wrap = (schema: string, content: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_7/xml_schema_flat/${schema}.xsd">
<identAndStatusSection><dmAddress><dmIdent>
  <dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="10" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="520" infoCodeVariant="A" itemLocationCode="A"/>
  <language languageIsoCode="ja" countryIsoCode="JP"/><issueInfo issueNumber="001" inWork="00"/>
</dmIdent></dmAddress><dmStatus/></identAndStatusSection>
<content>${content}</content></dmodule>`;

const PROCED = wrap(
  'proced',
  `<procedure>
  <preliminaryRqmts><reqCondGroup><noConds/></reqCondGroup><reqSafety><safetyRqmts><warning><warningAndCautionPara>扉を開ける前に電源を切る。</warningAndCautionPara></warning></safetyRqmts></reqSafety></preliminaryRqmts>
  <mainProcedure>
    <proceduralStep id="stp-0001" securityClassification="02"><para>保守鍵で前面扉を開ける。鍵は係員が持つ。</para>
      <caution><warningAndCautionPara>扉は重い</warningAndCautionPara></caution>
      <proceduralStep><para>鍵を右に回す。</para></proceduralStep>
      <proceduralStep applicRefId="app-0001"><para>MV-60 では取っ手を引く。</para><note><notePara>取っ手は上にある</notePara></note></proceduralStep>
    </proceduralStep>
    <proceduralStep><para>保守モードに入る。</para><table><tgroup cols="2"><tbody><row><entry>項目</entry><entry>値</entry></row></tbody></tgroup></table></proceduralStep>
  </mainProcedure>
  <closeRqmts><reqCondGroup><noConds/></reqCondGroup></closeRqmts>
</procedure>`,
);

describe('firstSentence', () => {
  it('句点・終止符・改行で切り、長ければ切り詰める', () => {
    expect(firstSentence('保守鍵で前面扉を開ける。鍵は係員が持つ。')).toBe(
      '保守鍵で前面扉を開ける。',
    );
    expect(firstSentence('Open the door. Then turn the key.')).toBe('Open the door.');
    expect(firstSentence('Use v1.2 of the tool. Then stop.')).toBe('Use v1.2 of the tool.');
    expect(firstSentence('一行目\n二行目')).toBe('一行目 二行目');
    expect(firstSentence('あ'.repeat(200), 20)).toBe(`${'あ'.repeat(19)}…`);
    expect(firstSentence(undefined)).toBeUndefined();
    expect(firstSentence('   ')).toBeUndefined();
  });
});

describe('measureContent / outlineContent', () => {
  it('手順 DM: 手順の番号と最初の 1 文、部分木の大きさ、警告の数、機密区分を返す', () => {
    const c = readContentFromXml(PROCED);
    const size = measureContent(c.blocks);
    expect(size.nodes).toBe(c.blocks.length > 0 ? size.nodes : 0);
    // preliminaryRqmts の reqSafety の warning は requirements の要約に入り、admonition の節点にはならない
    expect(size.admonitions).toEqual({ warning: 0, caution: 1, note: 1 });
    expect(size.byKind.step).toBe(4);
    expect(size.byKind.table).toBe(1);
    expect(size.chars).toBeGreaterThan(0);

    const o = outlineContent(c.blocks);
    // 概要には requirements と step だけが残り、段落・警告・表は数に入る
    const kinds = new Set<string>();
    const walk = (ns: typeof o) => ns.forEach((n) => (kinds.add(n.kind), walk(n.children)));
    walk(o);
    expect([...kinds].sort()).toEqual(['requirements', 'step']);
    const top = o.find((n) => n.kind === 'step' && n.number === '1')!;
    expect(top.firstSentence).toBe('保守鍵で前面扉を開ける。');
    expect(top.securityClassification).toBe('02');
    expect(top.id).toBe('stp-0001');
    expect(top.size.admonitions).toEqual({ warning: 0, caution: 1, note: 1 });
    expect(top.children.map((n) => n.number)).toEqual(['1.1', '1.2']);
    expect(top.children[1]!.applicRefId).toBe('app-0001');
    expect(top.children[1]!.firstSentence).toBe('MV-60 では取っ手を引く。');
    const second = o.find((n) => n.kind === 'step' && n.number === '2')!;
    expect(second.size.byKind.table).toBe(1);
    expect(second.size.chars).toBeGreaterThanOrEqual('保守モードに入る。'.length + '項目値'.length);
    // 概要の大きさの合計は全体の大きさと一致する（最上位の節点がすべて残るとき）
    expect(o.reduce((a, n) => a + n.size.nodes, 0)).toBe(size.nodes);
  });
  it('maxDepth で深さを制限できる', () => {
    const c = readContentFromXml(PROCED);
    const o = outlineContent(c.blocks, { maxDepth: 1 });
    expect(o.every((n) => n.children.length === 0)).toBe(true);
    expect(o.find((n) => n.number === '1')!.size.byKind.step).toBe(3);
  });
  it('説明 DM: levelledPara の見出しと最初の段落の 1 文', () => {
    const c = readContentFromXml(fx('kenbaiki-descript.xml'));
    const o = outlineContent(c.blocks);
    expect(o.length).toBeGreaterThan(0);
    expect(o.every((n) => n.kind === 'section')).toBe(true);
    expect(o.some((n) => n.title)).toBe(true);
    expect(o.some((n) => n.firstSentence)).toBe(true);
  });
  it('残す種類の節点が無いときは最上位の段落を 1 つ残す', () => {
    const c = readContentFromXml(
      wrap(
        'descript',
        '<description><para>一文だけ。二文目。</para><para>別の段落。</para></description>',
      ),
    );
    const o = outlineContent(c.blocks);
    expect(o).toHaveLength(1);
    expect(o[0]!.kind).toBe('para');
    expect(o[0]!.firstSentence).toBe('一文だけ。');
    expect(o[0]!.size.nodes).toBe(2);
  });
});
