/**
 * preliminaryRqmts を「読んで、書いて、失われるものを数える」ための道具（テスト用。配布物には入れない）。
 *
 * reader（readContent）が返した `requirements` の節点を、writer の下書き（DraftNode）に写して組み立て直し、
 * 元の preliminaryRqmts と、組み立て直した preliminaryRqmts の要素・属性の数を比べる。
 * 数が減ったものが、いまの core では往復できない構造である（読めない、下書きで表せない、書けない、のどれか）。
 * 値（文の中身）は比べない。構造が残るかだけを見る。
 */
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { readContentFromXml } from '../content/index.js';
import type { ContentNode, ContentRef } from '../content/types.js';
import { buildContent } from '../write/content/index.js';
import type { DraftNode, DraftRef } from '../write/types.js';

export interface RequirementsRoundTrip {
  /** 元の preliminaryRqmts の要素（`name`）と属性（`name/@attr`）の数 */
  original: Record<string, number>;
  /** 組み立て直した後に減った数 */
  lost: Record<string, number>;
  /** 下書きに写せなかった・組み立てられなかった節点（種類と理由） */
  dropped: string[];
}

function inventory(xml: string): Record<string, number> {
  const out: Record<string, number> = {};
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const walk = (n: { nodeType: number; nodeName: string; childNodes: ArrayLike<unknown> }) => {
    if (n.nodeType !== 1) return;
    const e = n as unknown as {
      nodeName: string;
      attributes: ArrayLike<{ name: string }>;
      childNodes: ArrayLike<never>;
    };
    out[e.nodeName] = (out[e.nodeName] ?? 0) + 1;
    for (const a of Array.from(e.attributes)) {
      const k = `${e.nodeName}/@${a.name}`;
      out[k] = (out[k] ?? 0) + 1;
    }
    for (const c of Array.from(e.childNodes)) walk(c);
  };
  walk(doc.documentElement as never);
  return out;
}

const fragment = (xml: string) => /<preliminaryRqmts[\s\S]*?<\/preliminaryRqmts>/.exec(xml)?.[0];

/** reader の参照（dmRef / pmRef）を下書きの参照に写す */
function toDraftRef(r: ContentRef): DraftRef {
  return {
    kind: r.kind as 'dmRef' | 'pmRef',
    target: r.target,
    ...(r.kind === 'dmRef' && r.techName !== undefined
      ? { title: r.techName, ...(r.infoName !== undefined ? { infoName: r.infoName } : {}) }
      : r.kind === 'pmRef' && r.title !== undefined
        ? { title: r.title }
        : {}),
    ...(r.issueInfo ? { issueInfo: r.issueInfo } : {}),
    ...(r.language ? { language: r.language } : {}),
    ...(r.fragment ? { fragment: r.fragment } : {}),
    ...(r.applicRefId ? { applicRefId: r.applicRefId } : {}),
  };
}

