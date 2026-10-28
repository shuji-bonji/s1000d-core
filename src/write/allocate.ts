/**
 * 採番: DMC・ICN・PMC を `Allocation` の規則と台帳（ledger）から決める。
 *
 * 方針（design/writer-mcp.md「採番と識別・状態部: allocation」）:
 * - writer は状態を持たない。台帳は入力で受け取り、新しい台帳を返す（入力は書き換えない）。
 *   同じ sourceId・assetId には、台帳にある値をそのまま返し、再変換で番号が変わらないようにする
 * - DMC は 台帳 → `map` → `rules` の順に決める。情報コードの既定は持たない（DECISIONS D-27）
 * - 分解コードは、同じ SNS・情報コードの既存 DM（CsdbIndex と台帳）の次の番号にする
 * - ICN は Issue 7 の CAGE 書式 `ICN-<cageCode>-<連番 5 桁>-<版>-<機密区分>`。連番は CsdbIndex・台帳の使用済みも避ける
 * - 入力の誤り（情報コードの欠落、桁数の誤りなど）は `DraftInputError` を投げる。S1000D の準拠は判定しない
 */
import type { CsdbIndex } from '../csdb-index.js';
import { formatDmc, parseDmc } from '../dmc.js';
import { formatIcn, parseIcn, parseIcnFileName } from '../icn.js';
import { formatPmc, parsePmc } from '../pmc.js';
import type { DmCode, PmCode } from '../types.js';
import { DraftInputError } from './errors.js';
import type { Allocation, DraftDataModule } from './types.js';

export interface DmcAllocation {
  dmCode: DmCode;
  /** どこから決めたか */
  from: 'draft' | 'ledger' | 'map' | 'rules';
  /** この採番を加えた新しい台帳（入力の台帳は書き換えない） */
  ledger: Record<string, string>;
}

export interface IcnAllocation {
  /** `ICN-…` の文字列 */
  icn: string;
  /** given: assetId がすでに ICN だった / ledger: 台帳にあった / new: 新しく採番した */
  from: 'given' | 'ledger' | 'new';
  ledger: Record<string, string>;
  /** 次に使う連番（`Allocation.icn.next` に戻して使う） */
  next: number;
}

export interface PmcAllocation {
  pmCode: PmCode;
  from: 'draft' | 'ledger' | 'derived';
  ledger: Record<string, string>;
}

export interface AllocateIcnOptions {
  /** ICN の版（既定 '001'） */
  issueNumber?: string;
  /** ICN の機密区分（既定 '01'）。buildDataModule はデータモジュールの機密区分を渡す */
  securityClassification?: string;
}

const MAX_ICN_SEQUENCE = 99999;

/** 1 つの DMC を、台帳・索引で使用済みかを見る単位のキーにする */
const dmcKey = (d: DmCode) => formatDmc(d).toUpperCase();

/** 台帳から、パースできる DMC を集める（他の sourceId が使った番号を避けるため） */
function usedDmcs(allocation: Allocation, index: CsdbIndex | undefined): DmCode[] {
  const out: DmCode[] = [];
  for (const v of Object.values(allocation.ledger ?? {})) {
    const r = parseDmc(v);
    if (r.ok) out.push(r.value);
  }
  for (const o of index?.objects ?? []) if (o.dm) out.push(o.dm.dmCode);
  return out;
}

/**
 * DMC を決める。`ledger` に同じ sourceId があればそれを返す。無ければ `map` → `rules` の順。
 * `draft.dmCode` を指定していれば、それを使って台帳に記録する。
 *
 * @throws DraftInputError 台帳の値が DMC として読めない、`infoCodeByKind` が無い、できた DMC の桁数が合わない、
 *   分解コードを使い切った、固定の分解コードが他の sourceId と衝突した
 */
