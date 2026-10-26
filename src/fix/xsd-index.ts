/**
 * XSD の定義を読んで、修正提案の候補（列挙値・正規表現・許される子要素・許される属性）を取り出す。
 *
 * 対象は S1000D の `xml_schema_flat/` の XSD（1 本に定義がまとまり、要素・属性・型が名前付きで大域に置かれる形）。
 * `xs:include` / `xs:import` の `schemaLocation` が相対パスなら同じフォルダーから読み足す（絶対 URL は読まない）。
 * 検証そのものは SchemaValidator（libxml2）が行う。ここは定義を引くだけで、検証はしない。
 * XSD の内容は利用者が持つ配布物から実行時に読み、このパッケージには含めない（D-03）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Element, Node, XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';

const XS_NS = 'http://www.w3.org/2001/XMLSchema';
const ELEMENT_NODE = 1;

/** 単純型の値の制約 */
export interface ValueConstraint {
  /** 制約を持つ型の名前（無名の型なら undefined） */
  typeName?: string;
  /** `xs:enumeration` の値（union なら各メンバーの和） */
  enumerations: string[];
  /** `xs:pattern` の値（restriction の連鎖では全部に合う必要がある） */
  patterns: string[];
  /** 行き着いた組み込み型（xs:string、xs:gYear など） */
  builtin?: string;
  /** 定義のあるファイル名 */
  file: string;
}

interface Definitions {
  elements: Map<string, Element>;
  complexTypes: Map<string, Element>;
  simpleTypes: Map<string, Element>;
  attributes: Map<string, Element>;
  attributeGroups: Map<string, Element>;
  groups: Map<string, Element>;
}

const local = (qname: string | null | undefined): string => (qname ?? '').replace(/^[^:]+:/, '');

function isXs(n: Node, name?: string): n is Element {
  if (n.nodeType !== ELEMENT_NODE) return false;
  const el = n as Element;
  if (el.namespaceURI !== XS_NS) return false;
  return name === undefined || el.localName === name;
}

function children(el: Element, name?: string): Element[] {
  return Array.from(el.childNodes).filter((c): c is Element => isXs(c, name));
}

export class XsdIndex {
  /** 最初に読んだ XSD のパス */
  readonly xsdPath: string;
  private readonly defs: Definitions = {
    elements: new Map(),
    complexTypes: new Map(),
    simpleTypes: new Map(),
    attributes: new Map(),
    attributeGroups: new Map(),
    groups: new Map(),
  };
  /** 定義 → ファイル名 */
  private readonly fileOf = new Map<Element, string>();

  private constructor(xsdPath: string) {
    this.xsdPath = xsdPath;
  }

  /** XSD をファイルから読む。読めなければ例外を投げる */
  static fromFile(xsdPath: string, engine: XmlEngine = defaultXmlEngine): XsdIndex {
    const index = new XsdIndex(xsdPath);
    const seen = new Set<string>();
    const load = (path: string) => {
      if (seen.has(path)) return;
      seen.add(path);
      const doc = engine.parse(readFileSync(path, 'utf8')).document;
      const root = doc.documentElement;
      if (!root || !isXs(root, 'schema')) return;
      index.register(root, basename(path));
      for (const inc of [...children(root, 'include'), ...children(root, 'import')]) {
        const loc = inc.getAttribute('schemaLocation');
        if (!loc || /^[a-z][a-z0-9+.-]*:/i.test(loc)) continue;
        const p = join(dirname(path), loc);
        if (existsSync(p)) load(p);
      }
    };
    load(xsdPath);
    return index;
  }

  /** XSD の文字列から作る（テスト用） */
  static fromString(xsd: string, fileName = 'schema.xsd', engine: XmlEngine = defaultXmlEngine) {
    const index = new XsdIndex(fileName);
    const root = engine.parse(xsd).document.documentElement;
    if (root && isXs(root, 'schema')) index.register(root, fileName);
    return index;
  }

