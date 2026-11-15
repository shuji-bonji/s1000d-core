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

/** 品目（supportEquipDescr など）の子のうち、中身を読んでいない要素（識別子以外） */
const ITEM_NOT_READ = new Set([
  'embeddedSupportEquipDescr',
  'embeddedSupplyDescr',
  'embeddedSpareDescr',
  'hazards',
  'footnoteRemarks',
]);

/** 品目（supportEquipDescr など）の識別子のうち、identNumber 以外の要素 */
const ITEM_IDENTIFIERS = new Set([
  'catalogSeqNumberRef',
  'natoStockNumber',
  'toolRef',
  'materialSetRef',
  'supplyRef',
  'supplyRqmtRef',
  'partRef',
  'functionalItemRef',
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
  /** あることは分かっているが、中身を読んでいない要素（名前 → 数） */
  readonly notRead: Record<string, number> = {};

  private markNotRead(name: string): void {
    this.notRead[name] = (this.notRead[name] ?? 0) + 1;
  }

  /** 参照（dmRef など）の子のうち、読んでいる要素（`read`）以外を「読んでいない」として数える */
  private markRefNotRead(el: Element, read: string[]): void {
    for (const c of elements(el)) if (!read.includes(c.nodeName)) this.markNotRead(c.nodeName);
  }

  /** dmRefIdent / pmRefIdent の issueInfo と language を参照に写す。identExtension は読んでいない */
  private refIdentTail(ref: ContentRef, ident: Element | undefined): void {
    if (!ident) return;
    const issue = firstChild(ident, 'issueInfo');
    const issueNumber = issue ? attr(issue, 'issueNumber') : undefined;
    const inWork = issue ? attr(issue, 'inWork') : undefined;
    if (issueNumber && inWork) ref.issueInfo = { issueNumber, inWork };
    const lang = firstChild(ident, 'language');
    const languageIsoCode = lang ? attr(lang, 'languageIsoCode') : undefined;
    const countryIsoCode = lang ? attr(lang, 'countryIsoCode') : undefined;
    if (languageIsoCode && countryIsoCode) ref.language = { languageIsoCode, countryIsoCode };
    if (firstChild(ident, 'identExtension')) this.markNotRead('identExtension');
  }
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
        const ref: ContentRef = {
          kind: 'dmRef',
          target: dm?.ok ? formatDmc(dm.value) : '(invalid dmCode)',
          title,
        };
        if (tech) ref.techName = norm(tech);
        if (info) ref.infoName = norm(info);
        this.refIdentTail(ref, firstChild(el, 'dmRefIdent'));
        const fragment = attr(el, 'referredFragment');
        if (fragment) ref.fragment = fragment;
        const applic = attr(el, 'applicRefId');
        if (applic) ref.applicRefId = applic;
        this.markRefNotRead(el, ['dmRefIdent', 'dmRefAddressItems']);
        return ref;
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
        const ref: ContentRef = { kind: 'pmRef', target, title: title ? norm(title) : undefined };
        this.refIdentTail(ref, firstChild(el, 'pmRefIdent'));
        const applic = attr(el, 'applicRefId');
        if (applic) ref.applicRefId = applic;
        this.markRefNotRead(el, ['pmRefIdent', 'pmRefAddressItems']);
        return ref;
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
        // 題名と番号だけを読む。発行情報（externalPubIssueInfo）などは読んでいない
        this.markRefNotRead(el, ['externalPubRefIdent']);
        const ident = firstChild(el, 'externalPubRefIdent');
        if (ident)
          for (const c of elements(ident))
            if (c.nodeName !== 'externalPubCode' && c.nodeName !== 'externalPubTitle')
              this.markNotRead(c.nodeName);
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

  /**
   * 文として読む要素の中にあるブロック要素を、節点として読む（`inlineText` が文に入れなかったもの）。
   * S1000D では、リスト（`randomList`・`sequentialList`・`definitionList`）は `para` の中に書くのが普通である
   */
  private blockChildren(el: Element): ContentNode[] {
    const out: ContentNode[] = [];
    for (const c of elements(el)) {
      if (this.refOf(c)) continue;
      if (INLINE.has(c.nodeName) || !BLOCKS[c.nodeName]) out.push(...this.blockChildren(c));
      else out.push(...this.readElement(c));
    }
    return out;
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
        // 段落の中のブロック要素（リスト・表・図・注意書きなど）は、文には入れず子として読む
        node.children = this.blockChildren(el);
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
        node.children = this.requirementsChildren(el);
        break;
      case 'if': {
        node.text = attr(el, 'applicRefId') ? `if applic ${attr(el, 'applicRefId')}` : undefined;
        // 条件: expression/@humanReadableForm が人が読む文（書く側は DraftNode.question から作る）。
        // 式の中身（演算・値）は評価しない。変数 1 つを参照するだけの式なら、その名前を attrs に残す
        const expression = firstChild(el, 'expression');
        if (expression) {
          const readable = attr(expression, 'humanReadableForm');
          if (readable) node.question = norm(readable);
          const vars = elements(expression).filter((c) => c.nodeName === 'variableRef');
          const v = vars.length === 1 ? attr(vars[0], 'variableName') : undefined;
          if (v && elements(expression).length === 1) node.attrs = { variableName: v };
        }
        // 条件を読めた expression は子に残さない。読めなかった式（文が無く、変数 1 つでもない）は unknown として残す
        const conditionRead = node.question !== undefined || node.attrs !== undefined;
        node.children = [];
        for (const c of elements(el)) {
          if (c === expression && conditionRead) continue;
          node.children.push(...this.readElement(c, stepCounter));
        }
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
          if (name === 'dmNode') {
            // プロセスの節点が指す DM・PM・文書（dmNode の直下の参照）
            for (const c of elements(el)) {
              const r = this.refOf(c);
              if (r) refs.push(r);
            }
          }
          node.children = this.readChildren(
            el,
            kind === 'section' ? { n: 0, prefix: '' } : stepCounter,
          );
          if (kind === 'unknown' && node.children.length === 0)
            node.text = this.inlineText(el, refs);
        }
      }
    }
    // @warningRefs / @cautionRefs（共通の警告・注意への参照）は、参照先を admonition として先頭に置く。
    // safetyRqmts の分は requirementsChildren が読む
    if (kind !== 'requirements') {
      const referenced = this.referencedAdmonitions(el);
      if (referenced.length > 0) node.children = [...referenced, ...node.children];
    }
    if (refs.length > 0) node.refs = refs;
    return [node];
  }

  /**
   * `@warningRefs` / `@cautionRefs`（IDREFS）が指す警告・注意を admonition の節点にする。
   * 参照先は、同じ DM の `warningsAndCautions` の warning / caution（本文を読む）か、
   * `warningsAndCautionsRef` の warningRef / cautionRef（別の DM への dmRef。本文は読まず、`refs` と識別番号を返す）。
   * どの節点にも `attrs.referencedId` を付ける。見つからない id は `attrs.unresolved` を付けて返す（黙って落とさない）
   */
  private referencedAdmonitions(el: Element): ContentNode[] {
    const out: ContentNode[] = [];
    for (const [attrName, level] of [
      ['warningRefs', 'warning'],
      ['cautionRefs', 'caution'],
    ] as const) {
      for (const id of (attr(el, attrName) ?? '').split(/\s+/).filter(Boolean)) {
        const target = /^[\w.-]+$/.test(id)
          ? (this.engine.selectNodes(`//*[@id="${id}"]`, el)[0] as Element | undefined)
          : undefined;
        if (target && (target.nodeName === 'warning' || target.nodeName === 'caution')) {
          for (const n of this.readElement(target)) {
            n.attrs = { ...(n.attrs ?? {}), referencedId: id };
            out.push(n);
          }
          continue;
        }
        const node: ContentNode = {
          kind: 'admonition',
          element: target?.nodeName ?? attrName,
          level,
          id,
          children: [],
          location: describeLocation(target ?? el),
          attrs: { referencedId: id },
        };
        if (target && (target.nodeName === 'warningRef' || target.nodeName === 'cautionRef')) {
          const number = attr(target, 'warningIdentNumber') ?? attr(target, 'cautionIdentNumber');
          if (number) node.attrs!.identNumber = number;
          const r = elements(target)
            .map((c) => this.refOf(c))
            .find((x) => x !== undefined);
          if (r) node.refs = [r];
        } else node.attrs!.unresolved = 'true';
        out.push(node);
      }
    }
    return out;
  }

  readChildren(el: Element, stepCounter?: { n: number; prefix: string }): ContentNode[] {
    const out: ContentNode[] = [];
    for (const c of elements(el)) out.push(...this.readElement(c, stepCounter));
    return out;
  }

  /**
   * preliminaryRqmts の人員・文書・品目・安全の要件を、子の節点として返す（書く側の `DraftNode` と同じ種類）。
   * 条件（reqCondGroup）は要約の文（`text`）にだけ入れる
   */
  private requirementsChildren(el: Element): ContentNode[] {
    const out: ContentNode[] = [];
    const base = (kind: ContentNodeKind, e: Element): ContentNode => {
      const n: ContentNode = {
        kind,
        element: e.nodeName,
        children: [],
        location: describeLocation(e),
      };
      const id = attr(e, 'id');
      if (id) n.id = id;
      const applicRefId = attr(e, 'applicRefId');
      if (applicRefId) n.applicRefId = applicRefId;
      const security = attr(e, 'securityClassification');
      if (security) n.securityClassification = security;
      return n;
    };
    const str = (expr: string, e: Element) => {
      const v = this.engine.selectString(expr, e);
      return v ? norm(v) : undefined;
    };
    const put = (attrs: Record<string, string>, key: string, v: string | undefined) => {
      if (v) attrs[key] = v;
    };

    // 作業の場所・所要時間など（productionMaintData）は読んでいない。あることを知らせる
    for (const c of elements(el)) {
      if (c.nodeName !== 'productionMaintData') continue;
      this.markNotRead('productionMaintData');
      out.push({
        ...base('unknown', c),
        attrs: { notRead: 'productionMaintData' },
      });
    }

    // 条件: 文（reqCond）と、あれば参照（reqCondDm の dmRef など）
    for (const cond of this.engine.selectNodes('reqCondGroup/*', el) as Element[]) {
      if (cond.nodeName === 'noConds') continue;
      const n = base('para', cond);
      const condRefs: ContentRef[] = [];
      const reqCond = firstChild(cond, 'reqCond');
      if (reqCond) n.text = this.inlineText(reqCond, condRefs);
      const category = reqCond ? attr(reqCond, 'reqCondCategory') : undefined;
      if (category) n.attrs = { ...(n.attrs ?? {}), reqCondCategory: category };
      for (const c of elements(cond)) {
        if (c.nodeName === 'reqCond') continue;
        const r = this.refOf(c);
        if (r) condRefs.push(r);
      }
      if (condRefs.length > 0) n.refs = condRefs;
      if (cond.nodeName === 'reqCondCircuitBreaker') {
        // 回路遮断器の条件は、文と参照以外（遮断器の一覧・操作）を読んでいない
        n.attrs = { ...(n.attrs ?? {}), notRead: 'circuitBreakerDescrGroup' };
        this.markNotRead('circuitBreakerDescrGroup');
      }
      out.push(n);
    }

    for (const p of this.engine.selectNodes(
      'reqPersons/personnel | reqPersons/person',
      el,
    ) as Element[]) {
      const n = base('person', p);
      const trade = str('trade', p);
      if (trade) n.text = trade;
      const num = attr(p, 'numRequired');
      if (num && /^\d+$/.test(num)) n.count = Number(num);
      // 適用性は reqPersons に付く（personnel / person には属性が無い）ので、人員の節点に写す
      const group = p.parentNode as Element | null;
      const groupApplic = group ? attr(group, 'applicRefId') : undefined;
      if (groupApplic) n.applicRefId = groupApplic;
      const man = attr(p, 'man');
      if (man) n.man = man;
      const category = str('personCategory/@personCategoryCode', p);
      if (category) n.personCategoryCode = category;
      const skill = str('personSkill/@skillLevelCode', p);
      if (skill) n.skillLevelCode = skill;
      const time = str('estimatedTime', p);
      if (time) n.estimatedTime = time;
      const timeUnit = str('estimatedTime/@unitOfMeasure', p);
      if (timeUnit) n.estimatedTimeUnit = timeUnit;
      out.push(n);
    }

    for (const info of this.engine.selectNodes('reqTechInfoGroup/reqTechInfo', el) as Element[]) {
      const n = base('document', info);
      const refEl = elements(info)[0];
      const r = refEl ? this.refOf(refEl) : undefined;
      if (r) {
        n.refs = [r];
        if (r.title) n.title = r.title;
      }
      if (refEl?.nodeName === 'externalPubRef') {
        const code = str('externalPubRefIdent/externalPubCode', refEl);
        if (code) n.text = code;
      }
      const category = attr(info, 'reqTechInfoCategory');
      if (category) n.reqTechInfoCategory = category;
      out.push(n);
    }

    const items = (kind: 'equipment' | 'supply' | 'spare', expr: string) => {
      for (const d of this.engine.selectNodes(expr, el) as Element[]) {
        const n = base(kind, d);
        const name = str('name', d);
        if (name) n.title = name;
        const mfc = str('identNumber/manufacturerCode', d);
        if (mfc) n.manufacturerCode = mfc;
        const pn = str('identNumber/partAndSerialNumber/partNumber', d);
        if (pn) n.partNumber = pn;
        const qty = str('reqQuantity', d);
        if (qty) n.quantity = qty;
        const unit = str('reqQuantity/@unitOfMeasure', d);
        if (unit) n.unit = unit;
        const remarks = (this.engine.selectNodes('remarks/simplePara', d) as Element[])
          .map((r) => deepText(r))
          .filter(Boolean);
        if (remarks.length > 0) n.text = remarks.join(' ');
        // identNumber 以外の識別子は、要素名だけを残す（中身は読んでいない）
        const others = elements(d)
          .map((c) => c.nodeName)
          .filter((x) => ITEM_IDENTIFIERS.has(x));
        const attrs: Record<string, string> = {};
        if (others.length > 0) attrs.otherIdentifiers = [...new Set(others)].join(' ');
        put(attrs, 'shortName', str('shortName', d));
        put(attrs, 'materialUsage', attr(d, 'materialUsage'));
        put(attrs, 'supplyCategory', attr(d, 'supplyCategory'));
        // 中身を読んでいない子（入れ子の品目、危険性、脚注）は、あることを知らせる
        const skipped = elements(d)
          .map((c) => c.nodeName)
          .filter((x) => ITEM_NOT_READ.has(x));
        for (const x of [...others, ...skipped]) this.markNotRead(x);
        if (skipped.length > 0) attrs.notRead = [...new Set(skipped)].join(' ');
        if (Object.keys(attrs).length > 0) n.attrs = attrs;
        out.push(n);
      }
    };
    // 品目の脚注（グループの直下の footnote）は読んでいない
    const footnotes = this.engine.selectNodes(
      'reqSupportEquips/*/footnote | reqSupplies/*/footnote | reqSpares/*/footnote',
      el,
    ).length;
    for (let i = 0; i < footnotes; i++) this.markNotRead('footnote');
    items('equipment', 'reqSupportEquips/supportEquipDescrGroup/supportEquipDescr');
    items('supply', 'reqSupplies/supplyDescrGroup/supplyDescr');
    items('spare', 'reqSpares/spareDescrGroup/spareDescr');

    for (const safety of this.engine.selectNodes('reqSafety/safetyRqmts', el) as Element[]) {
      out.push(...this.referencedAdmonitions(safety));
      for (const s of elements(safety)) out.push(...this.readElement(s));
    }
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
    const persons = this.engine.selectNodes(
      'reqPersons/person | reqPersons/personnel',
      el,
    ) as Element[];
    if (persons.length > 0) {
      parts.push(
        `persons: ${persons
          .map((p) => {
            const trade = this.engine.selectString('trade', p);
            const cat = this.engine.selectString('personCategory/@personCategoryCode', p);
            const time = this.engine.selectString('estimatedTime', p);
            const unit = this.engine.selectString('estimatedTime/@unitOfMeasure', p);
            const num = attr(p, 'numRequired');
            return [
              attr(p, 'man'),
              num ? `x${num}` : undefined,
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
    const safetyParts: string[] = [];
    for (const rqmts of this.engine.selectNodes('reqSafety/safetyRqmts', el) as Element[]) {
      // 共通の警告・注意への参照（@warningRefs / @cautionRefs）。本文は子の節点にある
      for (const n of this.referencedAdmonitions(rqmts)) {
        const where =
          n.refs?.[0]?.target ?? (n.attrs?.unresolved ? 'unresolved' : 'in this data module');
        safetyParts.push(`${n.level} ref ${n.attrs?.referencedId} (${where})`);
      }
      for (const s of elements(rqmts)) safetyParts.push(`${s.nodeName}: ${deepText(s)}`);
    }
    if (safetyParts.length > 0) parts.push(`safety: ${safetyParts.join('; ')}`);
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
    return {
      schemaName,
      kind,
      structured: false,
      blocks: [],
      notes,
      unknownElements: {},
      notReadElements: {},
    };
  }
  const content = engine.selectNodes('/*/content', document)[0] as Element | undefined;
  if (!content) {
    notes.push('The document has no <content> element.');
    return {
      schemaName,
      kind,
      structured: true,
      blocks: [],
      notes,
      unknownElements: {},
      notReadElements: {},
    };
  }
  const reader = new Reader(engine);
  const blocks = reader.readChildren(content, { n: 0, prefix: '' });
  const unknownTotal = Object.values(reader.unknown).reduce((a, b) => a + b, 0);
  if (unknownTotal > 0) {
    notes.push(
      `${unknownTotal} element(s) of ${Object.keys(reader.unknown).length} kind(s) were kept as "unknown" (text only): ${Object.keys(reader.unknown).join(', ')}.`,
    );
  }
  const notReadTotal = Object.values(reader.notRead).reduce((a, b) => a + b, 0);
  if (notReadTotal > 0) {
    notes.push(
      `${notReadTotal} element(s) are present but their content was not read: ${Object.entries(
        reader.notRead,
      )
        .map(([k, v]) => `${k} (${v})`)
        .join(', ')}. The response does not contain what they say.`,
    );
  }
  return {
    schemaName,
    kind,
    structured: true,
    blocks,
    notes,
    unknownElements: reader.unknown,
    notReadElements: reader.notRead,
  };
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
