/**
 * BREX データモジュールの XML を BrexDocument に読み取る。
 */
import { readDmCodeElement, readDmRef } from '../data-module.js';
import type { ParseResult } from '../types.js';
import type { Document, Element, Node, XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import type {
  AllowedObjectFlag,
  BrexContextRules,
  BrexDocument,
  BrexNonContextRule,
  BrexNotationRule,
  BrexObjectValue,
  BrexStructureRule,
  SnsDescription,
  SnsNode,
  ValueForm,
  ValueTailoring,
} from './types.js';

function attr(el: Element, name: string): string | undefined {
  const v = el.getAttribute(name);
  return v === null || v === '' ? undefined : v;
}

function text(engine: XmlEngine, expr: string, ctx: Node): string | undefined {
  const s = engine.selectString(expr, ctx);
  if (s === undefined) return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t : undefined;
}

function elements(engine: XmlEngine, expr: string, ctx: Node): Element[] {
  return engine.selectNodes(expr, ctx).filter((n) => n.nodeType === 1) as Element[];
}

function readObjectValue(el: Element): BrexObjectValue {
  const form = (attr(el, 'valueForm') ?? 'single') as ValueForm;
  const tailoring = (attr(el, 'valueTailoring') ?? 'closed') as ValueTailoring;
  return {
    valueForm: form,
    valueAllowed: attr(el, 'valueAllowed'),
    valueTailoring: tailoring,
    description: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
  };
}

function readStructureRule(
  engine: XmlEngine,
  el: Element,
  rulesContext: string | undefined,
): BrexStructureRule | undefined {
  const pathEl = elements(engine, 'objectPath', el)[0];
  if (!pathEl) return undefined;
  const ruleId = elements(engine, 'brDecisionRef', el)[0];
  return {
    kind: 'structure',
    ruleId: ruleId ? attr(ruleId, 'brDecisionIdentNumber') : undefined,
    id: attr(el, 'id'),
    objectPath: (pathEl.textContent ?? '').trim(),
    allowedObjectFlag: (attr(pathEl, 'allowedObjectFlag') ?? '2') as AllowedObjectFlag,
    objectUse: text(engine, 'objectUse', el) ?? '',
    objectValues: elements(engine, 'objectValue', el).map(readObjectValue),
    brSeverityLevel: attr(el, 'brSeverityLevel'),
    rulesContext,
  };
}

function readNotationRule(
  engine: XmlEngine,
  el: Element,
  rulesContext: string | undefined,
): BrexNotationRule | undefined {
  const nameEl = elements(engine, 'notationName', el)[0];
  if (!nameEl) return undefined;
  const ruleId = elements(engine, 'brDecisionRef', el)[0];
  const flag = attr(nameEl, 'allowedNotationFlag');
  return {
    kind: 'notation',
    ruleId: ruleId ? attr(ruleId, 'brDecisionIdentNumber') : undefined,
    id: attr(el, 'id'),
    notationName: (nameEl.textContent ?? '').trim(),
    allowedNotationFlag: flag === '0' || flag === '1' ? flag : undefined,
    objectUse: text(engine, 'objectUse', el) ?? '',
    brSeverityLevel: attr(el, 'brSeverityLevel'),
    rulesContext,
  };
}

function readSnsNode(engine: XmlEngine, el: Element, childName?: string): SnsNode {
  const node: SnsNode = {
    snsCode: text(engine, 'snsCode', el) ?? '',
    snsTitle: text(engine, 'snsTitle', el) ?? '',
    children: [],
  };
  if (childName) {
    const next: Record<string, string | undefined> = {
      snsSubSystem: 'snsSubSubSystem',
      snsSubSubSystem: 'snsAssy',
      snsAssy: undefined,
    };
    node.children = elements(engine, childName, el).map((c) =>
      readSnsNode(engine, c, next[childName]),
    );
  }
  return node;
}

/** 読み込み済みの Document から BREX を読む。ルートが BREX の内容部を持たなければ失敗。 */
export function readBrexDocument(
  document: Document,
  engine: XmlEngine = defaultXmlEngine,
): ParseResult<BrexDocument> {
  const root = document.documentElement;
  if (!root || root.nodeName !== 'dmodule') {
    return {
      ok: false,
      error: `Root element is "${root?.nodeName ?? '(none)'}", expected "dmodule"`,
    };
  }
  const brexEl = elements(engine, 'content/brex', root)[0];
  if (!brexEl) return { ok: false, error: 'dmodule has no content/brex (not a BREX data module)' };

  const codeEl = elements(engine, 'identAndStatusSection/dmAddress/dmIdent/dmCode', root)[0];
  if (!codeEl)
    return { ok: false, error: 'BREX has no identAndStatusSection/dmAddress/dmIdent/dmCode' };
  const dmCode = readDmCodeElement(codeEl);
  if (!dmCode.ok) return dmCode;

  const issueEl = elements(engine, 'identAndStatusSection/dmAddress/dmIdent/issueInfo', root)[0];
  const techName = text(
    engine,
    'identAndStatusSection/dmAddress/dmAddressItems/dmTitle/techName',
    root,
  );
  const infoName = text(
    engine,
    'identAndStatusSection/dmAddress/dmAddressItems/dmTitle/infoName',
    root,
  );

  const doc: BrexDocument = {
    dmCode: dmCode.value,
    title: [techName, infoName].filter(Boolean).join(' - ') || undefined,
    defaultBrSeverityLevel: attr(brexEl, 'defaultBrSeverityLevel'),
    commonInfo: text(engine, 'commonInfo', brexEl),
    snsRules: [],
    contextRules: [],
    nonContextRules: [],
  };
  if (issueEl) {
    const issueNumber = attr(issueEl, 'issueNumber');
    if (issueNumber) doc.issueInfo = { issueNumber, inWork: attr(issueEl, 'inWork') ?? '00' };
  }
  const brexRefEl = elements(engine, 'identAndStatusSection/dmStatus/brexDmRef/dmRef', root)[0];
  if (brexRefEl) {
    const ref = readDmRef(brexRefEl, engine);
    if (ref.ok) doc.brexDmRef = ref.value;
  }

  for (const descr of elements(engine, 'snsRules/snsDescr', brexEl)) {
    const sns: SnsDescription = {
      systems: elements(engine, 'snsSystem', descr).map((s) =>
        readSnsNode(engine, s, 'snsSubSystem'),
      ),
    };
    doc.snsRules.push(sns);
  }

  for (const ctx of elements(engine, 'contextRules', brexEl)) {
    const rulesContext = attr(ctx, 'rulesContext');
    const block: BrexContextRules = { rulesContext, structureRules: [], notationRules: [] };
    for (const r of elements(engine, 'structureObjectRuleGroup/structureObjectRule', ctx)) {
      const rule = readStructureRule(engine, r, rulesContext);
      if (rule) block.structureRules.push(rule);
    }
    for (const r of elements(engine, 'notationRuleList/notationRule', ctx)) {
      const rule = readNotationRule(engine, r, rulesContext);
      if (rule) block.notationRules.push(rule);
    }
    doc.contextRules.push(block);
  }

  for (const r of elements(engine, 'nonContextRules/nonContextRule', brexEl)) {
    const ruleId = elements(engine, 'brDecisionRef', r)[0];
    const rule: BrexNonContextRule = {
      kind: 'nonContext',
      ruleId: ruleId ? attr(ruleId, 'brDecisionIdentNumber') : undefined,
      id: attr(r, 'id'),
      text: text(engine, 'simplePara', r) ?? text(engine, '.', r) ?? '',
      brSeverityLevel: attr(r, 'brSeverityLevel'),
    };
    doc.nonContextRules.push(rule);
  }
  return { ok: true, value: doc };
}

/** XML 文字列から BREX を読む。 */
export function readBrex(
  xml: string,
  engine: XmlEngine = defaultXmlEngine,
): ParseResult<BrexDocument> {
  return readBrexDocument(engine.parse(xml).document, engine);
}

/** BREX の全ルール（構造・NOTATION・文脈非依存）を 1 つの配列で返す。 */
export function allRules(
  brex: BrexDocument,
): (BrexStructureRule | BrexNotationRule | BrexNonContextRule)[] {
  return [
    ...brex.contextRules.flatMap((c) => [...c.structureRules, ...c.notationRules]),
    ...brex.nonContextRules,
  ];
}
