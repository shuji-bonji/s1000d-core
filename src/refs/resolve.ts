/**
 * 集めた参照の参照先があるかを確かめる。
 *
 * - dmRef / pmRef: CSDB の索引（CsdbIndex）から探す。issueInfo 付きの参照で版が違えば、見つかった版を添えて `issueMismatch: true`
 * - icn: `@infoEntityIdent` → DOCTYPE の ENTITY 宣言 → 宣言の SYSTEM のファイル名を CSDB から探す。宣言が無ければ理由 `no-entity-declaration`
 * - internalRef / applicRef: 同じ文書の `@id` / `applic/@id` にあるか
 *
 * 適用性の評価（この製品に当てはまるか）はここでは行わない（reader、段階 2 の作業 4）。
 */
import type { CsdbIndex, CsdbObject } from '../csdb-index.js';
import { formatDmc } from '../dmc.js';
import { formatPmc } from '../pmc.js';
import type { IssueInfo } from '../types.js';
import type { CollectedReferences, Reference } from './collect.js';

export type UnresolvedReason =
  /** CSDB に無い */
  | 'not-found'
  /** 実体名に対する ENTITY 宣言が DOCTYPE に無い */
  | 'no-entity-declaration'
  /** ENTITY 宣言はあるが SYSTEM のファイルが CSDB に無い */
  | 'file-not-found'
  /** 同じ文書に id が無い */
  | 'no-such-id'
  /** CSDB の索引が渡されていない */
  | 'no-csdb';

export interface ResolvedReference {
  reference: Reference;
  /** 人が読む参照先（DMC・PMC・実体名・id） */
  target: string;
  /** 見つかったファイル（dmRef / pmRef / icn） */
  path?: string;
  /** 見つかったファイルの発行情報（dmRef / pmRef） */
  foundIssueInfo?: IssueInfo;
  /** 参照の issueInfo と見つかった版が違う */
  issueMismatch?: boolean;
  /** ICN の NOTATION（宣言の NDATA） */
  notation?: string;
  /** applicRef が `referencedApplicGroupRef/applicRef` を指すとき、その `@applicIdentValue`（文書外の適用性文。中身はここでは確かめない） */
  externalApplic?: string;
}

export interface UnresolvedReference {
  reference: Reference;
  target: string;
  reason: UnresolvedReason;
  message: string;
}

export interface ReferenceReport {
  checked: number;
  resolved: ResolvedReference[];
  unresolved: UnresolvedReference[];
  /** 種類ごとの件数 */
  counts: Record<Reference['kind'], { checked: number; unresolved: number }>;
}

export interface ResolveOptions {
  /** 無ければ dmRef / pmRef / icn は `no-csdb` になる（internalRef / applicRef は文書内で判定できる） */
  csdb?: CsdbIndex;
}

function targetOf(r: Reference): string {
  switch (r.kind) {
    case 'dmRef':
      return formatDmc(r.ref.dmCode);
    case 'pmRef':
      return formatPmc(r.pmCode);
    case 'icn':
      return r.entityName;
    case 'internalRef':
      return r.targetId;
    case 'applicRef':
      return r.applicRefId;
  }
}

function sameIssue(a: IssueInfo | undefined, b: IssueInfo | undefined): boolean {
  if (!a || !b) return true;
  return a.issueNumber === b.issueNumber && a.inWork === b.inWork;
}

function pickByIssue(
  found: CsdbObject[],
  wanted: IssueInfo | undefined,
  info: (o: CsdbObject) => IssueInfo | undefined,
) {
  if (wanted) {
    const exact = found.find((o) => sameIssue(info(o), wanted) && info(o) !== undefined);
    if (exact) return { obj: exact, mismatch: false };
  }
  return { obj: found[0], mismatch: wanted !== undefined };
}

export function resolveReferences(
  collected: CollectedReferences,
  options: ResolveOptions = {},
): ReferenceReport {
  const resolved: ResolvedReference[] = [];
  const unresolved: UnresolvedReference[] = [];
  const counts: ReferenceReport['counts'] = {
    dmRef: { checked: 0, unresolved: 0 },
    pmRef: { checked: 0, unresolved: 0 },
    icn: { checked: 0, unresolved: 0 },
    internalRef: { checked: 0, unresolved: 0 },
    applicRef: { checked: 0, unresolved: 0 },
  };
  const miss = (reference: Reference, reason: UnresolvedReason, message: string) => {
    counts[reference.kind].unresolved++;
    unresolved.push({ reference, target: targetOf(reference), reason, message });
  };

  for (const r of collected.references) {
    counts[r.kind].checked++;
    const target = targetOf(r);
    switch (r.kind) {
      case 'dmRef': {
        if (!options.csdb) {
          miss(r, 'no-csdb', 'No CSDB folders were given to search');
          break;
        }
        const found = options.csdb.findDataModules(r.ref.dmCode);
        if (found.length === 0) {
          miss(r, 'not-found', `Data module ${target} is not in the CSDB`);
          break;
        }
        const { obj, mismatch } = pickByIssue(found, r.ref.issueInfo, (o) => o.dm?.issueInfo);
        const out: ResolvedReference = {
          reference: r,
          target,
          path: obj.path,
          foundIssueInfo: obj.dm?.issueInfo,
        };
        if (mismatch) out.issueMismatch = true;
        resolved.push(out);
        break;
      }
      case 'pmRef': {
        if (!options.csdb) {
          miss(r, 'no-csdb', 'No CSDB folders were given to search');
          break;
        }
        const found = options.csdb.findPublicationModules(r.pmCode);
        if (found.length === 0) {
          miss(r, 'not-found', `Publication module ${target} is not in the CSDB`);
          break;
        }
        const { obj, mismatch } = pickByIssue(found, r.issueInfo, (o) => o.pm?.issueInfo);
        const out: ResolvedReference = {
          reference: r,
          target,
          path: obj.path,
          foundIssueInfo: obj.pm?.issueInfo,
        };
        if (mismatch) out.issueMismatch = true;
        resolved.push(out);
        break;
      }
      case 'icn': {
        if (!r.declaration) {
          miss(r, 'no-entity-declaration', `No <!ENTITY ${target} …> declaration in the DOCTYPE`);
          break;
        }
        if (!options.csdb) {
          miss(r, 'no-csdb', 'No CSDB folders were given to search');
          break;
        }
        const file = r.declaration.systemId;
        const found = file ? options.csdb.findByFileName(file) : [];
        if (found.length === 0) {
          miss(
            r,
            'file-not-found',
            `File ${file ?? '(no SYSTEM identifier)'} declared for ${target} is not in the CSDB`,
          );
          break;
        }
        resolved.push({
          reference: r,
          target,
          path: found[0].path,
          notation: r.declaration.notation,
        });
        break;
      }
      case 'internalRef': {
        if (collected.ids.has(r.targetId)) resolved.push({ reference: r, target });
        else miss(r, 'no-such-id', `No element with id="${target}" in this document`);
        break;
      }
      case 'applicRef': {
        if (collected.applicIds.has(r.applicRefId)) {
          resolved.push({ reference: r, target });
        } else if (collected.applicRefIds.has(r.applicRefId)) {
          resolved.push({
            reference: r,
            target,
            externalApplic: collected.applicRefIds.get(r.applicRefId),
          });
        } else {
          miss(
            r,
            'no-such-id',
            `No <applic id="${target}"> or <applicRef id="${target}"> in this document`,
          );
        }
        break;
      }
    }
  }

  return { checked: collected.references.length, resolved, unresolved, counts };
}
