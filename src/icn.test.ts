import { describe, expect, it } from 'vitest';
import { formatIcn, parseIcn, parseIcnFileName } from './icn.js';

describe('parseIcn', () => {
  it('MIC 基準の 9 区画を読む', () => {
    const r = parseIcn('ICN-KENBAIKI-A-000000-0-K0001-00001-A-01-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      form: 'mic',
      modelIdentCode: 'KENBAIKI',
      systemDiffCode: 'A',
      sns: '000000',
      responsiblePartnerCompanyCode: '0',
      originatorCode: 'K0001',
      uniqueIdentifier: '00001',
      variantCode: 'A',
      issueNumber: '01',
      securityClassification: '1',
    });
    expect(formatIcn(r.value)).toBe('ICN-KENBAIKI-A-000000-0-K0001-00001-A-01-1');
  });

  it('CAGE 基準の 4 区画を読む', () => {
    const r = parseIcn('ICN-K0001-KENBAIKI0001-001-01');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      form: 'cage',
      originatorCode: 'K0001',
      uniqueIdentifier: 'KENBAIKI0001',
      issueNumber: '001',
      securityClassification: '01',
    });
    expect(formatIcn(r.value)).toBe('ICN-K0001-KENBAIKI0001-001-01');
  });

  it('接頭辞や区画数が違えば失敗', () => {
    expect(parseIcn('K0001-KENBAIKI0001-001-01').ok).toBe(false);
    expect(parseIcn('ICN-K0001-KENBAIKI0001-001').ok).toBe(false);
    expect(parseIcn('ICN-K00_1-KENBAIKI0001-001-01').ok).toBe(false);
  });

  it('ファイル名から拡張子を分ける', () => {
    const r = parseIcnFileName('img/ICN-K0001-KENBAIKI0001-001-01.PNG');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.extension).toBe('PNG');
    expect(r.value.icn.form).toBe('cage');
  });
});
