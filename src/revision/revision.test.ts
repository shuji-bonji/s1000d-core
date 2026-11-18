import { describe, expect, it } from 'vitest';
import { editContent } from '../edit/edit.js';
import { readContentFromXml } from '../content/index.js';
import { scanAttributes, scanElementRanges } from '../xml/ranges.js';
import { addReasonForUpdate } from './reason.js';
import { startRevision } from './start.js';

/** 前の版の変更の印を持つ、発行済みの手順 DM（自作。属性を 1 行に 1 つずつ書いた開始タグを含む） */
const released = (o: { issue?: string; inWork?: string; issueType?: string; ref?: string } = {}) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!-- 自作の見本 -->
<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_7/xml_schema_flat/proced.xsd">
  <identAndStatusSection>
    <dmAddress>
      <dmIdent>
        <dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="10" subSystemCode="2"
                subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A"
                infoCode="520" infoCodeVariant="A" itemLocationCode="D"/>
        <language languageIsoCode="ja" countryIsoCode="JP"/>
        <issueInfo issueNumber="${o.issue ?? '005'}"
                   inWork="${o.inWork ?? '00'}"/>
      </dmIdent>
      <dmAddressItems>
        <issueDate year="2026" month="10" day="01"/>
        <dmTitle><techName>券売機</techName><infoName>取り外し</infoName></dmTitle>
      </dmAddressItems>
    </dmAddress>
    <dmStatus${o.issueType === '' ? '' : ` issueType="${o.issueType ?? 'changed'}"`}>
      <security securityClassification="01"/>
      <qualityAssurance><firstVerification verificationType="tabtop"/></qualityAssurance>
      <reasonForUpdate id="rfu-0001" updateReasonType="urt02">
        <simplePara>手順 2 を足した。</simplePara>
      </reasonForUpdate>
      <reasonForUpdate id="rfu-0002"
                       updateReasonType="urt02">
        <simplePara>手順 3 を取り除いた。</simplePara>
      </reasonForUpdate>
      <remarks><simplePara>備考</simplePara></remarks>
    </dmStatus>
  </identAndStatusSection>
  <content>
    <procedure>
      <mainProcedure>
        <proceduralStep id="stp-0001">
          <para>カバーを<changeInline changeMark="1" changeType="modify" reasonForUpdateRefIds="rfu-0001">ゆっくり</changeInline>開ける。</para>
        </proceduralStep>
        <proceduralStep id="stp-0002"
                        changeType="add"
                        changeMark="1"
                        reasonForUpdateRefIds="rfu-0001">
          <para>ねじを外す。</para>
        </proceduralStep>
        <proceduralStep changeMark="1" changeType="delete" id="stp-0003" reasonForUpdateRefIds="rfu-0002">
          <para>古い手順。</para>
        </proceduralStep>
        <proceduralStep id="stp-0004">
          <para>部品を取り出す${o.ref ?? ''}。</para>
        </proceduralStep>
      </mainProcedure>
    </procedure>
  </content>
