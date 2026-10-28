/**
 * comment のコードとファイル名の分解・組み立て。
 *
 * 確かめられたこと（2026-10-28）:
 * - `commentCode` の属性は modelIdentCode（`[A-Z0-9]{2,14}`）・senderIdent（`[A-Z0-9]{5}`）・yearOfDataIssue（4 桁）・
 *   seqNumber（5 桁、正の整数）・commentType（q / i / r）の 5 つ（comment.xsd）
 * - `commentIdent` は `commentCode` と `language` だけで、`issueInfo` を持たない（comment.xsd）。comment には版が無い
 * - ファイル名の見本は 1 つだけ: 配布物のデータ辞書の DDN の例にある `COM-AJ-I9034-2006-00365-R_SX-US.XML`
 *   （`COM-<MIC>-<送り手>-<年>-<連番>-<種類 大文字>_<言語>-<国>.XML`）
 *
 * 確かめられていないこと（仕様書の PDF が読めないため）:
 * - ファイル名の規則そのもの（上の 1 例からの推定）。種類を大文字にするのか、言語の部分が必須か
 * - 連番が commentType ごとに独立か、同じモデル・送り手・年で通しか（採番は安全側で通しにしている）
 */
import type { Language, ParseResult } from '../types.js';
import type { CommentCode, CommentFileName, CommentType } from './types.js';

const CODE_RE = /^([A-Z0-9]{2,14})-([A-Z0-9]{5})-(\d{4})-(\d{5})-([A-Za-z])$/;

/** commentType の値（XSD の列挙）。意味は解釈しない */
export const COMMENT_TYPES: readonly CommentType[] = ['q', 'i', 'r'];

/** `S1000DBIKE-B6865-2026-00001-Q` の形の文字列を CommentCode にする（先頭の `COM-` は付いていてもよい。種類は大文字小文字を問わない） */
export function parseCommentCode(input: string): ParseResult<CommentCode> {
  const m = CODE_RE.exec(input.trim().replace(/^COM-/i, ''));
  if (!m) return { ok: false, error: `Not a comment code: ${input}` };
  const commentType = m[5]!.toLowerCase();
  if (!(COMMENT_TYPES as readonly string[]).includes(commentType)) {
    return {
      ok: false,
      error: `Invalid commentType "${m[5]}" in comment code (q, i or r): ${input}`,
    };
  }
  return {
    ok: true,
    value: {
      modelIdentCode: m[1]!,
      senderIdent: m[2]!,
      yearOfDataIssue: m[3]!,
      seqNumber: m[4]!,
      commentType: commentType as CommentType,
    },
  };
}

/** `S1000DBIKE-B6865-2026-00001-Q`（種類は大文字。配布物の見本に合わせる） */
export function formatCommentCode(code: CommentCode): string {
  return `${code.modelIdentCode}-${code.senderIdent}-${code.yearOfDataIssue}-${code.seqNumber}-${code.commentType.toUpperCase()}`;
}

export function sameCommentCode(a: CommentCode, b: CommentCode): boolean {
  return formatCommentCode(a) === formatCommentCode(b);
}

/**
 * ファイル名を組み立てる: `COM-<modelIdentCode>-<senderIdent>-<年>-<連番>-<種類>[_<言語>-<国>].<拡張子>`。
 * 版（`_001-00`）は付けない（comment の `commentIdent` に `issueInfo` が無いため）。
 * 規則は配布物にある 1 例（`COM-AJ-I9034-2006-00365-R_SX-US.XML`）からの推定で、仕様書では確かめていない
 */
export function formatCommentFileName(
  code: CommentCode,
  language?: Language,
  extension = 'XML',
): string {
  let name = `COM-${formatCommentCode(code)}`;
  if (language)
    name += `_${language.languageIsoCode.toUpperCase()}-${language.countryIsoCode.toUpperCase()}`;
  return extension ? `${name}.${extension}` : name;
}

/** `COM-<code>[_<言語>-<国>][.<拡張子>]` の形のファイル名（パス付きでもよい）を分解する */
export function parseCommentFileName(fileName: string): ParseResult<CommentFileName> {
  const base = fileName.replace(/^.*[\\/]/, '');
  const m = /^(COM-[^_.]+)(?:_([A-Za-z]{2,3})-([A-Za-z]{2}))?(?:\.([A-Za-z0-9]+))?$/i.exec(base);
  if (!m) return { ok: false, error: `Not a comment file name: ${fileName}` };
  const code = parseCommentCode(m[1]!);
  if (!code.ok) return code;
  const value: CommentFileName = { commentCode: code.value };
  if (m[2] !== undefined) {
    value.language = { languageIsoCode: m[2].toLowerCase(), countryIsoCode: m[3]!.toUpperCase() };
  }
  if (m[4] !== undefined) value.extension = m[4];
  return { ok: true, value };
}
