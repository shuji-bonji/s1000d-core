/**
 * フォルダーを CSDB として扱い、DMC からファイルを探す。
 *
 * S1000D は CSDB の機能を定めるが、特定の保管方法は定めない。ここでは「フォルダーの中に
 * `DMC-….XML` の名前で置かれたファイル」を CSDB と見なす（配布物の Bike Samples と同じ形）。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readBrex } from './brex/read.js';
import type { BrexDocument } from './brex/types.js';
import type { BrexResolver } from './brex/chain.js';
import { CsdbIndex } from './csdb-index.js';
import { parseDmcFileName, sameDmc } from './dmc.js';
import type { DmCode, DmRef, DmcFileName } from './types.js';
import type { XmlEngine } from './xml/engine.js';
import { defaultXmlEngine } from './xml/xmldom-fontoxpath.js';

export interface CsdbEntry {
  path: string;
  name: DmcFileName;
}

/** フォルダー（再帰）から DMC ファイルを集める。 */
export function listDataModules(dirs: string[]): CsdbEntry[] {
  const out: CsdbEntry[] = [];
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
      } else if (/^DMC-.*\.xml$/i.test(e.name)) {
        const name = parseDmcFileName(e.name);
        if (name.ok) out.push({ path: p, name: name.value });
      }
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

/**
 * DMC（発行情報は見ない）に一致するファイルを、優先順に並べて返す。
 * 発行情報付きの名前（CSDB の形）を先に、同じなら発行番号が大きいものを先にする。
 */
export function findDataModules(entries: CsdbEntry[], dmCode: DmCode): CsdbEntry[] {
  const issueKey = (e: CsdbEntry) =>
    e.name.issueInfo ? `1-${e.name.issueInfo.issueNumber}-${e.name.issueInfo.inWork}` : '0';
  return entries
    .filter((e) => sameDmc(e.name.dmCode, dmCode))
    .sort((a, b) => issueKey(b).localeCompare(issueKey(a)));
}

/** DMC に一致するファイルのうち、最も優先されるものを返す。 */
export function findDataModule(entries: CsdbEntry[], dmCode: DmCode): CsdbEntry | undefined {
  return findDataModules(entries, dmCode)[0];
}

/**
 * CSDB の索引から BREX を探す BrexResolver を作る。中身は索引の `CsdbSource` から読む。
 * 既定 BREX（`S1000D_SPEC_DIR` の中）とプロジェクトの CSDB を同じ索引に入れておけば、連鎖を最後までたどれる。
 */
export function createBrexResolver(
  index: CsdbIndex,
  engine: XmlEngine = defaultXmlEngine,
): BrexResolver {
  const cache = new Map<string, BrexDocument | undefined>();
  return (ref: DmRef) => {
    const key = JSON.stringify(ref.dmCode);
    if (cache.has(key)) return cache.get(key);
    // ファイル名が一致しても中身の DMC が違うことがある（配布物のデータ辞書の見本など）。
    // 中身の DMC が参照と一致するものを優先し、無ければ最初に読めたものを返す
    let fallback: BrexDocument | undefined;
    let brex: BrexDocument | undefined;
    for (const obj of index.findDataModules(ref.dmCode)) {
      let r;
      try {
        r = readBrex(index.read(obj), engine);
      } catch {
        continue;
      }
      if (!r.ok) continue;
      if (sameDmc(r.value.dmCode, ref.dmCode)) {
        brex = r.value;
        break;
      }
      fallback ??= r.value;
    }
    brex ??= fallback;
    cache.set(key, brex);
    return brex;
  };
}

/**
 * フォルダー群から BREX を探す BrexResolver を作る（`createBrexResolver(CsdbIndex.fromDirs(dirs))` と同じ）。
 */
export function createDirectoryBrexResolver(
  dirs: string[],
  engine: XmlEngine = defaultXmlEngine,
): BrexResolver {
  return createBrexResolver(CsdbIndex.fromDirs(dirs), engine);
}
