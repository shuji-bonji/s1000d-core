/**
 * BREX 違反から修正候補を作る。
 *
 * - value: そのルールの objectValue（valueAllowed と説明文）をそのまま候補にする。range / pattern はその書き方のまま渡す
 * - forbidden: objectPath に述語が無ければ「この要素・属性を取り除く」。述語があれば（条件付きのルール）、
 *   条件を成り立たなくする変更を候補にする（brex-condition.ts）。決められなければ候補なし。objectUse を理由に添える
 * - missing: 「objectPath の指す要素・属性を足す」。objectValue があれば初期値の候補にする
 * - notation: 許可された NOTATION の一覧
 *
 * 違反の報告（BrexViolation）は許可値の文字列しか持たないので、説明文は BREX の層（BrexDocument）から
 * ルール ID と objectPath で引き直す。層が渡されなければ許可値の文字列だけで候補を作る。
 */
import { formatDmc, sameDmc } from '../dmc.js';
import type {
  BrexCheckReport,
  BrexDocument,
  BrexObjectValue,
  BrexStructureRule,
  BrexViolation,
} from '../brex/types.js';
import type { Document, XmlEngine } from '../xml/engine.js';
import { conditionCandidates, isConditionalPath } from './brex-condition.js';
import { confidenceOf, type Fix, type FixCandidate } from './types.js';
import type { XsdIndex } from './xsd-index.js';

export interface BrexFixOptions {
  /** 照合に使った BREX の層（resolveBrexChain の layers と extraLayers）。objectValue の説明文に使う */
  layers?: BrexDocument[];
  /**
   * 検証した文書と、その XPath の処理系。条件付きで禁止するルールの候補を、文書を変えて評価し直して決めるのに使う。
   * 無ければ、条件付きのルールは候補なし（none）になる
   */
  document?: Document;
  engine?: XmlEngine;
  /** 属性の列挙値と、要素を置ける親を調べる XSD の定義 */
  xsd?: XsdIndex;
}

const CONDITIONAL_NOTE =
  'The rule forbids this element only while the condition in its objectPath holds. Each candidate changes one place so that the condition no longer holds; changes to the identification of the object itself (its code, issueNumber, inWork) are not offered. Verify again after applying: another rule may then apply.';
const CONDITIONAL_NO_CANDIDATE_NOTE =
  'The rule forbids this element only while the condition in its objectPath holds, and no single change that ends the condition could be decided here. Removing the element is not offered, because the element itself is not what the rule forbids. Read the rule (problem) and ask the user what to change.';

function findRule(
  layer: BrexDocument | undefined,
  v: BrexViolation,
): BrexStructureRule | undefined {
  if (!layer || !v.objectPath) return undefined;
  for (const block of layer.contextRules) {
    for (const r of block.structureRules) {
      if (
        r.objectPath === v.objectPath &&
        r.ruleId === v.ruleId &&
        r.rulesContext === v.rulesContext
      )
        return r;
    }
  }
  return undefined;
}

function valueCandidates(
  values: BrexObjectValue[],
  action: 'replace' | 'add',
  target: string | undefined,
): FixCandidate[] {
  return values
    .filter((ov) => ov.valueAllowed !== undefined)
    .map((ov) => {
      const c: FixCandidate = {
        action,
        value: ov.valueAllowed,
        description: ov.description || 'a value allowed by the BREX rule',
      };
      if (ov.valueForm !== 'single') c.valueForm = ov.valueForm;
      if (target) c.target = target;
      return c;
    });
}

/** 違反の場所の最後の段（`@name` か要素名） */
function lastStep(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1]?.replace(/\[\d+\]$/, '');
}

