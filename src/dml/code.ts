/**
 * DML・DDN のコードの分解と組み立て。ファイル名の形は配布物の Bike Samples で確認した
 * （`DML-S1000DBIKE-B6865-S-2026-00001_001-00.XML`、`DDN-S1000DBIKE-B6865-B6865-2026-00001.XML`）。
 * DML のファイル名の種類は大文字（S）、`dmlCode/@dmlType` は小文字（s）なので、比較は大文字小文字を区別しない。
 */
import type { IssueInfo, ParseResult } from '../types.js';
import type { DdnCode, DdnFileName, DmlCode, DmlFileName } from './types.js';

const DML_RE = /^([A-Z0-9]+)-([A-Z0-9]{5})-([A-Za-z])-(\d{4})-(\d{5})$/;
const DDN_RE = /^([A-Z0-9]+)-([A-Z0-9]{5})-([A-Z0-9]{5})-(\d{4})-(\d{5})$/;

/** `S1000DBIKE-B6865-S-2026-00001` の形の文字列を DmlCode にする（先頭の `DML-` は付いていてもよい） */
export function parseDmlCode(input: string): ParseResult<DmlCode> {
  const m = DML_RE.exec(input.trim().replace(/^DML-/i, ''));
  if (!m) return { ok: false, error: `Not a DML code: ${input}` };
  return {
    ok: true,
    value: {
      modelIdentCode: m[1]!,
      senderIdent: m[2]!,
      dmlType: m[3]!.toLowerCase(),
      yearOfDataIssue: m[4]!,
      seqNumber: m[5]!,
    },
  };
}

export function formatDmlCode(code: DmlCode): string {
  return `${code.modelIdentCode}-${code.senderIdent}-${code.dmlType.toUpperCase()}-${code.yearOfDataIssue}-${code.seqNumber}`;
}

export function sameDmlCode(a: DmlCode, b: DmlCode): boolean {
  return (
    a.modelIdentCode === b.modelIdentCode &&
    a.senderIdent === b.senderIdent &&
    a.dmlType.toLowerCase() === b.dmlType.toLowerCase() &&
    a.yearOfDataIssue === b.yearOfDataIssue &&
    a.seqNumber === b.seqNumber
  );
}

/** `DML-<code>[_<issue>-<inWork>].<ext>` の形のファイル名を分解する */
export function parseDmlFileName(fileName: string): ParseResult<DmlFileName> {
  const m = /^DML-([^_.]+)(?:_(\d{3})-(\d{2}))?(?:\.([A-Za-z0-9]+))?$/i.exec(fileName.trim());
  if (!m) return { ok: false, error: `Not a DML file name: ${fileName}` };
  const code = parseDmlCode(m[1]!);
  if (!code.ok) return code;
  const value: DmlFileName = { dmlCode: code.value };
  if (m[2]) value.issueInfo = { issueNumber: m[2], inWork: m[3] ?? '00' } satisfies IssueInfo;
  if (m[4]) value.extension = m[4];
  return { ok: true, value };
}

/** `S1000DBIKE-B6865-B6865-2026-00001` の形の文字列を DdnCode にする（先頭の `DDN-` は付いていてもよい） */
export function parseDdnCode(input: string): ParseResult<DdnCode> {
  const m = DDN_RE.exec(input.trim().replace(/^DDN-/i, ''));
  if (!m) return { ok: false, error: `Not a DDN code: ${input}` };
  return {
    ok: true,
    value: {
      modelIdentCode: m[1]!,
      senderIdent: m[2]!,
      receiverIdent: m[3]!,
      yearOfDataIssue: m[4]!,
      seqNumber: m[5]!,
    },
  };
}

export function formatDdnCode(code: DdnCode): string {
  return `${code.modelIdentCode}-${code.senderIdent}-${code.receiverIdent}-${code.yearOfDataIssue}-${code.seqNumber}`;
}

export function sameDdnCode(a: DdnCode, b: DdnCode): boolean {
  return formatDdnCode(a) === formatDdnCode(b);
}

/** `DDN-<code>.<ext>` の形のファイル名を分解する */
export function parseDdnFileName(fileName: string): ParseResult<DdnFileName> {
  const m = /^DDN-([^_.]+)(?:\.([A-Za-z0-9]+))?$/i.exec(fileName.trim());
  if (!m) return { ok: false, error: `Not a DDN file name: ${fileName}` };
  const code = parseDdnCode(m[1]!);
  if (!code.ok) return code;
  const value: DdnFileName = { ddnCode: code.value };
  if (m[2]) value.extension = m[2];
  return { ok: true, value };
}
