/**
 * BREX 違反から修正候補を作る。
 *
 * - value: そのルールの objectValue（valueAllowed と説明文）をそのまま候補にする。range / pattern はその書き方のまま渡す
 * - forbidden: 「この要素・属性を取り除く」。objectUse を理由に添える
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
import { confidenceOf, type Fix, type FixCandidate } from './types.js';

export interface BrexFixOptions {
  /** 照合に使った BREX の層（resolveBrexChain の layers と extraLayers）。objectValue の説明文に使う */
  layers?: BrexDocument[];
}

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
          const cands: FixCandidate[] = [
            {
              action: 'remove',
              target,
              description: v.location
                ? `remove this ${target?.startsWith('@') ? 'attribute' : 'element'}: ${v.objectUse}`
                : `remove what the objectPath selects (${v.objectPath ?? ''}): ${v.objectUse}`,
            },
          ];
          finish({
            kind: 'brex-forbidden',
            ...base,
            candidates: cands,
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
              'The BREX layer allows no notation for this schema context, so no candidate can be given. If the layer only excludes some notations, the empty allowed set may not be what the project intends; ask the user.';
          finish(fix);
          break;
        }
      }
    }
  }
  return fixes;
}