  private register(schema: Element, file: string) {
    const table: Record<string, Map<string, Element>> = {
      element: this.defs.elements,
      complexType: this.defs.complexTypes,
      simpleType: this.defs.simpleTypes,
      attribute: this.defs.attributes,
      attributeGroup: this.defs.attributeGroups,
      group: this.defs.groups,
    };
    for (const el of children(schema)) {
      const map = table[el.localName ?? ''];
      const name = el.getAttribute('name');
      if (!map || !name || map.has(name)) continue;
      map.set(name, el);
      this.fileOf.set(el, file);
    }
  }

  /** 定義の場所の説明（例: `descript.xsd xs:simpleType name="securityClassificationAttType"`） */
  describe(kind: keyof Definitions, name: string): string | undefined {
    const el = this.defs[kind].get(name);
    if (!el) return undefined;
    const xsName = {
      elements: 'element',
      complexTypes: 'complexType',
      simpleTypes: 'simpleType',
      attributes: 'attribute',
      attributeGroups: 'attributeGroup',
      groups: 'group',
    }[kind];
    return `${this.fileOf.get(el)} xs:${xsName} name="${name}"`;
  }

  hasElement(name: string): boolean {
    return this.defs.elements.has(name);
  }

  /** 要素の複合型（名前付きの型か、要素の中の無名の型） */
  private complexTypeOfElement(name: string): Element | undefined {
    const el = this.defs.elements.get(name);
    if (!el) return undefined;
    const type = el.getAttribute('type');
    if (type) return this.defs.complexTypes.get(local(type));
    return children(el, 'complexType')[0];
  }

  /** 要素の中に置ける子要素の名前（出現順・重複なし）。定義が無ければ undefined */
  allowedChildren(elementName: string): string[] | undefined {
    const ct = this.complexTypeOfElement(elementName);
    if (!ct) return this.defs.elements.has(elementName) ? [] : undefined;
    const out: string[] = [];
    const visited = new Set<Element>();
    const walk = (node: Element) => {
      if (visited.has(node)) return;
      visited.add(node);
      for (const c of children(node)) {
        switch (c.localName) {
          case 'element': {
            const n = local(c.getAttribute('ref')) || c.getAttribute('name');
            if (n && !out.includes(n)) out.push(n);
            break; // 子要素の中の定義（孫）には降りない
          }
          case 'group': {
            const ref = c.getAttribute('ref');
            const g = ref ? this.defs.groups.get(local(ref)) : undefined;
            if (g) walk(g);
            else walk(c);
            break;
          }
          case 'extension':
          case 'restriction': {
            const base = this.defs.complexTypes.get(local(c.getAttribute('base')));
            if (base && c.localName === 'extension') walk(base);
            walk(c);
            break;
          }
          case 'attribute':
          case 'attributeGroup':
          case 'annotation':
          case 'any':
            break;
          default:
            walk(c); // sequence / choice / all / complexContent / simpleContent
        }
      }
    };
    walk(ct);
    return out;
  }

  /** 要素に付けられる属性の名前。定義が無ければ undefined */
  allowedAttributes(elementName: string): string[] | undefined {
    const ct = this.complexTypeOfElement(elementName);
    if (!ct) return this.defs.elements.has(elementName) ? [] : undefined;
    return [...this.attributeDecls(ct).keys()];
  }

  /** 複合型の属性宣言（名前 → 宣言の要素。ref なら大域の宣言） */
  private attributeDecls(ct: Element): Map<string, Element> {
    const out = new Map<string, Element>();
    const visited = new Set<Element>();
    const walk = (node: Element) => {
      if (visited.has(node)) return;
      visited.add(node);
      for (const c of children(node)) {
        switch (c.localName) {
          case 'attribute': {
            const ref = c.getAttribute('ref');
            if (ref) {
              const g = this.defs.attributes.get(local(ref));
              out.set(ref, g ?? c);
            } else if (c.getAttribute('name')) {
              out.set(c.getAttribute('name')!, c);
            }
            break;
          }
          case 'attributeGroup': {
            const g = this.defs.attributeGroups.get(local(c.getAttribute('ref')));
            if (g) walk(g);
            break;
          }
          case 'extension':
          case 'restriction': {
            const base = this.defs.complexTypes.get(local(c.getAttribute('base')));
            if (base) walk(base);
            walk(c);
            break;
          }
          case 'element':
          case 'annotation':
            break;
          default:
            walk(c);
        }
      }
    };
    walk(ct);
    return out;
  }

