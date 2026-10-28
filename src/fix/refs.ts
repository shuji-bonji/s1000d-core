/**
 * 未解決の参照（と版の食い違い）から修正候補を作る。
 *
 * - dmRef が CSDB に無い: CSDB にある「情報コード（とそのバリアント）以外が同じ DMC」「システム差異コードだけ違う DMC」。
 *   モデル識別コード S1000D への参照は仕様書の章への参照で CSDB には無いので、候補を作らず説明だけを返す（CSDB を渡していなくても同じ。no-csdb より先に判定する）
 * - dmRef / pmRef の版が違う（解決はしたが issueMismatch）: CSDB にある版
 * - pmRef が CSDB に無い: 巻（pmVolume）だけ違う PMC
 * - ICN の ENTITY 宣言が無い: 実体名と同じ名前（拡張子を除く）のファイル
 * - ICN のファイルが無い: 拡張子だけ違うファイル（`.PNG` ↔ `.SVG`）、実体名と同じ名前のファイル
 * - internalRef / applicRefId の id が無い: 同じ文書の id から、接頭辞が同じもの・編集距離が小さいもの
 */
import type { CsdbIndex, CsdbObject } from '../csdb-index.js';
import { formatDmc } from '../dmc.js';
import { formatPmc } from '../pmc.js';
import type { CollectedReferences } from '../refs/collect.js';
import type { ReferenceReport } from '../refs/resolve.js';
import type { DmCode, IssueInfo } from '../types.js';
import { nearMatches } from './similar.js';
import { confidenceOf, type Fix, type FixCandidate } from './types.js';

export interface ReferenceFixOptions {
  csdb?: CsdbIndex;
  /** 対象文書から集めた参照（id の集合を使う）。無ければ internalRef / applicRefId の候補は作らない */
  collected?: CollectedReferences;
  /** 1 つの参照に付ける候補の上限（既定 10） */
  maxCandidates?: number;
}

const DMC_PARTS: Array<keyof DmCode> = [
  'modelIdentCode',
  'systemDiffCode',
  'systemCode',
  'subSystemCode',
  'subSubSystemCode',
  'assyCode',
  'disassyCode',
  'disassyCodeVariant',
  'infoCode',
  'infoCodeVariant',
  'itemLocationCode',
  'learnCode',
  'learnEventCode',
];

/** 2 つの DMC で値の違う構成要素 */
function differingParts(a: DmCode, b: DmCode): Array<keyof DmCode> {
  return DMC_PARTS.filter((k) => (a[k] ?? '') !== (b[k] ?? ''));
}

const issueText = (i: IssueInfo | undefined) => (i ? `${i.issueNumber}-${i.inWork}` : '(none)');

/** CSDB の DM を DMC ごとに 1 つ（最初に見つかったもの）にまとめる */
function distinctDms(objects: CsdbObject[]): CsdbObject[] {
  const seen = new Map<string, CsdbObject>();
  for (const o of objects) {
    if (!o.dm) continue;
    const key = formatDmc(o.dm.dmCode);
    if (!seen.has(key)) seen.set(key, o);
  }
  return [...seen.values()];
}

const stem = (file: string) => file.replace(/\.[^.]+$/, '');
const ext = (file: string) => (/\.([^.]+)$/.exec(file)?.[1] ?? '').toUpperCase();

