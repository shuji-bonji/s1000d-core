/**
 * `xsi:noNamespaceSchemaLocation` の値から、S1000D の版とスキーマ名（データモジュールの種類）を推定する。
 *
 * 実測した値の形:
 * - Issue 7:   `http://www.s1000d.org/S1000D_7/xml_schema_flat/descript.xsd`
 * - Issue 4.2: `http://www.s1000d.org/S1000D_4-2/xml_schema_flat/brex.xsd`（仕様書の例）
 *
 * URL でなくローカルのパスが書かれていることもあるため、末尾のファイル名と `S1000D_<版>` の区画だけを見る。
 */

export interface SchemaLocationInfo {
  /** スキーマのファイル名から拡張子を除いたもの（brex / descript / proced / pm など） */
  schemaName?: string;
  /** `S1000D_7` → "7"、`S1000D_4-2` → "4.2"。見つからなければ undefined */
  issue?: string;
}

export function parseSchemaLocation(location: string | undefined | null): SchemaLocationInfo {
  if (!location) return {};
  const value = location.trim();
  const info: SchemaLocationInfo = {};
  const file = /([A-Za-z0-9_-]+)\.xsd$/i.exec(value);
  if (file) info.schemaName = file[1].toLowerCase();
  const issue = /S1000D_(\d+(?:-\d+)*)/i.exec(value);
  if (issue) info.issue = issue[1].replace(/-/g, '.');
  return info;
}
