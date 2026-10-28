/**
 * CSDB の置き場所を表すインターフェース。
 *
 * core はこれまで「フォルダーの中の `DMC-….XML`」を CSDB と見なしてきた（`CsdbIndex.fromDirs`）。
 * 製品の CSDB はデータベースや API なので、「一覧」と「中身の取得」をここに集め、
 * フォルダー実装（`DirectoryCsdbSource`）を既定にしたまま、製品側が自分の実装を差し込めるようにする。
 * `XmlEngine` / `SchemaValidator` と同じ形。書き戻しは `WritableCsdbSource`（writer のために足した、既存の `CsdbSource` は変えない）。
 *
 * 同期にしている理由: `resolveReferences`・`suggestFixes`・`findApplicTables` が同期関数で、
 * ここを非同期にするとそれらの API を変えることになる。データベースや API から読む実装は、
 * 先に読み込んでから `MemoryCsdbSource` に渡すか、同期で読める形（キャッシュなど）にして差し込む。
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseDmcFileName } from './dmc.js';
import { parseCommentFileName } from './comment/code.js';
import type { CommentFileName } from './comment/types.js';
import { parseDdnFileName, parseDmlFileName } from './dml/code.js';
import type { DdnFileName, DmlFileName } from './dml/types.js';
import { parsePmcFileName } from './pmc.js';
import type { DmcFileName, PmcFileName } from './types.js';

/**
 * dme は拡張 DMC（`dmCodeExtension`）を持つデータモジュール（`DME-<製造者>-<拡張コード>-<DMC>…`、Bike Samples に 2 件）。
 * ファイル名だけで DMC を決められないため `dm` は付けず、`findDataModules` では見つからない（`findByFileName` では見つかる）
 */
export type CsdbObjectKind =
  'dm' | 'dme' | 'pm' | 'dml' | 'ddn' | 'imf' | 'upf' | 'icn' | 'comment' | 'other';

export interface CsdbObject {
  kind: CsdbObjectKind;
  /** 出どころの中での識別子。フォルダーならファイルのパス。応答にそのまま載せる */
  path: string;
  /** ファイル名（パス無し） */
  fileName: string;
  /** kind が dm のとき */
  dm?: DmcFileName;
  /** kind が pm のとき */
  pm?: PmcFileName;
  /** kind が dml で、ファイル名が DML のコードとして読めたとき */
  dml?: DmlFileName;
  /** kind が ddn で、ファイル名が DDN のコードとして読めたとき */
  ddn?: DdnFileName;
  /** kind が comment で、ファイル名が comment のコードとして読めたとき */
  comment?: CommentFileName;
}

/** CSDB オブジェクトの一覧と中身の取得 */
export interface CsdbSource {
  /** 出どころの説明（応答の注記や、見つからなかったときの文章に使う） */
  readonly description: string;
  /** CSDB オブジェクトの一覧。呼ぶたびに同じ内容を返してよい（索引が覚える） */
  list(): CsdbObject[];
  /** XML の中身（テキスト）。読めないときは throw する。ICN など XML でないものは対象外 */
  readText(object: CsdbObject): string;
}

/** 書き込みの指定 */
export interface CsdbWriteOptions {
  /** 同じ `path` があっても上書きする。省略か false なら `CsdbWriteConflictError` */
  overwrite?: boolean;
}

/**
 * 書き込める CSDB の置き場所（writer-mcp の `write: true` が使う）。`CsdbSource` に書き込みを足したもの。
 * 同期のままにしている理由は `CsdbSource` と同じ。非同期にしか書けない製品は、応答の `xml` を受け取って自分で書く。
 */
export interface WritableCsdbSource extends CsdbSource {
  /** 置き場所の中の識別子（`CsdbObject.path`）と中身を受け取り、書き込んだ識別子を返す */
  writeText(path: string, text: string, options?: CsdbWriteOptions): string;
  /** ICN の原本など、文字列でないファイル */
  writeBytes(path: string, bytes: Uint8Array, options?: CsdbWriteOptions): string;
}