export function allocateDmc(
  sourceId: string,
  draft: Pick<DraftDataModule, 'kind' | 'dmCode'>,
  allocation: Allocation,
  index?: CsdbIndex,
): DmcAllocation {
  const ledger = { ...(allocation.ledger ?? {}) };

  if (draft.dmCode) {
    ledger[sourceId] = formatDmc(draft.dmCode);
    return { dmCode: draft.dmCode, from: 'draft', ledger };
  }

  const recorded = ledger[sourceId];
  if (recorded !== undefined) {
    const r = parseDmc(recorded);
    if (!r.ok) {
      throw new DraftInputError(
        `/allocation/ledger/${sourceId}`,
        `ledger value is not a DMC: ${r.error}`,
      );
    }
    return { dmCode: r.value, from: 'ledger', ledger };
  }

  const { rules } = allocation;
  const m = allocation.map?.[sourceId];
  const spec = rules.infoCodeByKind?.[draft.kind];
  const infoCode = m?.infoCode ?? spec?.infoCode;
  const infoCodeVariant = m?.infoCodeVariant ?? spec?.infoCodeVariant;
  if (infoCode === undefined || infoCodeVariant === undefined) {
    throw new DraftInputError(
      `/allocation/rules/infoCodeByKind/${draft.kind}`,
      `no info code for kind "${draft.kind}": add it to infoCodeByKind (there is no default; the meaning of an info code is decided by the project) or give infoCode and infoCodeVariant in map["${sourceId}"]`,
    );
  }

  const base = {
    modelIdentCode: m?.modelIdentCode ?? allocation.modelIdentCode,
    systemDiffCode: m?.systemDiffCode ?? allocation.systemDiffCode,
    systemCode: m?.systemCode ?? rules.sns.systemCode,
    subSystemCode: m?.subSystemCode ?? rules.sns.subSystemCode,
    subSubSystemCode: m?.subSubSystemCode ?? rules.sns.subSubSystemCode,
    assyCode: m?.assyCode ?? rules.sns.assyCode,
    disassyCodeVariant: m?.disassyCodeVariant ?? rules.disassyCodeVariant ?? 'A',
    infoCode,
    infoCodeVariant,
    itemLocationCode: m?.itemLocationCode ?? rules.itemLocationCode,
  };

  const used = usedDmcs({ ...allocation, ledger }, index);
  const fixed = m?.disassyCode ?? rules.disassyCode;
  let disassyCode: string;
  if (fixed !== undefined) {
    disassyCode = fixed;
  } else {
    // 同じ SNS・情報コードの既存 DM の分解コードの最大値の次
    let max = -1;
    for (const d of used) {
      if (
        d.modelIdentCode === base.modelIdentCode &&
        d.systemDiffCode === base.systemDiffCode &&
        d.systemCode === base.systemCode &&
        d.subSystemCode === base.subSystemCode &&
        d.subSubSystemCode === base.subSubSystemCode &&
        d.assyCode === base.assyCode &&
        d.infoCode === base.infoCode &&
        d.infoCodeVariant === base.infoCodeVariant &&
        /^\d{2}$/.test(d.disassyCode)
      ) {
        max = Math.max(max, Number(d.disassyCode));
      }
    }
    const next = max + 1;
    if (next > 99) {
      throw new DraftInputError(
        '/allocation/rules',
        'disassyCode is used up (00-99) for this SNS and info code: change the SNS or give disassyCode in map',
      );
    }
    disassyCode = String(next).padStart(2, '0');
  }

  const dmCode: DmCode = { ...base, disassyCode };
  const parsed = parseDmc(formatDmc(dmCode));
  if (!parsed.ok) {
    throw new DraftInputError('/allocation', `allocated DMC is not valid: ${parsed.error}`);
  }
  // 固定の分解コード、または map の指定が、他の sourceId と衝突していないか
  const key = dmcKey(dmCode);
  if (used.some((d) => dmcKey(d) === key)) {
    throw new DraftInputError(
      `/allocation/ledger/${sourceId}`,
      `DMC ${formatDmc(dmCode)} is already used by another data module (ledger or CSDB); give a different disassyCode`,
    );
  }
  ledger[sourceId] = formatDmc(dmCode);
  return { dmCode, from: m ? 'map' : 'rules', ledger };
}

/**
 * ICN を決める。assetId がすでに ICN ならそのまま、台帳にあればそれ、無ければ新しい連番で採番する。
 * 連番は `allocation.icn.next`、CsdbIndex の既存の ICN、台帳の使用済みの最大値の次の、最も大きいもの。
 *
 * @throws DraftInputError 台帳の値が ICN として読めない、連番を使い切った、できた ICN が読めない
 */
