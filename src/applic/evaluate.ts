/**
 * 適用性の評価。reader-mcp と writer が共有する（design/reader-mcp.md「適用性の判定」、D-18）。
 *
 * 判定は 3 値（applicable / notApplicable / undetermined）。LLM に assert の中身を渡さず、ここで判定を済ませる。
 *
 * - assert: product の該当する値が `applicPropertyValues`（単一値・`|` 区切り・`a~b` の範囲）に合えば applicable。
 *   product にその属性・条件が無ければ undetermined
 * - evaluate and: 1 つでも notApplicable なら notApplicable、無ければ 1 つでも undetermined なら undetermined、それ以外 applicable
 * - evaluate or: 1 つでも applicable なら applicable、無ければ 1 つでも undetermined なら undetermined、それ以外 notApplicable
 * - 式の無い applic（displayText だけ）は applicable
 *
 * 値の比較は文字列の完全一致。大文字小文字は区別する（ACT の enumeration と PCT の値が食い違う例が Bike Samples にあり、
 * それは配布物側の不整合として見えるようにする）。
 */
import { matchesRange } from '../brex/values.js';
import type { Document, Element, XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import { readApplicStatements } from './read.js';
import type { ApplicExpr, ApplicResult, ApplicState, ApplicStatement, Product } from './types.js';

interface ExprResult {
  state: ApplicState;
  missing: string[];
}

function lookup(product: Product, propertyType: string, ident: string): string | undefined {
  if (propertyType === 'condition') return product.conditions[ident];
  if (propertyType === 'prodattr') return product.attributes[ident];
  // 種類が不明なら両方を見る
  return product.attributes[ident] ?? product.conditions[ident];
}

export function evaluateExpr(expr: ApplicExpr, product: Product): ExprResult {
  if (expr.kind === 'assert') {
    const value = lookup(product, expr.propertyType, expr.propertyIdent);
    if (value === undefined) return { state: 'undetermined', missing: [expr.propertyIdent] };
    return {
      state: matchesRange(value, expr.values) ? 'applicable' : 'notApplicable',
      missing: [],
    };
  }
  if (expr.children.length === 0) return { state: 'undetermined', missing: [] };
  const results = expr.children.map((c) => evaluateExpr(c, product));
  const missing = results.flatMap((r) => r.missing);
  const has = (s: ApplicState) => results.some((r) => r.state === s);
  // missing には、判定が undetermined になる原因になった属性だけを残す（結論が出た枝の不足は報告しない）
  if (expr.andOr === 'and') {
    if (has('notApplicable')) return { state: 'notApplicable', missing: [] };
    if (has('undetermined')) return { state: 'undetermined', missing };
    return { state: 'applicable', missing: [] };
  }
  if (has('applicable')) return { state: 'applicable', missing: [] };
  if (has('undetermined')) return { state: 'undetermined', missing };
  return { state: 'notApplicable', missing: [] };
}

/** applic 1 つを製品に対して判定する */
export function evaluateApplic(
  statement: ApplicStatement,
  product: Product | undefined,
): ApplicResult {
  const base: ApplicResult = {
    state: 'undetermined',
    displayText: statement.displayText,
    applicId: statement.id,
  };
  if (!statement.expr)
    return { ...base, state: 'applicable', reason: 'no expression (display text only)' };
  if (!product) return { ...base, reason: 'product not given' };
  const r = evaluateExpr(statement.expr, product);
  const out: ApplicResult = { ...base, state: r.state };
  if (r.missing.length > 0) {
    out.missingProperties = [...new Set(r.missing)];
    if (r.state === 'undetermined')
      out.reason = `product has no value for: ${out.missingProperties.join(', ')}`;
  }
  return out;
}

export interface ApplicEvaluatorOptions {
  engine?: XmlEngine;
  /**
   * 適用性リポジトリ（`referencedApplicGroupRef/applicRef/@applicIdentValue` が指す先）。
   * `applicIdentValue` → applic。別の DM の `readApplicStatements` の結果から作る
   */
  repository?: Map<string, ApplicStatement>;
}

/**
 * 1 つのデータモジュールの適用性をまとめて判定するための評価器。
 *
 * - `dmLevel()`: 識別・状態部の applic（DM 全体）
 * - `forRefId(id)`: 要素の `@applicRefId` が指す applic。同じ文書の `applic/@id`、無ければ
 *   `referencedApplicGroupRef/applicRef/@id` → `@applicIdentValue` → リポジトリ
 */
export class ApplicEvaluator {
  readonly statements: ApplicStatement[];
  private readonly byId = new Map<string, ApplicStatement>();
  private readonly refIdToIdentValue = new Map<string, string>();
  private readonly repository: Map<string, ApplicStatement>;

  constructor(document: Document, options: ApplicEvaluatorOptions = {}) {
    const engine = options.engine ?? defaultXmlEngine;
    this.statements = readApplicStatements(document, engine);
    for (const s of this.statements) if (s.id) this.byId.set(s.id, s);
    for (const n of engine.selectNodes('//referencedApplicGroupRef/applicRef[@id]', document)) {
      const el = n as Element;
      this.refIdToIdentValue.set(
        el.getAttribute('id') ?? '',
        el.getAttribute('applicIdentValue') ?? '',
      );
    }
    this.repository = options.repository ?? new Map();
  }

  /** 識別・状態部の applic。無ければ undefined */
  get dmLevelStatement(): ApplicStatement | undefined {
    return this.statements.find((s) => s.isDmLevel);
  }

  dmLevel(product: Product | undefined): ApplicResult {
    const s = this.dmLevelStatement;
    if (!s) return { state: 'applicable', reason: 'no applic in dmStatus' };
    return evaluateApplic(s, product);
  }

  /** `@applicRefId` の値が指す applic を探す */
  resolveRefId(applicRefId: string): { statement?: ApplicStatement; externalIdent?: string } {
    const local = this.byId.get(applicRefId);
    if (local) return { statement: local };
    const ident = this.refIdToIdentValue.get(applicRefId);
    if (ident === undefined) return {};
    return { statement: this.repository.get(ident), externalIdent: ident };
  }

  forRefId(applicRefId: string, product: Product | undefined): ApplicResult {
    const { statement, externalIdent } = this.resolveRefId(applicRefId);
    if (statement) return evaluateApplic(statement, product);
    if (externalIdent !== undefined) {
      return {
        state: 'undetermined',
        applicId: applicRefId,
        reason: `applic with applicIdentValue="${externalIdent}" was not found in the applicability repository`,
      };
    }
    return {
      state: 'undetermined',
      applicId: applicRefId,
      reason: `no applic with id="${applicRefId}" in this document`,
    };
  }

  /**
   * 要素に効く適用性: 要素自身か祖先の `@applicRefId`（最も近いもの）と、DM 全体の applic を and で結ぶ。
   * 要素も祖先も applicRefId を持たなければ DM 全体の判定だけ
   */
  forElement(el: Element, product: Product | undefined): ApplicResult {
    let n: Element | null = el;
    while (n && n.nodeType === 1) {
      const id = n.getAttribute('applicRefId');
      if (id) {
        const own = this.forRefId(id, product);
        const dm = this.dmLevel(product);
        return combineAnd(own, dm);
      }
      n = n.parentNode as Element | null;
    }
    return this.dmLevel(product);
  }
}

/** 2 つの判定を and で結ぶ（要素の適用性と DM 全体の適用性） */
export function combineAnd(a: ApplicResult, b: ApplicResult): ApplicResult {
  const states = [a.state, b.state];
  let state: ApplicState;
  if (states.includes('notApplicable')) state = 'notApplicable';
  else if (states.includes('undetermined')) state = 'undetermined';
  else state = 'applicable';
  const out: ApplicResult = { ...a, state };
  if (state === 'undetermined' && a.state !== 'undetermined') out.reason = b.reason;
  return out;
}

/** 適用性リポジトリ（別 DM の applic 群）から `applicIdentValue` → applic の表を作る */
export function buildApplicRepository(statements: ApplicStatement[]): Map<string, ApplicStatement> {
  const m = new Map<string, ApplicStatement>();
  for (const s of statements) if (s.applicIdentValue) m.set(s.applicIdentValue, s);
  return m;
}
