/**
 * BREX の連鎖（プロジェクト → 組織 → … → 既定 BREX）をたどる。
 *
 * - 各データモジュールは brexDmRef で BREX を 1 つ参照する（Chap 4.10.2 Para 2.1）
 * - BREX は自分の brexDmRef で上位の BREX を参照する。既定 BREX は自分自身を参照し、連鎖の終端になる（Chap 4.10.3）
 * - 照合は各層に個別に行う（Chap 7.9）
 */
import { formatDmc, sameDmc } from '../dmc.js';
import { readBrexDmRefOf, readDataModuleInfo, readNonDmIdent } from '../data-module.js';
import type { DmRef } from '../types.js';
import type { XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import { checkAgainstBrexLayer } from './check.js';
import type { BrexCheckReport, BrexDocument } from './types.js';

/** DMC から BREX を探して返す。見つからなければ undefined。 */
export type BrexResolver = (
  ref: DmRef,
) => BrexDocument | undefined | Promise<BrexDocument | undefined>;

export interface BrexChain {
  /** 対象に近い層から順に並ぶ */
  layers: BrexDocument[];
  /** 見つからなかった参照 */
  unresolved: DmRef[];
}

const MAX_DEPTH = 16;

/**
 * 最初の参照から連鎖をたどる。
 * 自己参照（既定 BREX）、既に訪れた BREX（循環）、解決できない参照のいずれかで止まる。
 */
export async function resolveBrexChain(
  first: DmRef | undefined,
  resolve: BrexResolver,
): Promise<BrexChain> {
  const layers: BrexDocument[] = [];
  const unresolved: DmRef[] = [];
  const visited = new Set<string>();
  let ref = first;
  while (ref && layers.length < MAX_DEPTH) {
    const key = formatDmc(ref.dmCode);
    if (visited.has(key)) break; // 循環（参照の繰り返し）
    visited.add(key);
    const brex = await resolve(ref);
    if (!brex) {
      unresolved.push(ref);
      break;
    }
    // 解決器が返した BREX の DMC が参照と違っても（ファイル名と中身の不一致など）、同じ文書を 2 度は載せない
    if (layers.some((l) => sameDmc(l.dmCode, brex.dmCode))) break;
    layers.push(brex);
    const next = brex.brexDmRef;
    if (!next || sameDmc(next.dmCode, brex.dmCode) || sameDmc(next.dmCode, ref.dmCode)) break; // 終端
    ref = next;
  }
  return { layers, unresolved };
}

/**
 * 対象の brexDmRef から連鎖をたどり、すべての層に照合する。
 * 対象のルートは `dmodule`（dmStatus）・`pm`（pmStatus）・`comment`（commentStatus）のどれでもよい。
 * `extraLayers` を渡すと、対象が参照していない BREX にも照合できる（Chap 7.9 の注記）。
 */
export async function checkAgainstBrexChain(
  xml: string,
  resolve: BrexResolver,
  options: { extraLayers?: BrexDocument[]; engine?: XmlEngine } = {},
): Promise<BrexCheckReport> {
  const engine = options.engine ?? defaultXmlEngine;
  const info = readDataModuleInfo(xml, engine);
  const parsed = engine.parse(xml);
  const chain = await resolveBrexChain(readBrexDmRefOf(parsed.document, engine), resolve);
  const layers = [...chain.layers, ...(options.extraLayers ?? [])];
  const nonDm = readNonDmIdent(parsed.document, engine);
  const reports = layers.map((b) =>
    checkAgainstBrexLayer(parsed.document, b, info.schemaLocation, engine),
  );
  return {
    target: {
      dmCode: info.identAndStatus?.dmCode,
      ...(nonDm.pmCode ? { pmCode: nonDm.pmCode } : {}),
      ...(nonDm.commentCode ? { commentCode: nonDm.commentCode } : {}),
      schemaLocation: info.schemaLocation,
      schemaName: info.schemaName,
    },
    layers: reports,
    unresolved: chain.unresolved,
    passed:
      chain.unresolved.length === 0 &&
      reports.every((r) => r.violations.length === 0 && r.skipped.length === 0),
  };
}
