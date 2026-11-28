/**
 * 利用者が置いた S1000D の配布物（`S1000D_SPEC_DIR`）から XSD を探す。
 *
 * - 配布物は再配布できない（D-03）ので、XSD は利用者が展開したフォルダーから探す。
 * - 内側の zip をどの名前で展開しても見つかるように、`brex.xsd` を含む `xml_schema_flat/` フォルダーを再帰的に探す。
 * - 版（Issue）は `brex.xsd` 冒頭の `<xs:documentation>Issue number: 7</xs:documentation>` か
 *   URL の `S1000D_7` から読む。フォルダー名には頼らない。
 * - データ辞書の中の写しは、絶対 URL で import しているもの（オフラインでは解決できない）を除き、
 *   中身が XML Schema Package と同じものは 1 つにまとめる。
 * - 配布物の `xml_schema_cat/catalog.xml` は `rewritePrefix` を利用者が書き換える前提のものなので使わない。
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
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
  /** XSD の名前と中身から作った指紋（16 進 16 桁）。同じなら、中身が 1 バイトも違わない */
  fingerprint?: string;
  /** 中身が同じだったほかのフォルダー（データ辞書の中の写しなど）。無ければ付かない */
  alsoAt?: string[];
  /** 利用者が優先すると選んだフォルダー（`FindSchemaDirsOptions.preferred`）か、その下にある */
  preferred?: boolean;
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
  const m2 = /S1000D_([0-9]+(?:-[0-9]+)*)/i.exec(head);
  const fromText = m1?.[1];
  const fromUrl = m2?.[1]?.replace(/-/g, '.');
  // パッチの XSD には、「Issue number: 4.0」と書いたまま URL だけを `S1000D_4-0-2` にしたものがある（Issue 4.0 の Patch 4.0.2）。
  // 文書の側は URL（`xsi:noNamespaceSchemaLocation`）で版を示すので、URL のほうが細かいときは URL を使う
  if (fromText && fromUrl && fromUrl !== fromText && fromUrl.startsWith(`${fromText}.`))
    return fromUrl;
  return fromText ?? fromUrl;
}

