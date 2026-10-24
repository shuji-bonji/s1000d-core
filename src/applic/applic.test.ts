import { describe, expect, it } from 'vitest';
import { defaultXmlEngine } from '../xml/index.js';
import type { Element } from '../xml/engine.js';
import {
  ApplicEvaluator,
  buildApplicRepository,
  evaluateApplic,
  evaluateExpr,
} from './evaluate.js';
import { productFromPct, readAct, readApplicStatements, readCct, readPct } from './read.js';
import type { Product } from './types.js';

const parse = (xml: string) => defaultXmlEngine.parse(xml).document;

/** 自作の ACT（券売機 KENBAIKI。機種 model、版 version、設置形態 site） */
const ACT = `<dmodule><content><applicCrossRefTable>
  <productAttributeList>
    <productAttribute id="serial" productIdentifier="primary"><name>製造番号</name><displayName>S/N</displayName></productAttribute>
    <productAttribute id="model" valuePattern="MV-\\d{2}"><name>機種</name><enumeration applicPropertyValues="MV-50|MV-60"/></productAttribute>
    <productAttribute id="version" valueDataType="integer"><name>版</name><enumeration applicPropertyValues="1~9"/></productAttribute>
  </productAttributeList>
  <condCrossRefTableRef><dmRef><dmRefIdent><dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="00" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="00Q" infoCodeVariant="A" itemLocationCode="D"/></dmRefIdent></dmRef></condCrossRefTableRef>
</applicCrossRefTable></content></dmodule>`;

const CCT = `<dmodule><content><condCrossRefTable>
  <condTypeList><condType id="SB" valueDataType="string"><name>改修</name><enumeration applicPropertyValues="PRE"/><enumeration applicPropertyValues="POST-001~POST-099"/></condType></condTypeList>
  <condList><cond condTypeRefId="SB" id="SB-001"><name>改修 001 - 読み取り部の交換</name></cond></condList>
</condCrossRefTable></content></dmodule>`;

const PCT = `<dmodule><content><productCrossRefTable>
  <product id="p1"><assign applicPropertyIdent="serial" applicPropertyType="prodattr" applicPropertyValue="K0001"/><assign applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValue="MV-50"/><assign applicPropertyIdent="version" applicPropertyType="prodattr" applicPropertyValue="3"/><assign applicPropertyIdent="SB-001" applicPropertyType="condition" applicPropertyValue="PRE"/></product>
  <product id="p2"><assign applicPropertyIdent="serial" applicPropertyType="prodattr" applicPropertyValue="K0002"/><assign applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValue="MV-60"/><assign applicPropertyIdent="version" applicPropertyType="prodattr" applicPropertyValue="7"/><assign applicPropertyIdent="SB-001" applicPropertyType="condition" applicPropertyValue="POST-002"/></product>
</productCrossRefTable></content></dmodule>`;

/** 自作の説明 DM。DM 全体は MV-50/MV-60、段落ごとに版や改修で絞る */
const DM = `<dmodule>
  <identAndStatusSection><dmAddress/><dmStatus>
    <applic><displayText><simplePara>MV-50 と MV-60</simplePara></displayText>
      <assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="MV-50|MV-60"/></applic>
  </dmStatus></identAndStatusSection>
  <content>
    <referencedApplicGroup>
      <applic id="app-v5"><displayText><simplePara>版 5 以降</simplePara></displayText>
        <assert applicPropertyIdent="version" applicPropertyType="prodattr" applicPropertyValues="5~9"/></applic>
      <applic id="app-post"><displayText><simplePara>改修 001 後の MV-60、または MV-50 の版 1〜2</simplePara></displayText>
        <evaluate andOr="or">
          <evaluate andOr="and">
            <assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="MV-60"/>
            <assert applicPropertyIdent="SB-001" applicPropertyType="condition" applicPropertyValues="POST-001~POST-099"/>
          </evaluate>
          <evaluate andOr="and">
            <assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="MV-50"/>
            <assert applicPropertyIdent="version" applicPropertyType="prodattr" applicPropertyValues="1~2"/>
          </evaluate>
        </evaluate></applic>
      <applic id="app-text"><displayText><simplePara>すべて</simplePara></displayText></applic>
    </referencedApplicGroup>
    <referencedApplicGroupRef><applicRef applicIdentValue="app-KENBAIKI-0007" id="app-ext"/><applicRef applicIdentValue="app-KENBAIKI-9999" id="app-missing"/></referencedApplicGroupRef>
    <description>
      <levelledPara id="p1" applicRefId="app-v5"><para>新しい画面</para><para id="p1a">入れ子</para></levelledPara>
      <levelledPara id="p2" applicRefId="app-post"><para>改修後の手順</para></levelledPara>
      <levelledPara id="p3"><para>共通</para></levelledPara>
      <levelledPara id="p4" applicRefId="app-ext"><para>別 DM の適用性</para></levelledPara>
      <levelledPara id="p5" applicRefId="app-missing"><para>無い適用性</para></levelledPara>
      <levelledPara id="p6" applicRefId="app-nowhere"><para>どこにも無い id</para></levelledPara>
    </description>
  </content>
</dmodule>`;

