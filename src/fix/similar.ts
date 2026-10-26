/**
 * 文字列の近さ。未解決の internalRef / applicRefId の候補と、XSD で許されない属性名の言い換え候補に使う。
 */

/** レーベンシュタイン距離（挿入・削除・置換をそれぞれ 1 と数える） */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 末尾の数字を除いた部分（`fig-0003` → `fig-`）。数字だけなら空 */
export function idPrefix(id: string): string {
  return id.replace(/\d+$/, '');
}

export interface NearMatch {
  value: string;
  distance: number;
  /** 近いと判断した理由 */
  why: 'same-prefix' | 'edit-distance' | 'case';
}

/**
 * `wanted` に近い文字列を `pool` から選ぶ。距離の小さい順、同じなら文字列順。
 *
 * 近いと見なす条件（どれか 1 つ）:
 * - 大文字小文字だけが違う
 * - 編集距離が max(2, 長さの 1/3) 以下
 * - 末尾の数字を除いた接頭辞が同じ（接頭辞が 2 文字以上のとき。`fig-0003` と `fig-0001`）
 */
export function nearMatches(wanted: string, pool: Iterable<string>, limit = 5): NearMatch[] {
  const threshold = Math.max(2, Math.floor(wanted.length / 3));
  const prefix = idPrefix(wanted);
  const out: NearMatch[] = [];
  for (const v of pool) {
    if (v === wanted || v === '') continue;
    const distance = editDistance(wanted, v);
    if (v.toLowerCase() === wanted.toLowerCase()) out.push({ value: v, distance, why: 'case' });
    else if (distance <= threshold) out.push({ value: v, distance, why: 'edit-distance' });
    else if (prefix.length >= 2 && idPrefix(v) === prefix)
      out.push({ value: v, distance, why: 'same-prefix' });
  }
  // 大文字小文字だけの違いを先に、その後は距離の小さい順
  const rank = (m: NearMatch) => (m.why === 'case' ? 0 : 1);
  out.sort(
    (a, b) => rank(a) - rank(b) || a.distance - b.distance || a.value.localeCompare(b.value),
  );
  return out.slice(0, limit);
}