  /**
   * 属性の値の制約。要素名を渡せばその要素の宣言（局所宣言を含む）を優先し、無ければ大域の属性宣言を見る
   */
  attributeConstraint(attrName: string, elementName?: string): ValueConstraint | undefined {
    let decl: Element | undefined;
    if (elementName) {
      const ct = this.complexTypeOfElement(elementName);
      if (ct) decl = this.attributeDecls(ct).get(attrName);
    }
    decl ??= this.defs.attributes.get(local(attrName));
    if (!decl) return undefined;
    const file = this.fileOf.get(decl) ?? basename(this.xsdPath);
    const type = decl.getAttribute('type');
    if (type)
      return this.typeConstraint(type) ?? { enumerations: [], patterns: [], builtin: type, file };
    const inline = children(decl, 'simpleType')[0];
    return inline ? this.simpleTypeConstraint(inline, undefined, file) : undefined;
  }

  /** 単純型の名前から制約を求める。組み込み型（xs:*）なら builtin だけを返す */
  typeConstraint(typeName: string): ValueConstraint | undefined {
    const st = this.defs.simpleTypes.get(local(typeName));
    if (!st) {
      if (/^(xs|xsd):/.test(typeName))
        return { enumerations: [], patterns: [], builtin: typeName, file: basename(this.xsdPath) };
      return undefined;
    }
    return this.simpleTypeConstraint(st, local(typeName), this.fileOf.get(st) ?? '');
  }

  private simpleTypeConstraint(
    st: Element,
    typeName: string | undefined,
    file: string,
    depth = 0,
  ): ValueConstraint {
    const out: ValueConstraint = { typeName, enumerations: [], patterns: [], file };
    if (depth > 16) return out;
    const restriction = children(st, 'restriction')[0];
    if (restriction) {
      for (const e of children(restriction, 'enumeration'))
        out.enumerations.push(e.getAttribute('value') ?? '');
      for (const p of children(restriction, 'pattern'))
        out.patterns.push(p.getAttribute('value') ?? '');
      const base = restriction.getAttribute('base');
      const baseSt = base
        ? this.defs.simpleTypes.get(local(base))
        : children(restriction, 'simpleType')[0];
      if (baseSt) {
        const b = this.simpleTypeConstraint(
          baseSt,
          base ? local(base) : undefined,
          file,
          depth + 1,
        );
        if (out.enumerations.length === 0) out.enumerations.push(...b.enumerations);
        out.patterns.push(...b.patterns);
        out.builtin = b.builtin;
      } else if (base) {
        out.builtin = base;
      }
      return out;
    }
    const union = children(st, 'union')[0];
    if (union) {
      const members = [
        ...(union.getAttribute('memberTypes') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((m) => this.typeConstraint(m)),
        ...children(union, 'simpleType').map((s) =>
          this.simpleTypeConstraint(s, undefined, file, depth + 1),
        ),
      ];
      for (const m of members) {
        if (!m) continue;
        out.enumerations.push(...m.enumerations.filter((v) => !out.enumerations.includes(v)));
        out.patterns.push(...m.patterns);
      }
    }
    return out;
  }
}

const cache = new Map<string, XsdIndex>();
/** 同じ XSD を何度も読まないための入口。読めなければ undefined */
export function loadXsdIndex(xsdPath: string, engine?: XmlEngine): XsdIndex | undefined {
  const hit = cache.get(xsdPath);
  if (hit) return hit;
  try {
    const index = XsdIndex.fromFile(xsdPath, engine);
    cache.set(xsdPath, index);
    return index;
  } catch {
    return undefined;
  }
}
