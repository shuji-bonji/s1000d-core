/**
 * CSDB オブジェクト（DMC・PMC・DML・DDN・IMF・UPF・ICN）の一覧を、DMC・PMC・ファイル名から探せるようにする索引。
 *
 * 一覧と中身の取得は `CsdbSource`（csdb-source.ts）が行う。既定はフォルダー（`DirectoryCsdbSource`）。
 * `listDataModules`（csdb.ts）は DMC だけを拾う。参照の解決と reader にはそれ以外も要るため、ここで広げる。
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { DirectoryCsdbSource, type CsdbObject, type CsdbSource } from './csdb-source.js';
import { sameDmc } from './dmc.js';
import { samePmc } from './pmc.js';
import type { DmCode, IssueInfo, PmCode } from './types.js';

export { classifyCsdbFileName, listCsdbObjects } from './csdb-source.js';
export type { CsdbObject, CsdbObjectKind } from './csdb-source.js';

const issueKey = (i: IssueInfo | undefined) => (i ? `1-${i.issueNumber}-${i.inWork}` : '0');

/** DMC・PMC・ファイル名で探せる索引 */
export class CsdbIndex {
  readonly objects: CsdbObject[];
  /** 中身を読むための出どころ。`new CsdbIndex(objects)` で作ったときは undefined（`path` をファイルとして読む） */
  readonly source: CsdbSource | undefined;
  private readonly byFileName = new Map<string, CsdbObject[]>();

  constructor(objects: CsdbObject[], source?: CsdbSource) {
    this.objects = objects;
    this.source = source;
    for (const o of objects) {
      const key = o.fileName.toLowerCase();
      const list = this.byFileName.get(key);
      if (list) list.push(o);
      else this.byFileName.set(key, [o]);
    }
  }

  /** フォルダー群を CSDB と見なす（既定の形） */
  static fromDirs(dirs: string[]): CsdbIndex {
    return CsdbIndex.fromSource(new DirectoryCsdbSource(dirs));
  }

  /** 任意の `CsdbSource` の上に索引を作る。一覧はこのときに 1 回だけ取る */
  static fromSource(source: CsdbSource): CsdbIndex {
    return new CsdbIndex(source.list(), source);
  }

  /** 出どころの説明。source が無ければ 'files' */
  get description(): string {
    return this.source?.description ?? 'files';
  }

  /** オブジェクトの中身（XML のテキスト）を読む。source が無ければ `path` をファイルとして読む */
  read(object: CsdbObject): string {
    return this.source ? this.source.readText(object) : readFileSync(object.path, 'utf8');
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
