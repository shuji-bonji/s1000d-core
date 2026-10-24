import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { countNodes, readContentFromXml } from './read.js';
import type { ContentNode } from './types.js';

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

const DMREF = `<dmRef><dmRefIdent><dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="10" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="040" infoCodeVariant="A" itemLocationCode="A"/></dmRefIdent><dmRefAddressItems><dmTitle><techName>券売機</techName><infoName>説明</infoName></dmTitle></dmRefAddressItems></dmRef>`;

/** 自作の手順 DM */
const PROCED = wrap(
  'proced',
  `<procedure>
  <preliminaryRqmts>
    <reqCondGroup><reqCondNoRef><reqCond>電源が入っていること</reqCond></reqCondNoRef></reqCondGroup>
    <reqPersons><person man="A"><personCategory personCategoryCode="Operator"/><trade>係員</trade><estimatedTime unitOfMeasure="min">5</estimatedTime></person></reqPersons>
    <reqSupportEquips><supportEquipDescrGroup><supportEquipDescr id="seq-0001"><name>保守鍵</name><identNumber><manufacturerCode>K0001</manufacturerCode><partAndSerialNumber><partNumber>KEY-01</partNumber></partAndSerialNumber></identNumber><reqQuantity unitOfMeasure="EA">1</reqQuantity></supportEquipDescr></supportEquipDescrGroup></reqSupportEquips>
    <reqSupplies><noSupplies/></reqSupplies><reqSpares><noSpares/></reqSpares>
    <reqSafety><safetyRqmts><warning><warningAndCautionPara>扉を開ける前に電源を切る</warningAndCautionPara></warning></safetyRqmts></reqSafety>
  </preliminaryRqmts>
  <mainProcedure>
    <proceduralStep id="stp-0001"><para>保守鍵（<internalRef internalRefId="seq-0001" internalRefTargetType="irtt05"/>）で前面扉を開ける。</para>
      <caution><warningAndCautionPara>扉は重い</warningAndCautionPara></caution>
      <proceduralStep><para>鍵を右に回す。</para></proceduralStep>
      <proceduralStep applicRefId="app-0001"><para>MV-60 では取っ手を引く。</para>
        <figure id="fig-0001"><title>扉</title><graphic infoEntityIdent="ICN-K0001-00001-001-01"><hotspot applicationStructureIdent="door-handle" id="hs-1"/></graphic></figure>
      </proceduralStep>
    </proceduralStep>
    <proceduralStep><para>保守モードに入る。詳細は ${DMREF} を見る。</para></proceduralStep>
  </mainProcedure>
  <closeRqmts><reqCondGroup><noConds/></reqCondGroup></closeRqmts>
</procedure>`,
);

const PROCESS = wrap(
  'process',
  `<process>
  <dmNode><title>はじめに</title><proceduralStep><para>画面に触れる。</para></proceduralStep></dmNode>
  <dmSeq>
    <dmNode><title>人数の選択</title><dialog><dialogGroup><userEntry><prompt><paraBasic>人数を入れてください</paraBasic></prompt><variableRef variableName="persons"/></userEntry></dialogGroup></dialog></dmNode>
    <dmIf applicRefId="many"><dmNode><title>団体</title><proceduralStep><para>係員を呼ぶ。</para></proceduralStep></dmNode></dmIf>
  </dmSeq>
</process>`,
);

const FAULT = wrap(
  'fault',
  `<faultIsolation><faultIsolationProcedure>
  <fault faultCode="E01"/><faultDescr><descr>切符が出ない</descr></faultDescr>
  <isolationProcedure>
    <preliminaryRqmts><reqCondGroup><noConds/></reqCondGroup><reqSupportEquips><noSupportEquips/></reqSupportEquips><reqSupplies><noSupplies/></reqSupplies><reqSpares><noSpares/></reqSpares><reqSafety><noSafety/></reqSafety></preliminaryRqmts>
    <isolationMainProcedure>
      <isolationStep id="stp-0001"><action>用紙の残量を見る</action><isolationStepQuestion>用紙はありますか</isolationStepQuestion>
        <isolationStepAnswer><listOfChoices><choice nextActionRefId="stp-0002">ある</choice><choice nextActionRefId="stp-0003">ない</choice></listOfChoices></isolationStepAnswer></isolationStep>
      <isolationProcedureEnd id="stp-0002"><action>印字部を清掃する</action></isolationProcedureEnd>
      <isolationProcedureEnd id="stp-0003"><action>用紙を補充する</action></isolationProcedureEnd>
    </isolationMainProcedure>
  </isolationProcedure>
</faultIsolationProcedure></faultIsolation>`,
);

