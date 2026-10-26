/**
 * `verifyDataModule` の結果から修正提案をまとめて作る。
 *
 * 順番は XSD → BREX → 参照 → 適用性。XSD の違反は BREX の違反の原因になることがあるので先に並べる。
 * 候補はすべてここ（core）で決定論的に決め、LLM は候補の中から選んで説明するだけにする（design/agent-platform.md、D-18・D-19）。
 */
import { basename } from 'node:path';
import type { BrexDocument } from '../brex/types.js';
import type { CsdbIndex } from '../csdb-index.js';
import { collectReferences, type CollectedReferences } from '../refs/collect.js';
import type { VerifyResult } from '../verify/verify.js';
import type { XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import { suggestApplicabilityFixes, type ApplicFinding, type ApplicFixOptions } from './applic.js';
import { suggestBrexFixes } from './brex.js';
import { suggestReferenceFixes } from './refs.js';
import { suggestSchemaFixes } from './schema.js';
import type { Fix } from './types.js';
import { loadXsdIndex, type XsdIndex } from './xsd-index.js';

export interface SuggestFixesOptions {
  /** 検証した文書。internalRef / applicRefId の候補（文書内の id）に使う */
  xml?: string;
  /** 参照の候補を探す CSDB の索引 */
  csdb?: CsdbIndex;
  /** 照合に使った BREX の層（resolveBrexChain の layers）。BREX の objectValue の説明文に使う */
  brexLayers?: BrexDocument[];
  /**
   * XSD の定義。省略すると `result.schema.xsdPath` から読む。false なら読まず、libxml2 の文章にある候補だけにする
   */
  xsd?: XsdIndex | false;
  /** 適用性の判定不能（findUndeterminedApplicability の結果）と、ACT・CCT・PCT */
  applicability?: ApplicFixOptions & { findings: ApplicFinding[] };
  /** 参照 1 つに付ける候補の上限（既定 10） */
  maxReferenceCandidates?: number;
  engine?: XmlEngine;
}

export function suggestFixes(result: VerifyResult, options: SuggestFixesOptions = {}): Fix[] {
  const engine = options.engine ?? defaultXmlEngine;
  const fixes: Fix[] = [];

  if (result.schema.errors.length > 0) {
    const xsd =
      options.xsd === false
        ? undefined
        : (options.xsd ??
          (result.schema.xsdPath ? loadXsdIndex(result.schema.xsdPath, engine) : undefined));
    fixes.push(
      ...suggestSchemaFixes(result.schema.errors, {
        xsd,
        xsdName: result.schema.xsdPath ? basename(result.schema.xsdPath) : undefined,
      }),
    );
  }

  if (result.brex) fixes.push(...suggestBrexFixes(result.brex, { layers: options.brexLayers }));

  if (result.references) {
    let collected: CollectedReferences | undefined;
    if (options.xml !== undefined) {
      try {
        collected = collectReferences(engine.parse(options.xml).document, engine);
      } catch {
        collected = undefined;
      }
    }
    fixes.push(
      ...suggestReferenceFixes(result.references, {
        csdb: options.csdb,
        collected,
        maxCandidates: options.maxReferenceCandidates,
      }),
    );
  }

  if (options.applicability) {
    const { findings, ...tables } = options.applicability;
    fixes.push(...suggestApplicabilityFixes(findings, tables));
  }
  return fixes;
}
