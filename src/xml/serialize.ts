/**
 * 文書要素だけを直列化し、文書要素より前（XML 宣言・コメント・DOCTYPE の内部サブセット）と後ろを元の文字列のまま保つ。
 *
 * `fix/apply.ts` の同名の処理と同じ方式（そちらは変更しない。重複は承知のうえで複製した）。
 * xmldom の `serializeToString(document)` は DOCTYPE の内部サブセット（ENTITY / NOTATION 宣言）を落とすことがあるため、
 * 文書要素より前は元の文字列を使う。
 */
import { XMLSerializer } from '@xmldom/xmldom';
import type { Document } from '@xmldom/xmldom';

/** 文書要素の開始位置。XML 宣言・コメント・PI・DOCTYPE（内部サブセットを含む）を読み飛ばす。見つからなければ -1 */
export function findRootStart(xml: string): number {
  const n = xml.length;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < n && /\s/.test(xml[i]!)) i++;
    if (xml.startsWith('<?', i)) {
      const e = xml.indexOf('?>', i + 2);
      if (e < 0) return -1;
      i = e + 2;
    } else if (xml.startsWith('<!--', i)) {
      const e = xml.indexOf('-->', i + 4);
      if (e < 0) return -1;
      i = e + 3;
    } else if (xml.startsWith('<!DOCTYPE', i)) {
      let depth = 0;
      let quote = '';
      i += 9;
      for (; i < n; i++) {
        const ch = xml[i]!;
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (xml.startsWith('<!--', i)) {
          const e = xml.indexOf('-->', i + 4);
          if (e < 0) return -1;
          i = e + 2;
        } else if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '>' && depth <= 0) {
          i++;
          break;
        }
      }
    } else return xml[i] === '<' ? i : -1;
  }
}

/** 文書要素の後ろに続く、コメント・PI・空白だけの末尾 */
export function findEpilog(xml: string): string {
  const m = /(?:\s*(?:<!--[\s\S]*?-->|<\?[\s\S]*?\?>))*\s*$/.exec(xml);
  return m ? m[0] : '';
}

/** 文書要素より前の文字列（XML 宣言・DOCTYPE など）。見つからなければ undefined */
export function prologOf(original: string): string | undefined {
  const start = findRootStart(original);
  return start < 0 ? undefined : original.slice(0, start);
}

/**
 * 文書を直列化する。文書要素より前・後ろは `original` のものを使う。
 * 文書要素の位置が分からないときは文書全体を直列化し、`onFallback` を呼ぶ。
 */
export function serializeKeepingProlog(
  doc: Document,
  original: string,
  onFallback?: () => void,
): string {
  const serializer = new XMLSerializer();
  const root = doc.documentElement;
  const start = findRootStart(original);
  if (!root || start < 0) {
    onFallback?.();
    return serializer.serializeToString(doc);
  }
  const epilog = findEpilog(original.slice(start));
  return original.slice(0, start) + serializer.serializeToString(root) + epilog;
}