/** reader の節点を下書きに写す。写せないものは undefined と理由 */
function toDraft(n: ContentNode): { node?: DraftNode; reason?: string } {
  const id: { id?: string; applicRefId?: string } = n.id ? { id: n.id } : {};
  switch (n.kind) {
    case 'para': {
      if (!n.text) return { reason: 'para without text' };
      // 条件の参照は、dmRef / pmRef を 1 つだけ受け取る（文の中の参照は `[→ …]` として文に残る）
      const r = n.refs?.length === 1 ? n.refs[0] : undefined;
      const text = n.text.replace(/\s*\[→ [^\]]*\]\s*/g, ' ').trim() || n.text;
      if (r && (r.kind === 'dmRef' || r.kind === 'pmRef') && n.element !== 'reqCondNoRef')
        return {
          node: { kind: 'para', ...id, text, refs: [toDraftRef(r)] },
        };
      return { node: { kind: 'para', ...id, text: n.text } };
    }
    case 'person':
      return {
        node: {
          kind: 'person',
          ...(n.applicRefId !== undefined ? { applicRefId: n.applicRefId } : {}),
          ...(n.text !== undefined ? { text: n.text } : {}),
          ...(n.count !== undefined && n.man === undefined ? { count: n.count } : {}),
          ...(n.man !== undefined ? { man: n.man } : {}),
          ...(n.personCategoryCode !== undefined
            ? { personCategoryCode: n.personCategoryCode }
            : {}),
          ...(n.skillLevelCode !== undefined ? { skillLevelCode: n.skillLevelCode } : {}),
          ...(n.estimatedTime !== undefined && n.estimatedTimeUnit !== undefined
            ? { estimatedTime: n.estimatedTime, estimatedTimeUnit: n.estimatedTimeUnit }
            : {}),
        },
      };
    case 'document': {
      const r = n.refs?.[0];
      const category =
        n.reqTechInfoCategory !== undefined ? { reqTechInfoCategory: n.reqTechInfoCategory } : {};
      if (r && (r.kind === 'dmRef' || r.kind === 'pmRef'))
        return {
          node: {
            kind: 'document',
            ...category,
            refs: [toDraftRef(r)],
          },
        };
      if (n.title !== undefined || n.text !== undefined)
        return {
          node: {
            kind: 'document',
            ...category,
            ...(n.title !== undefined ? { title: n.title } : {}),
            ...(n.text !== undefined ? { text: n.text } : {}),
          },
        };
      return { reason: 'document without ref, title or code' };
    }
    case 'equipment':
    case 'supply':
    case 'spare':
      if (n.applicRefId !== undefined) Object.assign(id, { applicRefId: n.applicRefId });
      if (!n.manufacturerCode && !n.natoStockNumber)
        return { reason: `${n.kind} without identNumber/manufacturerCode` };
      if (
        n.natoStockNumber !== undefined &&
        !/^\d{4}-?\d{2}-?\d{3}-?\d{4}$/.test(n.natoStockNumber)
      )
        return { reason: `${n.kind} with an incomplete natoStockNumber` };
      if (!n.quantity) return { reason: `${n.kind} without reqQuantity text` };
      return {
        node: {
          kind: n.kind,
          ...id,
          ...(n.title !== undefined ? { title: n.title } : {}),
          ...(n.text !== undefined ? { text: n.text } : {}),
          quantity: n.quantity,
          ...(n.unit !== undefined ? { unit: n.unit } : {}),
          ...(n.partNumber !== undefined ? { partNumber: n.partNumber } : {}),
          ...(n.manufacturerCode ? { manufacturerCode: n.manufacturerCode } : {}),
          ...(n.natoStockNumber !== undefined ? { natoStockNumber: n.natoStockNumber } : {}),
        },
      };
    case 'admonition': {
      if (n.attrs?.referencedId) return { reason: `admonition by reference (${n.element})` };
      const paras = n.children
        .filter((c) => c.kind === 'para' && c.text)
        .map((c) => ({ kind: 'para' as const, text: c.text! }));
      if (!n.level || paras.length === 0) return { reason: 'admonition without text' };
      return {
        node: {
          kind: 'admonition',
          ...id,
          ...(n.applicRefId !== undefined ? { applicRefId: n.applicRefId } : {}),
          level: n.level,
          children: paras,
        },
      };
    }
    default:
      return { reason: `kind ${n.kind}` };
  }
}

/**
 * データモジュール 1 件の preliminaryRqmts を往復させて、失われた要素・属性を数える。
 * preliminaryRqmts が無い、または reader が `requirements` として返さないときは undefined
 */
