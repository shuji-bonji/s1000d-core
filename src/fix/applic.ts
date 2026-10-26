/**
 * 適用性の判定不能（undetermined）から修正候補を作る。
 *
 * 判定不能は文書の誤りではなく、判定に使う製品（product）の値が足りないことが多い。そこで候補は action: 'provide'
 * （製品の属性・条件に値を与える）にし、値は ACT の列挙・`valuePattern`、CCT の条件の種類の列挙、PCT の製品が割り当てている値から取る。
 * 足りない属性の分からない判定不能（適用性リポジトリに無い、など）は、ここでは扱わない（参照の修正提案が扱う）。
 */
import type { NodeLocation } from '../brex/types.js';
import { ApplicEvaluator } from '../applic/evaluate.js';
import type { Act, ApplicResult, ApplicStatement, Cct, Pct, Product } from '../applic/types.js';
import type { Element, XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import { describeLocation } from '../brex/check.js';
import { confidenceOf, type Fix, type FixCandidate } from './types.js';

export interface ApplicFinding {
  result: ApplicResult;
  /** 判定に使った applic 要素（無ければそれを参照した要素）の場所 */
  location?: NodeLocation;
}

export interface FindApplicOptions {
  repository?: Map<string, ApplicStatement>;
  engine?: XmlEngine;
}

/**
 * 文書の中で、製品の値が足りずに判定不能になった適用性を集める。
 * DM 全体の applic と、`@applicRefId` が指す applic（同じ id は 1 回だけ）を見る。
 */
export function findUndeterminedApplicability(
  xml: string,
  product: Product,
  options: FindApplicOptions = {},
): ApplicFinding[] {
  const engine = options.engine ?? defaultXmlEngine;
  const doc = engine.parse(xml).document;
  const evaluator = new ApplicEvaluator(doc, { engine, repository: options.repository });
  const out: ApplicFinding[] = [];
  const keep = (r: ApplicResult) =>
    r.state === 'undetermined' && (r.missingProperties?.length ?? 0) > 0;

  const dm = evaluator.dmLevel(product);
  if (keep(dm)) out.push({ result: dm, location: evaluator.dmLevelStatement?.location });

  const seen = new Set<string>();
  for (const n of engine.selectNodes('//*[@applicRefId]', doc)) {
    const el = n as Element;
    const id = el.getAttribute('applicRefId') ?? '';
    if (seen.has(id)) continue;
    seen.add(id);
    const r = evaluator.forRefId(id, product);
    if (!keep(r)) continue;
    const { statement } = evaluator.resolveRefId(id);
    out.push({ result: r, location: statement?.location ?? describeLocation(el) });
  }
  return out;
}

export interface ApplicFixOptions {
  act?: Act;
  cct?: Cct;
  pct?: Pct;
}

/** 属性・条件 1 つに与えられる値の候補（値 → 説明） */
function valuesFor(
  ident: string,
  options: ApplicFixOptions,
): { values: Map<string, string[]>; pattern?: string; label?: string } {
  const values = new Map<string, string[]>();
  const note = (v: string, why: string) => {
    const list = values.get(v);
    if (list) list.push(why);
    else values.set(v, [why]);
  };
  let pattern: string | undefined;
  let label: string | undefined;
  const attr = options.act?.productAttributes.find((a) => a.id === ident);
  if (attr) {
    label = attr.displayName ?? attr.name;
    for (const v of attr.enumerations) note(v, 'ACT enumeration');
    if (attr.enumerations.length === 0 && attr.valuePattern) pattern = attr.valuePattern;
  }
  const cond = options.cct?.conds.find((c) => c.id === ident);
  if (cond) {
    label ??= cond.name;
    const type = options.cct?.condTypes.find((t) => t.id === cond.condTypeRefId);
    for (const v of type?.enumerations ?? []) note(v, `CCT condition type ${type!.id}`);
  }
  for (const p of options.pct?.products ?? []) {
    for (const a of p.assigns) {
      if (a.propertyIdent === ident) note(a.value, `PCT product ${p.id ?? '(no id)'}`);
    }
  }
  return { values, pattern, label };
}

export function suggestApplicabilityFixes(
  findings: ApplicFinding[],
  options: ApplicFixOptions = {},
): Fix[] {
  const fixes: Fix[] = [];
  const sources = [options.act && 'ACT', options.cct && 'CCT', options.pct && 'PCT']
    .filter(Boolean)
    .join(', ');
  for (const f of findings) {
    const cands: FixCandidate[] = [];
    for (const ident of f.result.missingProperties ?? []) {
      const { values, pattern, label } = valuesFor(ident, options);
      const name = label ? `${ident} (${label})` : ident;
      for (const [v, whys] of values) {
        cands.push({
          action: 'provide',
          value: v,
          target: ident,
          description: `a value of ${name}: ${[...new Set(whys)].join('; ')}`,
        });
      }
      if (pattern)
        cands.push({
          action: 'provide',
          value: pattern,
          valueForm: 'pattern',
          target: ident,
          description: `a value of ${name} matching the ACT valuePattern`,
        });
    }
    const fix: Fix = {
      kind: 'applicability',
      location: f.location,
      problem: `applicability is undetermined${f.result.displayText ? ` for "${f.result.displayText}"` : ''}: ${f.result.reason ?? 'missing product values'}`,
      candidates: cands,
      confidence: confidenceOf(cands),
      source: sources || 'no ACT/CCT/PCT',
    };
    if (cands.length === 0)
      fix.note = sources
        ? 'The ACT/CCT/PCT do not list values for the missing properties; ask which product is meant.'
        : 'No ACT/CCT/PCT was available; ask which product is meant.';
    fixes.push(fix);
  }
  return fixes;
}
