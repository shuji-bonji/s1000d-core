/**
 * CSDB の置き場所を表すインターフェース。
 *
 * core はこれまで「フォルダーの中の `DMC-….XML`」を CSDB と見なしてきた（`CsdbIndex.fromDirs`）。
 * 製品の CSDB はデータベースや API なので、「一覧」と「中身の取得」をここに集め、
 * フォルダー実装（`DirectoryCsdbSource`）を既定にしたまま、製品側が自分の実装を差し込めるようにする。
 * `XmlEngine` / `SchemaValidator` と同じ形。書き戻しは段階 3（writer）で足す。
 *
 * 同期にしている理由: `resolveReferences`・`suggestFixes`・`findApplicTables` が同期関数で、
 * ここを非同期にするとそれらの API を変えることになる。データベースや API から読む実装は、
 * 先に読み込んでから `MemoryCsdbSource` に渡すか、同期で読める形（キャッシュなど）にして差し込む。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseDmcFileName } from './dmc.js';
import { parseDdnFileName, parseDmlFileName } from './dml/code.js';
import type { DdnFileName, DmlFileName } from './dml/types.js';
import { parsePmcFileName } from './pmc.js';
import type { DmcFileName, PmcFileName } from './types.js';

/**
 * dme は拡張 DMC（`dmCodeExtension`）を持つデータモジュール（`DME-<製造者>-<拡張コード>-<DMC>…`、Bike Samples に 2 件）。
 * ファイル名だけで DMC を決められないため `dm` は付けず、`findDataModules` では見つからない（`findByFileName` では見つかる）
 */
export type CsdbObjectKind = 'dm' | 'dme' | 'pm' | 'dml' | 'ddn' | 'imf' | 'upf' | 'icn' | 'other';

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

/**
 * ファイル名から CSDB オブジェクトの種類と DMC・PMC を決める。
 * 接頭辞（DMC- / PMC- / …）が無い、XML でない（ICN 以外）、DMC・PMC として読めない名前は undefined
 */
export function classifyCsdbFileName(fileName: string): CsdbObject | undefined {
  const m = /^(DMC|DME|PMC|DML|DDN|IMF|UPF|ICN)-/i.exec(fileName);
  if (!m) return undefined;
  const kind = m[1].toLowerCase() as 'dmc' | 'dme' | 'pmc' | 'dml' | 'ddn' | 'imf' | 'upf' | 'icn';
  const k: CsdbObjectKind = kind === 'dmc' ? 'dm' : kind === 'pmc' ? 'pm' : kind;
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

/** 既定の実装。フォルダー群（再帰）を CSDB と見なし、`path` はファイルのパス */
export class DirectoryCsdbSource implements CsdbSource {
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
export class MemoryCsdbSource implements CsdbSource {
  private readonly objects: CsdbObject[] = [];
  private readonly texts = new Map<CsdbObject, string | undefined>();
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
    return text;
  }
  private findByPath(path: string): string | undefined {
    for (const [o, text] of this.texts) if (o.path === path) return text;
    return undefined;
  }
}