const PM = `<?xml version="1.0" encoding="UTF-8"?>
<pm xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_7/xml_schema_flat/pm.xsd">
<identAndStatusSection><pmAddress><pmIdent><pmCode modelIdentCode="KENBAIKI" pmIssuer="K0001" pmNumber="OPM01" pmVolume="00"/><language languageIsoCode="ja" countryIsoCode="JP"/><issueInfo issueNumber="001" inWork="00"/></pmIdent></pmAddress><pmStatus/></identAndStatusSection>
<content>
  <pmEntry><pmEntryTitle>操作</pmEntryTitle>
    ${DMREF}
    <pmEntry><pmEntryTitle>保守</pmEntryTitle>
      <dmRef><dmRefIdent><dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="10" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="520" infoCodeVariant="A" itemLocationCode="A"/></dmRefIdent></dmRef>
    </pmEntry>
    <pmRef><pmRefIdent><pmCode modelIdentCode="KENBAIKI" pmIssuer="K0001" pmNumber="OPM02" pmVolume="00"/></pmRefIdent><pmRefAddressItems><pmTitle>別冊</pmTitle></pmRefAddressItems></pmRef>
  </pmEntry>
</content></pm>`;

const find = (nodes: ContentNode[], pred: (n: ContentNode) => boolean): ContentNode | undefined => {
  for (const n of nodes) {
    if (pred(n)) return n;
    const c = find(n.children, pred);
    if (c) return c;
  }
  return undefined;
};

