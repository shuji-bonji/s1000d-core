/**
 * 対象 DM の ACT・CCT・PCT を CSDB から探す。
 *
 * 識別・状態部の applicCrossRefTableRef から ACT を探し、ACT の参照から CCT・PCT を探す。
 * ACT の参照が無いときは、同じモデル識別コードの ACT（情報コード 00W）を CSDB から探す。
 * s1000d-reader-mcp の services/context.ts にあった処理を、verify-mcp の suggest_fixes と共有するために移した。
 */
import type { CsdbIndex } from '../csdb-index.js';
import { readDataModuleInfo, readDmCodeElement } from '../data-module.js';
import { formatDmc } from '../dmc.js';
import type { DmCode, DmRef } from '../types.js';
import type { Element, XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import { readAct, readCct, readPct } from './read.js';
import type { Act, Cct, Pct } from './types.js';

export interface ApplicTables {
  act?: { path: string; act: Act };
  cct?: { path: string; cct: Cct };
  pct?: { path: string; pct: Pct };
  /** 見つからなかった表と理由 */
  missing: string[];
}

function readDm(index: CsdbIndex, dmCode: DmCode): { path: string; xml: string } | undefined {
  const found = index.findDataModules(dmCode)[0];
  if (!found) return undefined;
  return { path: found.path, xml: index.read(found) };
}

export function findApplicTables(
  dmXml: string,
  index: CsdbIndex | undefined,
  engine: XmlEngine = defaultXmlEngine,
): ApplicTables {
  const out: ApplicTables = { missing: [] };
  if (!index) {
    out.missing.push('no CSDB folders (ACT/CCT/PCT cannot be searched)');
    return out;
  }
  const doc = engine.parse(dmXml).document;
  const info = readDataModuleInfo(dmXml, engine);
  let actRef: DmRef | undefined;
  const refEl = engine.selectNodes('//applicCrossRefTableRef/dmRef/dmRefIdent/dmCode', doc)[0];
  if (refEl) {
    const r = readDmCodeElement(refEl as Element);
    if (r.ok) actRef = { dmCode: r.value };
  }
  if (!actRef && info.identAndStatus) {
    const own = info.identAndStatus.dmCode;
    const cand = index.objects.find(
      (o) =>
        o.dm && o.dm.dmCode.modelIdentCode === own.modelIdentCode && o.dm.dmCode.infoCode === '00W',
    );
    if (cand?.dm) actRef = { dmCode: cand.dm.dmCode };
  }
  if (!actRef) {
    out.missing.push(
      'the data module has no applicCrossRefTableRef and no ACT (infoCode 00W) with the same modelIdentCode was found',
    );
    return out;
  }
  const actFile = readDm(index, actRef.dmCode);
  if (!actFile) {
    out.missing.push(`ACT ${formatDmc(actRef.dmCode)} is not in the CSDB`);
    return out;
  }
  const act = readAct(engine.parse(actFile.xml).document, engine);
  if (!act) {
    out.missing.push(`${actFile.path} is not an applicCrossRefTable`);
    return out;
  }
  out.act = { path: actFile.path, act };
  if (act.condCrossRefTableRef) {
    const f = readDm(index, act.condCrossRefTableRef.dmCode);
    const cct = f ? readCct(engine.parse(f.xml).document, engine) : undefined;
    if (f && cct) out.cct = { path: f.path, cct };
    else out.missing.push(`CCT ${formatDmc(act.condCrossRefTableRef.dmCode)} is not in the CSDB`);
  }
  if (act.productCrossRefTableRef) {
    const f = readDm(index, act.productCrossRefTableRef.dmCode);
    const pct = f ? readPct(engine.parse(f.xml).document, engine) : undefined;
    if (f && pct) out.pct = { path: f.path, pct };
    else
      out.missing.push(`PCT ${formatDmc(act.productCrossRefTableRef.dmCode)} is not in the CSDB`);
  }
  return out;
}
