/**
 * DML・DDN と CSDB の照合。「DML にあるのに CSDB に無い」「版が違う」「CSDB にあるのに DML に無い」を返す。
 * 判定は決定論的で、何をもって一致としたかを `state` と `reason` に書く。
 */
import type { CsdbIndex } from '../csdb-index.js';
import type { CsdbObject } from '../csdb-source.js';
import { formatDmc, sameDmc } from '../dmc.js';
import { formatPmc, samePmc } from '../pmc.js';
import type { IssueInfo } from '../types.js';
import { formatDdnCode, formatDmlCode, parseDmlFileName, sameDmlCode } from './code.js';
import type { DdnDocument, DdnItem, DmlDocument, DmlEntry } from './types.js';

/**
 * - found: 対象が CSDB にある（発行情報まで指定されていればその版がある）
 * - issue-mismatch: 対象は CSDB にあるが、DML が指す版が無い（`foundIssueInfo` は CSDB にある最新の版）
 * - not-found: 対象が CSDB に無い
 * - not-checked: 照合の対象外（comment への参照）
 */
export type ReconcileState = 'found' | 'issue-mismatch' | 'not-found' | 'not-checked';

export interface DmlEntryResult {
  entry: DmlEntry;
  state: ReconcileState;
  /** 見つかったオブジェクトの識別子（CsdbObject.path） */
  path?: string;
  foundIssueInfo?: IssueInfo;
  reason?: string;
}

export interface NotListedObject {
  kind: 'dm' | 'pm';
  path: string;
  fileName: string;
  /** DMC または PMC */
  target: string;
}

export interface DmlReconciliation {
  dmlCode: string;
  entryCount: number;
  counts: Record<ReconcileState, number>;
  entries: DmlEntryResult[];
  /**
   * CSDB にあるのに DML に載っていない DM・PM。DML の行に出てくるモデル識別コード（または `modelIdentCodes`）の
   * ものだけを対象にし、言語は見ない（同じ DMC の言語違いは 1 つと数える）。`includeNotListed: false` なら空
   */
  notListed: NotListedObject[];
}

export interface ReconcileDmlOptions {
  /** 既定 true */
  includeNotListed?: boolean;
  /** `notListed` の対象にするモデル識別コード。省略時は DML の行から集める */
  modelIdentCodes?: string[];
}

const issueKey = (i: IssueInfo | undefined) => (i ? `${i.issueNumber}-${i.inWork}` : undefined);

function pickIssue<T>(
  found: T[],
  wanted: IssueInfo | undefined,
  issueOf: (o: T) => IssueInfo | undefined,
): { obj: T; mismatch: boolean } {
  if (wanted) {
    const exact = found.find((o) => issueKey(issueOf(o)) === issueKey(wanted));
    if (exact) return { obj: exact, mismatch: false };
    return { obj: found[0]!, mismatch: true };
  }
  return { obj: found[0]!, mismatch: false };
}

function emptyCounts(): Record<ReconcileState, number> {
  return { found: 0, 'issue-mismatch': 0, 'not-found': 0, 'not-checked': 0 };
}

function icnMatches(fileName: string, ident: string): boolean {
  const base = fileName.replace(/\.[^.]+$/, '').toUpperCase();
  const key = ident.toUpperCase().replace(/^ICN-/, '');
  return base === key || base === `ICN-${key}`;
}

