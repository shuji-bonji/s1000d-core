/**
 * データモジュールを BREX に照合する。
 *
 * 判定（Chap 4.10.2.2）:
 * - allowedObjectFlag=0: objectPath の結果が空でなければ違反（forbidden）
 * - allowedObjectFlag=1: 結果が空なら違反（missing）
 * - allowedObjectFlag=2: 結果の各節点の値を objectValue と照合し、合わなければ違反（value）
 * - objectPath が真偽値を返す式（`not(…)` など）なら、true を「対象あり」、false を「対象なし」として扱う
 *
 * 文脈（Chap 4.10.2.2 Para 2）:
 * - rulesContext 無しの contextRules はすべてのスキーマに適用
 * - rulesContext 有りの contextRules は、対象 DM の xsi:noNamespaceSchemaLocation と一致するときだけ適用
 *
 * 階層（Chap 7.9）: 各層に個別に照合し、どの層にも違反が無いときだけ合格。層の統合はしない。
 */
import type { Document, Element, Node, XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import { readDataModuleInfo } from '../data-module.js';
import { parseSchemaLocation } from '../schema-location.js';
import type {
  BrexCheckReport,
  BrexDocument,
  BrexLayerReport,
  BrexNotationRule,
  BrexStructureRule,
  BrexViolation,
  NodeLocation,
  SkippedRule,
} from './types.js';
import { matchesAnyObjectValue } from './values.js';

const ELEMENT_NODE = 1;
const ATTRIBUTE_NODE = 2;

interface Positioned {
  lineNumber?: number;
  columnNumber?: number;
  ownerElement?: Element | null;
}

/** 節点のルートからの簡易なパスと行番号 */
export function describeLocation(node: Node): NodeLocation {
  const parts: string[] = [];
  let n: Node | null = node;
  if (n.nodeType === ATTRIBUTE_NODE) {
    parts.unshift(`@${n.nodeName}`);
    n = (n as unknown as Positioned).ownerElement ?? null;
  }
  while (n && n.nodeType === ELEMENT_NODE) {
    const parent: Node | null = n.parentNode;
    let index = '';
    if (parent) {
      const siblings = Array.from(parent.childNodes).filter(
        (c) => c.nodeType === ELEMENT_NODE && c.nodeName === n!.nodeName,
      );
      if (siblings.length > 1) index = `[${siblings.indexOf(n) + 1}]`;
    }
    parts.unshift(`${n.nodeName}${index}`);
    n = parent;
  }
  const pos = node as unknown as Positioned;
  const loc: NodeLocation = { path: '/' + parts.join('/') };
  if (typeof pos.lineNumber === 'number') loc.line = pos.lineNumber;
  if (typeof pos.columnNumber === 'number') loc.column = pos.columnNumber;
  return loc;
}

function nodeValue(node: Node): string {
  if (node.nodeType === ATTRIBUTE_NODE) return node.nodeValue ?? '';
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 対象 DM のスキーマに、この contextRules が当てはまるか */
export function contextApplies(
  rulesContext: string | undefined,
  schemaLocation: string | undefined,
): boolean {
  if (rulesContext === undefined) return true;
  if (schemaLocation === undefined) return false;
  if (rulesContext === schemaLocation) return true;
  // URL の違い（版の表記揺れなど）に備え、スキーマのファイル名が同じなら同じ文脈と見る
  const a = parseSchemaLocation(rulesContext).schemaName;
  const b = parseSchemaLocation(schemaLocation).schemaName;
  return a !== undefined && a === b;
}

function severityOf(rule: { brSeverityLevel?: string }, brex: BrexDocument): string | undefined {
  return rule.brSeverityLevel ?? brex.defaultBrSeverityLevel;
}

function checkStructureRule(
  rule: BrexStructureRule,
  brex: BrexDocument,
  document: Document,
  engine: XmlEngine,
  violations: BrexViolation[],
  skipped: SkippedRule[],
): void {
  let result;
  try {
    result = engine.evaluate(rule.objectPath, document);
  } catch (e) {
    skipped.push({ ruleId: rule.ruleId, objectPath: rule.objectPath, error: (e as Error).message });
    return;
  }
  const nodes: Node[] = Array.isArray(result) ? result : [];
  const present = Array.isArray(result) ? result.length > 0 : Boolean(result);
  const base = {
    ruleId: rule.ruleId,
    objectPath: rule.objectPath,
    objectUse: rule.objectUse,
    brSeverityLevel: severityOf(rule, brex),
    rulesContext: rule.rulesContext,
  };

  switch (rule.allowedObjectFlag) {
    case '0':
      if (present) {
        if (nodes.length > 0) {
          for (const n of nodes) {
            violations.push({
              kind: 'forbidden',
              ...base,
              location: describeLocation(n),
              actualValue: nodeValue(n),
            });
          }
        } else {
          violations.push({ kind: 'forbidden', ...base });
        }
      }
      return;
    case '1':
      if (!present) violations.push({ kind: 'missing', ...base });
      return;
    case '2': {
      const constrained = rule.objectValues.filter((v) => v.valueAllowed !== undefined);
      if (constrained.length === 0) return;
      for (const n of nodes) {
        const value = nodeValue(n);
        if (!matchesAnyObjectValue(value, rule.objectValues)) {
          violations.push({
            kind: 'value',
            ...base,
            location: describeLocation(n),
            actualValue: value,
            allowedValues: constrained.map((v) => v.valueAllowed!),
          });
        }
      }
      return;
    }
  }
}

/**
 * 対象 DM が使っている NOTATION（DOCTYPE の ENTITY 宣言の NDATA）を集める。
 * 宣言の無い DM では空。
 */
export function usedNotations(document: Document): string[] {
  const subset = document.doctype?.internalSubset ?? '';
  const names = new Set<string>();
  for (const m of subset.matchAll(
    /<!ENTITY\s+\S+\s+(?:SYSTEM\s+"[^"]*"|PUBLIC\s+"[^"]*"\s+"[^"]*")\s+NDATA\s+(\S+)\s*>/gi,
  )) {
    names.add(m[1]);
  }
  return [...names];
}

/**
 * この層の NOTATION ルールから、対象スキーマで使ってよい NOTATION の集合を求める。
 * 基本セット（rulesContext 無し）に、スキーマ固有の追加（flag=1）と除外（flag=0）を適用する。
 * NOTATION ルールが 1 つも無ければ undefined（制限なし）。
 */
export function allowedNotations(
  brex: BrexDocument,
  schemaLocation: string | undefined,
): Set<string> | undefined {
  const rules: BrexNotationRule[] = brex.contextRules.flatMap((c) => c.notationRules);
  if (rules.length === 0) return undefined;
  const base = new Set<string>();
  for (const r of rules) {
    if (r.rulesContext === undefined && r.allowedNotationFlag === '1')
      base.add(r.notationName.toUpperCase());
  }
  const specific = rules.filter(
    (r) => r.rulesContext !== undefined && contextApplies(r.rulesContext, schemaLocation),
  );
  const allowed = new Set(base);
  // スキーマ固有の flag=1 があれば、その文脈の集合は再定義される
  if (specific.some((r) => r.allowedNotationFlag === '1')) {
    allowed.clear();
    for (const r of specific)
      if (r.allowedNotationFlag === '1') allowed.add(r.notationName.toUpperCase());
  }
  for (const r of specific)
    if (r.allowedNotationFlag === '0') allowed.delete(r.notationName.toUpperCase());
  return allowed;
}

/** 対象 DM を BREX 1 層に照合する。 */
export function checkAgainstBrexLayer(
  document: Document,
  brex: BrexDocument,
  schemaLocation: string | undefined,
  engine: XmlEngine = defaultXmlEngine,
): BrexLayerReport {
  const violations: BrexViolation[] = [];
  const skipped: SkippedRule[] = [];
  let evaluated = 0;
  for (const block of brex.contextRules) {
    if (!contextApplies(block.rulesContext, schemaLocation)) continue;
    for (const rule of block.structureRules) {
      evaluated++;
      checkStructureRule(rule, brex, document, engine, violations, skipped);
    }
  }
  const allowed = allowedNotations(brex, schemaLocation);
  if (allowed) {
    for (const used of usedNotations(document)) {
      if (!allowed.has(used.toUpperCase())) {
        const rule = brex.contextRules
          .flatMap((c) => c.notationRules)
          .find((r) => r.notationName.toUpperCase() === used.toUpperCase());
        violations.push({
          kind: 'notation',
          ruleId: rule?.ruleId,
          objectUse:
            rule?.objectUse ??
            `NOTATION "${used}" is not in the allowed set (${[...allowed].join(', ')})`,
          brSeverityLevel: rule ? severityOf(rule, brex) : brex.defaultBrSeverityLevel,
          actualValue: used,
          allowedValues: [...allowed],
        });
      }
    }
  }
  return {
    brex: { dmCode: brex.dmCode, issueInfo: brex.issueInfo, title: brex.title },
    evaluatedRules: evaluated,
    violations,
    skipped,
    manualChecks: brex.nonContextRules,
  };
}

/** 対象 DM（XML 文字列）を、与えられた BREX の層すべてに照合する。層の順序は呼び出し側が決める。 */
export function checkAgainstBrexLayers(
  xml: string,
  layers: BrexDocument[],
  engine: XmlEngine = defaultXmlEngine,
): BrexCheckReport {
  const info = readDataModuleInfo(xml, engine);
  const parsed = engine.parse(xml);
  const reports = layers.map((b) =>
    checkAgainstBrexLayer(parsed.document, b, info.schemaLocation, engine),
  );
  return {
    target: {
      dmCode: info.identAndStatus?.dmCode,
      schemaLocation: info.schemaLocation,
      schemaName: info.schemaName,
    },
    layers: reports,
    unresolved: [],
    passed: reports.every((r) => r.violations.length === 0 && r.skipped.length === 0),
  };
}