</dmodule>
`;

describe('scanAttributes', () => {
  it('開始タグの属性を、値の中の > や改行があっても読む', () => {
    const xml = `<a x="1 > 0"\n   y='b "c"' z = "3"/>`;
    const r = scanElementRanges(xml)!;
    const attrs = scanAttributes(xml, r);
    expect(attrs.map((a) => [a.name, xml.slice(a.valueStart, a.valueEnd)])).toEqual([
      ['x', '1 > 0'],
      ['y', 'b "c"'],
      ['z', '3'],
    ]);
    expect(xml.slice(attrs[1]!.start, attrs[1]!.end)).toBe(`\n   y='b "c"'`);
  });
});

describe('startRevision', () => {
  it('inWork を 01 にし、issueType を書き、前の版の変更の印を消す', () => {
    const xml = released();
    const r = startRevision(xml, { issueType: 'changed' });
    expect(r.refusals).toEqual([]);
    expect(r.started).toBe(true);
    expect(r.previous).toEqual({
      issueInfo: { issueNumber: '005', inWork: '00' },
      issueType: 'changed',
    });
    expect(r.issueInfo).toEqual({ issueNumber: '005', inWork: '01' });
    expect(r.fileName).toBe('DMC-KENBAIKI-A-10-20-00-00A-520A-D_005-01_JA-JP.XML');
    expect(r.removed.markedElements).toBe(1);
    expect(r.removed.changeInline).toBe(1);
    expect(r.removed.reasonForUpdate).toBe(2);
    expect(r.removed.deletedElements.map((l) => l.path)).toEqual([
      '/dmodule/content/procedure/mainProcedure/proceduralStep[3]',
    ]);
    expect(r.xml).not.toMatch(/changeType|changeMark|reasonForUpdate|changeInline|stp-0003/);
    expect(r.xml).toContain('<para>カバーをゆっくり開ける。</para>');
    expect(r.xml).toContain('<proceduralStep id="stp-0002">');
    expect(r.xml).toContain('inWork="01"/>');
    // 触っていない行は、元の文字列のまま
    const before = xml.split('\n');
    const after = new Set(r.xml.split('\n'));
    const lost = before.filter((l) => !after.has(l));
    const odd = lost.filter(
      (l) =>
        !/changeType|changeMark|reasonForUpdate|updateReasonType|simplePara>手順|inWork|古い手順|changeInline|stp-0002"$/.test(
          l,
        ),
    );
    expect(odd).toEqual([]);
    expect(r.xml).toContain('<remarks><simplePara>備考</simplePara></remarks>');
    expect(r.xml).toContain('<issueDate year="2026" month="10" day="01"/>');
  });

  it('issueType の属性が無い dmStatus には、属性を足す', () => {
    const r = startRevision(released({ issueType: '' }), { issueType: 'status' });
    expect(r.started).toBe(true);
    expect(r.xml).toContain('<dmStatus issueType="status">');
    expect(r.notes.join('\n')).toContain('BREX-S1-00038');
  });

  it('既に作業中の版、deleted の版、issueType の入力の誤りを断る', () => {
    expect(
      startRevision(released({ inWork: '02' }), { issueType: 'changed' }).refusals[0]?.reason,
    ).toBe('already-in-work');
    expect(
      startRevision(released({ issueType: 'deleted' }), { issueType: 'changed' }).refusals[0]
        ?.reason,
    ).toBe('deleted-issue');
    expect(startRevision(released(), { issueType: 'deleted' as never }).refusals[0]?.reason).toBe(
      'issue-type-input-error',
    );
    expect(startRevision(released(), {} as never).refusals[0]?.reason).toBe(
      'issue-type-input-error',
    );
    // new は 001-00 から始めるときだけ
    expect(startRevision(released(), { issueType: 'new' }).refusals[0]?.reason).toBe(
      'issue-type-input-error',
    );
    const first = startRevision(released({ issue: '001', issueType: 'new' }), { issueType: 'new' });
    expect(first.started).toBe(true);
    expect(first.notes.join('\n')).toContain('BREX-S1-00030');
  });

  it('取り除く delete の要素の id を残る部分が指していれば断り、何も変えない', () => {
    const xml = released({
      ref: '<internalRef internalRefId="stp-0003" internalRefTargetType="irtt08"/>',
    });
    const r = startRevision(xml, { issueType: 'changed' });
    expect(r.started).toBe(false);
    expect(r.xml).toBe(xml);
    expect(r.refusals[0]?.reason).toBe('id-referenced');
    expect(r.refusals[0]?.referencedBy?.length).toBe(1);
  });
});

describe('editContent の marking', () => {
  const marking = {
    reason: { text: '手順を見直した。', updateReasonType: 'urt02' },
    changeMark: '1' as const,
  };
  const inWork = () => startRevision(released(), { issueType: 'changed' }).xml;
  const step = (n: number) => `/dmodule/content/procedure/mainProcedure/proceduralStep[${n}]`;

  it('発行済みの版は allowReleasedIssue があっても断る', () => {
    const r = editContent(released(), [{ op: 'remove', at: step(1) }], {
      marking,
      allowReleasedIssue: true,
    });
    expect(r.refusals[0]?.reason).toBe('released-issue');
  });

  it('issueType が revised の版、urt01、足りない入力を断る', () => {
    const revised = startRevision(released(), { issueType: 'revised' }).xml;
    expect(
      editContent(revised, [{ op: 'remove', at: step(1) }], { marking }).refusals[0]?.reason,
    ).toBe('issue-type-not-markable');
    const x = inWork();
    expect(
      editContent(x, [{ op: 'remove', at: step(1) }], {
        marking: { ...marking, reason: { text: 'x', updateReasonType: 'urt01' } },
      }).refusals[0]?.reason,
    ).toBe('editorial-reason');
    const bad = editContent(x, [{ op: 'remove', at: step(1) }], {
      marking: { reason: { text: ' ' }, changeMark: '2' } as never,
    });
    expect(bad.refusals.map((f) => f.reason)).toEqual([
      'marking-input-error',
      'marking-input-error',
      'marking-input-error',
    ]);
  });

  it('insert は add、remove は delete を付けて残し、reasonForUpdate を remarks の前に足す', () => {
    const x = inWork();
    const r = editContent(
      x,
      [
        {
          op: 'insert',
          to: step(1),
          position: 'after',
          node: { kind: 'step', text: '電源を切る。' },
        },
        { op: 'remove', at: step(3) },
      ],
      { marking },
    );
    expect(r.refusals).toEqual([]);
    expect(r.reasonForUpdate).toEqual({ id: 'rfu-0001', added: true, updateReasonType: 'urt02' });
    expect(r.changes[0]?.mark).toMatchObject({
      changeType: 'add',
      element: 'proceduralStep',
      reasonForUpdateRefId: 'rfu-0001',
    });
    expect(r.changes[1]).toMatchObject({
      kept: true,
      mark: { changeType: 'delete', at: { path: step(3) } },
    });
    expect(r.xml).toContain(
      '<proceduralStep changeType="add" changeMark="1" reasonForUpdateRefIds="rfu-0001">',
    );
    expect(r.xml).toContain(
      '<proceduralStep id="stp-0004" changeType="delete" changeMark="1" reasonForUpdateRefIds="rfu-0001">',
    );
    expect(r.xml).toMatch(
      /<\/qualityAssurance>\n {6}<reasonForUpdate id="rfu-0001" updateReasonType="urt02">\n {8}<simplePara>手順を見直した。<\/simplePara>\n {6}<\/reasonForUpdate>\n {6}<remarks>/,
    );
    // reader が印と理由を読める
    const read = readContentFromXml(r.xml);
    expect(read.changeMarks?.map((m) => m.changeType)).toEqual(['add', 'delete']);
  });

  it('この作業中の版で足した要素の remove は、印を付けずに取り除く。その中への insert にも印を付けない', () => {
    const first = editContent(
      inWork(),
      [
        {
          op: 'insert',
          to: step(1),
          position: 'after',
          node: { kind: 'step', text: '電源を切る。' },
        },
      ],
      { marking },
    );
    const inside = editContent(
      first.xml,
      [
        {
          op: 'insert',
          to: step(2),
          position: 'last-child',
          node: { kind: 'para', text: '補足。' },
        },
      ],
      { marking },
    );
    expect(inside.applied).toBe(true);
    expect(inside.changes[0]?.mark).toBeUndefined();
    expect(inside.reasonForUpdate).toBeUndefined();
    expect(inside.xml.match(/<reasonForUpdate /g)?.length).toBe(1);
    const undo = editContent(first.xml, [{ op: 'remove', at: step(2) }], { marking });
    expect(undo.applied).toBe(true);
    expect(undo.changes[0]?.kept).toBeUndefined();
    expect(undo.xml).not.toContain('電源を切る');
    // 既に delete の印を持つ要素は断る
    const del = editContent(inWork(), [{ op: 'remove', at: step(1) }], { marking });
    expect(
      editContent(del.xml, [{ op: 'remove', at: step(1) }], { marking }).refusals[0]?.reason,
    ).toBe('already-marked-deleted');
  });

  it('remove と、その隣への insert で置き換えを書ける', () => {
    const r = editContent(
      inWork(),
      [
        { op: 'remove', at: step(2) },
        {
          op: 'insert',
          to: step(2),
          position: 'after',
          node: { kind: 'step', text: 'ねじを 2 本外す。' },
        },
      ],
      { marking },
    );
    expect(r.refusals).toEqual([]);
    expect(r.xml).toMatch(
      /stp-0002" changeType="delete"[\s\S]*<\/proceduralStep>\n {8}<proceduralStep changeType="add"/,
    );
  });

  it('同じ親の中の move は親に modify を付ける。親が変わる move と、印を持てない親は断る', () => {
    const x = inWork();
    const r = editContent(x, [{ op: 'move', at: step(3), to: step(1), position: 'before' }], {
      marking,
    });
    expect(r.refusals).toEqual([]);
    expect(r.xml).toContain(
      '<mainProcedure changeType="modify" changeMark="1" reasonForUpdateRefIds="rfu-0001">',
    );
    expect(r.changes[0]?.mark).toMatchObject({ changeType: 'modify', element: 'mainProcedure' });
    // 2 回目は、理由を足すだけ
    const again = editContent(
      r.xml,
      [{ op: 'move', at: step(1), to: step(3), position: 'after' }],
      {
        marking: { ...marking, reason: { text: '順を戻した。', updateReasonType: 'urt02' } },
      },
    );
    expect(again.refusals).toEqual([]);
    expect(again.xml).toContain(
      '<mainProcedure changeType="modify" changeMark="1" reasonForUpdateRefIds="rfu-0001 rfu-0002">',
    );
    const across = editContent(
      x,
      [{ op: 'move', at: `${step(1)}/para`, to: step(2), position: 'last-child' }],
      { marking },
    );
    expect(across.refusals[0]?.reason).toBe('move-across-parents');
  });

  it('reasonRefId で、既にある reasonForUpdate を指す（識別・状態部は変えない）', () => {
    const first = editContent(inWork(), [{ op: 'remove', at: step(1) }], { marking });
    const r = editContent(
      first.xml,
      [
        {
          op: 'insert',
          to: step(3),
          position: 'after',
          node: { kind: 'step', text: '元に戻す。' },
        },
      ],
      { marking: { reasonRefId: 'rfu-0001', changeMark: '1' } },
    );
    expect(r.refusals).toEqual([]);
    expect(r.reasonForUpdate).toEqual({ id: 'rfu-0001', added: false, updateReasonType: 'urt02' });
    expect(r.xml.match(/<reasonForUpdate /g)?.length).toBe(1);
    expect(r.xml.match(/reasonForUpdateRefIds="rfu-0001"/g)?.length).toBe(2);
    // 無い id、reason との併用、どちらも無い指定、urt01 の理由は断る
    const reasons = (m: unknown) =>
      editContent(first.xml, [{ op: 'remove', at: step(2) }], { marking: m as never }).refusals.map(
        (f) => f.reason,
      );
    expect(reasons({ reasonRefId: 'rfu-9999', changeMark: '1' })).toEqual(['marking-input-error']);
    expect(reasons({ ...marking, reasonRefId: 'rfu-0001' })).toEqual(['marking-input-error']);
    expect(reasons({ changeMark: '1' })).toEqual(['marking-input-error']);
    const editorial = first.xml.replace('updateReasonType="urt02"', 'updateReasonType="urt01"');
    expect(
      editContent(editorial, [{ op: 'remove', at: step(2) }], {
        marking: { reasonRefId: 'rfu-0001', changeMark: '1' },
      }).refusals[0]?.reason,
    ).toBe('editorial-reason');
  });

  it('marking が無ければ、層 1 の動きのまま', () => {
    const r = editContent(inWork(), [{ op: 'remove', at: step(3) }]);
    expect(r.applied).toBe(true);
    expect(r.xml).not.toMatch(/changeType|reasonForUpdate/);
    expect(r.reasonForUpdate).toBeUndefined();
  });
});

describe('addReasonForUpdate', () => {
  const status = () => startRevision(released(), { issueType: 'status' }).xml;

  it('本文に触らず、reasonForUpdate を remarks の前に足す（urt01 も受け付ける）', () => {
    const x = status();
    const r = addReasonForUpdate(x, { text: '誤字を直した。', updateReasonType: 'urt01' });
    expect(r.refusals).toEqual([]);
    expect(r.added).toBe(true);
    expect(r.reasonForUpdate).toEqual({ id: 'rfu-0001', updateReasonType: 'urt01' });
    const added = [
      '      <reasonForUpdate id="rfu-0001" updateReasonType="urt01">',
      '        <simplePara>誤字を直した。</simplePara>',
      '      </reasonForUpdate>',
    ];
    const lines = x.split('\n');
    const at = lines.findIndex((l) => l.includes('<remarks>'));
    expect(r.xml).toBe([...lines.slice(0, at), ...added, ...lines.slice(at)].join('\n'));
    // 2 つ目は、1 つ目の後ろ（remarks の前）に、文書に無い id で足す
    const second = addReasonForUpdate(r.xml, {
      text: '適用性を見直した。',
      updateReasonType: 'urt04',
      updateHighlight: '1',
    });
    expect(second.reasonForUpdate).toEqual({
      id: 'rfu-0002',
      updateReasonType: 'urt04',
      updateHighlight: '1',
    });
    expect(second.xml).toMatch(
      /rfu-0001"[\s\S]*<reasonForUpdate id="rfu-0002" updateReasonType="urt04" updateHighlight="1">[\s\S]*<remarks>/,
    );
  });

  it('足した理由を、後の編集の印から reasonRefId で指せる（urt01 の理由は指せない）', () => {
    const x = startRevision(released(), { issueType: 'changed' }).xml;
    const at = '/dmodule/content/procedure/mainProcedure/proceduralStep[1]';
    const technical = addReasonForUpdate(x, {
      text: '手順を見直した。',
      updateReasonType: 'urt02',
      id: 'rfu-a',
    });
    const e = editContent(technical.xml, [{ op: 'remove', at }], {
      marking: { reasonRefId: 'rfu-a', changeMark: '1' },
    });
    expect(e.refusals).toEqual([]);
    expect(e.reasonForUpdate).toEqual({ id: 'rfu-a', added: false, updateReasonType: 'urt02' });
    const editorial = addReasonForUpdate(x, {
      text: '誤字。',
      updateReasonType: 'urt01',
      id: 'rfu-b',
    });
    expect(
      editContent(editorial.xml, [{ op: 'remove', at }], {
        marking: { reasonRefId: 'rfu-b', changeMark: '1' },
      }).refusals[0]?.reason,
    ).toBe('editorial-reason');
  });

  it('発行済みの版、足りない入力、重なる id を断り、何も変えない', () => {
    const rel = addReasonForUpdate(released(), { text: 'x', updateReasonType: 'urt01' });
    expect(rel.refusals[0]?.reason).toBe('released-issue');
    expect(rel.xml).toBe(released());
    const x = status();
    expect(addReasonForUpdate(x, { text: ' ' } as never).refusals.map((f) => f.reason)).toEqual([
      'reason-input-error',
      'reason-input-error',
    ]);
    expect(
      addReasonForUpdate(x, { text: 'x', updateReasonType: 'urt01', id: 'stp-0001' }).refusals[0]
        ?.reason,
    ).toBe('id-duplicate');
  });
});
