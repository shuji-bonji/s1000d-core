/**
 * データモジュールコード（DMC）の分解と組み立て。
 *
 * 根拠: S1000D Chap 4.3（Data module code）。桁数は Issue 4 以降で共通。
 * - modelIdentCode 2〜14、systemDiffCode 1〜4、systemCode 2〜3、subSystemCode 1、subSubSystemCode 1、
 *   assyCode 2 または 4、disassyCode 2、disassyCodeVariant 1〜3、infoCode 3、infoCodeVariant 1、
 *   itemLocationCode 1、学習用は learnCode 3 ＋ learnEventCode 1。
 *
 * ハイフン区切りの文字列表現では、subSystemCode と subSubSystemCode が 1 つの区画（2 文字）に、
 * disassyCode と disassyCodeVariant が 1 つの区画に、infoCode と infoCodeVariant が 1 つの区画に入る。
 */
import type { DmCode, DmcFileName, IssueInfo, Language, ParseResult } from './types.js';

const RE = {
  modelIdentCode: /^[A-Z0-9]{2,14}$/,
  systemDiffCode: /^[A-Z0-9]{1,4}$/,
  systemCode: /^[A-Z0-9]{2,3}$/,
  subSystems: /^[A-Z0-9]{2}$/,
  assyCode: /^([A-Z0-9]{2}|[A-Z0-9]{4})$/,
  disassy: /^([A-Z0-9]{2})([A-Z0-9]{1,3})$/,
  info: /^([A-Z0-9]{3})([A-Z0-9])$/,
  itemLocationCode: /^[A-Z0-9]$/,
  learn: /^([A-Z0-9]{3})([A-Z0-9])$/,
} as const;

/**
 * DMC の文字列を構成要素に分解する。
 * 先頭の `DMC-` は付いていても付いていなくてもよい。
 *
 * @example parseDmc('S1000DBIKE-AAA-D00-00-00-00AA-041A-A')
 */
export function parseDmc(input: string): ParseResult<DmCode> {
  const text = input.trim().replace(/^DMC-/i, '');
  const seg = text.split('-');
  if (seg.length !== 8 && seg.length !== 9) {
    return {
      ok: false,
      error: `DMC must have 8 segments (9 with learn code), got ${seg.length}: ${input}`,
    };
  }
  const [mic, sdc, sys, subs, assy, disassy, info, loc, learn] = seg as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string?,
  ];
  const fail = (what: string, value: string): ParseResult<DmCode> => ({
    ok: false,
    error: `Invalid ${what} "${value}" in DMC: ${input}`,
  });
  if (!RE.modelIdentCode.test(mic)) return fail('modelIdentCode', mic);
  if (!RE.systemDiffCode.test(sdc)) return fail('systemDiffCode', sdc);
  if (!RE.systemCode.test(sys)) return fail('systemCode', sys);
  if (!RE.subSystems.test(subs)) return fail('subSystemCode/subSubSystemCode', subs);
  if (!RE.assyCode.test(assy)) return fail('assyCode', assy);
  const d = RE.disassy.exec(disassy);
  if (!d) return fail('disassyCode/disassyCodeVariant', disassy);
  const i = RE.info.exec(info);
  if (!i) return fail('infoCode/infoCodeVariant', info);
  if (!RE.itemLocationCode.test(loc)) return fail('itemLocationCode', loc);

  const value: DmCode = {
    modelIdentCode: mic,
    systemDiffCode: sdc,
    systemCode: sys,
    subSystemCode: subs[0],
    subSubSystemCode: subs[1],
    assyCode: assy,
    disassyCode: d[1],
    disassyCodeVariant: d[2],
    infoCode: i[1],
    infoCodeVariant: i[2],
    itemLocationCode: loc,
  };
  if (learn !== undefined) {
    const l = RE.learn.exec(learn);
    if (!l) return fail('learnCode/learnEventCode', learn);
    value.learnCode = l[1];
    value.learnEventCode = l[2];
  }
  return { ok: true, value };
}

/** 構成要素から DMC の文字列（`DMC-` 無し）を組み立てる。 */
export function formatDmc(dmc: DmCode): string {
  const parts = [
    dmc.modelIdentCode,
    dmc.systemDiffCode,
    dmc.systemCode,
    dmc.subSystemCode + dmc.subSubSystemCode,
    dmc.assyCode,
    dmc.disassyCode + dmc.disassyCodeVariant,
    dmc.infoCode + dmc.infoCodeVariant,
    dmc.itemLocationCode,
  ];
  if (dmc.learnCode !== undefined && dmc.learnEventCode !== undefined) {
    parts.push(dmc.learnCode + dmc.learnEventCode);
  }
  return parts.join('-');
}

/**
 * ファイル名（例: `DMC-S1000DBIKE-AAA-D00-00-00-00AA-041A-A_013-00_EN-US.XML`）を分解する。
 * パスが付いていてもよい。発行情報と言語は無くてもよい。
 */
export function parseDmcFileName(fileName: string): ParseResult<DmcFileName> {
  const base = fileName.replace(/^.*[\\/]/, '');
  const m =
    /^(DMC-[^_]+?)(?:_(\d{3,4})-(\d{2}))?(?:_([A-Za-z]{2})-([A-Za-z]{2}))?(?:\.([A-Za-z0-9]+))?$/.exec(
      base,
    );
  if (!m) return { ok: false, error: `Not a DMC file name: ${fileName}` };
  const dm = parseDmc(m[1]);
  if (!dm.ok) return dm;
  const value: DmcFileName = { dmCode: dm.value };
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

/**
 * ファイル名を組み立てる。言語コードは S1000D の慣例（言語は大文字、国は大文字）に合わせて大文字にする。
 */
export function formatDmcFileName(parts: DmcFileName): string {
  let name = `DMC-${formatDmc(parts.dmCode)}`;
  if (parts.issueInfo) name += `_${parts.issueInfo.issueNumber}-${parts.issueInfo.inWork}`;
  if (parts.language) {
    name += `_${parts.language.languageIsoCode.toUpperCase()}-${parts.language.countryIsoCode.toUpperCase()}`;
  }
  if (parts.extension) name += `.${parts.extension}`;
  return name;
}

/** 2 つの DMC が同じデータモジュールを指すか（発行情報と言語は見ない）。 */
export function sameDmc(a: DmCode, b: DmCode): boolean {
  return formatDmc(a) === formatDmc(b);
}

/** BREX データモジュールの情報コード（Chap 4.10.2.4）。 */
export const BREX_INFO_CODE = '022';

/** この DMC が BREX データモジュールのものか（情報コード 022、アイテムロケーションコード D）。 */
export function isBrexDmc(dmc: DmCode): boolean {
  return dmc.infoCode === BREX_INFO_CODE && dmc.itemLocationCode === 'D';
}
