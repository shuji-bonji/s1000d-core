import { describe, expect, it } from 'vitest';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import { rangeOfElement, rangesMatchDocument, scanElementRanges } from '../xml/ranges.js';
import type { Element } from '../xml/engine.js';
import { editContent } from './edit.js';

/** 属性を 1 行に 1 つずつ書いた手順 DM（自作。XMLSerializer を通すと、開始タグの行が変わる書き方） */
const dm = (inWork = '01') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE dmodule [
<!NOTATION PNG SYSTEM "png">
<!ENTITY ICN-KENBAIKI-00001-001-01 SYSTEM "ICN-KENBAIKI-00001-001-01.PNG" NDATA PNG>
]>
<!-- 自作の見本 -->
<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_7/xml_schema_flat/proced.xsd">
  <identAndStatusSection>
    <dmAddress>
      <dmIdent>
        <dmCode modelIdentCode="KENBAIKI"
                systemDiffCode="A"
                systemCode="10"
                subSystemCode="2"
                subSubSystemCode="0"
                assyCode="00"
                disassyCode="00"
                disassyCodeVariant="A"
                infoCode="520"
                infoCodeVariant="A"
                itemLocationCode="D"/>
        <language languageIsoCode="ja" countryIsoCode="JP"/>
        <issueInfo issueNumber="000" inWork="${inWork}"/>
      </dmIdent>
    </dmAddress>
  </identAndStatusSection>
  <content>
    <refs>
      <externalPubRef>
        <externalPubRefIdent>
          <externalPubCode>KB-0001</externalPubCode>
        </externalPubRefIdent>
      </externalPubRef>
    </refs>
    <procedure>
      <mainProcedure>
        <proceduralStep id="stp-0001">
          <para>カバーを <![CDATA[<開ける>]]>。値は a &gt; b。</para>
        </proceduralStep>
        <!-- 2 つ目の手順 -->
        <proceduralStep id="stp-0002"
                        applicRefId="app-0001">
          <para>ねじを外す（<internalRef internalRefId="stp-0001"
                                         internalRefTargetType="irtt08"/>の後）。</para>
          <para>
            <sequentialList>
              <listItem><para>1 本目</para></listItem>
              <listItem><para>2 本目</para></listItem>
            </sequentialList>
          </para>
        </proceduralStep>
        <proceduralStep id="stp-0003">
          <note>
            <notePara>部品を落とさない。</notePara>
          </note>
          <para>部品を取り出す。</para>
        </proceduralStep>
      </mainProcedure>
    </procedure>
  </content>
