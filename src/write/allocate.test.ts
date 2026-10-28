import { describe, expect, it } from 'vitest';
import { kenbaikiAllocation } from '../__fixtures__/kenbaiki-drafts.js';
import { CsdbIndex } from '../csdb-index.js';
import { classifyCsdbFileName } from '../csdb-source.js';
import { formatDmc, parseDmc } from '../dmc.js';
import { parseIcn } from '../icn.js';
import { formatPmc, parsePmc } from '../pmc.js';
import { allocateDmc, allocateIcn, allocatePmc } from './allocate.js';
import { DraftInputError } from './errors.js';
import type { Allocation } from './types.js';

const indexOf = (...names: string[]) =>
  new CsdbIndex(names.map((n) => classifyCsdbFileName(n)).filter((o) => o !== undefined));

describe('allocateDmc', () => {
  it('rules から DMC を組み立て、台帳に記録する（入力の台帳は書き換えない）', () => {
    const allocation = kenbaikiAllocation();
    const a = allocateDmc('topic-1', { kind: 'proced' }, allocation);
    expect(a.from).toBe('rules');
    expect(formatDmc(a.dmCode)).toBe('KENBAIKI-A-10-20-00-00A-520A-D');
    expect(a.ledger).toEqual({ 'topic-1': 'KENBAIKI-A-10-20-00-00A-520A-D' });
    expect(allocation.ledger).toBeUndefined();
  });

  it('同じ sourceId には、台帳を渡し直しても同じ DMC を返す（往復）', () => {
    let allocation = kenbaikiAllocation();
    const first: Record<string, string> = {};
    for (const id of ['a', 'b', 'c']) {
      const r = allocateDmc(id, { kind: 'descript' }, allocation);
      first[id] = formatDmc(r.dmCode);
      allocation = { ...allocation, ledger: r.ledger };
    }
    // 同じ情報コードなので、分解コードは 00、01、02 と進む
    expect(Object.values(first).map((d) => d.split('-')[5])).toEqual(['00A', '01A', '02A']);
    // 台帳を JSON にして戻しても同じ
    const restored: Allocation = {
      ...allocation,
      ledger: JSON.parse(JSON.stringify(allocation.ledger)),
    };
    for (const id of ['c', 'a', 'b']) {
      const r = allocateDmc(id, { kind: 'descript' }, restored);
      expect(r.from).toBe('ledger');
      expect(formatDmc(r.dmCode)).toBe(first[id]);
    }
    // 台帳にある sourceId の後に新しい sourceId を出すと、その次の番号になる
    const d = allocateDmc('d', { kind: 'descript' }, restored);
    expect(d.dmCode.disassyCode).toBe('03');
  });

  it('draft.dmCode を指定すると、それを使って台帳に記録する', () => {
    const dm = parseDmc('KENBAIKI-A-10-20-00-07A-040A-D');
    if (!dm.ok) throw new Error('fixture');
    const a = allocateDmc('x', { kind: 'descript', dmCode: dm.value }, kenbaikiAllocation());
    expect(a.from).toBe('draft');
    expect(a.ledger.x).toBe('KENBAIKI-A-10-20-00-07A-040A-D');
  });

  it('map は rules より先に使われ、指定した項目だけを上書きする', () => {
    const allocation: Allocation = {
      ...kenbaikiAllocation(),
      map: { special: { systemCode: '20', subSystemCode: '1', infoCode: '041' } },
    };
    const a = allocateDmc('special', { kind: 'descript' }, allocation);
    expect(a.from).toBe('map');
    expect(formatDmc(a.dmCode)).toBe('KENBAIKI-A-20-10-00-00A-041A-D');
  });

  it('同じ SNS・情報コードの既存 DM（CsdbIndex）の次の番号にする', () => {
    const index = indexOf(
      'DMC-KENBAIKI-A-10-20-00-00A-040A-D_001-00_JA-JP.XML',
      'DMC-KENBAIKI-A-10-20-00-04A-040A-D_001-00_JA-JP.XML',
      // 情報コードが違うものは数えない
      'DMC-KENBAIKI-A-10-20-00-09A-520A-D_001-00_JA-JP.XML',
    );
    const a = allocateDmc('new', { kind: 'descript' }, kenbaikiAllocation(), index);
    expect(a.dmCode.disassyCode).toBe('05');
    const b = allocateDmc('new', { kind: 'proced' }, kenbaikiAllocation(), index);
    expect(b.dmCode.disassyCode).toBe('10');
  });

  it('infoCodeByKind に無い kind は DraftInputError（既定の情報コードは持たない）', () => {
    const allocation = kenbaikiAllocation();
    delete allocation.rules.infoCodeByKind.proced;
    expect(() => allocateDmc('x', { kind: 'proced' }, allocation)).toThrowError(DraftInputError);
    try {
      allocateDmc('x', { kind: 'proced' }, allocation);
    } catch (e) {
      expect((e as DraftInputError).path).toBe('/allocation/rules/infoCodeByKind/proced');
      expect((e as DraftInputError).message).toMatch(/no default/);
    }
    // map が情報コードを与えれば、infoCodeByKind が無くても採番できる
    const withMap: Allocation = {
      ...allocation,
      map: { x: { infoCode: '520', infoCodeVariant: 'A' } },
    };
    expect(formatDmc(allocateDmc('x', { kind: 'proced' }, withMap).dmCode)).toBe(
      'KENBAIKI-A-10-20-00-00A-520A-D',
    );
  });

  it('固定の分解コードが他の sourceId と衝突したら DraftInputError', () => {
    const allocation: Allocation = {
      ...kenbaikiAllocation(),
      rules: { ...kenbaikiAllocation().rules, disassyCode: '00' },
    };
    const a = allocateDmc('a', { kind: 'descript' }, allocation);
    expect(a.dmCode.disassyCode).toBe('00');
    expect(() =>
      allocateDmc('b', { kind: 'descript' }, { ...allocation, ledger: a.ledger }),
    ).toThrowError(/already used/);
  });

  it('台帳の値が DMC でなければ DraftInputError、桁数の誤りも DraftInputError', () => {
    expect(() =>
      allocateDmc(
        'a',
        { kind: 'descript' },
        { ...kenbaikiAllocation(), ledger: { a: 'ICN-K0001-00001-001-01' } },
      ),
    ).toThrowError(DraftInputError);
    expect(() =>
      allocateDmc('a', { kind: 'descript' }, { ...kenbaikiAllocation(), modelIdentCode: 'x' }),
    ).toThrowError(/not valid/);
  });
});

