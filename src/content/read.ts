/**
 * 内容部を共通の形（ContentNode の木）に読み取る。
 *
 * 方針:
 * - 要素名 → kind の対応表で変換する。表に無い要素は `unknown` として残し、名前と数を `unknownElements` に数える
 *   （読み取り部分を育てるための材料。黙って捨てない）
 * - 文（text）は段落の中の文字と行内要素から組み立て、参照は `[→ …]` の形で埋め込む。参照そのものは `refs` にも入れる
 * - 手順（step）の番号は兄弟の順で 1、1.1、… と組み立てる
 * - 適用性の判定はしない。`@applicRefId` を残すだけ（判定は ApplicEvaluator）
 *
 * Bike Samples の実測（2026-10-25）で出てきた要素を対象にした。descript 734・proced 3,420・process 214・fault 204・pm 1,003 タグ。
 */
import { describeLocation } from '../brex/check.js';
import { readDataModuleInfo, readDmCodeElement } from '../data-module.js';
import { formatDmc } from '../dmc.js';
import type { Document, Element, XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import type {
  ContentKind,
  ContentNode,
  ContentNodeKind,
  ContentRef,
  DataModuleContent,
} from './types.js';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** ブロック要素 → kind */
const BLOCKS: Record<string, ContentNodeKind> = {
  levelledPara: 'section',
  pmEntry: 'section',
  dmNode: 'section',
  para: 'para',
  notePara: 'para',
  warningAndCautionPara: 'para',
  attentionListItemPara: 'para',
  simplePara: 'para',
  paraBasic: 'para',
  action: 'para',
  descr: 'para',
  randomList: 'list',
  sequentialList: 'list',
  definitionList: 'list',
  attentionRandomList: 'list',
  attentionSequentialList: 'list',
  listOfChoices: 'list',
  listItem: 'listItem',
  attentionRandomListItem: 'listItem',
  attentionSequentialListItem: 'listItem',
  definitionListItem: 'definition',
  table: 'table',
  figure: 'figure',
  foldout: 'figure',
  multimedia: 'figure',
  warning: 'admonition',
  caution: 'admonition',
  note: 'admonition',
  proceduralStep: 'step',
  isolationStep: 'step',
  isolationProcedureEnd: 'step',
  preliminaryRqmts: 'requirements',
  closeRqmts: 'requirements',
  dmSeq: 'sequence',
  dmIf: 'if',
  dialog: 'dialog',
  dialogGroup: 'dialog',
  userEntry: 'dialog',
  menu: 'dialog',
  menuChoice: 'listItem',
  commonInfoDescrPara: 'para',
};

/** 中身をそのまま辿る（節点を作らない）容れ物の要素 */
const TRANSPARENT = new Set([
  'content',
  'description',
  'procedure',
  'mainProcedure',
  'process',
  'faultIsolation',
  'faultIsolationProcedure',
  'isolationProcedure',
  'isolationMainProcedure',
  'faultReporting',
  'isolateDetectedFault',
  'detectedFault',
  'correlatedFault',
  'isolatedFault',
  'locateAndRepair',
  'commonRepository',
  'tgroup',
  'tbody',
  'thead',
  'tfoot',
  'isolationStepAnswer',
  'yesNoAnswer',
  'proceduralStepAlts',
  'figureAlts',
  'dmSeqAlts',
  'dmThenSeq',
  'dmElseSeq',
  'dmLoop',
  'warningsAndCautions',
  'commonInfo',
]);

/** 読まない（識別・状態部に属する、または本文の意味に関わらない）要素 */
const SKIP = new Set([
  'refs',
  'referencedApplicGroup',
  'referencedApplicGroupRef',
  'variableDeclarations',
  'variablePreSet',
  'title',
  'pmEntryTitle',
  'isolationStepQuestion',
  'faultDescr',
  'fault',
  'colspec',
  'spanspec',
  'graphic',
  'symbol',
  'hotspot',
  'dmRef',
  'pmRef',
  'externalPubRef',
  'internalRef',
  'listItemTerm',
  'listItemDefinition',
  'definitionListHeader',
  'applic',
  'choice',
  'yesAnswer',
  'noAnswer',
  'prompt',
  'validate',
  'assertion',
  'noAssertions',
  'variablePostSet',
  'message',
  'warningRef',
  'cautionRef',
  'warningsAndCautionsRef',
]);

/** 行内要素（文の一部として読む） */
const INLINE = new Set([
  'emphasis',
  'verbatimText',
  'subScript',
  'superScript',
  'indexFlag',
  'changeInline',
  'acronym',
  'acronymTerm',
  'acronymDefinition',
  'quantity',
  'quantityGroup',
  'quantityValue',
  'quantityTolerance',
  'inlineSignificantData',
  'footnote',
  'symbol',
  'xref',
  'variableRef',
  'expression',
  'booleanValue',
  'trueValue',
  'falseValue',
  'stringValue',
  'integerValue',
  'realValue',
]);

function attr(el: Element, name: string): string | undefined {
  const v = el.getAttribute(name);
  return v === null || v === '' ? undefined : v;
}

function elements(el: Element): Element[] {
  return Array.from(el.childNodes).filter((n): n is Element => n.nodeType === ELEMENT_NODE);
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function firstChild(el: Element, name: string): Element | undefined {
  return elements(el).find((c) => c.nodeName === name);
}

function deepText(el: Element): string {
  return norm(el.textContent ?? '');
}

class Reader {
  readonly unknown: Record<string, number> = {};
  constructor(private readonly engine: XmlEngine) {}

  private refOf(el: Element): ContentRef | undefined {
    switch (el.nodeName) {
      case 'dmRef': {
        const code = this.engine.selectNodes('dmRefIdent/dmCode', el)[0] as Element | undefined;
        const dm = code ? readDmCodeElement(code) : undefined;
        const tech = this.engine.selectString('dmRefAddressItems/dmTitle/techName', el);
        const info = this.engine.selectString('dmRefAddressItems/dmTitle/infoName', el);
        const title =
          [tech, info]
            .filter(Boolean)
            .map((s) => norm(s!))
            .join(' - ') || undefined;
        return { kind: 'dmRef', target: dm?.ok ? formatDmc(dm.value) : '(invalid dmCode)', title };
      }
      case 'pmRef': {
        const code = this.engine.selectNodes('pmRefIdent/pmCode', el)[0] as Element | undefined;
        const target = code
          ? [
              attr(code, 'modelIdentCode'),
              attr(code, 'pmIssuer'),
              attr(code, 'pmNumber'),
              attr(code, 'pmVolume'),
            ].join('-')
          : '(no pmCode)';
        const title = this.engine.selectString('pmRefAddressItems/pmTitle', el);
        return { kind: 'pmRef', target, title: title ? norm(title) : undefined };
      }
      case 'internalRef':
        return {
          kind: 'internalRef',
          target: attr(el, 'internalRefId') ?? '',
          note: attr(el, 'internalRefTargetType'),
        };
      case 'externalPubRef': {
        const code = this.engine.selectString('externalPubRefIdent/externalPubCode', el);
        const title = this.engine.selectString('externalPubRefIdent/externalPubTitle', el);
        return {
          kind: 'externalPubRef',
          target: norm(code ?? title ?? ''),
          title: title ? norm(title) : undefined,
        };
      }
      case 'graphic':
      case 'symbol':
        return { kind: 'graphic', target: attr(el, 'infoEntityIdent') ?? '' };
      case 'multimediaObject':
        return { kind: 'multimedia', target: attr(el, 'infoEntityIdent') ?? '' };
      default:
        return undefined;
    }
  }

  /** 行内の文を組み立てる。参照は `[→ …]` で埋め込み、refs に集める */
  private inlineText(el: Element, refs: ContentRef[]): string {
    const parts: string[] = [];
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === TEXT_NODE) {
        parts.push(n.nodeValue ?? '');
        continue;
      }
      if (n.nodeType !== ELEMENT_NODE) continue;
      const c = n as Element;
      const ref = this.refOf(c);
      if (ref) {
        refs.push(ref);
        parts.push(ref.title ? ` [→ ${ref.target} ${ref.title}] ` : ` [→ ${ref.target}] `);
        continue;
      }
      if (INLINE.has(c.nodeName) || !BLOCKS[c.nodeName]) {
        parts.push(this.inlineText(c, refs));
        continue;
      }
      // 段落の中にブロック要素があるときは文には含めない（子として読まれる）
    }
    return norm(parts.join(''));
  }

  private tableRows(table: Element): string[][] {
    const rows: string[][] = [];
    for (const row of this.engine.selectNodes('.//row', table)) {
      rows.push(
        elements(row as Element)
          .filter((e) => e.nodeName === 'entry')
          .map((e) => deepText(e)),
      );
    }
    return rows;
  }

  /** 要素 1 つを節点にする。容れ物なら子をそのまま返す */
  readElement(el: Element, stepCounter?: { n: number; prefix: string }): ContentNode[] {
    const name = el.nodeName;
    if (SKIP.has(name)) return [];
    if (TRANSPARENT.has(name)) return this.readChildren(el, stepCounter);
    const kind: ContentNodeKind = BLOCKS[name] ?? 'unknown';
    if (kind === 'unknown') this.unknown[name] = (this.unknown[name] ?? 0) + 1;

    const node: ContentNode = { kind, element: name, children: [], location: describeLocation(el) };
    const id = attr(el, 'id');
    if (id) node.id = id;
    const applicRefId = attr(el, 'applicRefId');
    if (applicRefId) node.applicRefId = applicRefId;
    const security = attr(el, 'securityClassification');
    if (security) node.securityClassification = security;
    const refs: ContentRef[] = [];

    const title = firstChild(el, 'title') ?? firstChild(el, 'pmEntryTitle');
    if (title) node.title = this.inlineText(title, refs);

    switch (kind) {
      case 'para':
        node.text = this.inlineText(el, refs);
        break;
      case 'admonition':
        node.level = name as 'warning' | 'caution' | 'note';
        node.children = this.readChildren(el);
        break;
      case 'list':
        node.ordered = name === 'sequentialList' || name === 'attentionSequentialList';
        node.children = this.readChildren(el);
        break;
      case 'listItem': {
        // listItem は para を持つ。短い項目は text にまとめる
        const kids = this.readChildren(el);
        if (kids.length === 1 && kids[0].kind === 'para' && kids[0].children.length === 0) {
          node.text = kids[0].text;
          if (kids[0].refs) refs.push(...kids[0].refs);
        } else node.children = kids;
        break;
      }
      case 'definition': {
        const term = firstChild(el, 'listItemTerm');
        const def = firstChild(el, 'listItemDefinition');
        node.title = term ? this.inlineText(term, refs) : undefined;
        node.children = def ? this.readChildren(def) : [];
        break;
      }
      case 'table':
        node.rows = this.tableRows(el);
        break;
      case 'figure': {
        for (const g of this.engine.selectNodes(
          './/graphic | .//symbol | .//multimediaObject',
          el,
        )) {
          const r = this.refOf(g as Element);
          if (r) {
            const hotspots = this.engine
              .selectNodes('hotspot/@applicationStructureIdent', g)
              .map((h) => h.nodeValue ?? '')
              .filter(Boolean);
            if (hotspots.length > 0) r.note = `hotspots: ${hotspots.join(', ')}`;
            refs.push(r);
          }
        }
        break;
      }
      case 'step': {
        if (stepCounter) {
          stepCounter.n++;
          node.number = stepCounter.prefix
            ? `${stepCounter.prefix}.${stepCounter.n}`
            : String(stepCounter.n);
        }
        const question = firstChild(el, 'isolationStepQuestion');
        if (question) node.question = this.inlineText(question, refs);
        const choices = this.engine.selectNodes(
          'isolationStepAnswer/listOfChoices/choice',
          el,
        ) as Element[];
        if (choices.length > 0) {
          node.choices = choices.map((c) => ({
            text: this.inlineText(c, refs),
            nextActionRefId: attr(c, 'nextActionRefId'),
          }));
        }
        const yesNo = this.engine.selectNodes('isolationStepAnswer/yesNoAnswer/*', el) as Element[];
        if (yesNo.length > 0) {
          node.choices = yesNo.map((c) => ({
            text: c.nodeName === 'yesAnswer' ? 'yes' : 'no',
            nextActionRefId: attr(c, 'nextActionRefId'),
          }));
        }
        const childCounter = { n: 0, prefix: node.number ?? '' };
        node.children = this.readChildren(el, childCounter).filter(
          (c) => !(c.kind === 'list' && c.element === 'listOfChoices'),
        );
        // 手順の文（直下の para）は text にまとめ、残り（警告・図・子手順）を children に残す
        const paras = node.children.filter((c) => c.kind === 'para' && c.children.length === 0);
        if (paras.length > 0) {
          node.text = paras
            .map((p) => p.text)
            .filter(Boolean)
            .join(' ');
          for (const p of paras) if (p.refs) refs.push(...p.refs);
          node.children = node.children.filter((c) => !paras.includes(c));
        }
        break;
      }
      case 'requirements':
        node.text = this.requirementsText(el, refs);
        break;
      case 'if': {
        node.text = attr(el, 'applicRefId') ? `if applic ${attr(el, 'applicRefId')}` : undefined;
        node.children = this.readChildren(el, stepCounter);
        break;
      }
      case 'section':
      case 'sequence':
      case 'dialog':
      case 'unknown':
      default: {
        if (kind === 'dialog') {
          const prompt =
            this.engine.selectString('prompt', el) ?? this.engine.selectString('.//prompt', el);
          if (prompt) node.text = norm(prompt);
          const v = this.engine.selectString('variableRef/@variableName', el);
          if (v) node.attrs = { variableName: v };
        }
        if (name === 'pmEntry') {
          // pm の項目: dmRef / pmRef は entry、入れ子の pmEntry は section。文書の順を保つ
          for (const c of elements(el)) {
            const r = this.refOf(c);
            if (r) {
              node.children.push({
                kind: 'entry',
                element: c.nodeName,
                text: r.target,
                title: r.title,
                refs: [r],
                children: [],
                location: describeLocation(c),
              });
            } else node.children.push(...this.readElement(c));
          }
        } else {
          node.children = this.readChildren(
            el,
            kind === 'section' ? { n: 0, prefix: '' } : stepCounter,
          );
          if (kind === 'unknown' && node.children.length === 0)
            node.text = this.inlineText(el, refs);
        }
      }
    }
    if (refs.length > 0) node.refs = refs;
    return [node];
  }

  readChildren(el: Element, stepCounter?: { n: number; prefix: string }): ContentNode[] {
    const out: ContentNode[] = [];
    for (const c of elements(el)) out.push(...this.readElement(c, stepCounter));
    return out;
  }

  /** preliminaryRqmts / closeRqmts を 1 つの文に要約する */
  private requirementsText(el: Element, refs: ContentRef[]): string {
    const parts: string[] = [];
    const list = (label: string, expr: string, noneExpr: string) => {
      const items = this.engine.selectNodes(expr, el) as Element[];
      if (items.length > 0)
        parts.push(`${label}: ${items.map((i) => this.inlineText(i, refs)).join('; ')}`);
      else if (this.engine.selectNodes(noneExpr, el).length > 0) parts.push(`${label}: none`);
    };
    list(
      'conditions',
      'reqCondGroup/reqCondNoRef/reqCond | reqCondGroup/reqCondDm/reqCond | reqCondGroup/reqCondPm/reqCond | reqCondGroup/reqCondExternalPub/reqCond | reqCondGroup/reqCondCircuitBreaker/reqCond',
      'reqCondGroup/noConds',
    );
    const persons = this.engine.selectNodes('reqPersons/person', el) as Element[];
    if (persons.length > 0) {
      parts.push(
        `persons: ${persons
          .map((p) => {
            const trade = this.engine.selectString('trade', p);
            const cat = this.engine.selectString('personCategory/@personCategoryCode', p);
            const time = this.engine.selectString('estimatedTime', p);
            const unit = this.engine.selectString('estimatedTime/@unitOfMeasure', p);
            return [
              attr(p, 'man'),
              cat,
              trade,
              time ? `${norm(time)} ${unit ?? ''}`.trim() : undefined,
            ]
              .filter(Boolean)
              .join(' / ');
          })
          .join('; ')}`,
      );
    }
    const descrList = (label: string, expr: string, noneExpr: string) => {
      const items = this.engine.selectNodes(expr, el) as Element[];
      if (items.length > 0) {
        parts.push(
          `${label}: ${items
            .map((i) => {
              const name = this.engine.selectString('name', i);
              const pn = this.engine.selectString('identNumber/partAndSerialNumber/partNumber', i);
              const qty = this.engine.selectString('reqQuantity', i);
              return [name && norm(name), pn && `P/N ${norm(pn)}`, qty && `x${norm(qty)}`]
                .filter(Boolean)
                .join(' ');
            })
            .join('; ')}`,
        );
      } else if (this.engine.selectNodes(noneExpr, el).length > 0) parts.push(`${label}: none`);
    };
    descrList(
      'support equipment',
      'reqSupportEquips//supportEquipDescr',
      'reqSupportEquips/noSupportEquips',
    );
    descrList('supplies', 'reqSupplies//supplyDescr', 'reqSupplies/noSupplies');
    descrList('spares', 'reqSpares//spareDescr', 'reqSpares/noSpares');
    const safety = this.engine.selectNodes('reqSafety/safetyRqmts/*', el) as Element[];
    if (safety.length > 0)
      parts.push(`safety: ${safety.map((s) => `${s.nodeName}: ${deepText(s)}`).join('; ')}`);
    else if (this.engine.selectNodes('reqSafety/noSafety', el).length > 0)
      parts.push('safety: none');
    return parts.join('. ');
  }
}