</dmodule>
`;

const STEP = '/dmodule/content/procedure/mainProcedure/proceduralStep';
const MAIN = '/dmodule/content/procedure/mainProcedure';

/** 文字列から、ある行を含む行のまとまりを取り除いた残り（触っていない部分の比較に使う） */
const linesOf = (s: string) => s.split('\n');

describe('scanElementRanges', () => {
  it('要素の範囲が、DOM の同じ要素と対応する（コメント・CDATA・複数行の属性を読み飛ばす）', () => {
    const xml = dm();
    const doc = defaultXmlEngine.parse(xml).document;
    const root = scanElementRanges(xml)!;
    expect(root.name).toBe('dmodule');
    expect(rangesMatchDocument(root, doc.documentElement!)).toBe(true);
    const step2 = defaultXmlEngine.selectNodes(`${STEP}[2]`, doc)[0] as unknown as Element;
    const r = rangeOfElement(root, step2)!;
    const text = xml.slice(r.start, r.end);
    expect(text.startsWith('<proceduralStep id="stp-0002"')).toBe(true);
    expect(text.endsWith('</proceduralStep>')).toBe(true);
    expect(text).toContain('2 本目');
    expect(text).not.toContain('stp-0003');
  });

  it('空要素タグと、属性の値の中の > を読む', () => {
    const xml = '<a><b x="1 > 0"/><c y=\'/>\'>t</c></a>';
    const root = scanElementRanges(xml)!;
    expect(root.children.map((c) => [c.name, c.selfClosing, xml.slice(c.start, c.end)])).toEqual([
      ['b', true, '<b x="1 > 0"/>'],
      ['c', false, "<c y='/>'>t</c>"],
    ]);
  });

  it('終了タグが合わない文字列では undefined', () => {
    expect(scanElementRanges('<a><b></a></b>')).toBeUndefined();
    expect(scanElementRanges('<a><b>')).toBeUndefined();
  });
});

describe('editContent: remove / move', () => {
  it('move は、移した要素の中身も、ほかの行も 1 文字も変えない', () => {
    const xml = dm();
    const r = editContent(xml, [
      { op: 'move', at: `${STEP}[3]`, to: `${STEP}[1]`, position: 'before' },
    ]);
    expect(r.refusals).toEqual([]);
    expect(r.applied).toBe(true);
    // 行の集まりは同じで、順だけが違う
    expect(linesOf(r.xml).slice().sort()).toEqual(linesOf(xml).slice().sort());
    expect(r.xml.indexOf('id="stp-0003"')).toBeLessThan(r.xml.indexOf('id="stp-0001"'));
    // 複数行に書いた開始タグは元のまま
    expect(r.xml).toContain(
      '<dmCode modelIdentCode="KENBAIKI"\n                systemDiffCode="A"',
    );
    expect(r.xml).toContain('<![CDATA[<開ける>]]>');
    // 元の位置に戻すと、元の文字列に戻る
    const back = editContent(r.xml, [
      { op: 'move', at: `${STEP}[1]`, to: MAIN, position: 'last-child' },
    ]);
    expect(back.applied).toBe(true);
    expect(back.xml).toBe(xml);
    expect(r.changes).toEqual([
      expect.objectContaining({
        index: 0,
        op: 'move',
        position: 'before',
        element: 'proceduralStep',
      }),
    ]);
  });

  it('remove は、その要素の行だけを取り除く', () => {
    const xml = dm();
    const r = editContent(xml, [{ op: 'remove', at: `${STEP}[3]/note` }]);
    expect(r.applied).toBe(true);
    const before = linesOf(xml);
    const after = linesOf(r.xml);
    expect(before.length - after.length).toBe(3);
    expect(before.filter((l) => !/note/i.test(l))).toEqual(after);
  });

  it('行の途中にある要素は、その範囲だけを取り除く', () => {
    const xml = dm();
    const item = `${STEP}[2]/para[2]/sequentialList/listItem[1]`;
    const r = editContent(xml, [{ op: 'remove', at: item }]);
    expect(r.applied).toBe(true);
    expect(r.xml).not.toContain('1 本目');
    expect(r.xml).toContain('<listItem><para>2 本目</para></listItem>');
    expect(linesOf(r.xml).length).toBe(linesOf(xml).length - 1);
  });

  it('残る部分が id を指している節点は取り除かない（指している場所を返す）', () => {
    const r = editContent(dm(), [{ op: 'remove', at: `${STEP}[1]` }]);
    expect(r.applied).toBe(false);
    expect(r.xml).toBe(dm());
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toMatchObject({ index: 0, reason: 'id-referenced' });
    expect(r.refusals[0]!.referencedBy![0]!.path).toBe(`${STEP}[2]/para[1]/internalRef`);
  });

  it('指している側も一緒に取り除くなら、取り除ける', () => {
    const r = editContent(dm(), [
      { op: 'remove', at: `${STEP}[1]` },
      { op: 'remove', at: `${STEP}[2]` },
    ]);
    expect(r.refusals).toEqual([]);
    expect(r.xml).not.toContain('stp-0001');
    expect(r.xml).toContain('<!-- 2 つ目の手順 -->');
    expect(r.xml).toContain('stp-0003');
  });

  it('場所は、すべて編集の前の文書の path で指す', () => {
    const r = editContent(dm(), [
      { op: 'move', at: `${STEP}[1]`, to: `${STEP}[3]`, position: 'after' },
      { op: 'remove', at: `${STEP}[3]/note` },
    ]);
    expect(r.refusals).toEqual([]);
    const order = [...r.xml.matchAll(/id="(stp-\d+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['stp-0002', 'stp-0003', 'stp-0001']);
    expect(r.xml).not.toContain('notePara');
  });

  it('1 つでも断る理由があれば、1 つも適用しない', () => {
    const xml = dm();
    const r = editContent(xml, [
      { op: 'remove', at: `${STEP}[3]/note` },
      { op: 'remove', at: `${STEP}[9]` },
    ]);
    expect(r.applied).toBe(false);
    expect(r.xml).toBe(xml);
    expect(r.refusals).toEqual([
      expect.objectContaining({ index: 1, reason: 'location-not-found' }),
    ]);
  });

  it('断る理由: 対象でない要素、自分の中への移動、同じ節点への 2 つの編集、複数の節点を選ぶ path', () => {
    const reasons = (edits: Parameters<typeof editContent>[1]) =>
      editContent(dm(), edits).refusals.map((x) => x.reason);
    expect(reasons([{ op: 'remove', at: MAIN }])).toEqual(['unsupported-node']);
    expect(
      reasons([{ op: 'move', at: `${STEP}[2]`, to: `${STEP}[2]/para[1]`, position: 'after' }]),
    ).toEqual(['move-into-self']);
    expect(
      reasons([
        { op: 'remove', at: `${STEP}[3]` },
        { op: 'move', at: `${STEP}[3]`, to: `${STEP}[1]`, position: 'before' },
      ]),
    ).toEqual(['conflicting-edits', 'conflicting-edits']);
    expect(reasons([{ op: 'remove', at: STEP }])).toEqual(['location-ambiguous']);
    expect(reasons([{ op: 'remove', at: `${STEP}[` }])).toEqual(['xpath-error']);
  });

  it('発行済みの版（inWork が 00）は、allowReleasedIssue が無ければ断る', () => {
    const xml = dm('00');
    const edits = [{ op: 'remove' as const, at: `${STEP}[3]/note` }];
    const refused = editContent(xml, edits);
    expect(refused.applied).toBe(false);
    expect(refused.refusals).toEqual([expect.objectContaining({ reason: 'released-issue' })]);
    expect(refused.refusals[0]!.index).toBeUndefined();
    const allowed = editContent(xml, edits, { allowReleasedIssue: true });
    expect(allowed.applied).toBe(true);
    expect(allowed.notes.join(' ')).toContain('allowReleasedIssue');
    // 版は変えない
    expect(allowed.xml).toContain('<issueInfo issueNumber="000" inWork="00"/>');
  });

  it('CRLF の文書でも、触っていない部分は変わらない', () => {
    const xml = dm().replace(/\n/g, '\r\n');
    const r = editContent(xml, [
      { op: 'move', at: `${STEP}[3]`, to: `${STEP}[1]`, position: 'before' },
    ]);
    expect(r.applied).toBe(true);
    expect(r.xml.split('\r\n').slice().sort()).toEqual(xml.split('\r\n').slice().sort());
    expect(r.xml.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('editContent: insert', () => {
  it('手順を足す。足した行のほかは変わらない', () => {
    const xml = dm();
    const r = editContent(xml, [
      {
        op: 'insert',
        to: `${STEP}[1]`,
        position: 'after',
        node: {
          kind: 'step',
          id: 'stp-0010',
          children: [
            { kind: 'admonition', level: 'caution', text: '電源を切る。' },
            {
              kind: 'para',
              text: 'A < B を確かめる。',
              refs: [{ kind: 'internalRef', target: 'stp-0001' }],
            },
          ],
        },
      },
    ]);
    expect(r.refusals).toEqual([]);
    const block = [
      '        <proceduralStep id="stp-0010">',
      '          <caution>',
      '            <warningAndCautionPara>電源を切る。</warningAndCautionPara>',
      '          </caution>',
      '          <para>A &lt; B を確かめる。<internalRef internalRefId="stp-0001"/></para>',
      '        </proceduralStep>',
      '',
    ].join('\n');
    expect(r.xml).toContain(block);
    // 足した行を除くと、元の文字列に戻る
    expect(r.xml.replace(block, '')).toBe(xml);
    const order = [...r.xml.matchAll(/<proceduralStep id="(stp-\d+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['stp-0001', 'stp-0010', 'stp-0002', 'stp-0003']);
  });

  it('リストの項目と、手順の中の段落を足す', () => {
    const list = `${STEP}[2]/para[2]/sequentialList`;
    const r = editContent(dm(), [
      {
        op: 'insert',
        to: list,
        position: 'last-child',
        node: { kind: 'listItem', text: '3 本目' },
      },
      {
        op: 'insert',
        to: `${STEP}[3]/para`,
        position: 'after',
        node: { kind: 'para', text: '数を確かめる。' },
      },
    ]);
    expect(r.refusals).toEqual([]);
    expect(r.xml).toContain(
      [
        '              <listItem><para>2 本目</para></listItem>',
        '              <listItem>',
        '                <para>3 本目</para>',
        '              </listItem>',
        '            </sequentialList>',
      ].join('\n'),
    );
    expect(r.xml).toContain(
      '          <para>部品を取り出す。</para>\n          <para>数を確かめる。</para>\n',
    );
  });

  it('断る理由: 既にある id、置けない種類、足せない親、無い行き先への internalRef', () => {
    const reasons = (edits: Parameters<typeof editContent>[1]) =>
      editContent(dm(), edits).refusals.map((x) => x.reason);
    expect(
      reasons([
        {
          op: 'insert',
          to: `${STEP}[1]`,
          position: 'before',
          node: { kind: 'step', id: 'stp-0002', text: 'x' },
        },
      ]),
    ).toEqual(['id-duplicate']);
    expect(
      reasons([
        { op: 'insert', to: `${STEP}[1]`, position: 'before', node: { kind: 'para', text: 'x' } },
      ]),
    ).toEqual(['draft-input-error']);
    expect(
      reasons([
        {
          op: 'insert',
          to: `${STEP}[3]/note`,
          position: 'last-child',
          node: { kind: 'para', text: 'x' },
        },
      ]),
    ).toEqual(['unsupported-destination']);
    expect(
      reasons([
        {
          op: 'insert',
          to: MAIN,
          position: 'last-child',
          node: { kind: 'step', text: 'x', refs: [{ kind: 'internalRef', target: 'nowhere' }] },
        },
      ]),
    ).toEqual(['draft-input-error']);
  });

  it('XSD の定義があれば、親がその要素を取れるかを確かめる', () => {
    const xsd = {
      allowedChildren: (name: string) => (name === 'mainProcedure' ? ['proceduralStep'] : ['para']),
    };
    const r = editContent(
      dm(),
      [{ op: 'move', at: `${STEP}[3]/note`, to: MAIN, position: 'first-child' }],
      { xsd: xsd as never },
    );
    expect(r.refusals.map((x) => x.reason)).toEqual(['not-allowed-here']);
  });
});

describe('editContent: 先頭に BOM がある XML', () => {
  it('BOM を残し、BOM の無い XML を編集したときと同じ所だけが変わる', () => {
    const xml = dm();
    const edits = [{ op: 'remove' as const, at: `${STEP}[3]/note` }];
    const plain = editContent(xml, edits);
    const withBom = editContent(`\uFEFF${xml}`, edits);
    expect(plain.applied).toBe(true);
    expect(withBom.applied).toBe(true);
    expect(withBom.xml).toBe(`\uFEFF${plain.xml}`);
  });
});

describe('insert の節点の、管理された内容の印（authority）', () => {
  const insertStep = (xml: string, kind: 'step' | 'para' = 'step') =>
    editContent(xml, [
      {
        op: 'insert',
        to: kind === 'step' ? `${STEP}[1]` : `${STEP}[3]/para`,
        position: 'after',
        node: { kind, text: '受け取った側が足した内容。', authority: { name: 'xyz' } },
      },
    ]);

  it('文書が Issue 4.2 なら、authorityName を書く（版は文書の xsi:noNamespaceSchemaLocation から読む）', () => {
    const r = insertStep(dm().replace('S1000D_7/', 'S1000D_4-2/'));
    expect(r.refusals).toEqual([]);
    expect(r.xml).toContain('<proceduralStep authorityName="xyz">');
  });
  it('文書が Issue 7 なら、書かずに断る', () => {
    const r = insertStep(dm());
    expect(r.applied).toBe(false);
    expect(r.refusals[0]!.message).toContain('/edits[1]/node/authority');
  });
  it('authorityName を持てない要素（para）になる節点も、書かずに断る', () => {
    const r = insertStep(dm().replace('S1000D_7/', 'S1000D_4-2/'), 'para');
    expect(r.applied).toBe(false);
    expect(r.refusals[0]!.message).toContain('/edits[1]/node/authority');
  });
});