export function reconcileDml(
  dml: DmlDocument,
  index: CsdbIndex,
  options: ReconcileDmlOptions = {},
): DmlReconciliation {
  const entries: DmlEntryResult[] = [];
  const counts = emptyCounts();
  const listedDm: CsdbObject[] = [];
  const listedPm: CsdbObject[] = [];
  const mics = new Set<string>(options.modelIdentCodes ?? []);

  for (const entry of dml.entries) {
    let result: DmlEntryResult;
    switch (entry.kind) {
      case 'dm': {
        const ref = entry.dmRef!;
        if (!options.modelIdentCodes) mics.add(ref.dmCode.modelIdentCode);
        const found = index.findDataModules(ref.dmCode);
        if (found.length === 0) {
          result = {
            entry,
            state: 'not-found',
            reason: `Data module ${entry.target} is not in the CSDB`,
          };
          break;
        }
        listedDm.push(...found);
        const { obj, mismatch } = pickIssue(found, ref.issueInfo, (o) => o.dm?.issueInfo);
        result = mismatch
          ? {
              entry,
              state: 'issue-mismatch',
              path: obj.path,
              foundIssueInfo: obj.dm?.issueInfo,
              reason: `The DML lists issue ${issueKey(ref.issueInfo)}; the CSDB has ${issueKey(obj.dm?.issueInfo) ?? 'no issue in the file name'}`,
            }
          : { entry, state: 'found', path: obj.path, foundIssueInfo: obj.dm?.issueInfo };
        break;
      }
      case 'pm': {
        const ref = entry.pmRef!;
        if (!options.modelIdentCodes) mics.add(ref.pmCode.modelIdentCode);
        const found = index.findPublicationModules(ref.pmCode);
        if (found.length === 0) {
          result = {
            entry,
            state: 'not-found',
            reason: `Publication module ${entry.target} is not in the CSDB`,
          };
          break;
        }
        listedPm.push(...found);
        const { obj, mismatch } = pickIssue(found, ref.issueInfo, (o) => o.pm?.issueInfo);
        result = mismatch
          ? {
              entry,
              state: 'issue-mismatch',
              path: obj.path,
              foundIssueInfo: obj.pm?.issueInfo,
              reason: `The DML lists issue ${issueKey(ref.issueInfo)}; the CSDB has ${issueKey(obj.pm?.issueInfo) ?? 'no issue in the file name'}`,
            }
          : { entry, state: 'found', path: obj.path, foundIssueInfo: obj.pm?.issueInfo };
        break;
      }
      case 'icn': {
        const found = index.objects.find(
          (o) => o.kind === 'icn' && icnMatches(o.fileName, entry.infoEntityIdent!),
        );
        result = found
          ? { entry, state: 'found', path: found.path }
          : {
              entry,
              state: 'not-found',
              reason: `No ICN file named ${entry.infoEntityIdent} in the CSDB`,
            };
        break;
      }
      case 'dml': {
        const ref = entry.dmlRef!;
        const found = index.objects.filter((o) => {
          if (o.kind !== 'dml') return false;
          const parsed = o.dml ? undefined : parseDmlFileName(o.fileName);
          const r = o.dml ?? (parsed?.ok ? parsed.value : undefined);
          return r !== undefined && sameDmlCode(r.dmlCode, ref.dmlCode);
        });
        result =
          found.length > 0
            ? { entry, state: 'found', path: found[0]!.path }
            : {
                entry,
                state: 'not-found',
                reason: `Data module list ${entry.target} is not in the CSDB`,
              };
        break;
      }
      default:
        result = {
          entry,
          state: 'not-checked',
          reason: 'comment references are not indexed by CsdbIndex',
        };
    }
    counts[result.state]++;
    entries.push(result);
  }

  const notListed: NotListedObject[] = [];
  if (options.includeNotListed !== false) {
    for (const o of index.objects) {
      if (o.kind === 'dm' && o.dm) {
        if (!mics.has(o.dm.dmCode.modelIdentCode)) continue;
        if (listedDm.some((l) => l.dm && sameDmc(l.dm.dmCode, o.dm!.dmCode))) continue;
        notListed.push({
          kind: 'dm',
          path: o.path,
          fileName: o.fileName,
          target: formatDmc(o.dm.dmCode),
        });
      } else if (o.kind === 'pm' && o.pm) {
        if (!mics.has(o.pm.pmCode.modelIdentCode)) continue;
        if (listedPm.some((l) => l.pm && samePmc(l.pm.pmCode, o.pm!.pmCode))) continue;
        notListed.push({
          kind: 'pm',
          path: o.path,
          fileName: o.fileName,
          target: formatPmc(o.pm.pmCode),
        });
      }
    }
  }

  return {
    dmlCode: formatDmlCode(dml.dmlCode),
    entryCount: dml.entries.length,
    counts,
    entries,
    notListed,
  };
}

export interface DdnItemResult {
  item: DdnItem;
  state: Exclude<ReconcileState, 'not-checked'>;
  path?: string;
  foundIssueInfo?: IssueInfo;
  reason?: string;
}

export interface DdnReconciliation {
  ddnCode: string;
  itemCount: number;
  counts: Record<ReconcileState, number>;
  items: DdnItemResult[];
}

/** ファイル名から発行情報の部分（`_NNN-NN`）を取り除く。版違いを探すときの比較に使う */
function withoutIssue(fileName: string): string {
  return fileName.replace(/_\d{3}-\d{2}(?=(_[A-Za-z]{2}-[A-Za-z]{2})?\.[^.]+$)/, '').toUpperCase();
}

function issueFromFileName(fileName: string): IssueInfo | undefined {
  const m = /_(\d{3})-(\d{2})(?:_[A-Za-z]{2}-[A-Za-z]{2})?\.[^.]+$/.exec(fileName);
  return m ? { issueNumber: m[1]!, inWork: m[2]! } : undefined;
}

/**
 * DDN の納入物の一覧（`dispatchFileName`）を CSDB のファイル名と照合する。
 * 同じ名前が無いとき、発行情報（`_NNN-NN`）だけ違う名前があれば `issue-mismatch` にする（DMC・PMC・IMF・DML に共通）
 */
export function reconcileDdn(ddn: DdnDocument, index: CsdbIndex): DdnReconciliation {
  const items: DdnItemResult[] = [];
  const counts = emptyCounts();
  for (const item of ddn.items) {
    const exact = index.findByFileName(item.fileName);
    let result: DdnItemResult;
    if (exact.length > 0) {
      result = { item, state: 'found', path: exact[0]!.path };
    } else {
      const key = withoutIssue(item.fileName);
      const candidates = index.objects.filter((o) => withoutIssue(o.fileName) === key);
      if (candidates.length > 0) {
        const c = candidates[0]!;
        const foundIssueInfo =
          c.dm?.issueInfo ?? c.pm?.issueInfo ?? c.dml?.issueInfo ?? issueFromFileName(c.fileName);
        result = {
          item,
          state: 'issue-mismatch',
          path: c.path,
          foundIssueInfo,
          reason: `No file named ${item.fileName}; the CSDB has ${c.fileName}`,
        };
      } else {
        result = { item, state: 'not-found', reason: `No file named ${item.fileName} in the CSDB` };
      }
    }
    counts[result.state]++;
    items.push(result);
  }
  return { ddnCode: formatDdnCode(ddn.ddnCode), itemCount: ddn.items.length, counts, items };
}