describe('readContent', () => {
  it('descript: levelledPara の木、段落、図（参照つき）', () => {
    const c = readContentFromXml(fx('kenbaiki-descript.xml'));
    expect(c.kind).toBe('descript');
    expect(c.structured).toBe(true);
    const counts = countNodes(c.blocks);
    expect(counts.section).toBeGreaterThan(0);
    expect(counts.para).toBeGreaterThan(0);
    const fig = find(c.blocks, (n) => n.kind === 'figure');
    expect(fig?.refs?.[0]).toMatchObject({
      kind: 'graphic',
      target: 'ICN-KENBAIKI-A-000000-0-K0001-00001-A-01-1',
    });
    expect(c.unknownElements).toEqual({});
  });

  it('proced: 要件の要約、手順の番号（1、1.1）、警告、参照の埋め込み', () => {
    const c = readContentFromXml(PROCED);
    expect(c.kind).toBe('proced');
    const [pre, s1, s2, close] = c.blocks;
    expect(pre.kind).toBe('requirements');
    expect(pre.text).toContain('conditions: 電源が入っていること');
    expect(pre.text).toContain('persons: A / Operator / 係員 / 5 min');
    expect(pre.text).toContain('support equipment: 保守鍵 P/N KEY-01 x1');
    expect(pre.text).toContain('supplies: none');
    expect(pre.text).toContain('safety: warning: 扉を開ける前に電源を切る');
    expect(s1).toMatchObject({ kind: 'step', number: '1', id: 'stp-0001' });
    expect(s1.text).toBe('保守鍵（ [→ seq-0001] ）で前面扉を開ける。');
    expect(s1.refs).toEqual([{ kind: 'internalRef', target: 'seq-0001', note: 'irtt05' }]);
    expect(s1.children.map((n) => `${n.kind}:${n.number ?? n.level}`)).toEqual([
      'admonition:caution',
      'step:1.1',
      'step:1.2',
    ]);
    const s12 = s1.children[2];
    expect(s12.applicRefId).toBe('app-0001');
    expect(s12.children[0]).toMatchObject({ kind: 'figure', title: '扉' });
    expect(s12.children[0].refs?.[0]).toMatchObject({
      kind: 'graphic',
      target: 'ICN-K0001-00001-001-01',
      note: 'hotspots: door-handle',
    });
    expect(s2.number).toBe('2');
    expect(s2.text).toContain('[→ KENBAIKI-A-10-00-00-00A-040A-A 券売機 - 説明]');
    expect(s2.refs?.[0]).toMatchObject({
      kind: 'dmRef',
      target: 'KENBAIKI-A-10-00-00-00A-040A-A',
      title: '券売機 - 説明',
    });
    expect(close).toMatchObject({ kind: 'requirements', text: 'conditions: none' });
    expect(c.unknownElements).toEqual({});
  });

  it('process: dmNode / dmSeq / dmIf / dialog', () => {
    const c = readContentFromXml(PROCESS);
    expect(c.blocks.map((n) => n.kind)).toEqual(['section', 'sequence']);
    expect(c.blocks[0].title).toBe('はじめに');
    expect(c.blocks[0].children[0]).toMatchObject({
      kind: 'step',
      number: '1',
      text: '画面に触れる。',
    });
    const seq = c.blocks[1];
    expect(seq.children.map((n) => n.kind)).toEqual(['section', 'if']);
    const dialog = find(seq.children, (n) => n.kind === 'dialog' && n.element === 'userEntry');
    expect(dialog).toMatchObject({
      text: '人数を入れてください',
      attrs: { variableName: 'persons' },
    });
    expect(seq.children[1]).toMatchObject({
      kind: 'if',
      applicRefId: 'many',
      text: 'if applic many',
    });
  });

  it('fault: 問いと答えごとの次の手順', () => {
    const c = readContentFromXml(FAULT);
    const steps = c.blocks.filter((n) => n.kind === 'step');
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({
      id: 'stp-0001',
      text: '用紙の残量を見る',
      question: '用紙はありますか',
    });
    expect(steps[0].choices).toEqual([
      { text: 'ある', nextActionRefId: 'stp-0002' },
      { text: 'ない', nextActionRefId: 'stp-0003' },
    ]);
    expect(steps[1]).toMatchObject({
      element: 'isolationProcedureEnd',
      id: 'stp-0002',
      text: '印字部を清掃する',
    });
    expect(c.unknownElements).toEqual({});
  });

  it('pm: pmEntry の木と entry（dmRef / pmRef）を文書の順で', () => {
    const c = readContentFromXml(PM);
    expect(c.kind).toBe('pm');
    const top = c.blocks[0];
    expect(top).toMatchObject({ kind: 'section', title: '操作' });
    expect(top.children.map((n) => `${n.kind}:${n.element}`)).toEqual([
      'entry:dmRef',
      'section:pmEntry',
      'entry:pmRef',
    ]);
    expect(top.children[0]).toMatchObject({
      text: 'KENBAIKI-A-10-00-00-00A-040A-A',
      title: '券売機 - 説明',
    });
    expect(top.children[1].children[0]).toMatchObject({
      kind: 'entry',
      text: 'KENBAIKI-A-10-00-00-00A-520A-A',
    });
    expect(top.children[2]).toMatchObject({ text: 'KENBAIKI-K0001-OPM02-00', title: '別冊' });
  });

  it('構造化していない種類は other で、注記を返す', () => {
    const c = readContentFromXml(wrap('comrep', '<commonRepository/>'));
    expect(c).toMatchObject({ kind: 'other', structured: false, blocks: [] });
    expect(c.notes[0]).toMatch(/not structured yet/);
  });

  it('知らない要素は unknown として残し、数える', () => {
    const c = readContentFromXml(
      wrap(
        'descript',
        '<description><levelledPara><title>x</title><mysteryBlock>中身</mysteryBlock></levelledPara></description>',
      ),
    );
    expect(c.unknownElements).toEqual({ mysteryBlock: 1 });
    expect(find(c.blocks, (n) => n.kind === 'unknown')).toMatchObject({
      element: 'mysteryBlock',
      text: '中身',
    });
    expect(c.notes[0]).toMatch(/mysteryBlock/);
  });
});