/** 絶対 URL（http・https）の `schemaLocation` で import / include しているか。libxml2 はオフラインでは解決できない */
function importsAbsoluteUrl(dir: string, xsdNames: string[]): boolean {
  for (const name of xsdNames) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    if (/<xs:(?:import|include)\b[^>]*\bschemaLocation\s*=\s*["']https?:/i.test(text)) return true;
  }
  return false;
}

/** フォルダーの中の XSD の名前と中身から作る指紋。中身が同じフォルダー（写し）を見分けるために使う */
function fingerprintXsds(dir: string, xsdNames: string[]): string {
  const h = createHash('sha256');
  for (const name of [...xsdNames].sort()) {
    h.update(name.toLowerCase()).update('\0');
    try {
      h.update(readFileSync(join(dir, name)));
    } catch {
      h.update('(unreadable)');
    }
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

export interface FindSchemaDirsOptions {
  /**
   * 優先して使うフォルダー（利用者の設定。`resolveStackConfig().schemaDirs`）。`xml_schema_flat/` そのものか、
   * それを含むフォルダーを渡す。見つかったフォルダーのうち、ここに挙げたフォルダーと同じか、その下にあるものを、
   * 挙げた順に結果の先頭へ移す（`preferred: true` が付く）。`dirs` の下に無いフォルダーも、ここに挙げれば探す
   */
  preferred?: string[];
}

/**
 * フォルダー群から `xml_schema_flat/`（brex.xsd を含む）を探す。
 *
 * - フォルダーの中は名前の順に見る（OS によって並びが変わらないようにする）。
 * - 絶対 URL で import している XSD のフォルダー（Issue 7 のデータ辞書の中の写し）は除く。
 * - 中身が 1 バイトも違わないフォルダー（配布物のデータ辞書の中の写しなど）は、先に見つかった 1 つだけを返し、
 *   ほかの場所を `alsoAt` に入れる。
 * - 版が同じで中身が違うフォルダー（配布物の XSD とパッチの XSD）は、どちらも返す。`locateXsd` は先頭を使うので、
 *   利用者が `options.preferred` で選んだフォルダーを先頭へ移す。指定が無ければ、名前の順のまま。
 */
export function findSchemaDirs(dirs: string[], options: FindSchemaDirsOptions = {}): SchemaDir[] {
  const out: SchemaDir[] = [];
  const seen = new Set<string>();
  const byFingerprint = new Map<string, SchemaDir>();
  const visit = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    const brex = join(dir, 'brex.xsd');
    if (existsSync(brex)) {
      if (seen.has(dir)) return;
      seen.add(dir);
      const xsds = entries.filter((e) => e.isFile() && /\.xsd$/i.test(e.name)).map((e) => e.name);
      if (importsAbsoluteUrl(dir, xsds)) return;
      const fingerprint = fingerprintXsds(dir, xsds);
      const same = byFingerprint.get(fingerprint);
      if (same) {
        (same.alsoAt ??= []).push(dir);
        return;
      }
      const found: SchemaDir = {
        dir,
        issue: readIssueFromXsd(brex),
        xsdCount: xsds.length,
        schemaNames: xsds.map((n) => n.replace(/\.xsd$/i, '').toLowerCase()).sort(),
        fingerprint,
      };
      byFingerprint.set(fingerprint, found);
      out.push(found);
      return; // xml_schema_flat の下は見ない
    }
    // データ辞書のフォルダーは後回しにする（中身が同じ写しなら、XML Schema Package の側を残すため）
    const isDictionary = (name: string) => /data[ _-]?dictionary/i.test(name);
    const ordered = [
      ...entries.filter((e) => !isDictionary(e.name)),
      ...entries.filter((e) => isDictionary(e.name)),
    ];
    for (const e of ordered) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      // 配布物のデータ辞書（data_dictionary_7/）の中にも XSD の写しがあるが、xml.xsd などを
      // http://www.w3.org/2001/xml.xsd の絶対 URL で import しており、libxml2 がネットワークに出ようとして失敗する。
      // 「XML Schema Package」側（相対パスで import）だけを使う。この名前のフォルダーは、中を読まずに除く
      if (/^data_dictionary/i.test(e.name)) continue;
      visit(join(dir, e.name), depth + 1);
    }
  };
  const preferred = (options.preferred ?? []).map((p) => resolve(p));
  // 利用者が選んだフォルダーを先に見る（中身が同じ写しがあるとき、選んだ側を残すため）
  for (const d of [...preferred, ...dirs]) {
    try {
      if (statSync(d).isDirectory()) visit(d, 0);
    } catch {
      // 無いフォルダーは無視する
    }
  }
  if (preferred.length === 0) return out;
  const rank = (d: SchemaDir) => {
    const full = resolve(d.dir);
    const i = preferred.findIndex((p) => full === p || full.startsWith(p + sep));
    return i < 0 ? preferred.length : i;
  };
  for (const d of out) if (rank(d) < preferred.length) d.preferred = true;
  // 並べ替えは安定（同じ順位の中では、見つかった順のまま）
  return out
    .map((d, i) => ({ d, i, r: rank(d) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map((x) => x.d);
}

export type LocateXsdResult =
  | {
      ok: true;
      xsdPath: string;
      schemaDir: SchemaDir;
      schemaName: string;
      issue?: string;
      /**
       * 同じ版で中身の違う、ほかの `xml_schema_flat/`（配布物の XSD とパッチの XSD など）。あるときだけ付く。
       * 使ったのは `schemaDir`（見つかった順の先頭）で、ここに挙がるフォルダーの XSD では結果が変わり得る
       */
      otherCandidates?: SchemaDir[];
    }
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
  let otherCandidates: SchemaDir[] = [];
  if (schemaDirs.length === 1) {
    chosen = schemaDirs[0];
  } else {
    const matching = schemaDirs.filter((d) => d.issue !== undefined && d.issue === wantedIssue);
    chosen = matching[0];
    otherCandidates = matching.slice(1);
    if (!chosen && wantedIssue === undefined) {
      // 文書に版が書かれていない。この名前の XSD を持つフォルダーが 1 つだけなら、それを使う
      const having = schemaDirs.filter((d) => d.schemaNames.includes(schemaName));
      if (having.length === 1) chosen = having[0];
    }
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
  return {
    ok: true,
    xsdPath,
    schemaDir: chosen,
    schemaName,
    issue: chosen.issue ?? wantedIssue,
    ...(otherCandidates.length > 0 ? { otherCandidates } : {}),
  };
}
