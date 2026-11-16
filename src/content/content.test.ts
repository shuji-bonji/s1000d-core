import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { measureTextCoverage } from '../__fixtures__/text-coverage.js';
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
    <dmIf id="cond1"><expression humanReadableForm="[戻る] と [次へ] を同時に 2 秒押したとき"><variableRef variableName="cond1"/></expression><dmThenSeq><dmNode><title>保守画面</title><proceduralStep><para>設定を確かめる。</para></proceduralStep></dmNode></dmThenSeq></dmIf>
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
    // 人員・品目・安全の要件は、子の節点としても返す（書く側の DraftNode と同じ種類）
    expect(pre.children.map((n) => n.kind)).toEqual(['para', 'person', 'equipment', 'admonition']);
    expect(pre.children[0]).toMatchObject({ kind: 'para', element: 'reqCondNoRef' });
    expect(pre.children[0].text).toContain('電源が入っていること');
    expect(pre.children[1]).toMatchObject({
      kind: 'person',
      element: 'person',
      text: '係員',
      man: 'A',
      personCategoryCode: 'Operator',
      estimatedTime: '5',
      estimatedTimeUnit: 'min',
    });
    expect(c.notReadElements).toEqual({});
    expect(pre.children[2]).toMatchObject({
      kind: 'equipment',
      id: 'seq-0001',
      title: '保守鍵',
      manufacturerCode: 'K0001',
      partNumber: 'KEY-01',
      quantity: '1',
      unit: 'EA',
    });
    expect(pre.children[3]).toMatchObject({ kind: 'admonition', level: 'warning' });
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

  it('proced: 共通の警告・注意への参照（@warningRefs / @cautionRefs）と、参照付きの条件を落とさない', () => {
    const c = readContentFromXml(
      wrap(
        'proced',
        `<warningsAndCautionsRef>
  <warningRef id="w001" warningIdentNumber="warning-001">${DMREF}</warningRef>
</warningsAndCautionsRef>
<warningsAndCautions>
  <caution id="c001"><warningAndCautionPara>扉は重い</warningAndCautionPara></caution>
</warningsAndCautions>
<procedure>
  <preliminaryRqmts>
    <reqCondGroup>
      <reqCondDm><reqCond>電源を切ってあること</reqCond>${DMREF}</reqCondDm>
    </reqCondGroup>
    <reqPersons><personnel numRequired="2"><trade>係員</trade></personnel></reqPersons>
    <reqSupportEquips><noSupportEquips/></reqSupportEquips><reqSupplies><noSupplies/></reqSupplies><reqSpares><noSpares/></reqSpares>
    <reqSafety><safetyRqmts warningRefs="w001 w999" cautionRefs="c001"/></reqSafety>
  </preliminaryRqmts>
  <mainProcedure>
    <proceduralStep cautionRefs="c001"><para>扉を開ける。</para></proceduralStep>
  </mainProcedure>
  <closeRqmts><reqCondGroup><noConds/></reqCondGroup></closeRqmts>
</procedure>`,
      ),
    );
    const pre = c.blocks.find((b) => b.kind === 'requirements')!;
    // 条件の参照（reqCondDm の dmRef）
    expect(pre.children[0]).toMatchObject({
      kind: 'para',
      element: 'reqCondDm',
      text: '電源を切ってあること',
      refs: [{ kind: 'dmRef', target: 'KENBAIKI-A-10-00-00-00A-040A-A' }],
    });
    expect(pre.children[1]).toMatchObject({ kind: 'person', element: 'personnel', count: 2 });
    expect(pre.children[1].man).toBeUndefined();
    expect(pre.text).toContain('persons: x2 / 係員');
    // 安全の要件: 別の DM の警告への参照、見つからない id、同じ DM の注意
    const safety = pre.children.filter((n) => n.kind === 'admonition');
    expect(safety).toHaveLength(3);
    expect(safety[0]).toMatchObject({
      level: 'warning',
      element: 'warningRef',
      attrs: { referencedId: 'w001', identNumber: 'warning-001' },
      refs: [{ kind: 'dmRef', target: 'KENBAIKI-A-10-00-00-00A-040A-A' }],
    });
    expect(safety[1]).toMatchObject({
      level: 'warning',
      attrs: { referencedId: 'w999', unresolved: 'true' },
    });
    expect(safety[2]).toMatchObject({
      level: 'caution',
      element: 'caution',
      attrs: { referencedId: 'c001' },
    });
    expect(safety[2].children[0].text).toBe('扉は重い');
    expect(pre.text).toContain(
      'safety: warning ref w001 (KENBAIKI-A-10-00-00-00A-040A-A); warning ref w999 (unresolved); caution ref c001 (in this data module)',
    );
    expect(pre.text).not.toContain('safety: none');
    // 手順の @cautionRefs も、手順の先頭の admonition として読む
    const step = c.blocks.find((b) => b.kind === 'step')!;
    expect(step.children[0]).toMatchObject({
      kind: 'admonition',
      level: 'caution',
      attrs: { referencedId: 'c001' },
    });
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
    expect(seq.children.map((n) => n.kind)).toEqual(['section', 'if', 'if']);
    const dialog = find(seq.children, (n) => n.kind === 'dialog' && n.element === 'userEntry');
    expect(dialog).toMatchObject({
      text: '人数を入れてください',
      attrs: { variableName: 'persons' },
    });
    // 入力先の変数は attrs.variableName に読むので、子の unknown にも unknownElements にも数えない
    expect(dialog!.children).toEqual([]);
    expect(c.unknownElements.variableRef).toBeUndefined();
    expect(seq.children[1]).toMatchObject({
      kind: 'if',
      applicRefId: 'many',
      text: 'if applic many',
    });
    // expression の無い dmIf には条件の文を付けない
    expect(seq.children[1].question).toBeUndefined();
    // 条件の文は expression/@humanReadableForm から読む。読めた expression は unknown に数えない
    expect(seq.children[2]).toMatchObject({
      kind: 'if',
      id: 'cond1',
      question: '[戻る] と [次へ] を同時に 2 秒押したとき',
      attrs: { variableName: 'cond1' },
    });
    expect(seq.children[2].children.map((n) => n.title)).toEqual(['保守画面']);
    expect(c.unknownElements.expression).toBeUndefined();
  });

  it('process: 条件を読めない dmIf の expression は unknown として残す', () => {
    const c = readContentFromXml(
      wrap(
        'process',
        `<process><dmSeq>
  <dmIf id="cond2"><expression><variableRef variableName="a"/><variableRef variableName="b"/></expression><dmThenSeq><dmNode><title>読めない条件</title></dmNode></dmThenSeq></dmIf>
</dmSeq></process>`,
      ),
    );
    const node = c.blocks[0].children[0];
    expect(node.kind).toBe('if');
    expect(node.question).toBeUndefined();
    expect(node.attrs).toBeUndefined();
    expect(node.children.map((n) => n.element)).toEqual(['expression', 'dmNode']);
    expect(c.unknownElements.expression).toBe(1);
  });

  it('process: dmIf と dmLoop の式を attrs.expression に読む（question は人が書いた文だけ）', () => {
    const c = readContentFromXml(
      wrap(
        'process',
        `<process><dmSeq>
  <dmIf><expression><booleanFunction booleanAction="not"/><expression><expression><variableRef variableName="level"/></expression><numberOperator numberOperation="equal"/><expression><stringValue>experienced</stringValue></expression></expression></expression>
    <dmThenSeq>
      <dmLoop id="loop1">
        <variablePreSet><assertion><variableRef variableName="mistakes"/><expression><integerValue>0</integerValue></expression></assertion></variablePreSet>
        <expression><assert applicPropertyIdent="tourFinished" applicPropertyType="condition" applicPropertyValues="False"/></expression>
        <dmSeq><dmNode><title>案内</title></dmNode></dmSeq>
        <assertion><variableRef variableName="mistakes"/><expression><integerValue>1</integerValue></expression></assertion>
      </dmLoop>
    </dmThenSeq>
  </dmIf>
  <dmIf><expression humanReadableForm="初心者のとき"><expression><variableRef variableName="level"/></expression><stringOperator stringOperation="equal"/><expression><stringValue>amateur</stringValue></expression></expression><dmThenSeq><dmNode><title>初心者</title></dmNode></dmThenSeq></dmIf>
  <dmLoop><expression><variableRef variableName="a"/><variableRef variableName="b"/></expression><dmSeq><dmNode><title>読めない条件</title></dmNode></dmSeq></dmLoop>
</dmSeq></process>`,
      ),
    );
    const [first, second, badLoop] = c.blocks[0]!.children;
    // humanReadableForm が無い式: question は無く、式の文が attrs.expression に入る
    expect(first).toMatchObject({ kind: 'if', element: 'dmIf' });
    expect(first!.question).toBeUndefined();
    expect(first!.attrs).toEqual({ expression: 'not(level equal "experienced")' });
    // dmLoop は sequence の節点。条件の式は attrs.expression で、子は前の代入・繰り返す dmSeq・後ろの代入
    const loop = first!.children[0]!;
    expect(loop).toMatchObject({ kind: 'sequence', element: 'dmLoop', id: 'loop1' });
    expect(loop.attrs).toEqual({ expression: 'assert(tourFinished condition "False")' });
    expect(loop.children.map((n) => [n.kind, n.element, n.attrs])).toEqual([
      ['para', 'variablePreSet', { variableName: 'mistakes', expression: '0' }],
      ['sequence', 'dmSeq', undefined],
      ['para', 'assertion', { variableName: 'mistakes', expression: '1' }],
    ]);
    // humanReadableForm があれば question に入り、式の文も attrs.expression に入る
    expect(second!.question).toBe('初心者のとき');
    expect(second!.attrs).toEqual({ expression: 'level equal "amateur"' });
    // 文にできない式は、これまでどおり unknown の子として残す
    expect(badLoop).toMatchObject({ kind: 'sequence', element: 'dmLoop' });
    expect(badLoop!.attrs).toBeUndefined();
    expect(badLoop!.children.map((n) => n.element)).toEqual(['expression', 'dmSeq']);
    expect(c.unknownElements).toEqual({ expression: 1, variableRef: 2 });
    expect(c.notReadElements).toEqual({});
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

  it('段落の中のリスト・定義リスト・注意書きの中のリストを、子の節点として読む（文を落とさない）', () => {
    const xml = wrap(
      'descript',
      `<description>
  <para>構成は次のとおり。<randomList><listItem><para>本体</para></listItem><listItem><para>扉。詳細は ${DMREF} を見る。</para></listItem></randomList></para>
  <para><definitionList><title>用語</title><definitionListItem><listItemTerm>IC</listItemTerm><listItemDefinition><para>IC カード</para></listItemDefinition></definitionListItem></definitionList></para>
  <warning><warningAndCautionPara>次を守る。<attentionRandomList><attentionRandomListItem><attentionListItemPara>電源を切る</attentionListItemPara></attentionRandomListItem></attentionRandomList></warningAndCautionPara></warning>
</description>`,
    );
    const c = readContentFromXml(xml);
    const [p1, p2, w] = c.blocks;
    expect(p1).toMatchObject({ kind: 'para', text: '構成は次のとおり。' });
    expect(p1!.children).toHaveLength(1);
    expect(p1!.children[0]).toMatchObject({ kind: 'list', ordered: false });
    expect(p1!.children[0]!.children.map((i) => i.text)).toEqual([
      '本体',
      expect.stringContaining('扉。詳細は'),
    ]);
    expect(p1!.children[0]!.children[1]!.refs?.[0]).toMatchObject({ kind: 'dmRef' });
    expect(p2!.children[0]).toMatchObject({ kind: 'list', title: '用語' });
    expect(p2!.children[0]!.children[0]).toMatchObject({ kind: 'definition', title: 'IC' });
    expect(p2!.children[0]!.children[0]!.children[0]).toMatchObject({ text: 'IC カード' });
    const inWarning = w!.children[0]!;
    expect(inWarning).toMatchObject({ kind: 'para', text: '次を守る。' });
    expect(inWarning.children[0]!.children[0]).toMatchObject({ text: '電源を切る' });
    expect(c.unknownElements).toEqual({});
    // 本文のテキスト節点は、すべて読み取りの結果のどこかにある
    expect(measureTextCoverage(xml)).toEqual({
      total: 11,
      lost: 0,
      lostSilent: 0,
      lostByParent: {},
    });
  });

  it('process: dmNode の直下の参照（その節点が指す DM）を refs に返す', () => {
    const c = readContentFromXml(
      wrap(
        'process',
        `<process><dmSeq><dmNode><title>画面 1</title>${DMREF}</dmNode></dmSeq></process>`,
      ),
    );
    const node = c.blocks[0]!.children[0]!;
    expect(node).toMatchObject({ kind: 'section', title: '画面 1' });
    expect(node.refs).toEqual([expect.objectContaining({ kind: 'dmRef', techName: '券売機' })]);
  });

  it('proced: 品目の natoStockNumber を読む（属性、fullNatoStockNumber、要素の文。2 つ目は identifiers、refs は知らせる）', () => {
    const item = (name: string, ident: string) =>
      `<supplyDescr><name>${name}</name>${ident}<reqQuantity>1</reqQuantity></supplyDescr>`;
    const c = readContentFromXml(
      wrap(
        'proced',
        `<procedure><preliminaryRqmts><reqCondGroup><noConds/></reqCondGroup>
        <reqSupportEquips><noSupportEquips/></reqSupportEquips>
        <reqSupplies><supplyDescrGroup>
        ${item('属性', '<natoStockNumber natoSupplyClass="6850" natoCodificationBureau="00" natoItemIdentNumberCore="1817933"/>')}
        ${item('属性と文字列', '<natoStockNumber natoSupplyClass="4920" natoCodificationBureau="99" natoItemIdentNumberCore="1234567"><fullNatoStockNumber>4920-99-123-4567</fullNatoStockNumber></natoStockNumber>')}
        ${item('文字列だけ', '<natoStockNumber><fullNatoStockNumber>7920-00-140-0869</fullNatoStockNumber></natoStockNumber>')}
        ${item('要素の文', '<natoStockNumber>6810-00-107-1510</natoStockNumber>')}
        ${item('欠けた番号', '<natoStockNumber natoSupplyClass="1615"/>')}
        ${item('2 つと参照', `<natoStockNumber natoSupplyClass="9150" natoCodificationBureau="00" natoItemIdentNumberCore="0797374"><refs>${DMREF}</refs></natoStockNumber><natoStockNumber natoSupplyClass="9150" natoCodificationBureau="00" natoItemIdentNumberCore="1866681"/>`)}
        </supplyDescrGroup></reqSupplies>
        <reqSpares><noSpares/></reqSpares><reqSafety><noSafety/></reqSafety></preliminaryRqmts>
        <mainProcedure><proceduralStep><para>x</para></proceduralStep></mainProcedure>
        <closeRqmts><reqCondGroup><noConds/></reqCondGroup></closeRqmts></procedure>`,
      ),
    );
    const pre = c.blocks[0]!;
    expect(pre.children.map((n) => [n.title, n.natoStockNumber, n.attrs])).toEqual([
      ['属性', '6850-00-181-7933', undefined],
      ['属性と文字列', '4920-99-123-4567', { fullNatoStockNumber: '4920-99-123-4567' }],
      ['文字列だけ', '7920-00-140-0869', undefined],
      ['要素の文', '6810-00-107-1510', undefined],
      ['欠けた番号', '1615', undefined],
      ['2 つと参照', '9150-00-079-7374', { otherIdentifiers: 'natoStockNumber' }],
    ]);
    // 2 つ目の natoStockNumber は identifiers に返す（属性は書かれた値のまま）
    expect(pre.children[5]!.identifiers).toEqual([
      {
        element: 'natoStockNumber',
        attrs: {
          natoSupplyClass: '9150',
          natoCodificationBureau: '00',
          natoItemIdentNumberCore: '1866681',
        },
        text: '9150-00-186-6681',
      },
    ]);
    expect(c.notReadElements).toEqual({ refs: 1 });
    expect(c.unknownElements).toEqual({});
  });

  it('proced: 品目のほかの識別子・備考の脚注・危険性と、作業の場所・所要時間を読む', () => {
    const c = readContentFromXml(
      wrap(
        'proced',
        `<procedure><preliminaryRqmts>
        <productionMaintData applicRefId="app-1">
          <thresholdInterval thresholdUnitOfMeasure="th01">500</thresholdInterval>
          <workAreaLocationGroup>
            <zoneRef zoneNumber="F11"><name>前半分</name></zoneRef>
            <accessPointRef accessPointNumber="A1" accessPointTypeValue="accpnl01"/>
            <workLocation id="wla-1"><workArea>ハンドルの上</workArea>、<productItem productItemName="右フレーム" productItemType="pi01"/>の横。</workLocation>
          </workAreaLocationGroup>
          <taskDuration unitOfMeasure="h" startupDuration="0.1" procedureDuration="0.5" closeupDuration="0"/>
        </productionMaintData>
        <reqCondGroup><noConds/></reqCondGroup>
        <reqSupportEquips><supportEquipDescrGroup>
          <supportEquipDescr><name>トルクレンチ</name><toolRef toolNumber="T-100" manufacturerCodeValue="K0001"><refs>${DMREF}</refs></toolRef><reqQuantity>1</reqQuantity></supportEquipDescr>
        </supportEquipDescrGroup></reqSupportEquips>
        <reqSupplies><supplyDescrGroup>
          <supplyDescr><name>洗浄液</name>
            <supplyRef supplyNumber="CL-1" supplyNumberType="sp01"><name>クリーナー 1 号</name><shortName>CL1</shortName></supplyRef>
            <materialSetRef materialSetIdent="MS-1">${DMREF}</materialSetRef>
            <reqQuantity>As required</reqQuantity>
            <footnoteRemarks><simplePara>注文の後に届く</simplePara><footnoteRef internalRefId="ftn-1"/></footnoteRemarks>
            <hazards>
              <hazard><symbol infoEntityIdent="ICN-K0001-00009-001-01"/><hazardousClass hazardousClassValue="hz03"/><hazardousClass hazardousClassValue="hz07"/>
                <safetyInformation supplementalSafetyCategory="ssc01">引火しやすい</safetyInformation><safetyInformation>目に入れない</safetyInformation></hazard>
              <hazardRef hazardIdentNumber="HZ-9">${DMREF}</hazardRef>
            </hazards>
          </supplyDescr>
          <footnote id="ftn-1" footnoteMark="num"><para>在庫が無いときは購買に問い合わせる</para></footnote>
        </supplyDescrGroup></reqSupplies>
        <reqSpares><noSpares/></reqSpares><reqSafety><noSafety/></reqSafety></preliminaryRqmts>
        <mainProcedure><proceduralStep><para>x</para></proceduralStep></mainProcedure>
        <closeRqmts><reqCondGroup><noConds/></reqCondGroup></closeRqmts></procedure>`,
      ),
    );
    const [pmd, tool, supply, footnote] = c.blocks[0]!.children;

    // 作業の場所・所要時間・間隔
    expect([pmd!.kind, pmd!.element, pmd!.applicRefId, pmd!.attrs]).toEqual([
      'para',
      'productionMaintData',
      'app-1',
      {
        'taskDuration.unitOfMeasure': 'h',
        'taskDuration.startupDuration': '0.1',
        'taskDuration.procedureDuration': '0.5',
        'taskDuration.closeupDuration': '0',
      },
    ]);
    expect(pmd!.children.map((n) => [n.element, n.text, n.attrs])).toEqual([
      ['thresholdInterval', '500', { thresholdUnitOfMeasure: 'th01' }],
      ['workAreaLocationGroup', undefined, undefined],
    ]);
    const group = pmd!.children[1]!;
    expect(group.children.map((n) => [n.element, n.title, n.text, n.attrs])).toEqual([
      ['zoneRef', '前半分', undefined, { zoneNumber: 'F11' }],
      [
        'accessPointRef',
        undefined,
        undefined,
        { accessPointNumber: 'A1', accessPointTypeValue: 'accpnl01' },
      ],
      ['workLocation', undefined, 'ハンドルの上 、 右フレーム の横。', undefined],
    ]);
    expect(group.children[2]!.id).toBe('wla-1');
    expect(group.children[2]!.children.map((n) => [n.element, n.text, n.attrs])).toEqual([
      ['workArea', 'ハンドルの上', undefined],
      ['productItem', undefined, { productItemName: '右フレーム', productItemType: 'pi01' }],
    ]);

    // ほかの識別子: 属性・名前・参照
    expect(tool!.identifiers).toEqual([
      {
        element: 'toolRef',
        attrs: { toolNumber: 'T-100', manufacturerCodeValue: 'K0001' },
        refs: [expect.objectContaining({ kind: 'dmRef', techName: '券売機' })],
      },
    ]);
    expect(supply!.identifiers).toEqual([
      {
        element: 'supplyRef',
        attrs: { supplyNumber: 'CL-1', supplyNumberType: 'sp01' },
        name: 'クリーナー 1 号',
        shortName: 'CL1',
      },
      {
        element: 'materialSetRef',
        attrs: { materialSetIdent: 'MS-1' },
        refs: [expect.objectContaining({ kind: 'dmRef' })],
      },
    ]);
    expect(supply!.attrs).toEqual({
      otherIdentifiers: 'supplyRef materialSetRef',
      remarksElement: 'footnoteRemarks',
    });
    // 備考の文と、脚注への参照
    expect(supply!.text).toBe('注文の後に届く');
    expect(supply!.refs).toEqual([{ kind: 'internalRef', target: 'ftn-1', note: 'footnoteRef' }]);
    // 危険性
    const [hazard, hazardRef] = supply!.children;
    expect([hazard!.kind, hazard!.element, hazard!.attrs]).toEqual([
      'list',
      'hazard',
      { hazardousClass: 'hz03 hz07' },
    ]);
    expect(hazard!.refs).toEqual([{ kind: 'graphic', target: 'ICN-K0001-00009-001-01' }]);
    expect(hazard!.children.map((n) => [n.kind, n.element, n.text, n.attrs])).toEqual([
      ['listItem', 'safetyInformation', '引火しやすい', { supplementalSafetyCategory: 'ssc01' }],
      ['listItem', 'safetyInformation', '目に入れない', undefined],
    ]);
    expect([hazardRef!.kind, hazardRef!.element, hazardRef!.attrs]).toEqual([
      'para',
      'hazardRef',
      { hazardIdentNumber: 'HZ-9' },
    ]);
    expect(hazardRef!.refs).toEqual([expect.objectContaining({ kind: 'dmRef' })]);
    // グループの脚注は、その種類の品目の後ろ
    expect([
      footnote!.kind,
      footnote!.element,
      footnote!.id,
      footnote!.text,
      footnote!.attrs,
    ]).toEqual([
      'para',
      'footnote',
      'ftn-1',
      '在庫が無いときは購買に問い合わせる',
      { footnoteMark: 'num' },
    ]);
    expect(c.notReadElements).toEqual({});
    expect(c.unknownElements).toEqual({});
  });

  it('fault: 不具合の説明（faultDescr）を、faultCode を付けた段落として読む', () => {
    const c = readContentFromXml(
      wrap(
        'fault',
        `<faultReporting><isolatedFault id="f1"><fault faultCode="100FC01"/>
        <faultDescr><descr>警告灯が点かない</descr></faultDescr></isolatedFault></faultReporting>`,
      ),
    );
    expect(c.blocks.map((n) => [n.kind, n.element, n.text, n.attrs])).toEqual([
      ['para', 'faultDescr', '警告灯が点かない', { faultCode: '100FC01' }],
    ]);
  });

  it('process: メニューの選択肢と知らせ（message）の文、変数の宣言・代入・検査を読む', () => {
    const cmp = (name: string, op: string, value: string) =>
      `<expression><expression><variableRef variableName="${name}"/></expression><numberOperator numberOperation="${op}"/><expression><integerValue>${value}</integerValue></expression></expression>`;
    const c = readContentFromXml(
      wrap(
        'process',
        `<process><variableDeclarations>
          <variable variableName="level" valueType="string"><initialize><expression><stringValue>amateur</stringValue></expression></initialize></variable>
          <variable variableName="ok" valueType="boolean"><initialize><expression><booleanValue><falseValue/></booleanValue></expression></initialize></variable>
          <variable variableName="age" valueType="integer"/>
        </variableDeclarations>
        <dmSeq><dmNode id="n1">
          <variablePreSet><assertion><variableRef variableName="age"/><expression><stringValue>13</stringValue></expression></assertion></variablePreSet>
          <dialog>
          <menu><prompt><paraBasic>自転車に乗ったことがありますか</paraBasic></prompt>
            <menuChoice><prompt><paraBasic>はい</paraBasic></prompt><assertion><variableRef variableName="level"/><expression><stringValue>experienced</stringValue></expression></assertion></menuChoice>
            <menuChoice><prompt><paraBasic>いいえ</paraBasic></prompt><noAssertions/></menuChoice>
          </menu>
          <dialogGroup><message><prompt><paraBasic>年齢は 4 から 100 まで</paraBasic></prompt><prompt><paraBasic>すべて入力してください</paraBasic></prompt></message></dialogGroup>
          <userEntry><prompt><paraBasic>年齢</paraBasic></prompt><variableRef variableName="age"/>
            <validate errorMessage="4 から 100 まで"><expression>${cmp('age', 'greaterThanOrEqual', '4')}<booleanOperator booleanOperation="and"/>${cmp('age', 'lessThanOrEqual', '100')}</expression></validate></userEntry>
          </dialog>
          <variablePostSet><assertion><variableRef variableName="names"/><expression><expression><variableRef variableName="names"/></expression><setOperator setOperation="add"/><expression><variableRef variableName="name"/></expression></expression></assertion></variablePostSet>
        </dmNode></dmSeq></process>`,
      ),
    );
    // 変数の宣言: list。初期値の式は、書かれた値を並べた文にする（評価しない）
    const decl = c.blocks[0]!;
    expect([decl.kind, decl.element]).toEqual(['list', 'variableDeclarations']);
    expect(decl.children.map((n) => [n.kind, n.element, n.attrs])).toEqual([
      [
        'listItem',
        'variable',
        { variableName: 'level', valueType: 'string', initialValue: '"amateur"' },
      ],
      ['listItem', 'variable', { variableName: 'ok', valueType: 'boolean', initialValue: 'false' }],
      ['listItem', 'variable', { variableName: 'age', valueType: 'integer' }],
    ]);
    const [pre, dialog, post] = c.blocks[1]!.children[0]!.children;
    expect([pre!.kind, pre!.element, pre!.attrs]).toEqual([
      'para',
      'variablePreSet',
      { variableName: 'age', expression: '"13"' },
    ]);
    expect([post!.element, post!.attrs]).toEqual([
      'variablePostSet',
      { variableName: 'names', expression: 'names add name' },
    ]);
    const menu = dialog!.children[0]!;
    expect([menu.element, menu.text]).toEqual(['menu', '自転車に乗ったことがありますか']);
    expect(menu.children.map((n) => [n.kind, n.element, n.text])).toEqual([
      ['listItem', 'menuChoice', 'はい'],
      ['listItem', 'menuChoice', 'いいえ'],
    ]);
    // 選んだときの代入は、選択肢の子
    expect(menu.children[0]!.children.map((n) => [n.kind, n.element, n.attrs])).toEqual([
      ['para', 'assertion', { variableName: 'level', expression: '"experienced"' }],
    ]);
    expect(menu.children[1]!.children).toEqual([]);
    expect(dialog!.children[1]!.children.map((n) => [n.kind, n.element, n.text])).toEqual([
      ['para', 'prompt', '年齢は 4 から 100 まで'],
      ['para', 'prompt', 'すべて入力してください'],
    ]);
    // 入力の検査: 入れ子の式は括弧でくくる
    const validate = dialog!.children[2]!.children.find((n) => n.element === 'validate')!;
    expect(validate.attrs).toEqual({
      errorMessage: '4 から 100 まで',
      expression: '(age greaterThanOrEqual 4) and (age lessThanOrEqual 100)',
    });
    expect(c.notReadElements).toEqual({});
  });

  it('descript: 図の凡例、定義リストの見出し、折り込みの図を読む', () => {
    const c = readContentFromXml(
      wrap(
        'descript',
        `<description>
        <levelledPara><title>概要</title>
          <para><definitionList><definitionListHeader><termTitle>部品</termTitle><definitionTitle>働き</definitionTitle></definitionListHeader>
            <definitionListItem><listItemTerm>フレーム</listItemTerm><listItemDefinition><para>全体を支える</para></listItemDefinition></definitionListItem></definitionList></para>
          <figure id="fig-1"><title>外観</title><graphic infoEntityIdent="ICN-K0001-00001-001-01"><reasonForAmendment>図を足した</reasonForAmendment></graphic>
            <legend><definitionList><title>凡例</title>
              <definitionListItem><listItemTerm>1</listItemTerm><listItemDefinition><para>表示</para></listItemDefinition></definitionListItem></definitionList></legend></figure>
          <foldout><figure id="fig-2"><title>全体図</title><graphic infoEntityIdent="ICN-K0001-00002-001-01"/></figure></foldout>
        </levelledPara></description>`,
      ),
    );
    const [para, fig1, fig2] = c.blocks[0]!.children;
    const list = para!.children[0]!;
    expect([list.kind, list.attrs]).toEqual([
      'list',
      { termTitle: '部品', definitionTitle: '働き' },
    ]);
    expect(list.children.map((n) => [n.title, n.children[0]!.text])).toEqual([
      ['フレーム', '全体を支える'],
    ]);
    expect([fig1!.kind, fig1!.title, fig1!.refs?.[0]?.target]).toEqual([
      'figure',
      '外観',
      'ICN-K0001-00001-001-01',
    ]);
    const legend = fig1!.children[0]!;
    expect([legend.kind, legend.title]).toEqual(['list', '凡例']);
    expect(legend.children.map((n) => [n.title, n.children[0]!.text])).toEqual([['1', '表示']]);
    // 折り込み（foldout）は容れ物として辿り、中の figure を題名つきで返す
    expect([fig2!.kind, fig2!.element, fig2!.title, fig2!.refs?.[0]?.target]).toEqual([
      'figure',
      'figure',
      '全体図',
      'ICN-K0001-00002-001-01',
    ]);
    // 図の改訂の理由は、図への参照に付く
    expect(fig1!.refs?.[0]?.reasonForAmendment).toBe('図を足した');
    expect(c.notReadElements).toEqual({});
    expect(c.unknownElements).toEqual({});
  });

  it('proced: 外部の文書の版と発行日、入れ子の品目を読む', () => {
    const c = readContentFromXml(
      wrap(
        'proced',
        `<procedure><preliminaryRqmts><reqCondGroup><noConds/></reqCondGroup>
        <reqTechInfoGroup><reqTechInfo><externalPubRef><externalPubRefIdent><externalPubCode>SafeS-12</externalPubCode><externalPubTitle>安全データシート</externalPubTitle>
          <externalPubIssueInfo><externalPubIssue>2014</externalPubIssue></externalPubIssueInfo></externalPubRefIdent>
          <externalPubRefAddressItems><externalPubIssueDate>January 2014</externalPubIssueDate></externalPubRefAddressItems></externalPubRef></reqTechInfo></reqTechInfoGroup>
        <reqSupportEquips><supportEquipDescrGroup><supportEquipDescr><name>工具セット</name>
          <identNumber><manufacturerCode>K0001</manufacturerCode><partAndSerialNumber><partNumber>SET-1</partNumber></partAndSerialNumber></identNumber><reqQuantity>1</reqQuantity>
          <embeddedSupportEquipDescr id="e1"><name>のこぎり</name><identNumber><manufacturerCode>K0001</manufacturerCode><partAndSerialNumber><partNumber>SAW-1</partNumber></partAndSerialNumber></identNumber><reqQuantity>2</reqQuantity></embeddedSupportEquipDescr>
        </supportEquipDescr></supportEquipDescrGroup></reqSupportEquips>
        <reqSupplies><noSupplies/></reqSupplies><reqSpares><noSpares/></reqSpares><reqSafety><noSafety/></reqSafety></preliminaryRqmts>
        <mainProcedure><proceduralStep><para>x</para></proceduralStep></mainProcedure>
        <closeRqmts><reqCondGroup><noConds/></reqCondGroup></closeRqmts></procedure>`,
      ),
    );
    const [doc, set] = c.blocks[0]!.children;
    expect(doc!.refs).toEqual([
      {
        kind: 'externalPubRef',
        target: 'SafeS-12',
        title: '安全データシート',
        externalPubIssue: '2014',
        externalPubIssueDate: 'January 2014',
      },
    ]);
    expect([set!.kind, set!.title, set!.attrs]).toEqual(['equipment', '工具セット', undefined]);
    expect(
      set!.children.map((n) => [n.kind, n.element, n.id, n.title, n.partNumber, n.quantity]),
    ).toEqual([['equipment', 'embeddedSupportEquipDescr', 'e1', 'のこぎり', 'SAW-1', '2']]);
    expect(c.notReadElements).toEqual({});
    expect(c.unknownElements).toEqual({});
  });
});