/** 自作の適用性リポジトリ（別 DM） */
const REPO = `<dmodule><content><referencedApplicGroup>
  <applic id="r1" applicIdentValue="app-KENBAIKI-0007"><displayText><simplePara>MV-60 だけ</simplePara></displayText>
    <assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="MV-60"/></applic>
</referencedApplicGroup></content></dmodule>`;

const mv50v3: Product = {
  attributes: { model: 'MV-50', version: '3' },
  conditions: { 'SB-001': 'PRE' },
};
const mv60v7post: Product = {
  attributes: { model: 'MV-60', version: '7' },
  conditions: { 'SB-001': 'POST-002' },
};
const other: Product = { attributes: { model: 'MV-70', version: '1' }, conditions: {} };

describe('ACT / CCT / PCT の読み取り', () => {
  it('ACT の属性・列挙・参照を読む', () => {
    const act = readAct(parse(ACT))!;
    expect(act.productAttributes.map((a) => a.id)).toEqual(['serial', 'model', 'version']);
    expect(act.productAttributes[0].productIdentifier).toBe('primary');
    expect(act.productAttributes[1].enumerations).toEqual(['MV-50|MV-60']);
    expect(act.productAttributes[1].valuePattern).toBe('MV-\\d{2}');
    expect(act.productAttributes[2].valueDataType).toBe('integer');
    expect(act.condCrossRefTableRef?.dmCode.infoCode).toBe('00Q');
    expect(readAct(parse(CCT))).toBeUndefined();
  });
  it('CCT の条件の種類と条件を読む', () => {
    const cct = readCct(parse(CCT))!;
    expect(cct.condTypes[0]).toMatchObject({
      id: 'SB',
      enumerations: ['PRE', 'POST-001~POST-099'],
    });
    expect(cct.conds[0]).toMatchObject({
      id: 'SB-001',
      condTypeRefId: 'SB',
      name: '改修 001 - 読み取り部の交換',
    });
  });
  it('PCT の製品を読み、判定用の Product にする', () => {
    const pct = readPct(parse(PCT))!;
    expect(pct.products).toHaveLength(2);
    const p = productFromPct(pct.products[1]);
    expect(p).toEqual({
      attributes: { serial: 'K0002', model: 'MV-60', version: '7' },
      conditions: { 'SB-001': 'POST-002' },
    });
  });
});