export function suggestBrexFixes(report: BrexCheckReport, options: BrexFixOptions = {}): Fix[] {
  const fixes: Fix[] = [];
  for (const layerReport of report.layers) {
    const layer = options.layers?.find((l) => sameDmc(l.dmCode, layerReport.brex.dmCode));
    const brexName = formatDmc(layerReport.brex.dmCode);
    for (const v of layerReport.violations) {
      const source = `BREX ${brexName} rule ${v.ruleId ?? v.objectPath ?? '(no id)'}`;
      const base = {
        location: v.location,
        problem: v.objectUse,
        source,
      };
      const finish = (fix: Fix) => {
        if (v.brSeverityLevel) fix.brSeverityLevel = v.brSeverityLevel;
        fixes.push(fix);
      };
      const target = lastStep(v.location?.path);
      switch (v.kind) {
        case 'value': {
          const rule = findRule(layer, v);
          const cands = rule
            ? valueCandidates(rule.objectValues, 'replace', target)
            : (v.allowedValues ?? []).map((a) => ({
                action: 'replace' as const,
                value: a,
                target,
                description: 'a value allowed by the BREX rule',
              }));
          finish({
            kind: 'brex-value',
            ...base,
            problem: `${v.objectUse} (actual value: "${v.actualValue ?? ''}")`,
            candidates: cands,
            confidence: confidenceOf(cands),
            ...(rule
              ? {}
              : {
                  note: layer
                    ? 'The rule was not found in the given BREX layer; candidates have no descriptions.'
                    : 'The BREX layer was not given; candidates have no descriptions.',
                }),
          });
          break;
        }
        case 'forbidden': {
          const remove: FixCandidate = {
            action: 'remove',
            target,
            description: v.location
              ? `remove this ${target?.startsWith('@') ? 'attribute' : 'element'}: ${v.objectUse}`
              : `remove what the objectPath selects (${v.objectPath ?? ''}): ${v.objectUse}`,
          };
          // 述語のある objectPath: 禁じているのは要素ではなく条件。取り除く候補を exact にしない
          if (v.location?.path && isConditionalPath(v.objectPath)) {
            const derived =
              options.document && options.engine
                ? conditionCandidates(
                    { doc: options.document, engine: options.engine, xsd: options.xsd },
                    v.objectPath!,
                    v.location.path,
                  )
                : [];
            // 禁じているのは条件なので、要素を取り除く候補は出さない（identAndStatusSection や文書要素を
            // 取り除く、という選べない候補になる）。条件を直す変更を決められなければ、候補なしにして人に聞く
            const cands = derived;
            finish({
              kind: 'brex-forbidden',
              ...base,
              candidates: cands,
              confidence: cands.length === 0 ? 'none' : 'several',
              note: derived.length > 0 ? CONDITIONAL_NOTE : CONDITIONAL_NO_CANDIDATE_NOTE,
            });
            break;
          }
          finish({
            kind: 'brex-forbidden',
            ...base,
            candidates: [remove],
            // 場所が分からない（objectPath が真偽値の式）ときは、何を取り除くかを人が決める
            confidence: v.location ? 'exact' : 'several',
          });
          break;
        }
        case 'missing': {
          const rule = findRule(layer, v);
          let cands = rule ? valueCandidates(rule.objectValues, 'add', v.objectPath) : [];
          if (cands.length === 0) {
            cands = [
              {
                action: 'add',
                target: v.objectPath,
                description: `add the element or attribute selected by the objectPath: ${v.objectUse}`,
              },
            ];
          }
          finish({
            kind: 'brex-missing',
            ...base,
            candidates: cands,
            confidence: confidenceOf(cands),
          });
          break;
        }
        case 'notation': {
          const cands = (v.allowedValues ?? []).map((n) => ({
            action: 'replace' as const,
            value: n,
            target: `NOTATION ${v.actualValue ?? ''}`,
            description: `use an allowed notation (the NDATA of the ENTITY declarations and the graphic file format must change together)`,
          }));
          const fix: Fix = {
            kind: 'brex-notation',
            ...base,
            problem: v.objectUse,
            candidates: cands,
            confidence: confidenceOf(cands),
          };
          if (cands.length === 0)
            fix.note =
              'This BREX layer excludes the notation but does not list the allowed ones (other notations are not restricted by this layer), so no candidate can be given. Ask the user which format to use, and check the parent BREX layers and the project business rules.';
          finish(fix);
          break;
        }
      }
    }
  }
  return fixes;
}
