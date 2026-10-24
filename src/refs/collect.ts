/**
 * データモジュールの中の参照を集める。解決（参照先があるか）は resolve.ts。
 *
 * 集める参照（Bike Samples の実測: dmRef 1,464、brexDmRef 117、applicCrossRefTableRef 105、pmRef 10、
 * graphic/symbol の infoEntityIdent 63、internalRef 536、applicRefId 368）:
 *
 * | kind | 読む場所 |
 * |---|---|
 * | dmRef | `//dmRef/dmRefIdent`（brexDmRef・applicCrossRefTableRef・pmEntry など、どの文脈のものも） |
 * | pmRef | `//pmRef/pmRefIdent/pmCode` |
 * | icn | `//*[@infoEntityIdent]` と DOCTYPE 内部サブセットの `<!ENTITY name SYSTEM "file" NDATA notation>` |
 * | internalRef | `//internalRef/@internalRefId` → 同じ文書の `@id` |
 * | applicRef | `//*[@applicRefId]` → 同じ文書の `applic/@id`、または `referencedApplicGroupRef/applicRef/@id`（別の DM にある適用性文を `@applicIdentValue` で指す） |
 */
import { describeLocation } from '../brex/check.js';
import type { NodeLocation } from '../brex/types.js';
import { readDmRef } from '../data-module.js';
import type { DmRef, IssueInfo, PmCode } from '../types.js';
import type { Document, Element, Node, XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';

export type ReferenceKind = 'dmRef' | 'pmRef' | 'icn' | 'internalRef' | 'applicRef';

export interface EntityDeclaration {
  name: string;
  /** SYSTEM 識別子（ファイル名） */
  systemId?: string;
  publicId?: string;
  /** NDATA の NOTATION 名（cgm / png など） */
  notation?: string;
}

interface ReferenceBase {
  kind: ReferenceKind;
  /** 参照を書いた要素の親の名前（brexDmRef / applicCrossRefTableRef / pmEntry / para など） */
  context: string;
  location: NodeLocation;
}

export interface DmReference extends ReferenceBase {
  kind: 'dmRef';
  ref: DmRef;
}
export interface PmReference extends ReferenceBase {
  kind: 'pmRef';
  pmCode: PmCode;
  issueInfo?: IssueInfo;
}
export interface IcnReference extends ReferenceBase {
  kind: 'icn';
  /** `@infoEntityIdent` の値（実体名） */
  entityName: string;
  /** DOCTYPE の宣言。無ければ undefined */
  declaration?: EntityDeclaration;
}
export interface InternalReference extends ReferenceBase {
  kind: 'internalRef';
  targetId: string;
  /** `@internalRefTargetType`（irtt01 など） */
  targetType?: string;
}
export interface ApplicReference extends ReferenceBase {
  kind: 'applicRef';
  applicRefId: string;
}

export type Reference =
  DmReference | PmReference | IcnReference | InternalReference | ApplicReference;

export interface CollectedReferences {
  references: Reference[];
  /** DOCTYPE の ENTITY 宣言（実体名 → 宣言） */
  entities: Map<string, EntityDeclaration>;
  /** 文書内の `@id` の集合 */
  ids: Set<string>;
  /** `applic/@id` の集合 */
  applicIds: Set<string>;
  /** `referencedApplicGroupRef/applicRef/@id` → `@applicIdentValue`（文書外の適用性文への参照） */
  applicRefIds: Map<string, string>;
}

const ENTITY_RE =
  /<!ENTITY\s+([^\s%]+)\s+(?:SYSTEM\s+(["'])(.*?)\2|PUBLIC\s+(["'])(.*?)\4\s+(["'])(.*?)\6)(?:\s+NDATA\s+(\S+))?\s*>/g;

/** DOCTYPE の内部サブセットから ENTITY 宣言を読む（パラメーター実体 `%` は除く） */
export function readEntityDeclarations(
  internalSubset: string | undefined | null,
): Map<string, EntityDeclaration> {
  const out = new Map<string, EntityDeclaration>();
  if (!internalSubset) return out;
  for (const m of internalSubset.matchAll(ENTITY_RE)) {
    const decl: EntityDeclaration = { name: m[1] };
    if (m[3] !== undefined) decl.systemId = m[3];
    if (m[5] !== undefined) {
      decl.publicId = m[5];
      decl.systemId = m[7];
    }
    if (m[8] !== undefined) decl.notation = m[8];
    out.set(decl.name, decl);
  }
  return out;
}

function parentName(el: Node): string {
  const p = el.parentNode;
  return p && p.nodeType === 1 ? p.nodeName : '';
}

function attr(el: Element, name: string): string | undefined {
  const v = el.getAttribute(name);
  return v === null || v === '' ? undefined : v;
}

export function collectReferences(
  document: Document,
  engine: XmlEngine = defaultXmlEngine,
): CollectedReferences {
  const references: Reference[] = [];
  const entities = readEntityDeclarations(document.doctype?.internalSubset);

  for (const n of engine.selectNodes('//dmRef', document)) {
    const el = n as Element;
    const r = readDmRef(el, engine);
    if (!r.ok) continue;
    references.push({
      kind: 'dmRef',
      ref: r.value,
      context: parentName(el),
      location: describeLocation(el),
    });
  }

  for (const n of engine.selectNodes('//pmRef', document)) {
    const el = n as Element;
    const code = engine.selectNodes('pmRefIdent/pmCode', el)[0] as Element | undefined;
    if (!code) continue;
    const pm = {
      modelIdentCode: attr(code, 'modelIdentCode') ?? '',
      pmIssuer: attr(code, 'pmIssuer') ?? '',
      pmNumber: attr(code, 'pmNumber') ?? '',
      pmVolume: attr(code, 'pmVolume') ?? '',
    };
    const issue = engine.selectNodes('pmRefIdent/issueInfo', el)[0] as Element | undefined;
    const ref: PmReference = {
      kind: 'pmRef',
      pmCode: pm,
      context: parentName(el),
      location: describeLocation(el),
    };
    if (issue) {
      ref.issueInfo = {
        issueNumber: attr(issue, 'issueNumber') ?? '',
        inWork: attr(issue, 'inWork') ?? '00',
      };
    }
    references.push(ref);
  }

  for (const n of engine.selectNodes('//*[@infoEntityIdent]', document)) {
    const el = n as Element;
    const name = attr(el, 'infoEntityIdent');
    if (!name) continue;
    references.push({
      kind: 'icn',
      entityName: name,
      declaration: entities.get(name),
      context: el.nodeName,
      location: describeLocation(el),
    });
  }

  for (const n of engine.selectNodes('//internalRef[@internalRefId]', document)) {
    const el = n as Element;
    references.push({
      kind: 'internalRef',
      targetId: attr(el, 'internalRefId') ?? '',
      targetType: attr(el, 'internalRefTargetType'),
      context: parentName(el),
      location: describeLocation(el),
    });
  }

  for (const n of engine.selectNodes('//*[@applicRefId]', document)) {
    const el = n as Element;
    references.push({
      kind: 'applicRef',
      applicRefId: attr(el, 'applicRefId') ?? '',
      context: el.nodeName,
      location: describeLocation(el),
    });
  }

  const ids = new Set<string>();
  for (const n of engine.selectNodes('//*/@id', document)) ids.add(n.nodeValue ?? '');
  const applicIds = new Set<string>();
  for (const n of engine.selectNodes('//applic/@id', document)) applicIds.add(n.nodeValue ?? '');
  const applicRefIds = new Map<string, string>();
  for (const n of engine.selectNodes('//referencedApplicGroupRef/applicRef[@id]', document)) {
    const el = n as Element;
    applicRefIds.set(attr(el, 'id') ?? '', attr(el, 'applicIdentValue') ?? '');
  }

  return { references, entities, ids, applicIds, applicRefIds };
}