function kindOf(schemaName: string | undefined): ContentKind {
  switch (schemaName) {
    case 'descript':
    case 'proced':
    case 'process':
    case 'fault':
    case 'pm':
      return schemaName;
    default:
      return 'other';
  }
}

/** 内容部を読む。識別・状態部は readDataModuleInfo で別に読む */
export function readContent(
  document: Document,
  engine: XmlEngine = defaultXmlEngine,
): DataModuleContent {
  const root = document.documentElement;
  const schemaName = root ? readDataModuleInfoSchema(root) : undefined;
  const kind = kindOf(schemaName);
  const notes: string[] = [];
  if (kind === 'other') {
    notes.push(
      `Content of schema "${schemaName ?? '(unknown)'}" is not structured yet; only the identification and status section is read.`,
    );
    return { schemaName, kind, structured: false, blocks: [], notes, unknownElements: {} };
  }
  const content = engine.selectNodes('/*/content', document)[0] as Element | undefined;
  if (!content) {
    notes.push('The document has no <content> element.');
    return { schemaName, kind, structured: true, blocks: [], notes, unknownElements: {} };
  }
  const reader = new Reader(engine);
  const blocks = reader.readChildren(content, { n: 0, prefix: '' });
  const unknownTotal = Object.values(reader.unknown).reduce((a, b) => a + b, 0);
  if (unknownTotal > 0) {
    notes.push(
      `${unknownTotal} element(s) of ${Object.keys(reader.unknown).length} kind(s) were kept as "unknown" (text only): ${Object.keys(reader.unknown).join(', ')}.`,
    );
  }
  return { schemaName, kind, structured: true, blocks, notes, unknownElements: reader.unknown };
}

function readDataModuleInfoSchema(root: Element): string | undefined {
  const loc =
    root.getAttribute('xsi:noNamespaceSchemaLocation') ??
    root.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'noNamespaceSchemaLocation');
  const m = /([A-Za-z0-9_-]+)\.xsd$/i.exec(loc ?? '');
  return m ? m[1].toLowerCase() : undefined;
}

/** XML 文字列から内容部を読む */
export function readContentFromXml(
  xml: string,
  engine: XmlEngine = defaultXmlEngine,
): DataModuleContent {
  const parsed = engine.parse(xml);
  const info = readDataModuleInfo(xml, engine);
  const c = readContent(parsed.document, engine);
  if (!c.schemaName && info.schemaName) c.schemaName = info.schemaName;
  return c;
}

/** 木を平らにして数える（テストと reader の集計用） */
export function countNodes(nodes: ContentNode[]): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (ns: ContentNode[]) => {
    for (const n of ns) {
      out[n.kind] = (out[n.kind] ?? 0) + 1;
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