/** 同じ `path` が既にあり、`overwrite: true` でないため書かなかった（`code` は 'write-conflict'） */
export class CsdbWriteConflictError extends Error {
  readonly code = 'write-conflict';
  constructor(readonly path: string) {
    super(`write-conflict: ${path} already exists (pass overwrite: true to replace it)`);
    this.name = 'CsdbWriteConflictError';
  }
}

/** 書き込める置き場所か */
export function isWritableCsdbSource(source: CsdbSource): source is WritableCsdbSource {
  const s = source as Partial<WritableCsdbSource>;
  return typeof s.writeText === 'function' && typeof s.writeBytes === 'function';
}

/**
 * ファイル名から CSDB オブジェクトの種類と DMC・PMC を決める。
 * 接頭辞（DMC- / PMC- / …）が無い、XML でない（ICN 以外）、DMC・PMC として読めない名前は undefined
 */
export function classifyCsdbFileName(fileName: string): CsdbObject | undefined {
  const m = /^(DMC|DME|PMC|DML|DDN|IMF|UPF|ICN|COM)-/i.exec(fileName);
  if (!m) return undefined;
  const kind = m[1].toLowerCase() as
    'dmc' | 'dme' | 'pmc' | 'dml' | 'ddn' | 'imf' | 'upf' | 'icn' | 'com';
  const k: CsdbObjectKind =
    kind === 'dmc' ? 'dm' : kind === 'pmc' ? 'pm' : kind === 'com' ? 'comment' : kind;
  const isXml = /\.xml$/i.test(fileName);
  if (k !== 'icn' && !isXml) return undefined;
  const obj: CsdbObject = { kind: k, path: fileName, fileName };
  if (k === 'dm') {
    const r = parseDmcFileName(fileName);
    if (!r.ok) return undefined;
    obj.dm = r.value;
  } else if (k === 'pm') {
    const r = parsePmcFileName(fileName);
    if (!r.ok) return undefined;
    obj.pm = r.value;
  } else if (k === 'dml') {
    const r = parseDmlFileName(fileName);
    if (r.ok) obj.dml = r.value;
  } else if (k === 'ddn') {
    const r = parseDdnFileName(fileName);
    if (r.ok) obj.ddn = r.value;
  } else if (k === 'comment') {
    const r = parseCommentFileName(fileName);
    if (r.ok) obj.comment = r.value;
  }
  return obj;
}

/** フォルダー群（再帰）から CSDB オブジェクトを集める。XML でないファイルは ICN だけを拾う */
export function listCsdbObjects(dirs: string[]): CsdbObject[] {
  const out: CsdbObject[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(p);
        continue;
      }
      const obj = classifyCsdbFileName(e.name);
      if (!obj) continue;
      obj.path = p;
      out.push(obj);
    }
  };
  for (const d of dirs) {
    try {
      if (statSync(d).isDirectory()) walk(d);
    } catch {
      // 無いフォルダーは無視する
    }
  }
  return out;
}