describe('allocateIcn', () => {
  it('CAGE 書式で採番し、parseIcn で分解できる', () => {
    const a = allocateIcn('asset-home', kenbaikiAllocation());
    expect(a.icn).toBe('ICN-K0001-00001-001-01');
    expect(a.next).toBe(2);
    const parsed = parseIcn(a.icn);
    expect(parsed.ok && parsed.value).toEqual({
      form: 'cage',
      originatorCode: 'K0001',
      uniqueIdentifier: '00001',
      issueNumber: '001',
      securityClassification: '01',
    });
  });

  it('版と機密区分を指定できる', () => {
    const a = allocateIcn('a', kenbaikiAllocation(), undefined, {
      issueNumber: '002',
      securityClassification: '02',
    });
    expect(a.icn).toBe('ICN-K0001-00001-002-02');
  });

  it('同じ assetId は台帳から同じ ICN を返し、連番は進めない', () => {
    let allocation = kenbaikiAllocation();
    const a = allocateIcn('home', allocation);
    allocation = { ...allocation, ledger: a.ledger, icn: { ...allocation.icn, next: a.next } };
    const b = allocateIcn('door', allocation);
    expect(b.icn).toBe('ICN-K0001-00002-001-01');
    allocation = { ...allocation, ledger: b.ledger, icn: { ...allocation.icn, next: b.next } };
    const again = allocateIcn('home', allocation);
    expect(again.from).toBe('ledger');
    expect(again.icn).toBe(a.icn);
    expect(again.next).toBe(3);
  });

  it('assetId がすでに ICN ならそのまま返す', () => {
    const a = allocateIcn('ICN-C0419-S1000D0379-001-01', kenbaikiAllocation());
    expect(a.from).toBe('given');
    expect(a.icn).toBe('ICN-C0419-S1000D0379-001-01');
  });

  it('CsdbIndex・台帳の使用済みの連番を避ける', () => {
    const index = indexOf('ICN-K0001-00007-001-01.PNG', 'ICN-OTHER-00099-001-01.PNG');
    const a = allocateIcn('x', kenbaikiAllocation(), index);
    expect(a.icn).toBe('ICN-K0001-00008-001-01');
    const b = allocateIcn('y', {
      ...kenbaikiAllocation(),
      ledger: { z: 'ICN-K0001-00012-001-01' },
    });
    expect(b.icn).toBe('ICN-K0001-00013-001-01');
  });

  it('連番を使い切ったら DraftInputError', () => {
    const allocation = kenbaikiAllocation();
    allocation.icn.next = 100000;
    expect(() => allocateIcn('x', allocation)).toThrowError(DraftInputError);
  });
});

describe('allocatePmc', () => {
  it('sourceId から PMC を作り、台帳に記録する。同じ sourceId には同じ PMC', () => {
    const allocation = kenbaikiAllocation();
    const a = allocatePmc('manual-kenbaiki', {}, allocation);
    expect(a.from).toBe('derived');
    expect(a.pmCode.modelIdentCode).toBe('KENBAIKI');
    expect(a.pmCode.pmIssuer).toBe('K0001');
    expect(a.pmCode.pmVolume).toBe('00');
    expect(parsePmc(formatPmc(a.pmCode)).ok).toBe(true);
    const b = allocatePmc('manual-kenbaiki', {}, { ...allocation, ledger: a.ledger });
    expect(b.from).toBe('ledger');
    expect(b.pmCode).toEqual(a.pmCode);
    // 英数字 5 文字の sourceId は pmNumber にそのまま使う
    expect(allocatePmc('ab-c1d', {}, allocation).pmCode.pmNumber).toBe('ABC1D');
  });

  it('他の PMC と衝突したら別の番号にずらす', () => {
    const allocation = kenbaikiAllocation();
    const a = allocatePmc('ABC12', {}, allocation);
    const index = indexOf(`PMC-${formatPmc(a.pmCode)}_001-00_JA-JP.XML`);
    const b = allocatePmc('ABC12', {}, allocation, index);
    expect(b.pmCode.pmNumber).not.toBe('ABC12');
  });
});
