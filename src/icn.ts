/**
 * ICN（Information Control Number）の分解。
 *
 * 2 つの書式を扱う。
 * - MIC 基準（9 区画）: `ICN-S1000DBIKE-AAA-D000000-0-U8025-00525-A-04-1`
 * - CAGE 基準（5 区画）: `ICN-C0419-S1000D0406-001-01`
 *
 * 版数・機密区分の桁数は S1000D の版（Issue 4.x の前後）で異なるため、桁数は検査せず
 * 区画の数と並びだけで判定する。桁数の確認は呼び出し側（版を知っている側）で行う。
 */
import type { Icn, ParseResult } from './types.js';

export function parseIcn(input: string): ParseResult<Icn> {
  const text = input.trim();
  if (!/^ICN-/i.test(text)) return { ok: false, error: `ICN must start with "ICN-": ${input}` };
  const seg = text.slice(4).split('-');
  const bad = seg.find((s) => !/^[A-Z0-9]+$/i.test(s));
  if (bad !== undefined) return { ok: false, error: `Invalid segment "${bad}" in ICN: ${input}` };

  if (seg.length === 9) {
    const [mic, sdc, sns, rpc, cage, uid, variant, issue, sec] = seg;
    return {
      ok: true,
      value: {
        form: 'mic',
        modelIdentCode: mic,
        systemDiffCode: sdc,
        sns,
        responsiblePartnerCompanyCode: rpc,
        originatorCode: cage,
        uniqueIdentifier: uid,
        variantCode: variant,
        issueNumber: issue,
        securityClassification: sec,
      },
    };
  }
  if (seg.length === 4) {
    const [cage, uid, issue, sec] = seg;
    return {
      ok: true,
      value: {
        form: 'cage',
        originatorCode: cage,
        uniqueIdentifier: uid,
        issueNumber: issue,
        securityClassification: sec,
      },
    };
  }
  return {
    ok: false,
    error: `ICN must have 4 (CAGE-based) or 9 (MIC-based) segments after "ICN-", got ${seg.length}: ${input}`,
  };
}

/** ICN の文字列を組み立てる。 */
export function formatIcn(icn: Icn): string {
  if (icn.form === 'mic') {
    return [
      'ICN',
      icn.modelIdentCode,
      icn.systemDiffCode,
      icn.sns,
      icn.responsiblePartnerCompanyCode,
      icn.originatorCode,
      icn.uniqueIdentifier,
      icn.variantCode,
      icn.issueNumber,
      icn.securityClassification,
    ].join('-');
  }
  return [
    'ICN',
    icn.originatorCode,
    icn.uniqueIdentifier,
    icn.issueNumber,
    icn.securityClassification,
  ].join('-');
}

/** ファイル名（`ICN-….CGM` など）から ICN の部分だけを取り出す。 */
export function parseIcnFileName(fileName: string): ParseResult<{ icn: Icn; extension?: string }> {
  const base = fileName.replace(/^.*[\\/]/, '');
  const m = /^(ICN-[A-Za-z0-9-]+?)(?:\.([A-Za-z0-9]+))?$/.exec(base);
  if (!m) return { ok: false, error: `Not an ICN file name: ${fileName}` };
  const r = parseIcn(m[1]);
  if (!r.ok) return r;
  return {
    ok: true,
    value: m[2] !== undefined ? { icn: r.value, extension: m[2] } : { icn: r.value },
  };
}
