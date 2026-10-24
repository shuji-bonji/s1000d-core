/**
 * フォルダー群を CSDB と見なし、中の CSDB オブジェクト（DMC・PMC・DML・DDN・IMF・UPF・ICN）を一覧にして、
 * DMC・PMC・ファイル名から探せるようにする。
 *
 * `listDataModules`（csdb.ts）は DMC だけを拾う。参照の解決と reader にはそれ以外も要るため、ここで広げる。
 */
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseDmcFileName, sameDmc } from './dmc.js';
import { parsePmcFileName, samePmc } from './pmc.js';
import type { DmCode, DmcFileName, IssueInfo, PmCode, PmcFileName } from './types.js';

export type CsdbObjectKind = 'dm' | 'pm' | 'dml' | 'ddn' | 'imf' | 'upf' | 'icn' | 'other';

export interface CsdbObject {
  kind: CsdbObjectKind;
  path: string;
  /** ファイル名（パス無し） */
  fileName: string;
  /** kind が dm のとき */
  dm?: DmcFileName;
  /** kind が pm のとき */
  pm?: PmcFileName;
}

function kindOf(name: string): CsdbObjectKind | undefined {
  const m = /^(DMC|PMC|DML|DDN|IMF|UPF|ICN)-/i.exec(name);
  if (!m) return undefined;
  switch (m[1].toUpperCase()) {
    case 'DMC':
      return 'dm';
    case 'PMC':
      return 'pm';
    case 'DML':
      return 'dml';
    case 'DDN':
      return 'ddn';
    case 'IMF':
      return 'imf';
    case 'UPF':
      return 'upf';
    case 'ICN':
      return 'icn';
    default:
      return undefined;
  }
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
      const kind = kindOf(e.name);
      if (!kind) continue;
      const isXml = /\.xml$/i.test(e.name);
      if (kind !== 'icn' && !isXml) continue;
      const obj: CsdbObject = { kind, path: p, fileName: e.name };
      if (kind === 'dm') {
        const r = parseDmcFileName(e.name);
        if (!r.ok) continue;
        obj.dm = r.value;
      } else if (kind === 'pm') {
        const r = parsePmcFileName(e.name);
        if (!r.ok) continue;
        obj.pm = r.value;
      }
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

const issueKey = (i: IssueInfo | undefined) => (i ? `1-${i.issueNumber}-${i.inWork}` : '0');

/** DMC・PMC・ファイル名で探せる索引 */
export class CsdbIndex {
  readonly objects: CsdbObject[];
  private readonly byFileName = new Map<string, CsdbObject[]>();

  constructor(objects: CsdbObject[]) {
    this.objects = objects;
    for (const o of objects) {
      const key = o.fileName.toLowerCase();
      const list = this.byFileName.get(key);
      if (list) list.push(o);
      else this.byFileName.set(key, [o]);
    }
  }

  static fromDirs(dirs: string[]): CsdbIndex {
    return new CsdbIndex(listCsdbObjects(dirs));
  }

  /** DMC に一致するデータモジュール（発行番号の大きいものが先） */
  findDataModules(dmCode: DmCode): CsdbObject[] {
    return this.objects
      .filter((o) => o.dm && sameDmc(o.dm.dmCode, dmCode))
      .sort((a, b) => issueKey(b.dm!.issueInfo).localeCompare(issueKey(a.dm!.issueInfo)));
  }

  /** PMC に一致するパブリケーションモジュール（発行番号の大きいものが先） */
  findPublicationModules(pmCode: PmCode): CsdbObject[] {
    return this.objects
      .filter((o) => o.pm && samePmc(o.pm.pmCode, pmCode))
      .sort((a, b) => issueKey(b.pm!.issueInfo).localeCompare(issueKey(a.pm!.issueInfo)));
  }

  /** ファイル名（大文字小文字を区別しない。パスが付いていればファイル名だけを見る）で探す */
  findByFileName(name: string): CsdbObject[] {
    return this.byFileName.get(basename(name).toLowerCase()) ?? [];
  }
}
