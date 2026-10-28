/**
 * 翻訳向けの文の抜き出しと差し戻し（extractSegments / applySegments）のテスト。
 * 配布物を使うテストは `S1000D_SPEC_TESTS=1` のときだけ動かす（DECISIONS D-03）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readContentFromXml, type ContentNode } from '../content/index.js';
import { readDataModuleInfo } from '../data-module.js';
import { ID_ABBREVIATIONS } from './collect.js';
import {
  SkeletonMismatchError,
  applySegments,
  extractSegments,
  type ExtractResult,
  type Segment,
} from './index.js';

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), 'utf8');
const kenbaiki = fx('kenbaiki-descript.xml');

/** 空白を正規化して比べる（タグの前後の空白は無視する） */
const normalize = (xml: string) =>
  xml.replace(/\s+/g, ' ').replace(/>\s+/g, '>').replace(/\s+</g, '<').trim();

/** 手順・警告・注記・インライン要素・入れ子のリストを含む、自作の小さな手順 DM */
const PROCED = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE dmodule [
  <!ENTITY ICN-KENBAIKI-A-000000-0-K0001-00002-A-01-1 SYSTEM "ICN-KENBAIKI-A-000000-0-K0001-00002-A-01-1.PNG" NDATA png>
  <!NOTATION png PUBLIC "-//W3C//NOTATION Portable Network Graphics//EN">
]>
<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_7/xml_schema_flat/proced.xsd">
  <identAndStatusSection>
    <dmAddress>
      <dmIdent>
        <dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="10" subSystemCode="2"
          subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="520"
          infoCodeVariant="A" itemLocationCode="A"/>
        <language languageIsoCode="ja" countryIsoCode="JP"/>
        <issueInfo issueNumber="001" inWork="00"/>
      </dmIdent>
      <dmAddressItems>
        <issueDate year="2026" month="10" day="27"/>
        <dmTitle>
          <techName>指定席券売機</techName>
          <infoName>紙詰まりの除去</infoName>
        </dmTitle>
      </dmAddressItems>
    </dmAddress>
    <dmStatus issueType="new">
      <security securityClassification="01"/>
      <responsiblePartnerCompany enterpriseCode="K0001">
        <enterpriseName>Kenbaiki Works</enterpriseName>
      </responsiblePartnerCompany>
      <originator enterpriseCode="K0001">
        <enterpriseName>Kenbaiki Works</enterpriseName>
      </originator>
      <applic>
        <displayText>
          <simplePara>全機種</simplePara>
        </displayText>
      </applic>
      <brexDmRef>
        <dmRef>
          <dmRefIdent>
            <dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="00" subSystemCode="0"
              subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="022"
              infoCodeVariant="A" itemLocationCode="D"/>
            <issueInfo issueNumber="001" inWork="00"/>
          </dmRefIdent>
        </dmRef>
      </brexDmRef>
      <qualityAssurance>
        <unverified/>
      </qualityAssurance>
    </dmStatus>
  </identAndStatusSection>
  <content>
    <procedure>
      <mainProcedure>
        <proceduralStep id="stp-0001">
          <title>電源を切る</title>
          <para>本体の<emphasis>電源スイッチ</emphasis>を押して、<internalRef internalRefId="fig-0001" internalRefTargetType="irtt01"/>のとおり電源を切る。</para>
          <warning>
            <warningAndCautionPara>H<subScript>2</subScript>O を含む液体を近づけない。感電のおそれがある。</warningAndCautionPara>
          </warning>
          <proceduralStep id="stp-0002">
            <para>カバーを開ける。次の工具を使う：
              <randomList>
                <listItem><para>プラスドライバー</para></listItem>
                <listItem><para>手袋</para></listItem>
              </randomList>
              工具が無ければ交換する。</para>
          </proceduralStep>
          <proceduralStep id="stp-0003">
            <para>詰まった紙を取り除く。</para>
            <note>
              <notePara>設定値 {A} は変えない。</notePara>
            </note>
          </proceduralStep>
        </proceduralStep>
      </mainProcedure>
    </procedure>
  </content>
