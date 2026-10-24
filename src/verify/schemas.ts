/**
 * 利用者が置いた S1000D の配布物（`S1000D_SPEC_DIR`）から XSD を探す。
 *
 * - 配布物は再配布できない（D-03）ので、XSD は利用者が展開したフォルダーから探す。
 * - 内側の zip をどの名前で展開しても見つかるように、`brex.xsd` を含む `xml_schema_flat/` フォルダーを再帰的に探す。
 * - 版（Issue）は `brex.xsd` 冒頭の `<xs:documentation>Issue number: 7</xs:documentation>` か
 *   URL の `S1000D_7` から読む。フォルダー名には頼らない。
 * - データ辞書（`data_dictionary_7` など）の中の写しは見ない（import が絶対 URL で、オフラインでは解決できない）。
 * - 配布物の `xml_schema_cat/catalog.xml` は `rewritePrefix` を利用者が書き換える前提のものなので使わない。
 */
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSchemaLocation } from '../schema-location.js';

export interface SchemaDir {
  /** `xml_schema_flat/` の絶対または相対パス（渡されたフォルダー基準） */
  dir: string;
  /** 読めた版（"7"、"4.2" など）。読めなければ undefined */
  issue?: string;
  /** `.xsd` の数 */
  xsdCount: number;
  /** XSD のファイル名（拡張子を除く、小文字） */
  schemaNames: string[];
}

const MAX_DEPTH = 8;

/** brex.xsd の冒頭から版を読む。無ければ undefined */
export function readIssueFromXsd(xsdPath: string): string | undefined {
  let head: string;
  try {
    const fd = openSync(xsdPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const m1 = /Issue number:\s*([0-9]+(?:\.[0-9]+)*)/i.exec(head);
  if (m1) return m1[1];
  const m2 = /S1000D_([0-9]+(?:-[0-9]+)*)/i.exec(head);
  if (m2) return m2[1].replace(/-/g, '.');
  return undefined;
}

/** フォルダー群から `xml_schema_flat/`（brex.xsd を含む）を探す。見つかった順 */
export function findSchemaDirs(dirs: string[]): SchemaDir[] {
  const out: SchemaDir[] = [];
  const seen = new Set<string>();
  const visit = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const brex = join(dir, 'brex.xsd');
    if (existsSync(brex) && !seen.has(dir)) {
      seen.add(dir);
      const xsds = entries.filter((e) => e.isFile() && /\.xsd$/i.test(e.name)).map((e) => e.name);
      out.push({
        dir,
        issue: readIssueFromXsd(brex),
        xsdCount: xsds.length,
        schemaNames: xsds.map((n) => n.replace(/\.xsd$/i, '').toLowerCase()).sort(),
      });
      return; // xml_schema_flat の下は見ない
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      // 配布物のデータ辞書（data_dictionary_7/）の中にも XSD の写しがあるが、xml.xsd などを
      // http://www.w3.org/2001/xml.xsd の絶対 URL で import しており、libxml2 がネットワークに出ようとして失敗する。
      // 「XML Schema Package」側（相対パスで import）だけを使う
      if (/^data_dictionary/i.test(e.name)) continue;
      visit(join(dir, e.name), depth + 1);
    }
  };
  for (const d of dirs) {
    try {
      if (statSync(d).isDirectory()) visit(d, 0);
    } catch {
      // 無いフォルダーは無視する
    }
  }
  return out;
}

export type LocateXsdResult =
  | { ok: true; xsdPath: string; schemaDir: SchemaDir; schemaName: string; issue?: string }
  | {
      ok: false;
      reason:
        /** schemaLocation が無い、またはファイル名を得られない */
        | 'no-schema-location'
        /** `xml_schema_flat/` がフォルダー群に無い */
        | 'no-schema-dir'
        /** 版の合う `xml_schema_flat/` が無い（複数の版が置かれている） */
        | 'issue-mismatch'
        /** 該当する `<schemaName>.xsd` が無い */
        | 'xsd-not-found';
      message: string;
      candidates: SchemaDir[];
    };

/**
 * 対象データモジュールの `xsi:noNamespaceSchemaLocation` から、使う XSD のパスを決める。
 *
 * - 候補が 1 つなら版が読めなくてもそれを使う（版の食い違いは結果に `issue` として返すだけ）。
 * - 候補が複数なら、`schemaLocation` の版と `brex.xsd` から読んだ版が一致するものを使う。
 */
export function locateXsd(
  schemaLocation: string | undefined,
  schemaDirs: SchemaDir[],
  options: { issue?: string } = {},
): LocateXsdResult {
  const loc = parseSchemaLocation(schemaLocation);
  const schemaName = loc.schemaName;
  if (!schemaName) {
    return {
      ok: false,
      reason: 'no-schema-location',
      message:
        'The document has no usable xsi:noNamespaceSchemaLocation (cannot tell which XSD applies)',
      candidates: schemaDirs,
    };
  }
  if (schemaDirs.length === 0) {
    return {
      ok: false,
      reason: 'no-schema-dir',
      message: 'No xml_schema_flat/ folder (containing brex.xsd) was found in the given folders',
      candidates: [],
    };
  }
  const wantedIssue = options.issue ?? loc.issue;
  let chosen: SchemaDir | undefined;
  if (schemaDirs.length === 1) {
    chosen = schemaDirs[0];
  } else {
    chosen = schemaDirs.find((d) => d.issue !== undefined && d.issue === wantedIssue);
    if (!chosen) {
      return {
        ok: false,
        reason: 'issue-mismatch',
        message: `Several xml_schema_flat/ folders were found (issues: ${schemaDirs.map((d) => d.issue ?? '?').join(', ')}) but none matches issue ${wantedIssue ?? '(unknown)'}`,
        candidates: schemaDirs,
      };
    }
  }
  const xsdPath = join(chosen.dir, `${schemaName}.xsd`);
  if (!existsSync(xsdPath)) {
    return {
      ok: false,
      reason: 'xsd-not-found',
      message: `${schemaName}.xsd is not in ${chosen.dir}`,
      candidates: schemaDirs,
    };
  }
  return { ok: true, xsdPath, schemaDir: chosen, schemaName, issue: chosen.issue ?? wantedIssue };
}
