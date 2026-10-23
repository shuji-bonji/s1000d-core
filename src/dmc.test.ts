import { describe, expect, it } from 'vitest';
import {
  formatDmc,
  formatDmcFileName,
  isBrexDmc,
  parseDmc,
  parseDmcFileName,
  sameDmc,
} from './dmc.js';

describe('parseDmc', () => {
  it('分解して組み立てると元に戻る（3 文字のシステムコード）', () => {
    const r = parseDmc('KENBAIKI-A-D00-00-00-00AA-041A-A');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      modelIdentCode: 'KENBAIKI',
      systemDiffCode: 'A',
      systemCode: 'D00',
      subSystemCode: '0',
      subSubSystemCode: '0',
      assyCode: '00',
      disassyCode: '00',
      disassyCodeVariant: 'AA',
      infoCode: '041',
      infoCodeVariant: 'A',
      itemLocationCode: 'A',
    });
    expect(formatDmc(r.value)).toBe('KENBAIKI-A-D00-00-00-00AA-041A-A');
  });

  it('4 桁の組立コードと DMC- 接頭辞を受け付ける', () => {
    const r = parseDmc('DMC-S1000D-J-04-10-0301-00A-022A-D');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.assyCode).toBe('0301');
    expect(r.value.subSystemCode).toBe('1');
    expect(r.value.subSubSystemCode).toBe('0');
    expect(isBrexDmc(r.value)).toBe(true);
  });

  it('学習コードを読む', () => {
    const r = parseDmc('KENBAIKI-A-D00-00-00-00AA-200A-T-T36D');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.learnCode).toBe('T36');
    expect(r.value.learnEventCode).toBe('D');
    expect(formatDmc(r.value)).toBe('KENBAIKI-A-D00-00-00-00AA-200A-T-T36D');
  });

  it('区画の数や桁が違えば失敗を返す', () => {
    expect(parseDmc('KENBAIKI-A-D00-00-00-00AA-041A').ok).toBe(false);
    expect(parseDmc('K-A-D00-00-00-00AA-041A-A').ok).toBe(false);
    expect(parseDmc('KENBAIKI-A-D00-00-00-00AA-41A-A').ok).toBe(false);
    expect(parseDmc('KENBAIKI-A-D00-00-000-00AA-041A-A').ok).toBe(false);
  });

  it('sameDmc は発行情報を見ない', () => {
    const a = parseDmc('KENBAIKI-A-D00-00-00-00AA-041A-A');
    const b = parseDmc('DMC-KENBAIKI-A-D00-00-00-00AA-041A-A');
    expect(a.ok && b.ok && sameDmc(a.value, b.value)).toBe(true);
  });
});

describe('parseDmcFileName', () => {
  it('発行情報・言語・拡張子を読む', () => {
    const r = parseDmcFileName('/csdb/DMC-KENBAIKI-A-10-20-00-00A-040A-D_002-01_JA-JP.XML');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.issueInfo).toEqual({ issueNumber: '002', inWork: '01' });
    expect(r.value.language).toEqual({ languageIsoCode: 'ja', countryIsoCode: 'JP' });
    expect(r.value.extension).toBe('XML');
    expect(formatDmcFileName(r.value)).toBe('DMC-KENBAIKI-A-10-20-00-00A-040A-D_002-01_JA-JP.XML');
  });

  it('発行情報が無いファイル名も読む', () => {
    const r = parseDmcFileName('DMC-KENBAIKI-A-10-20-00-00A-040A-D.xml');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.issueInfo).toBeUndefined();
    expect(r.value.language).toBeUndefined();
  });

  it('DMC で始まらなければ失敗', () => {
    expect(parseDmcFileName('PMC-KENBAIKI-K0001-00001-00_001-00_JA-JP.XML').ok).toBe(false);
  });
});