</dmodule>
`;

/** 表・図・用語集・インライン要素（dmRef・acronym）を含む、自作の小さな説明 DM */
const DESCRIPT = kenbaiki.replace(
  /<levelledPara>[\s\S]*<\/levelledPara>/,
  `<levelledPara>
        <title>仕様</title>
        <para>詳しくは<dmRef><dmRefIdent><dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="10" subSystemCode="2" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="040" infoCodeVariant="A" itemLocationCode="D"/></dmRefIdent></dmRef>を見る。<acronym><acronymTerm acronymType="at01">ATM</acronymTerm><acronymDefinition>現金自動預け払い機</acronymDefinition></acronym>とは別の装置である。</para>
        <table frame="all">
          <title>寸法</title>
          <tgroup cols="2">
            <thead>
              <row><entry>項目</entry><entry>値</entry></row>
            </thead>
            <tbody>
              <row><entry><para>幅</para></entry><entry>600 <emphasis>mm</emphasis></entry></row>
            </tbody>
          </tgroup>
        </table>
        <figure>
          <title>外観</title>
          <graphic infoEntityIdent="ICN-KENBAIKI-A-000000-0-K0001-00001-A-01-1"/>
        </figure>
      </levelledPara>`,
);

const idsOf = (r: ExtractResult) => r.segments.map((s) => s.id);
const byId = (r: ExtractResult, id: string): Segment => {
  const s = r.segments.find((x) => x.id === id);
  if (!s) throw new Error(`segment not found: ${id} in ${idsOf(r).join(', ')}`);
  return s;
};

describe('extractSegments', () => {
  it('kenbaiki-descript.xml: 人が読む文だけを、種類と手がかりつきで出す', () => {
    const r = extractSegments(kenbaiki);
    expect(r.dmCode.modelIdentCode).toBe('KENBAIKI');
    expect(r.language).toEqual({ languageIsoCode: 'ja', countryIsoCode: 'JP' });
    expect(r.counts).toEqual({
      total: 6,
      title: 3,
      para: 2,
      step: 0,
      admonition: 0,
      table: 0,
      caption: 1,
    });
    expect(r.segments.map((s) => [s.id, s.category, s.text])).toEqual([
      ['ias.da.dai.dt.tn', 'title', '指定席券売機'],
      ['ias.da.dai.dt.in', 'title', '説明'],
      ['ias.ds.ap.dx.sp1', 'para', 'タッチパネル式、2 号機以降'],
      ['d.lp1.ti1', 'title', '画面の構成'],
      ['d.lp1.p1', 'para', '初期画面には「きっぷを買う」「予約を受け取る」の 2 つのボタンがある。'],
      ['d.lp1.f1.ti1', 'caption', '初期画面'],
    ]);
    expect(byId(r, 'd.lp1.p1').context).toBe('画面の構成');
    expect(byId(r, 'd.lp1.ti1').context).toBe('levelledPara title');
    expect(byId(r, 'd.lp1.f1.ti1').context).toBe('画面の構成 > figure');
    expect(byId(r, 'ias.da.dai.dt.tn').context).toBe('dmTitle/techName');
    expect(byId(r, 'd.lp1.p1').xpath).toBe('content[1]/description[1]/levelledPara[1]/para[1]');
    expect(byId(r, 'd.lp1.p1').location.path).toBe(
      '/dmodule/content/description/levelledPara/para',
    );
    expect(r.skeletonHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('手順 DM: 手順の番号・警告・注記・入れ子のリストを持つ段落を扱う', () => {
    const r = extractSegments(PROCED);
    expect(r.counts).toMatchObject({ title: 3, step: 4, admonition: 2, para: 3 });
    const step1 = byId(r, 'pr.mp.st1.p1');
    expect(step1.category).toBe('step');
    expect(step1.context).toBe('step 1: 電源を切る');
    // インライン要素は {1} {2} に置き換わる
    expect(step1.text).toBe('本体の{1}を押して、{2}のとおり電源を切る。');
    expect(step1.placeholders.map((p) => [p.index, p.element])).toEqual([
      [1, 'emphasis'],
      [2, 'internalRef'],
    ]);
    expect(step1.placeholders[0]!.xml).toBe('<emphasis>電源スイッチ</emphasis>');
    expect(step1.placeholders[1]!.xml).toContain('internalRefId="fig-0001"');

    const warn = byId(r, 'pr.mp.st1.w1.wcp1');
    expect(warn.category).toBe('admonition');
    expect(warn.context).toBe('step 1: 電源を切る > warning');
    expect(warn.text).toBe('H{1}O を含む液体を近づけない。感電のおそれがある。');

    // 入れ子のリストはそのまま残し、前後の文字は別の文（~番号）になる
    const before = byId(r, 'pr.mp.st1.st1.p1');
    const after = byId(r, 'pr.mp.st1.st1.p1~1');
    expect(before.text).toBe('カバーを開ける。次の工具を使う：');
    expect(after.text).toBe('工具が無ければ交換する。');
    expect(before.context).toBe('step 1: 電源を切る > step 1.1');
    expect(byId(r, 'pr.mp.st1.st1.p1.rl1.li1.p1').text).toBe('プラスドライバー');
    expect(byId(r, 'pr.mp.st1.st1.p1.rl1.li2.p1').category).toBe('para');

    // 文字としての波括弧は二重にする
    expect(byId(r, 'pr.mp.st1.st2.n1.np1').text).toBe('設定値 {{A}} は変えない。');
    expect(byId(r, 'pr.mp.st1.st2.p1').context).toBe('step 1: 電源を切る > step 1.2');
    // インライン要素の中の文が訳されないことは notes に出る
    expect(r.notes.join(' ')).toMatch(/inline element\(s\) with text/);
  });

  it('表・図・インライン要素（dmRef・acronym）', () => {
    const r = extractSegments(DESCRIPT);
    const para = byId(r, 'd.lp1.p1');
    expect(para.text).toBe('詳しくは{1}を見る。{2}とは別の装置である。');
    expect(para.placeholders.map((p) => p.element)).toEqual(['dmRef', 'acronym']);
    expect(byId(r, 'd.lp1.tb1.ti1').category).toBe('caption');
    expect(byId(r, 'd.lp1.tb1.ti1').context).toBe('仕様 > table');
    // 表のセル: 直接の文字を持つ entry と、para を持つ entry の中の para
    const cells = r.segments.filter((s) => s.category === 'table');
    expect(cells.map((c) => [c.text, c.context])).toEqual([
      ['項目', '仕様 > table: 寸法 > cell r1c1'],
      ['値', '仕様 > table: 寸法 > cell r1c2'],
      ['幅', '仕様 > table: 寸法 > cell r2c1'],
      ['600 {1}', '仕様 > table: 寸法 > cell r2c2'],
    ]);
    expect(byId(r, 'd.lp1.f1.ti1').category).toBe('caption');
  });

  it('include と maxSegments で絞れる。骨組みのハッシュは絞り込みに左右されない', () => {
    const all = extractSegments(PROCED);
    const onlyAdm = extractSegments(PROCED, { include: ['admonition'] });
    expect(onlyAdm.segments.map((s) => s.category)).toEqual(['admonition', 'admonition']);
    expect(onlyAdm.counts.total).toBe(2);
    const few = extractSegments(PROCED, { maxSegments: 2 });
    expect(few.segments).toHaveLength(2);
    expect(few.notes.join(' ')).toMatch(/Only the first 2 of/);
    expect(onlyAdm.skeletonHash).toBe(all.skeletonHash);
    expect(few.skeletonHash).toBe(all.skeletonHash);
  });

  it('id は一意で、短縮名は重複しない', () => {
    for (const xml of [kenbaiki, PROCED, DESCRIPT]) {
      const ids = idsOf(extractSegments(xml));
      expect(new Set(ids).size).toBe(ids.length);
    }
    const abbrs = Object.values(ID_ABBREVIATIONS);
    expect(new Set(abbrs).size).toBe(abbrs.length);
  });

  it('文の中身が変わっても骨組みのハッシュは変わらず、構造が変わると変わる', () => {
    const base = extractSegments(PROCED).skeletonHash;
    expect(extractSegments(PROCED.replace('カバーを開ける', 'フタを外す')).skeletonHash).toBe(base);
    // インデントだけの変更
    expect(extractSegments(PROCED.replace(/\n {6}/g, '\n    ')).skeletonHash).toBe(base);
    // 属性（id）の変更
    expect(extractSegments(PROCED.replace('stp-0003', 'stp-0099')).skeletonHash).not.toBe(base);
  });
});

const ja = { languageIsoCode: 'ja', countryIsoCode: 'JP' };
const en = { languageIsoCode: 'en', countryIsoCode: 'US' };

describe('applySegments', () => {
  it('抜き出した文をそのまま戻すと、元の XML と（空白を除いて）同じになる', () => {
    for (const xml of [kenbaiki, PROCED, DESCRIPT]) {
      const r = extractSegments(xml);
      const back = applySegments(xml, r.segments, { language: ja, skeletonHash: r.skeletonHash });
      expect(back.unapplied).toEqual([]);
      expect(back.applied).toBe(r.segments.length);
      expect(normalize(back.xml)).toBe(normalize(xml));
    }
  });

  it('言語だけ変えた往復でも、直列化で XML が崩れない（language 以外は同じ）', () => {
    for (const xml of [kenbaiki, PROCED, DESCRIPT]) {
      const r = extractSegments(xml);
      const back = applySegments(xml, r.segments, { language: en, skeletonHash: r.skeletonHash });
      expect(normalize(back.xml)).toBe(
        normalize(
          xml.replace(
            '<language languageIsoCode="ja" countryIsoCode="JP"/>',
            '<language languageIsoCode="en" countryIsoCode="US"/>',
          ),
        ),
      );
    }
  });

  it('訳文を入れると language だけ違う XML になり、読んだ木の text が訳文になる', () => {
    const r = extractSegments(PROCED);
    const translated = r.segments.map((s) => ({
      id: s.id,
      text:
        s.id === 'pr.mp.st1.p1'
          ? 'Push the {1} to turn off the power as shown in {2}.'
          : `EN:${s.text}`,
    }));
    const out = applySegments(PROCED, translated, {
      language: en,
      skeletonHash: r.skeletonHash,
      issueInfo: { issueNumber: '001', inWork: '01' },
    });
    expect(out.unapplied).toEqual([]);
    expect(out.fileName).toBe('DMC-KENBAIKI-A-10-20-00-00A-520A-A_001-01_EN-US.XML');
    // 宣言と DOCTYPE の内部サブセットは保たれる
    expect(out.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE dmodule [')).toBe(
      true,
    );
    expect(out.xml).toContain('<!ENTITY ICN-KENBAIKI-A-000000-0-K0001-00002-A-01-1 SYSTEM');
    const info = readDataModuleInfo(out.xml);
    expect(info.identAndStatus?.language).toEqual(en);
    expect(info.identAndStatus?.issueInfo).toEqual({ issueNumber: '001', inWork: '01' });
    expect(info.identAndStatus?.dmCode).toEqual(r.dmCode);
    expect(info.identAndStatus?.techName).toBe('EN:指定席券売機');

    const texts: string[] = [];
    const walk = (nodes: ContentNode[]) => {
      for (const n of nodes) {
        if (n.text) texts.push(n.text);
        walk(n.children);
      }
    };
    walk(readContentFromXml(out.xml).blocks);
    expect(texts).toContain(
      'Push the 電源スイッチ to turn off the power as shown in [→ fig-0001] .',
    );
    expect(texts.some((t) => t.startsWith('EN:H') && t.includes('O を含む液体'))).toBe(true);
    expect(texts).toContain('EN:設定値 {A} は変えない。');

    // 骨組み（文以外）は変わらない: 訳した XML から文を空にしたものは、元の骨組みと同じ
    const again = extractSegments(out.xml);
    expect(again.language).toEqual(en);
    expect(again.segments.length).toBe(r.segments.length);
    // 入れ子のリストの前後の文は別々に入れ替わり、リストは残る
    expect(byId(again, 'pr.mp.st1.st1.p1').text).toBe('EN:カバーを開ける。次の工具を使う：');
    expect(byId(again, 'pr.mp.st1.st1.p1~1').text).toBe('EN:工具が無ければ交換する。');
    expect(byId(again, 'pr.mp.st1.st1.p1.rl1.li1.p1').text).toBe('EN:プラスドライバー');
  });

  it('プレースホルダーの順序は入れ替えられる。欠けた・増えた・壊れた文は unapplied で元の文が残る', () => {
    const r = extractSegments(PROCED);
    const out = applySegments(
      PROCED,
      [
        { id: 'pr.mp.st1.p1', text: '{2} then {1}' }, // 順序の入れ替えは可
        { id: 'pr.mp.st1.w1.wcp1', text: 'Keep away from water.' }, // {1} を欠く
        { id: 'pr.mp.st1.st1.p1', text: 'Open {1} the cover.' }, // 元に無い {1}
        { id: 'pr.mp.st1.st2.p1', text: 'Remove {{ the paper.' }, // 波括弧は二重なので文字（{）だけ。これは可
        { id: 'pr.mp.st1.st2.n1.np1', text: 'Do not change {A}.' }, // 壊れた書式（{A}）
        { id: 'pr.mp.st1.p1', text: 'dup' }, // 重複
        { id: 'no.such.id', text: 'x' }, // 知らない id
      ],
      { language: en, skeletonHash: r.skeletonHash },
    );
    expect(out.unapplied).toEqual([
      { id: 'pr.mp.st1.w1.wcp1', reason: 'placeholder-mismatch' },
      { id: 'pr.mp.st1.st1.p1', reason: 'placeholder-mismatch' },
      { id: 'pr.mp.st1.st2.n1.np1', reason: 'placeholder-mismatch' },
      { id: 'pr.mp.st1.p1', reason: 'duplicate-id' },
      { id: 'no.such.id', reason: 'unknown-id' },
    ]);
    expect(out.applied).toBe(2);
    const again = extractSegments(out.xml);
    expect(byId(again, 'pr.mp.st1.p1').text).toBe('{1} then {2}');
    expect(byId(again, 'pr.mp.st1.p1').placeholders.map((p) => p.element)).toEqual([
      'internalRef',
      'emphasis',
    ]);
    // 適用しなかった文は元のまま
    expect(byId(again, 'pr.mp.st1.w1.wcp1').text).toBe(byId(r, 'pr.mp.st1.w1.wcp1').text);
    expect(byId(again, 'pr.mp.st1.st1.p1').text).toBe(byId(r, 'pr.mp.st1.st1.p1').text);
    expect(byId(again, 'pr.mp.st1.st2.p1').text).toBe('Remove {{ the paper.');
  });

  it('骨組みのハッシュが合わなければ SkeletonMismatchError で止まる', () => {
    const r = extractSegments(PROCED);
    const changed = PROCED.replace('stp-0003', 'stp-0099');
    expect(() =>
      applySegments(changed, r.segments, { language: en, skeletonHash: r.skeletonHash }),
    ).toThrowError(SkeletonMismatchError);
    try {
      applySegments(changed, r.segments, { language: en, skeletonHash: 'abc' });
    } catch (e) {
      expect(e).toBeInstanceOf(SkeletonMismatchError);
      expect((e as SkeletonMismatchError).code).toBe('skeleton-mismatch');
      expect((e as SkeletonMismatchError).expected).toBe('abc');
    }
  });
});

// ---------------------------------------------------------------------------
// 配布物（Bike Samples）

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

describe.skipIf(!enabled || !existsSync(specDir))('S1000D 配布物（Bike Samples）で往復する', () => {
  const files = findFiles(specDir, /^DMC-.*\.XML$/i).filter((f) => /Bike Samples/.test(f));

  it('106 件を抜き出して、そのまま戻すと元と同じ（空白を除く）', () => {
    expect(files.length).toBe(106);
    const bad: string[] = [];
    let total = 0;
    for (const f of files) {
      const xml = readFileSync(f, 'utf8');
      const r = extractSegments(xml);
      total += r.segments.length;
      const lang = r.language!;
      const back = applySegments(xml, r.segments, { language: lang, skeletonHash: r.skeletonHash });
      if (back.unapplied.length > 0 || normalize(back.xml) !== normalize(xml)) bad.push(f);
      // 言語だけ変えて戻しても、language 以外は同じ（直列化の忠実さ）
      const sw = applySegments(xml, r.segments, { language: en, skeletonHash: r.skeletonHash });
      const expected = xml.replace(
        /(<language\s[^>]*?)languageIsoCode="[^"]*"(\s+)countryIsoCode="[^"]*"/,
        '$1languageIsoCode="en"$2countryIsoCode="US"',
      );
      if (normalize(sw.xml) !== normalize(expected)) bad.push(`${f} (language switch)`);
    }
    expect(bad).toEqual([]);
    expect(total).toBeGreaterThan(1000);
  }, 120000);

  it('訳文を入れた DM も、本物の XSD で valid のまま', async () => {
    const { Libxml2SchemaValidator } = await import('../xsd-libxml2.js');
    const { findSchemaDirs, verifyDataModule } = await import('../verify/index.js');
    const schemaDirs = findSchemaDirs([specDir]).filter((d) => !/data_dictionary/i.test(d.dir));
    const validator = new Libxml2SchemaValidator();
    const invalid: string[] = [];
    let validBefore = 0;
    try {
      for (const f of files) {
        const xml = readFileSync(f, 'utf8');
        const before = await verifyDataModule(xml, { path: f, schema: { validator, schemaDirs } });
        const r = extractSegments(xml);
        const out = applySegments(
          xml,
          // 文を実際に書き換える（インライン要素を戻す経路も通す）
          r.segments.map((s) => ({ id: s.id, text: `T: ${s.text}` })),
          { language: en, skeletonHash: r.skeletonHash },
        );
        const after = await verifyDataModule(out.xml, {
          path: f,
          schema: { validator, schemaDirs },
        });
        // 元が valid なら、差し戻した後も valid
        if (before.status.schema.state === 'valid') {
          validBefore++;
          if (after.status.schema.state !== 'valid') invalid.push(f);
        }
      }
    } finally {
      validator.dispose();
    }
    expect(invalid).toEqual([]);
    expect(validBefore).toBeGreaterThan(50);
  }, 120000);
});