describe('applic の読み取りと評価', () => {
  it('識別・状態部と referencedApplicGroup の applic を読む', () => {
    const sts = readApplicStatements(parse(DM));
    expect(sts).toHaveLength(4);
    expect(sts[0].isDmLevel).toBe(true);
    expect(sts[0].expr?.kind).toBe('assert');
    expect(sts.find((s) => s.id === 'app-post')?.expr).toMatchObject({
      kind: 'evaluate',
      andOr: 'or',
    });
    expect(sts.find((s) => s.id === 'app-text')?.expr).toBeUndefined();
    expect(sts[1].location.path).toMatch(/referencedApplicGroup\/applic\[1\]$/);
  });
  it('assert と evaluate を 3 値で評価する', () => {
    const sts = readApplicStatements(parse(DM));
    const post = sts.find((s) => s.id === 'app-post')!;
    expect(evaluateApplic(post, mv60v7post).state).toBe('applicable'); // MV-60 かつ POST-002
    expect(evaluateApplic(post, mv50v3).state).toBe('notApplicable'); // MV-50 だが版 3
    expect(evaluateApplic(post, other).state).toBe('notApplicable'); // model が合わないので and は偽、or 全体も偽
    const partial: Product = { attributes: { model: 'MV-60' }, conditions: {} };
    const r = evaluateApplic(post, partial);
    expect(r.state).toBe('undetermined'); // MV-60 の and は条件が無く undetermined、MV-50 の and は偽 → or は undetermined
    expect(r.missingProperties).toEqual(['SB-001']);
    expect(r.reason).toMatch(/SB-001/);
    expect(evaluateApplic(post, undefined)).toMatchObject({
      state: 'undetermined',
      reason: 'product not given',
    });
    expect(
      evaluateApplic(
        sts.find((s) => s.id === 'app-text')!,
        undefined,
      ).state,
    ).toBe('applicable');
  });
  it('and / or の短絡: 偽が 1 つあれば未知があっても and は偽、真が 1 つあれば or は真', () => {
    const andExpr = {
      kind: 'evaluate' as const,
      andOr: 'and' as const,
      children: [
        {
          kind: 'assert' as const,
          propertyIdent: 'model',
          propertyType: 'prodattr',
          values: 'MV-99',
        },
        {
          kind: 'assert' as const,
          propertyIdent: 'nothing',
          propertyType: 'prodattr',
          values: 'x',
        },
      ],
    };
    expect(evaluateExpr(andExpr, mv50v3).state).toBe('notApplicable');
    const orExpr = {
      ...andExpr,
      andOr: 'or' as const,
      children: [
        {
          kind: 'assert' as const,
          propertyIdent: 'model',
          propertyType: 'prodattr',
          values: 'MV-50',
        },
        {
          kind: 'assert' as const,
          propertyIdent: 'nothing',
          propertyType: 'prodattr',
          values: 'x',
        },
      ],
    };
    expect(evaluateExpr(orExpr, mv50v3).state).toBe('applicable');
  });
});

describe('ApplicEvaluator', () => {
  const doc = parse(DM);
  const repo = buildApplicRepository(readApplicStatements(parse(REPO)));
  const ev = new ApplicEvaluator(doc, { repository: repo });
  const el = (id: string) => defaultXmlEngine.selectNodes(`//*[@id="${id}"]`, doc)[0] as Element;

  it('DM 全体の判定', () => {
    expect(ev.dmLevel(mv50v3).state).toBe('applicable');
    expect(ev.dmLevel(other).state).toBe('notApplicable');
    expect(ev.dmLevel(undefined)).toMatchObject({
      state: 'undetermined',
      displayText: 'MV-50 と MV-60',
    });
  });
  it('要素の判定は、最も近い applicRefId と DM 全体を and で結ぶ', () => {
    expect(ev.forElement(el('p1'), mv60v7post).state).toBe('applicable'); // 版 7 ≥ 5
    expect(ev.forElement(el('p1'), mv50v3).state).toBe('notApplicable'); // 版 3
    expect(ev.forElement(el('p1a'), mv50v3).state).toBe('notApplicable'); // 祖先の applicRefId を継ぐ
    expect(ev.forElement(el('p3'), mv50v3).state).toBe('applicable'); // DM 全体だけ
    expect(ev.forElement(el('p3'), other).state).toBe('notApplicable'); // DM 全体で外れる
    expect(ev.forElement(el('p2'), mv60v7post)).toMatchObject({
      state: 'applicable',
      applicId: 'app-post',
    });
  });
  it('referencedApplicGroupRef 経由はリポジトリから探し、無ければ理由付きで undetermined', () => {
    expect(ev.forElement(el('p4'), mv60v7post)).toMatchObject({
      state: 'applicable',
      displayText: 'MV-60 だけ',
    });
    expect(ev.forElement(el('p4'), mv50v3).state).toBe('notApplicable');
    const missing = ev.forElement(el('p5'), mv50v3);
    expect(missing.state).toBe('undetermined');
    expect(missing.reason).toMatch(/app-KENBAIKI-9999.*not found in the applicability repository/);
    const nowhere = ev.forElement(el('p6'), mv50v3);
    expect(nowhere.state).toBe('undetermined');
    expect(nowhere.reason).toMatch(/no applic with id="app-nowhere"/);
    const noRepo = new ApplicEvaluator(doc);
    expect(noRepo.forRefId('app-ext', mv50v3).state).toBe('undetermined');
  });
});
