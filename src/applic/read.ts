/**
 * 適用性の読み取り: `applic` 要素（assert / evaluate）、ACT、CCT、PCT。
 */
import { describeLocation } from '../brex/check.js';
import { readDmRef } from '../data-module.js';
import type { Document, Element, Node, XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import type {
  Act,
  ApplicExpr,
  ApplicStatement,
  Cct,
  Cond,
  CondType,
  Pct,
  PctProduct,
  Product,
  ProductAttribute,
} from './types.js';

const ELEMENT_NODE = 1;

function attr(el: Element, name: string): string | undefined {
  const v = el.getAttribute(name);
  return v === null || v === '' ? undefined : v;
}

function text(engine: XmlEngine, expr: string, ctx: Node): string | undefined {
  const v = engine.selectString(expr, ctx);
  if (v === undefined) return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  return t === '' ? undefined : t;
}

function childElements(el: Element): Element[] {
  return Array.from(el.childNodes).filter((n): n is Element => n.nodeType === ELEMENT_NODE);
}

/** `assert` または `evaluate` の要素を式にする。それ以外の要素なら undefined */
export function readApplicExpr(el: Element): ApplicExpr | undefined {
  if (el.nodeName === 'assert') {
    return {
      kind: 'assert',
      propertyIdent: attr(el, 'applicPropertyIdent') ?? '',
      propertyType: attr(el, 'applicPropertyType') ?? 'prodattr',
      values: attr(el, 'applicPropertyValues') ?? '',
    };
  }
  if (el.nodeName === 'evaluate') {
    const andOr = attr(el, 'andOr') === 'or' ? 'or' : 'and';
    const children: ApplicExpr[] = [];
    for (const c of childElements(el)) {
      const e = readApplicExpr(c);
      if (e) children.push(e);
    }
    return { kind: 'evaluate', andOr, children };
  }
  return undefined;
}

/** `applic` 要素 1 つを読む */
export function readApplicElement(
  el: Element,
  engine: XmlEngine = defaultXmlEngine,
): ApplicStatement {
  let expr: ApplicExpr | undefined;
  for (const c of childElements(el)) {
    const e = readApplicExpr(c);
    if (e) {
      expr = e;
      break;
    }
  }
  const parent = el.parentNode;
  const st: ApplicStatement = {
    id: attr(el, 'id'),
    applicIdentValue: attr(el, 'applicIdentValue'),
    displayText: text(engine, 'displayText', el),
    expr,
    isDmLevel:
      parent !== null && parent.nodeType === ELEMENT_NODE && parent.nodeName === 'dmStatus',
    location: describeLocation(el),
  };
  return st;
}

/** 文書中のすべての `applic`（識別・状態部、referencedApplicGroup、適用性リポジトリ） */
export function readApplicStatements(
  document: Document,
  engine: XmlEngine = defaultXmlEngine,
): ApplicStatement[] {
  return engine
    .selectNodes('//applic', document)
    .map((n) => readApplicElement(n as Element, engine));
}

function enumerations(engine: XmlEngine, el: Element): string[] {
  return engine
    .selectNodes('enumeration/@applicPropertyValues', el)
    .map((n) => n.nodeValue ?? '')
    .filter((s) => s !== '');
}

/** ACT（applicCrossRefTable）を読む。ACT で無ければ undefined */
export function readAct(document: Document, engine: XmlEngine = defaultXmlEngine): Act | undefined {
  const root = engine.selectNodes('//applicCrossRefTable', document)[0] as Element | undefined;
  if (!root) return undefined;
  const productAttributes: ProductAttribute[] = engine
    .selectNodes('productAttributeList/productAttribute', root)
    .map((n) => {
      const el = n as Element;
      return {
        id: attr(el, 'id') ?? '',
        name: text(engine, 'name', el),
        displayName: text(engine, 'displayName', el),
        descr: text(engine, 'descr', el),
        valueDataType: attr(el, 'valueDataType'),
        valuePattern: attr(el, 'valuePattern'),
        enumerations: enumerations(engine, el),
        productIdentifier: attr(el, 'productIdentifier'),
      };
    });
  const act: Act = { productAttributes };
  const cctRef = engine.selectNodes('condCrossRefTableRef/dmRef', root)[0] as Element | undefined;
  const pctRef = engine.selectNodes('productCrossRefTableRef/dmRef', root)[0] as
    Element | undefined;
  if (cctRef) {
    const r = readDmRef(cctRef, engine);
    if (r.ok) act.condCrossRefTableRef = r.value;
  }
  if (pctRef) {
    const r = readDmRef(pctRef, engine);
    if (r.ok) act.productCrossRefTableRef = r.value;
  }
  return act;
}

/** CCT（condCrossRefTable）を読む。CCT で無ければ undefined */
export function readCct(document: Document, engine: XmlEngine = defaultXmlEngine): Cct | undefined {
  const root = engine.selectNodes('//condCrossRefTable', document)[0] as Element | undefined;
  if (!root) return undefined;
  const condTypes: CondType[] = engine.selectNodes('condTypeList/condType', root).map((n) => {
    const el = n as Element;
    return {
      id: attr(el, 'id') ?? '',
      name: text(engine, 'name', el),
      descr: text(engine, 'descr', el),
      valueDataType: attr(el, 'valueDataType'),
      enumerations: enumerations(engine, el),
    };
  });
  const conds: Cond[] = engine.selectNodes('condList/cond', root).map((n) => {
    const el = n as Element;
    return {
      id: attr(el, 'id') ?? '',
      condTypeRefId: attr(el, 'condTypeRefId') ?? '',
      name: text(engine, 'name', el),
      descr: text(engine, 'descr', el),
    };
  });
  return { condTypes, conds };
}

/** PCT（productCrossRefTable）を読む。PCT で無ければ undefined */
export function readPct(document: Document, engine: XmlEngine = defaultXmlEngine): Pct | undefined {
  const root = engine.selectNodes('//productCrossRefTable', document)[0] as Element | undefined;
  if (!root) return undefined;
  const products: PctProduct[] = engine.selectNodes('product', root).map((n) => {
    const el = n as Element;
    return {
      id: attr(el, 'id'),
      assigns: engine.selectNodes('assign', el).map((a) => {
        const ae = a as Element;
        return {
          propertyIdent: attr(ae, 'applicPropertyIdent') ?? '',
          propertyType: attr(ae, 'applicPropertyType') ?? 'prodattr',
          value: attr(ae, 'applicPropertyValue') ?? '',
        };
      }),
    };
  });
  return { products };
}

/** PCT の 1 行を判定用の Product にする */
export function productFromPct(p: PctProduct): Product {
  const product: Product = { attributes: {}, conditions: {} };
  for (const a of p.assigns) {
    if (a.propertyType === 'condition') product.conditions[a.propertyIdent] = a.value;
    else product.attributes[a.propertyIdent] = a.value;
  }
  return product;
}