export function allocateIcn(
  assetId: string,
  allocation: Allocation,
  index?: CsdbIndex,
  options: AllocateIcnOptions = {},
): IcnAllocation {
  const ledger = { ...(allocation.ledger ?? {}) };
  const given = /^ICN-/i.test(assetId) ? parseIcn(assetId) : undefined;
  if (given?.ok) return { icn: assetId, from: 'given', ledger, next: allocation.icn.next };

  const recorded = ledger[assetId];
  if (recorded !== undefined) {
    const r = parseIcn(recorded);
    if (!r.ok) {
      throw new DraftInputError(
        `/allocation/ledger/${assetId}`,
        `ledger value is not an ICN: ${r.error}`,
      );
    }
    return { icn: recorded, from: 'ledger', ledger, next: allocation.icn.next };
  }

  const cage = allocation.icn.cageCode;
  let next = allocation.icn.next;
  const bump = (originator: string, unique: string) => {
    if (originator === cage && /^\d+$/.test(unique)) next = Math.max(next, Number(unique) + 1);
  };
  for (const v of Object.values(ledger)) {
    const r = parseIcn(v);
    if (r.ok && r.value.form === 'cage') bump(r.value.originatorCode, r.value.uniqueIdentifier);
  }
  for (const o of index?.objects ?? []) {
    if (o.kind !== 'icn') continue;
    const r = parseIcnFileName(o.fileName);
    if (r.ok && r.value.icn.form === 'cage') {
      bump(r.value.icn.originatorCode, r.value.icn.uniqueIdentifier);
    }
  }
  if (next > MAX_ICN_SEQUENCE) {
    throw new DraftInputError(
      '/allocation/icn/next',
      `ICN sequence is used up (max ${MAX_ICN_SEQUENCE}) for ${cage}`,
    );
  }
  const icn = formatIcn({
    form: 'cage',
    originatorCode: cage,
    uniqueIdentifier: String(next).padStart(5, '0'),
    issueNumber: options.issueNumber ?? '001',
    securityClassification: options.securityClassification ?? '01',
  });
  const check = parseIcn(icn);
  if (!check.ok) {
    throw new DraftInputError(
      '/allocation/icn/cageCode',
      `allocated ICN is not valid: ${check.error}`,
    );
  }
  ledger[assetId] = icn;
  return { icn, from: 'new', ledger, next: next + 1 };
}

/** 文字列から 5 文字の英数字を作る（FNV-1a。同じ入力には同じ値） */
function hash5(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 36 ** 5).toString(36).toUpperCase().padStart(5, '0');
}

/**
 * PMC を決める。台帳にあればそれ。無ければ modelIdentCode は allocation と同じ、pmIssuer は `icn.cageCode`、
 * pmVolume は '00'、pmNumber は sourceId から作る（英数字 5 文字ならそのまま、そうでなければ sourceId のハッシュ）。
 * 他の PM・台帳と衝突したら、別の値にずらす。
 *
 * @throws DraftInputError 台帳の値が PMC として読めない、できた PMC の桁数が合わない
 */
export function allocatePmc(
  sourceId: string,
  draft: Pick<DraftDataModule, 'pmCode'>,
  allocation: Allocation,
  index?: CsdbIndex,
): PmcAllocation {
  const ledger = { ...(allocation.ledger ?? {}) };
  if (draft.pmCode) {
    ledger[sourceId] = formatPmc(draft.pmCode);
    return { pmCode: draft.pmCode, from: 'draft', ledger };
  }
  const recorded = ledger[sourceId];
  if (recorded !== undefined) {
    const r = parsePmc(recorded);
    if (!r.ok) {
      throw new DraftInputError(
        `/allocation/ledger/${sourceId}`,
        `ledger value is not a PMC: ${r.error}`,
      );
    }
    return { pmCode: r.value, from: 'ledger', ledger };
  }

  const used = new Set<string>();
  for (const v of Object.values(ledger)) {
    const r = parsePmc(v);
    if (r.ok) used.add(formatPmc(r.value).toUpperCase());
  }
  for (const o of index?.objects ?? []) if (o.pm) used.add(formatPmc(o.pm.pmCode).toUpperCase());

  const normalized = sourceId.toUpperCase().replace(/[^A-Z0-9]/g, '');
  let pmNumber = normalized.length === 5 ? normalized : hash5(sourceId);
  const make = (n: string): PmCode => ({
    modelIdentCode: allocation.modelIdentCode,
    pmIssuer: allocation.icn.cageCode,
    pmNumber: n,
    pmVolume: '00',
  });
  for (let salt = 1; used.has(formatPmc(make(pmNumber)).toUpperCase()) && salt < 1000; salt++) {
    pmNumber = hash5(`${sourceId}#${salt}`);
  }
  const pmCode = make(pmNumber);
  const parsed = parsePmc(formatPmc(pmCode));
  if (!parsed.ok) {
    throw new DraftInputError('/allocation', `allocated PMC is not valid: ${parsed.error}`);
  }
  ledger[sourceId] = formatPmc(pmCode);
  return { pmCode: parsed.value, from: 'derived', ledger };
}