/** 既定の実装。フォルダー群（再帰）を CSDB と見なし、`path` はファイルのパス。書き込みは最初のフォルダーに行う */
export class DirectoryCsdbSource implements WritableCsdbSource {
  readonly dirs: readonly string[];
  constructor(dirs: string[]) {
    this.dirs = [...dirs];
  }
  get description(): string {
    return `directories: ${this.dirs.join(', ')}`;
  }
  list(): CsdbObject[] {
    return listCsdbObjects([...this.dirs]);
  }
  readText(object: CsdbObject): string {
    return readFileSync(object.path, 'utf8');
  }
  /**
   * 最初のフォルダーに書く。`path` はファイル名か、そのフォルダーの中の相対パス（親フォルダーが無ければ作る）。
   * そのフォルダーの中を指す絶対パス（前回の戻り値）も受け付ける。戻り値は書いたファイルのパス（`CsdbObject.path` と同じ形）
   */
  writeText(path: string, text: string, options: CsdbWriteOptions = {}): string {
    return this.write(path, text, options);
  }
  writeBytes(path: string, bytes: Uint8Array, options: CsdbWriteOptions = {}): string {
    return this.write(path, bytes, options);
  }
  private write(path: string, data: string | Uint8Array, options: CsdbWriteOptions): string {
    const root = this.dirs[0];
    if (root === undefined) throw new Error('DirectoryCsdbSource has no directory to write to');
    const base = resolve(root);
    const file = isAbsolute(path) ? resolve(path) : resolve(base, path);
    const rel = relative(base, file);
    if (path === '' || rel === '' || rel.startsWith('..') || isAbsolute(rel))
      throw new Error(`Cannot write outside the first directory (${root}): ${path}`);
    mkdirSync(dirname(file), { recursive: true });
    try {
      // 'wx' は既にあれば EEXIST（確かめて書くまでの隙間を作らない）
      writeFileSync(file, data, { flag: options.overwrite ? 'w' : 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new CsdbWriteConflictError(file);
      throw e;
    }
    return join(root, rel);
  }
}

export interface MemoryCsdbEntry {
  /** CSDB の形のファイル名（`DMC-….XML` など）。種類と DMC・PMC はここから決める */
  fileName: string;
  /** XML の中身。ICN など XML でないものは省いてよい */
  xml?: string;
  /** 識別子。省くと fileName */
  path?: string;
}

/**
 * メモリー上の CSDB。テストと、データベースや API から先に読み込んだ内容を渡すのに使う。
 * CSDB の形でないファイル名（`classifyCsdbFileName` が undefined を返す名前）は無視する
 */
export class MemoryCsdbSource implements WritableCsdbSource {
  private readonly objects: CsdbObject[] = [];
  private readonly texts = new Map<CsdbObject, string | Uint8Array | undefined>();
  /** CSDB の形でない名前で書かれたもの（`list()` には出ない）。識別子 → 中身 */
  private readonly others = new Map<string, string | Uint8Array>();
  readonly description: string;

  constructor(entries: MemoryCsdbEntry[], description = 'in-memory CSDB') {
    this.description = description;
    for (const e of entries) {
      const obj = classifyCsdbFileName(e.fileName);
      if (!obj) continue;
      obj.path = e.path ?? e.fileName;
      this.objects.push(obj);
      this.texts.set(obj, e.xml);
    }
  }
  list(): CsdbObject[] {
    return [...this.objects];
  }
  readText(object: CsdbObject): string {
    const text = this.texts.get(object) ?? this.findByPath(object.path);
    if (text === undefined) throw new Error(`No content for ${object.path} in ${this.description}`);
    return typeof text === 'string' ? text : new TextDecoder().decode(text);
  }
  private findByPath(path: string): string | Uint8Array | undefined {
    for (const [o, text] of this.texts) if (o.path === path) return text;
    return undefined;
  }
  /**
   * 書き込む。`path` は識別子（`MemoryCsdbEntry.path`）で、種類と DMC・PMC はその最後の段（ファイル名）から決める。
   * CSDB の形でない名前も書けるが、`list()` には出ない（`DirectoryCsdbSource` と同じ）。戻り値は `path`
   */
  writeText(path: string, text: string, options: CsdbWriteOptions = {}): string {
    return this.write(path, text, options);
  }
  writeBytes(path: string, bytes: Uint8Array, options: CsdbWriteOptions = {}): string {
    return this.write(path, bytes.slice(), options);
  }
  private write(path: string, data: string | Uint8Array, options: CsdbWriteOptions): string {
    if (path === '') throw new Error('path must not be empty');
    const existing = this.objects.find((o) => o.path === path);
    if (existing || this.others.has(path)) {
      if (!options.overwrite) throw new CsdbWriteConflictError(path);
      if (existing) this.texts.set(existing, data);
      else this.others.set(path, data);
      return path;
    }
    const obj = classifyCsdbFileName(basename(path));
    if (!obj) {
      this.others.set(path, data);
      return path;
    }
    obj.path = path;
    this.objects.push(obj);
    this.texts.set(obj, data);
    return path;
  }
}
