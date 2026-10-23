/**
 * `objectValue` の値の照合。
 *
 * - single: 文字列として一致
 * - range: `brsl51~brsl99` のように「共通の接頭辞＋数字」の範囲。`|` 区切りの列挙も受け付ける
 *   （Chap 3.9.5.3 の適用性の範囲表記に合わせる）
 * - pattern: XML Schema Part 2 の正規表現。全体一致で評価する。
 *   既定 BREX の実例は JavaScript の正規表現と同じ書き方だが、XSD 固有の `\i` `\c` は変換する
 */
import type { BrexObjectValue } from './types.js';

function splitPrefixNumber(s: string): { prefix: string; digits: string } | undefined {
  const m = /^(.*?)(\d+)$/.exec(s);
  return m ? { prefix: m[1], digits: m[2] } : undefined;
}

/** 範囲 1 区間（`a~b`）に値が入るか */
function inRange(value: string, range: string): boolean {
  const [lo, hi] = range.split('~');
  if (hi === undefined) return value === lo;
  const l = splitPrefixNumber(lo);
  const h = splitPrefixNumber(hi);
  const v = splitPrefixNumber(value);
  if (!l || !h || !v) return false;
  if (l.prefix !== h.prefix || v.prefix !== l.prefix) return false;
  // 桁数が揃っている範囲（000~022、51~99）では桁数も一致させる
  if (l.digits.length === h.digits.length && v.digits.length !== l.digits.length) return false;
  const n = Number(v.digits);
  return n >= Number(l.digits) && n <= Number(h.digits);
}

export function matchesRange(value: string, valueAllowed: string): boolean {
  return valueAllowed
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .some((part) => inRange(value, part));
}

/** XSD の正規表現を JavaScript の RegExp に変換する（全体一致） */
export function xsdPatternToRegExp(pattern: string): RegExp {
  const js = pattern
    .replace(/\\i/g, '[A-Za-z_:]')
    .replace(/\\c/g, '[A-Za-z0-9._:-]')
    // XSD では空白をエスケープして書けるが JS の u フラグ無しなら同じ意味
    .replace(/\\ /g, ' ');
  return new RegExp(`^(?:${js})$`);
}

const patternCache = new Map<string, RegExp | null>();

export function matchesPattern(value: string, valueAllowed: string): boolean {
  let re = patternCache.get(valueAllowed);
  if (re === undefined) {
    try {
      re = xsdPatternToRegExp(valueAllowed);
    } catch {
      re = null;
    }
    patternCache.set(valueAllowed, re);
  }
  return re ? re.test(value) : false;
}

/** 値が objectValue 1 件に合うか。valueAllowed が無い objectValue は照合の対象外（false） */
export function matchesObjectValue(value: string, ov: BrexObjectValue): boolean {
  if (ov.valueAllowed === undefined) return false;
  switch (ov.valueForm) {
    case 'single':
      return value === ov.valueAllowed;
    case 'range':
      return matchesRange(value, ov.valueAllowed);
    case 'pattern':
      return matchesPattern(value, ov.valueAllowed);
  }
}

/**
 * 値が、並んだ objectValue のどれか 1 つに合うか。
 * valueAllowed を持つ objectValue が 1 つも無ければ、照合すべき制限が無いので true。
 */
export function matchesAnyObjectValue(value: string, values: BrexObjectValue[]): boolean {
  const constrained = values.filter((v) => v.valueAllowed !== undefined);
  if (constrained.length === 0) return true;
  return constrained.some((v) => matchesObjectValue(value, v));
}