export function suggestReferenceFixes(
  report: ReferenceReport,
  options: ReferenceFixOptions = {},
): Fix[] {
  const max = options.maxCandidates ?? 10;
  const { csdb, collected } = options;
  const fixes: Fix[] = [];
  const add = (fix: Omit<Fix, 'confidence' | 'kind'> & { confidence?: Fix['confidence'] }) => {
    fixes.push({
      kind: 'reference',
      ...fix,
      confidence: fix.confidence ?? confidenceOf(fix.candidates),
    });
  };

  for (const u of report.unresolved) {
    const r = u.reference;
    const base = { location: r.location, problem: u.message };
    // モデル識別コード S1000D の dmRef は仕様書の章への参照で、CSDB の有無にかかわらず CSDB には無い。
    // CSDB を渡していなくても「CSDB を渡せ」とは言わない
    if (r.kind === 'dmRef' && r.ref.dmCode.modelIdentCode.toUpperCase() === 'S1000D') {
      add({
        ...base,
        candidates: [],
        confidence: 'none',
        source: 'modelIdentCode S1000D',
        note: 'This dmRef points to a chapter of the S1000D specification (modelIdentCode "S1000D"). It is never in a project CSDB and is not an error.',
      });
      continue;
    }
    if (u.reason === 'no-csdb') {
      add({
        ...base,
        candidates: [],
        source: 'CsdbIndex',
        note: 'No CSDB folders were given, so the target could not be searched. Give the CSDB folders and check again.',
      });
      continue;
    }
    switch (r.kind) {
      case 'dmRef': {
        const wanted = r.ref.dmCode;
        const ranked: Array<{ rank: number; c: FixCandidate }> = [];
        if (csdb) {
          for (const o of distinctDms(csdb.objects)) {
            const diff = differingParts(wanted, o.dm!.dmCode);
            let why: string | undefined;
            // 近さの順: 情報コードのバリアントだけ・システム差異コードだけの違い（0）→ 情報コードの違い（1）
            let rank = 1;
            if (diff.length > 0 && diff.every((k) => k === 'infoCode' || k === 'infoCodeVariant')) {
              why = `same DMC except the information code (${o.dm!.dmCode.infoCode}${o.dm!.dmCode.infoCodeVariant})`;
              if (!diff.includes('infoCode')) rank = 0;
            } else if (diff.length === 1 && diff[0] === 'systemDiffCode') {
              why = `same DMC except the system difference code (${o.dm!.dmCode.systemDiffCode})`;
              rank = 0;
            }
            if (why)
              ranked.push({
                rank,
                c: {
                  action: 'retarget',
                  value: formatDmc(o.dm!.dmCode),
                  target: 'dmRefIdent/dmCode',
                  description: `${why}; file ${o.fileName}`,
                },
              });
          }
        }
        ranked.sort((a, b) => a.rank - b.rank || a.c.value!.localeCompare(b.c.value!));
        const cands = ranked.map((x) => x.c);
        add({
          ...base,
          candidates: cands.slice(0, max),
          source: 'CsdbIndex',
          note:
            cands.length === 0 ? 'No similar data module code was found in the CSDB.' : undefined,
        });
        break;
      }
      case 'pmRef': {
        const cands: FixCandidate[] = [];
        if (csdb) {
          const seen = new Set<string>();
          for (const o of csdb.objects) {
            if (!o.pm) continue;
            const p = o.pm.pmCode;
            const w = r.pmCode;
            const key = formatPmc(p);
            if (seen.has(key)) continue;
            if (
              p.modelIdentCode === w.modelIdentCode &&
              p.pmIssuer === w.pmIssuer &&
              p.pmNumber === w.pmNumber &&
              p.pmVolume !== w.pmVolume
            ) {
              seen.add(key);
              cands.push({
                action: 'retarget',
                value: key,
                target: 'pmRefIdent/pmCode',
                description: `same PMC except the volume (${p.pmVolume}); file ${o.fileName}`,
              });
            }
          }
        }
        add({
          ...base,
          candidates: cands.slice(0, max),
          source: 'CsdbIndex',
          note:
            cands.length === 0
              ? 'No similar publication module code was found in the CSDB.'
              : undefined,
        });
        break;
      }
      case 'icn': {
        const icnFiles = csdb ? csdb.objects.filter((o) => o.kind === 'icn') : [];
        const sameName = icnFiles.filter(
          (o) => stem(o.fileName).toLowerCase() === r.entityName.toLowerCase(),
        );
        if (u.reason === 'no-entity-declaration') {
          const cands = sameName.slice(0, max).map((o) => ({
            action: 'add' as const,
            value: o.fileName,
            target: `<!ENTITY ${r.entityName} SYSTEM "…" NDATA …>`,
            description: `declare the entity in the DOCTYPE with this file as its SYSTEM identifier and the NOTATION of its format (${ext(o.fileName)})`,
          }));
          add({
            ...base,
            candidates: cands,
            source: 'CsdbIndex and DOCTYPE',
            note:
              cands.length === 0
                ? 'No ICN file with the entity name was found in the CSDB.'
                : undefined,
          });
          break;
        }
        // file-not-found
        const declared = r.declaration?.systemId ?? '';
        const byStem = icnFiles.filter(
          (o) => stem(o.fileName).toLowerCase() === stem(declared).toLowerCase(),
        );
        const pool = [...byStem, ...sameName.filter((o) => !byStem.includes(o))];
        const cands = pool.slice(0, max).map((o) => {
          const changesFormat = ext(o.fileName) !== ext(declared);
          return {
            action: 'replace' as const,
            value: o.fileName,
            target: `SYSTEM identifier of <!ENTITY ${r.entityName}>`,
            description: changesFormat
              ? `a file with the same name but extension ${ext(o.fileName)}; the NDATA notation (${r.declaration?.notation ?? 'unknown'}) must be changed to match`
              : 'a file with the same name',
          };
        });
        add({
          ...base,
          candidates: cands,
          source: 'CsdbIndex and DOCTYPE',
          note:
            cands.length === 0
              ? 'No ICN file with a similar name was found in the CSDB.'
              : undefined,
        });
        break;
      }
      case 'internalRef':
      case 'applicRef': {
        if (!collected) {
          add({
            ...base,
            candidates: [],
            source: 'ids in this document',
            note: 'The document was not given, so ids could not be compared.',
          });
          break;
        }
        const wanted = r.kind === 'internalRef' ? r.targetId : r.applicRefId;
        const pool =
          r.kind === 'internalRef'
            ? collected.ids
            : new Set([...collected.applicIds, ...collected.applicRefIds.keys()]);
        const near = nearMatches(wanted, pool, max);
        const attr = r.kind === 'internalRef' ? '@internalRefId' : '@applicRefId';
        const cands = near.map((n) => ({
          action: 'retarget' as const,
          value: n.value,
          target: attr,
          description:
            n.why === 'case'
              ? 'an id that differs only in letter case'
              : n.why === 'same-prefix'
                ? 'an id with the same prefix'
                : `an id with edit distance ${n.distance}`,
        }));
        add({
          ...base,
          candidates: cands,
          source: r.kind === 'internalRef' ? 'ids in this document' : 'applic ids in this document',
          note: cands.length === 0 ? 'No similar id was found in this document.' : undefined,
        });
        break;
      }
    }
  }

  for (const res of report.resolved) {
    if (!res.issueMismatch || !res.foundIssueInfo) continue;
    const r = res.reference;
    if (r.kind !== 'dmRef' && r.kind !== 'pmRef') continue;
    const wanted = r.kind === 'dmRef' ? r.ref.issueInfo : r.issueInfo;
    const fromBrex = res.source === 'brex-chain';
    const where = fromBrex ? 'the BREX layers' : 'the CSDB';
    add({
      location: r.location,
      problem: `${res.target}: issue ${issueText(wanted)} is not in ${where}; issue ${issueText(res.foundIssueInfo)} was found`,
      candidates: [
        {
          action: 'replace',
          value: issueText(res.foundIssueInfo),
          target: `${r.kind === 'dmRef' ? 'dmRefIdent' : 'pmRefIdent'}/issueInfo`,
          description: fromBrex
            ? 'the issue of the BREX layer that was followed; set issueNumber and inWork accordingly'
            : `the issue found in the CSDB (${res.path ?? ''}); set issueNumber and inWork accordingly`,
        },
      ],
      source: fromBrex ? 'BREX chain' : 'CsdbIndex',
    });
  }

  // 未定義の note を消す
  for (const f of fixes) if (f.note === undefined) delete f.note;
  return fixes;
}