export function measureRequirementsRoundTrip(xml: string): RequirementsRoundTrip | undefined {
  const source = fragment(xml);
  if (!source) return undefined;
  const pre = readContentFromXml(xml).blocks.find(
    (b) => b.kind === 'requirements' && b.element === 'preliminaryRqmts',
  );
  if (!pre) return undefined;
  const dropped: string[] = [];
  const children: DraftNode[] = [];
  const build = (kids: DraftNode[]) =>
    new XMLSerializer().serializeToString(
      buildContent('proced', [
        { kind: 'requirements', children: kids },
        { kind: 'step', text: 'x' },
      ]) as never,
    );
  for (const c of pre.children) {
    const d = toDraft(c);
    if (!d.node) {
      dropped.push(d.reason!);
      continue;
    }
    try {
      build([d.node]);
      children.push(d.node);
    } catch (e) {
      dropped.push(`${c.kind}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120));
    }
  }
  const original = inventory(source);
  const rebuilt = inventory(fragment(build(children))!);
  const lost: Record<string, number> = {};
  for (const [k, v] of Object.entries(original)) {
    const diff = v - (rebuilt[k] ?? 0);
    if (diff > 0) lost[k] = diff;
  }
  return { original, lost, dropped };
}

/** reader が preliminaryRqmts の中で読んでいる要素（構造として返す、または文・属性として読む） */
const READ_ELEMENTS = new Set([
  'preliminaryRqmts',
  'reqCondGroup',
  'noConds',
  'reqCondNoRef',
  'reqCondDm',
  'reqCondPm',
  'reqCondExternalPub',
  'reqCondCircuitBreaker',
  'reqPersons',
  'personnel',
  'person',
  'personCategory',
  'personSkill',
  'reqTechInfoGroup',
  'reqTechInfo',
  'reqSupportEquips',
  'noSupportEquips',
  'supportEquipDescrGroup',
  'supportEquipDescr',
  'reqSupplies',
  'noSupplies',
  'supplyDescrGroup',
  'supplyDescr',
  'reqSpares',
  'noSpares',
  'spareDescrGroup',
  'spareDescr',
  'embeddedSupportEquipDescr',
  'embeddedSupplyDescr',
  'embeddedSpareDescr',
  'identNumber',
  'partAndSerialNumber',
  'natoStockNumber',
  'reqSafety',
  'noSafety',
  'safetyRqmts',
  // 作業の場所・所要時間・間隔
  'productionMaintData',
  'workAreaLocationGroup',
  'workLocation',
  // 品目のほかの識別子（属性・name / shortName・参照を identifiers に返す）
  'catalogSeqNumberRef',
  'toolRef',
  'materialSetRef',
  'supplyRef',
  'supplyRqmtRef',
  'partRef',
  'functionalItemRef',
  'refs',
  // 品目の危険性と、備考の脚注
  'hazards',
  'hazard',
  'hazardRef',
  'footnoteRemarks',
]);

/** 中身ごと読んでいる要素（文として読む、参照として読む、節点として読む）。この下は調べない */
const READ_SUBTREES = new Set([
  'reqCond',
  'trade',
  'estimatedTime',
  'dmRef',
  'pmRef',
  'externalPubRef',
  'name',
  'shortName',
  'manufacturerCode',
  'partNumber',
  'fullNatoStockNumber',
  'reqQuantity',
  'remarks',
  'warning',
  'caution',
  'note',
  'thresholdInterval',
  'taskDuration',
  'zoneRef',
  'accessPointRef',
  'workArea',
  'installationLocation',
  'productItem',
  'symbol',
  'hazardousClass',
  'safetyInformation',
  'simplePara',
  'footnoteRef',
  'footnote',
  'internalRef',
]);

/**
 * preliminaryRqmts の中の要素のうち、reader が読んでおらず、読んでいないことも知らせていないものの名前を返す。
 * 空でなければ、reader が黙って落としている要素がある。
 * 参照（dmRef など）の中身は「読んでいる」とみなす。参照が返すのは行き先と題名だけで、版と言語は返していない
 */
export function findSilentlyDroppedElements(xml: string): string[] {
  const source = fragment(xml);
  if (!source) return [];
  const content = readContentFromXml(xml);
  if (!content.blocks.some((b) => b.kind === 'requirements' && b.element === 'preliminaryRqmts'))
    return [];
  const reported = new Set(Object.keys(content.notReadElements));
  const dropped = new Set<string>();
  const doc = new DOMParser().parseFromString(source, 'text/xml');
  const walk = (n: { nodeType: number; nodeName: string; childNodes: ArrayLike<unknown> }) => {
    if (n.nodeType !== 1) return;
    if (READ_SUBTREES.has(n.nodeName) || reported.has(n.nodeName)) return;
    if (!READ_ELEMENTS.has(n.nodeName)) {
      dropped.add(n.nodeName);
      return;
    }
    for (const c of Array.from(n.childNodes)) walk(c as never);
  };
  walk(doc.documentElement as never);
  return [...dropped].sort();
}

/**
 * reader が読んでいる属性（要素名 → 属性名）。`id`・`applicRefId`・`securityClassification` は節点に写るものだけを書く
 */
const READ_ATTRIBUTES: Record<string, string[]> = {
  reqCondNoRef: ['id', 'applicRefId', 'securityClassification'],
  reqCondDm: ['id', 'applicRefId', 'securityClassification'],
  reqCondPm: ['id', 'applicRefId', 'securityClassification'],
  reqCondExternalPub: ['id', 'applicRefId', 'securityClassification'],
  reqCondCircuitBreaker: ['id', 'applicRefId', 'securityClassification'],
  reqCond: ['reqCondCategory'],
  reqPersons: ['applicRefId'],
  personnel: ['id', 'numRequired', 'securityClassification'],
  person: ['id', 'man', 'securityClassification'],
  personCategory: ['personCategoryCode'],
  personSkill: ['skillLevelCode'],
  estimatedTime: ['unitOfMeasure'],
  reqTechInfo: ['reqTechInfoCategory'],
  supportEquipDescr: ['id', 'applicRefId', 'securityClassification', 'materialUsage'],
  supplyDescr: ['id', 'applicRefId', 'securityClassification', 'materialUsage', 'supplyCategory'],
  spareDescr: ['id', 'applicRefId', 'securityClassification', 'materialUsage'],
  embeddedSupportEquipDescr: ['id', 'applicRefId', 'securityClassification', 'materialUsage'],
  embeddedSupplyDescr: [
    'id',
    'applicRefId',
    'securityClassification',
    'materialUsage',
    'supplyCategory',
  ],
  embeddedSpareDescr: ['id', 'applicRefId', 'securityClassification', 'materialUsage'],
  natoStockNumber: ['natoSupplyClass', 'natoCodificationBureau', 'natoItemIdentNumberCore'],
  // `*` は、書かれている属性をすべて返す要素
  catalogSeqNumberRef: ['*'],
  toolRef: ['*'],
  materialSetRef: ['*'],
  supplyRef: ['*'],
  supplyRqmtRef: ['*'],
  partRef: ['*'],
  functionalItemRef: ['*'],
  productionMaintData: ['id', 'applicRefId'],
  workAreaLocationGroup: ['id', 'applicRefId'],
  workLocation: ['id', 'applicRefId'],
  thresholdInterval: ['*'],
  taskDuration: ['*'],
  zoneRef: ['*'],
  accessPointRef: ['*'],
  workArea: ['*'],
  installationLocation: ['*'],
  productItem: ['*'],
  hazard: ['id', 'securityClassification'],
  hazardRef: ['*'],
  symbol: ['infoEntityIdent'],
  hazardousClass: ['hazardousClassValue'],
  safetyInformation: ['*'],
  footnoteRemarks: ['applicRefId'],
  footnoteRef: ['internalRefId'],
  footnote: ['id', 'applicRefId', 'securityClassification', 'footnoteMark'],
  reqQuantity: ['unitOfMeasure'],
  safetyRqmts: ['warningRefs', 'cautionRefs'],
  warning: ['id', 'applicRefId', 'securityClassification'],
  caution: ['id', 'applicRefId', 'securityClassification'],
  note: ['id', 'applicRefId', 'securityClassification'],
  dmRef: ['applicRefId', 'referredFragment'],
  pmRef: ['applicRefId'],
  dmCode: [
    'modelIdentCode',
    'systemDiffCode',
    'systemCode',
    'subSystemCode',
    'subSubSystemCode',
    'assyCode',
    'disassyCode',
    'disassyCodeVariant',
    'infoCode',
    'infoCodeVariant',
    'itemLocationCode',
    'learnCode',
    'learnEventCode',
  ],
  pmCode: ['modelIdentCode', 'pmIssuer', 'pmNumber', 'pmVolume'],
  issueInfo: ['issueNumber', 'inWork'],
  language: ['languageIsoCode', 'countryIsoCode'],
};

/** 参照の中で、子まで調べる要素（属性を読んでいるので、落としていないかを確かめる） */
const REF_STRUCTURE = new Set(['dmRef', 'pmRef', 'dmRefIdent', 'pmRefIdent', 'reqTechInfo']);

/**
 * preliminaryRqmts の中の属性のうち、reader が読んでおらず、読んでいないことも知らせていないものを
 * `要素/@属性` の形で返す。調べるのは、reader が構造として読む要素と、参照（dmRef / pmRef）の中。
 * 文として読む要素（reqCond・警告の本文など）の中と、知らせた要素（notReadElements）の中は調べない
 */
export function findSilentlyDroppedAttributes(xml: string): string[] {
  const source = fragment(xml);
  if (!source) return [];
  const content = readContentFromXml(xml);
  if (!content.blocks.some((b) => b.kind === 'requirements' && b.element === 'preliminaryRqmts'))
    return [];
  const reported = new Set(Object.keys(content.notReadElements));
  const dropped = new Set<string>();
  const doc = new DOMParser().parseFromString(source, 'text/xml');
  type El = { nodeType: number; nodeName: string; childNodes: ArrayLike<unknown> };
  const walk = (n: El) => {
    if (n.nodeType !== 1 || reported.has(n.nodeName)) return;
    const e = n as unknown as { nodeName: string; attributes: ArrayLike<{ name: string }> };
    const read = READ_ATTRIBUTES[e.nodeName] ?? [];
    for (const a of Array.from(e.attributes))
      if (!read.includes('*') && !read.includes(a.name)) dropped.add(`${e.nodeName}/@${a.name}`);
    const descend =
      READ_ELEMENTS.has(n.nodeName) ||
      REF_STRUCTURE.has(n.nodeName) ||
      ['reqCondDm', 'reqCondPm'].includes(n.nodeName);
    if (!descend && READ_SUBTREES.has(n.nodeName)) return;
    if (!descend && !READ_ELEMENTS.has(n.nodeName)) return;
    for (const c of Array.from(n.childNodes)) walk(c as El);
  };
  walk(doc.documentElement as El);
  return [...dropped].sort();
}
