/**
 * パブリケーションモジュールコード（PMC）の分解・組み立て。
 *
 * 例: `PMC-S1000DBIKE-B6865-EPWG1-00_006-00_EN-US.XML`
 *     → modelIdentCode S1000DBIKE、pmIssuer B6865、pmNumber EPWG1、pmVolume 00、発行 006-00、言語 en-US
 * 要素は `pmCode` の属性名（modelIdentCode / pmIssuer / pmNumber / pmVolume）に合わせる（Chap 4.3.4）。
 */
import type { IssueInfo, Language, ParseResult, PmCode, PmcFileName } from './types.js';

export function parsePmc(input: string): ParseResult<PmCode> {
  const s = input.trim().replace(/^PMC-/i, '');
  const m = /^([A-Z0-9]{2,14})-([A-Z0-9]{5})-([A-Z0-9]{5})-([A-Z0-9]{2})$/i.exec(s);
  if (!m) return { ok: false, error: `Not a PMC: ${input}` };
  return {
    ok: true,
    value: { modelIdentCode: m[1], pmIssuer: m[2], pmNumber: m[3], pmVolume: m[4] },
  };
}

export function formatPmc(pm: PmCode): string {
  return `${pm.modelIdentCode}-${pm.pmIssuer}-${pm.pmNumber}-${pm.pmVolume}`;
}

export function samePmc(a: PmCode, b: PmCode): boolean {
  return formatPmc(a).toUpperCase() === formatPmc(b).toUpperCase();
}

/** ファイル名（パス付きでもよい）を分解する。発行情報と言語は無くてもよい。 */
export function parsePmcFileName(fileName: string): ParseResult<PmcFileName> {
  const base = fileName.replace(/^.*[\\/]/, '');
  const m =
    /^(PMC-[^_]+?)(?:_(\d{3,4})-(\d{2}))?(?:_([A-Za-z]{2})-([A-Za-z]{2}))?(?:\.([A-Za-z0-9]+))?$/.exec(
      base,
    );
  if (!m) return { ok: false, error: `Not a PMC file name: ${fileName}` };
  const pm = parsePmc(m[1]);
  if (!pm.ok) return pm;
  const value: PmcFileName = { pmCode: pm.value };
  if (m[2] !== undefined) value.issueInfo = { issueNumber: m[2], inWork: m[3] } satisfies IssueInfo;
  if (m[4] !== undefined) {
    value.language = {
      languageIsoCode: m[4].toLowerCase(),
      countryIsoCode: m[5].toUpperCase(),
    } satisfies Language;
  }
  if (m[6] !== undefined) value.extension = m[6];
  return { ok: true, value };
}
