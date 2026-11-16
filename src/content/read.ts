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
  ContentIdentifier,
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
  faultDescr: 'para',
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
  // 繰り返し。条件の式は attrs.expression、子は前の代入・繰り返す dmSeq・後ろの代入
  dmLoop: 'sequence',
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
  'warningsAndCautions',
  'commonInfo',
  // 折り込みページの容れ物。中の figure / table をそのまま読む
  'foldout',
  // 利用者への知らせ。中の prompt を 1 つずつ段落として読む
  'message',
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
  'warningRef',
  'cautionRef',
  'warningsAndCautionsRef',
]);

/**
 * プロセス DM の変数の宣言・代入・検査。`logicNodes` が節点として読む（式は評価せず、書かれた値と演算の名前を並べた文にする）
 */
const LOGIC = new Set([
  'variableDeclarations',
  'variablePreSet',
  'variablePostSet',
  'validate',
  'assertion',
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

/** 入れ子の品目（embedded…Descr）。親の品目の子の節点として読む */
const ITEM_EMBEDDED = new Set([
  'embeddedSupportEquipDescr',
  'embeddedSupplyDescr',
  'embeddedSpareDescr',
]);

/** 品目（supportEquipDescr など）の識別子のうち、identNumber と natoStockNumber 以外の要素（`identifiers` に返す） */
const ITEM_IDENTIFIERS = new Set([
  'catalogSeqNumberRef',
  'toolRef',
  'materialSetRef',
  'supplyRef',
  'supplyRqmtRef',
  'partRef',
  'functionalItemRef',
]);

/** 要素に書かれている属性をすべて返す（`skip` の名前を除く） */
function allAttrs(el: Element, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    if (skip.includes(a.name) || a.value === '') continue;
    out[a.name] = a.value;
  }
  return out;
}

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

  /**
   * natoStockNumber を読む。`value` は、3 つの属性があればそれを書かれた値のままつないだもの
   * （7 桁の番号は 3-4 桁に分ける）、無ければ `fullNatoStockNumber`、それも無ければ要素の文。
   * 属性と `fullNatoStockNumber` の両方があるときは、後者を `full` に返す。`refs` は読んでいない（`mark` が真なら、そのことを数える）
   */
  private natoStockNumber(el: Element, mark = true): { value?: string; full?: string } {
    const nsc = attr(el, 'natoSupplyClass');
    const ncb = attr(el, 'natoCodificationBureau');
    const core = attr(el, 'natoItemIdentNumberCore');
    const fullEl = firstChild(el, 'fullNatoStockNumber');
    const full = fullEl ? norm(fullEl.textContent ?? '') : '';
    if (mark && firstChild(el, 'refs')) this.markNotRead('refs');
    const parts = [
      nsc,
      ncb,
      core && /^\d{7}$/.test(core) ? `${core.slice(0, 3)}-${core.slice(3)}` : core,
    ].filter((x): x is string => x !== undefined);
    if (parts.length > 0) return { value: parts.join('-'), ...(full ? { full } : {}) };
    if (full) return { value: full };
    const text = Array.from(el.childNodes)
      .filter((c) => c.nodeType === 3)
      .map((c) => c.textContent ?? '')
      .join('');
    return norm(text) ? { value: norm(text) } : {};
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
        // 番号・題名・版（externalPubIssueInfo/externalPubIssue の文）・発行日（externalPubIssueDate の文）を読む。
        // ほかの発行情報（externalPubIssueInfo の属性、機密区分、責任者など）は読んでいない
        const ident = firstChild(el, 'externalPubRefIdent');
        const items = firstChild(el, 'externalPubRefAddressItems');
        const issue = this.engine.selectString(
          'externalPubRefIdent/externalPubIssueInfo/externalPubIssue',
          el,
        );
        const issueDate = this.engine.selectString(
          'externalPubRefAddressItems/externalPubIssueDate',
          el,
        );
        const issueRead = !!issue && norm(issue) !== '';
        const dateRead = !!issueDate && norm(issueDate) !== '';
        this.markRefNotRead(el, [
          'externalPubRefIdent',
          ...(dateRead ? ['externalPubRefAddressItems'] : []),
        ]);
        if (ident)
          for (const c of elements(ident)) {
            if (c.nodeName === 'externalPubCode' || c.nodeName === 'externalPubTitle') continue;
            if (c.nodeName === 'externalPubIssueInfo' && issueRead) {
              for (const g of elements(c))
                if (g.nodeName !== 'externalPubIssue') this.markNotRead(g.nodeName);
              continue;
            }
            this.markNotRead(c.nodeName);
          }
        if (items && dateRead)
          for (const c of elements(items))
            if (c.nodeName !== 'externalPubIssueDate') this.markNotRead(c.nodeName);
        const ref: ContentRef = {
          kind: 'externalPubRef',
          target: norm(code ?? title ?? ''),
          title: title ? norm(title) : undefined,
        };
        if (issueRead) ref.externalPubIssue = norm(issue as string);
        if (dateRead) ref.externalPubIssueDate = norm(issueDate as string);
        return ref;
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

  /** prompt の文（中の paraBasic をつないだもの） */
  private promptText(prompt: Element, refs: ContentRef[]): string {
    return (this.engine.selectNodes('paraBasic', prompt) as Element[])
      .map((p) => this.inlineText(p, refs))
      .filter(Boolean)
      .join(' ');
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
    // message（利用者への知らせ）の prompt は、1 つずつ段落として読む。ほかの prompt は、親の dialog・menuChoice が文として読む
    if (name === 'prompt' && (el.parentNode as Element | null)?.nodeName === 'message') {
      const refs: ContentRef[] = [];
      const text = this.promptText(el, refs);
      const node: ContentNode = {
        kind: 'para',
        element: name,
        children: [],
        text,
        location: describeLocation(el),
      };
      if (refs.length > 0) node.refs = refs;
      return [node];
    }
    if (LOGIC.has(name)) return this.logicNodes(el);
    if (SKIP.has(name)) return [];
    // userEntry の入力先の変数は、親の dialog の節点が attrs.variableName に読む（unknown に数えない）
    if (name === 'variableRef' && (el.parentNode as Element | null)?.nodeName === 'userEntry')
      return [];
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
        if (name === 'faultDescr') {
          // 不具合の説明: descr の文を text に、ほかの子（detailedFaultDescr など）は子として読む。
          // 同じ親の fault の faultCode（不具合のコード。値は解釈しない）を attrs に残す
          const descr = firstChild(el, 'descr');
          node.text = descr ? this.inlineText(descr, refs) : '';
          node.children = elements(el)
            .filter((c) => c !== descr)
            .flatMap((c) => this.readElement(c));
          const parent = el.parentNode as Element | null;
          const fault = parent ? firstChild(parent, 'fault') : undefined;
          const code = fault ? attr(fault, 'faultCode') : undefined;
          if (code) node.attrs = { faultCode: code };
          break;
        }
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
        if (name === 'definitionList') {
          // 定義リストの見出し（用語の列と定義の列の題名）
          const header = firstChild(el, 'definitionListHeader');
          const termTitle = header && firstChild(header, 'termTitle');
          const definitionTitle = header && firstChild(header, 'definitionTitle');
          const attrs: Record<string, string> = {};
          if (termTitle) attrs.termTitle = this.inlineText(termTitle, refs);
          if (definitionTitle) attrs.definitionTitle = this.inlineText(definitionTitle, refs);
          if (Object.keys(attrs).length > 0) node.attrs = attrs;
        }
        break;
      case 'listItem': {
        // listItem は para を持つ。短い項目は text にまとめる
        if (name === 'menuChoice') {
          // メニューの選択肢: prompt の文を text に、選んだときの変数の代入（assertion）を子に読む
          const prompt = firstChild(el, 'prompt');
          if (prompt) node.text = this.promptText(prompt, refs);
          node.children = elements(el)
            .filter((c) => LOGIC.has(c.nodeName))
            .flatMap((c) => this.logicNodes(c));
          break;
        }
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
            // 図の改訂の理由（graphic/reasonForAmendment の文）
            const reason = firstChild(g as Element, 'reasonForAmendment');
            if (reason) r.reasonForAmendment = this.inlineText(reason, refs);
            refs.push(r);
          } else if (firstChild(g as Element, 'reasonForAmendment'))
            this.markNotRead('reasonForAmendment');
        }
        // 図の凡例（legend の中の定義リストなど）は子として読む
        const legend = firstChild(el, 'legend');
        if (legend) node.children = this.readChildren(legend);
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
          // 式そのものは、書かれた値と演算の名前を並べた文にして attrs.expression に入れる（question は人が書いた文だけ）
          const text = this.expressionText(expression);
          if (text !== undefined) node.attrs = { ...(node.attrs ?? {}), expression: text };
        }
        // 条件を読めた expression は子に残さない。読めなかった式（文が無く、文にもできない）は unknown として残す
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
          // dmLoop の条件の式は attrs.expression に入れ、子に残さない。文にできない式は unknown として残す
          let loopCondition: Element | undefined;
          if (name === 'dmLoop') {
            const expression = firstChild(el, 'expression');
            const text = expression ? this.expressionText(expression) : undefined;
            if (expression && text !== undefined) {
              loopCondition = expression;
              node.attrs = { ...(node.attrs ?? {}), expression: text };
              const readable = attr(expression, 'humanReadableForm');
              if (readable) node.attrs.humanReadableForm = norm(readable);
            }
          }
          const counter = kind === 'section' ? { n: 0, prefix: '' } : stepCounter;
          node.children = loopCondition
            ? elements(el)
                .filter((c) => c !== loopCondition)
                .flatMap((c) => this.readElement(c, counter))
            : this.readChildren(el, counter);
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

  /** id・applicRefId・securityClassification を写しただけの節点 */
  private plainNode(kind: ContentNodeKind, el: Element): ContentNode {
    const n: ContentNode = {
      kind,
      element: el.nodeName,
      children: [],
      location: describeLocation(el),
    };
    const id = attr(el, 'id');
    if (id) n.id = id;
    const applicRefId = attr(el, 'applicRefId');
    if (applicRefId) n.applicRefId = applicRefId;
    const security = attr(el, 'securityClassification');
    if (security) n.securityClassification = security;
    return n;
  }

  /** 節点に写した 3 つの属性を除いた、書かれている属性 */
  private restAttrs(el: Element): Record<string, string> | undefined {
    const a = allAttrs(el, ['id', 'applicRefId', 'securityClassification']);
    return Object.keys(a).length > 0 ? a : undefined;
  }

  /** `refs` の中の参照と、直下の参照（dmRef など）を集める */
  private refsUnder(el: Element): ContentRef[] {
    const out: ContentRef[] = [];
    for (const c of elements(el)) {
      if (c.nodeName === 'refs') {
        for (const r of elements(c)) {
          const ref = this.refOf(r);
          if (ref) out.push(ref);
          else this.markNotRead(r.nodeName);
        }
        continue;
      }
      const ref = this.refOf(c);
      if (ref) out.push(ref);
    }
    return out;
  }

  /** 品目の識別子（toolRef・supplyRef など）: 属性、name / shortName、参照 */
  private identifier(el: Element): ContentIdentifier {
    const id: ContentIdentifier = { element: el.nodeName, attrs: allAttrs(el) };
    const name = firstChild(el, 'name');
    if (name) id.name = deepText(name);
    const shortName = firstChild(el, 'shortName');
    if (shortName) id.shortName = deepText(shortName);
    const refs = this.refsUnder(el);
    if (refs.length > 0) id.refs = refs;
    return id;
  }

  /**
   * 品目の危険性（hazards）。`hazard` は list の節点（`refs` が記号の図、`attrs.hazardousClass` が区分の値の並び、
   * 子の listItem が `safetyInformation` の文）、`hazardRef` は para の節点（`attrs.hazardIdentNumber` と参照）。値は解釈しない
   */
  private hazards(el: Element): ContentNode[] {
    const out: ContentNode[] = [];
    for (const h of elements(el)) {
      if (h.nodeName === 'hazardRef') {
        const n = this.plainNode('para', h);
        const attrs = this.restAttrs(h);
        if (attrs) n.attrs = attrs;
        const refs = this.refsUnder(h);
        if (refs.length > 0) n.refs = refs;
        out.push(n);
        continue;
      }
      if (h.nodeName !== 'hazard') {
        this.markNotRead(h.nodeName);
        continue;
      }
      const n = this.plainNode('list', h);
      n.ordered = false;
      const refs: ContentRef[] = [];
      const classes: string[] = [];
      for (const c of elements(h)) {
        if (c.nodeName === 'symbol') {
          const r = this.refOf(c);
          if (r) refs.push(r);
        } else if (c.nodeName === 'hazardousClass') {
          const v = attr(c, 'hazardousClassValue');
          if (v) classes.push(v);
        } else if (c.nodeName === 'safetyInformation') {
          const item = this.plainNode('listItem', c);
          item.text = this.inlineText(c, refs);
          const attrs = this.restAttrs(c);
          if (attrs) item.attrs = attrs;
          n.children.push(item);
        } else this.markNotRead(c.nodeName);
      }
      if (classes.length > 0) n.attrs = { hazardousClass: classes.join(' ') };
      if (refs.length > 0) n.refs = refs;
      out.push(n);
    }
    return out;
  }

  /**
   * 作業の場所・所要時間・間隔（productionMaintData）。節点は para で、
   * `attrs` に taskDuration の属性（`taskDuration.unitOfMeasure` など）、子に間隔（thresholdInterval）と
   * 場所のまとまり（workAreaLocationGroup。その子が zoneRef・accessPointRef・workLocation）を返す。値は解釈しない
   */
  private productionMaintData(el: Element): ContentNode {
    const node = this.plainNode('para', el);
    const attrs: Record<string, string> = {};
    /** 名前と属性だけを持つ参照（zoneRef・accessPointRef・functionalItemRef）と、文だけの要素 */
    const leaf = (c: Element): ContentNode => {
      const n = this.plainNode('para', c);
      const a = this.restAttrs(c);
      if (a) n.attrs = a;
      const name = firstChild(c, 'name');
      const refs: ContentRef[] = this.refsUnder(c);
      if (name) n.title = deepText(name);
      const shortName = firstChild(c, 'shortName');
      if (shortName) n.attrs = { ...(n.attrs ?? {}), shortName: deepText(shortName) };
      if (!name && !shortName && elements(c).length === 0) {
        const text = deepText(c);
        if (text) n.text = text;
      }
      if (refs.length > 0) n.refs = refs;
      return n;
    };
    for (const c of elements(el)) {
      if (c.nodeName === 'taskDuration') {
        for (const [k, v] of Object.entries(allAttrs(c))) attrs[`taskDuration.${k}`] = v;
      } else if (c.nodeName === 'thresholdInterval') {
        node.children.push(leaf(c));
      } else if (c.nodeName === 'workAreaLocationGroup') {
        const group = this.plainNode('para', c);
        for (const g of elements(c)) {
          if (g.nodeName !== 'workLocation') {
            group.children.push(leaf(g));
            continue;
          }
          // workLocation: 文と要素が混ざる。文は、要素の文・名前を元の順につないだものにし、要素は子にも返す
          const loc = this.plainNode('para', g);
          const refs: ContentRef[] = [];
          const parts: string[] = [];
          for (const x of Array.from(g.childNodes)) {
            if (x.nodeType === TEXT_NODE) {
              parts.push(x.nodeValue ?? '');
              continue;
            }
            if (x.nodeType !== ELEMENT_NODE) continue;
            const e = x as Element;
            if (e.nodeName === 'refs') {
              for (const r of elements(e)) {
                const ref = this.refOf(r);
                if (ref) refs.push(ref);
                else this.markNotRead(r.nodeName);
              }
              continue;
            }
            const r = this.refOf(e);
            if (r) {
              refs.push(r);
              parts.push(` [→ ${r.target}] `);
              continue;
            }
            const child = leaf(e);
            loc.children.push(child);
            parts.push(` ${child.text ?? child.title ?? child.attrs?.productItemName ?? ''} `);
          }
          const text = norm(parts.join('')).replace(/ ([.,;:])/g, '$1');
          if (text) loc.text = text;
          if (refs.length > 0) loc.refs = refs;
          group.children.push(loc);
        }
        node.children.push(group);
      } else this.markNotRead(c.nodeName);
    }
    if (Object.keys(attrs).length > 0) node.attrs = attrs;
    return node;
  }

  /**
   * 式（expression）を、書かれた値と演算の名前を並べた文にする。評価はしない。
   * 2 項の演算は `(左 演算 右)`、関数は `名前(式)`、変数は名前、文字列は引用符付き、集合は `{a, b}`、
   * 適用性の条件（assert）は `assert(識別子 種類 "値")`。
   * 知らない要素があれば undefined（呼び出し側が `notReadElements` に数える）
   */
  private expressionText(el: Element, top = true): string | undefined {
    const kids = elements(el);
    const one = (c: Element): string | undefined => {
      switch (c.nodeName) {
        case 'expression':
          return this.expressionText(c, false);
        case 'variableRef':
          return attr(c, 'variableName') ?? '';
        case 'stringValue':
          return JSON.stringify(c.textContent ?? '');
        case 'integerValue':
        case 'realValue':
          return norm(c.textContent ?? '');
        case 'booleanValue':
          return firstChild(c, 'trueValue') ? 'true' : firstChild(c, 'falseValue') ? 'false' : '';
        case 'noValue':
          return 'noValue';
        case 'assert': {
          // 適用性の条件: `assert(識別子 種類 "値")`。属性が無く文だけの assert は `assert("文")`
          const parts = [attr(c, 'applicPropertyIdent'), attr(c, 'applicPropertyType')].filter(
            (v): v is string => !!v,
          );
          const values = attr(c, 'applicPropertyValues');
          if (values !== undefined) parts.push(JSON.stringify(values));
          const text = norm(c.textContent ?? '');
          if (parts.length === 0 && text) parts.push(JSON.stringify(text));
          return parts.length > 0 ? `assert(${parts.join(' ')})` : undefined;
        }
        case 'setValue': {
          const items = elements(c).map(one);
          return items.some((i) => i === undefined) ? undefined : `{${items.join(', ')}}`;
        }
        default:
          return undefined;
      }
    };
    const OPERATION: Record<string, string> = {
      booleanOperator: 'booleanOperation',
      numberOperator: 'numberOperation',
      setOperator: 'setOperation',
      stringOperator: 'stringOperation',
    };
    const ACTION: Record<string, string> = {
      booleanFunction: 'booleanAction',
      numberFunction: 'numberAction',
      setFunction: 'setAction',
      stringFunction: 'stringAction',
    };
    if (kids.length === 3 && OPERATION[kids[1]!.nodeName]) {
      const l = one(kids[0]!);
      const r = one(kids[2]!);
      const op = attr(kids[1]!, OPERATION[kids[1]!.nodeName]!);
      if (l === undefined || r === undefined || !op) return undefined;
      return top ? `${l} ${op} ${r}` : `(${l} ${op} ${r})`;
    }
    if (kids.length === 2 && ACTION[kids[0]!.nodeName]) {
      const arg = one(kids[1]!);
      const action = attr(kids[0]!, ACTION[kids[0]!.nodeName]!);
      if (arg === undefined || !action) return undefined;
      return `${action}(${arg.replace(/^\((.*)\)$/, '$1')})`;
    }
    if (kids.length === 1) return one(kids[0]!);
    return undefined;
  }

  /** 式を attrs に入れる。読めない式は、あることを知らせる */
  private putExpression(attrs: Record<string, string>, key: string, owner: Element): void {
    const expression = firstChild(owner, 'expression');
    if (!expression) return;
    const text = this.expressionText(expression);
    if (text !== undefined) attrs[key] = text;
    else this.markNotRead('expression');
    const readable = attr(expression, 'humanReadableForm');
    if (readable) attrs.humanReadableForm = norm(readable);
  }

  /**
   * プロセス DM の変数の操作を節点にする。
   * - variableDeclarations: list。子の listItem が `variable`（`attrs` に属性と、あれば `initialValue`）
   * - variablePreSet / variablePostSet / assertion: para。`attrs.variableName` と `attrs.expression`（代入する値の式）
   * - validate: para。`attrs.errorMessage` と `attrs.expression`（検査の式）
   */
  private logicNodes(el: Element): ContentNode[] {
    const assertion = (node: ContentNode, a: Element): void => {
      const attrs: Record<string, string> = { ...(node.attrs ?? {}) };
      const target = firstChild(a, 'variableRef');
      if (target) {
        const v = attr(target, 'variableName');
        if (v) attrs.variableName = v;
      } else if (firstChild(a, 'globalPropertyRef')) this.markNotRead('globalPropertyRef');
      this.putExpression(attrs, 'expression', a);
      if (Object.keys(attrs).length > 0) node.attrs = attrs;
    };
    switch (el.nodeName) {
      case 'variableDeclarations': {
        const list = this.plainNode('list', el);
        list.ordered = false;
        for (const v of elements(el)) {
          if (v.nodeName !== 'variable') {
            this.markNotRead(v.nodeName);
            continue;
          }
          const item = this.plainNode('listItem', v);
          const attrs = this.restAttrs(v) ?? {};
          const init = firstChild(v, 'initialize');
          if (init) this.putExpression(attrs, 'initialValue', init);
          if (Object.keys(attrs).length > 0) item.attrs = attrs;
          // 変数に付く問い（dialog / dialogAlts）
          item.children = elements(v)
            .filter((c) => c.nodeName !== 'initialize')
            .flatMap((c) => this.readElement(c));
          list.children.push(item);
        }
        return [list];
      }
      case 'variablePreSet':
      case 'variablePostSet': {
        const node = this.plainNode('para', el);
        const a = firstChild(el, 'assertion');
        if (a) assertion(node, a);
        return [node];
      }
      case 'assertion': {
        const node = this.plainNode('para', el);
        assertion(node, el);
        return [node];
      }
      case 'validate': {
        const node = this.plainNode('para', el);
        const attrs: Record<string, string> = {};
        const message = attr(el, 'errorMessage');
        if (message) attrs.errorMessage = message;
        this.putExpression(attrs, 'expression', el);
        if (Object.keys(attrs).length > 0) node.attrs = attrs;
        return [node];
      }
      default:
        return [];
    }
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

    // 作業の場所・所要時間・間隔（productionMaintData）
    for (const c of elements(el))
      if (c.nodeName === 'productionMaintData') out.push(this.productionMaintData(c));

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

    const item = (kind: 'equipment' | 'supply' | 'spare', d: Element): ContentNode => {
      {
        const n = base(kind, d);
        const name = str('name', d);
        if (name) n.title = name;
        const mfc = str('identNumber/manufacturerCode', d);
        if (mfc) n.manufacturerCode = mfc;
        const pn = str('identNumber/partAndSerialNumber/partNumber', d);
        if (pn) n.partNumber = pn;
        const nsns = elements(d).filter((c) => c.nodeName === 'natoStockNumber');
        const nsn = nsns[0] ? this.natoStockNumber(nsns[0]) : undefined;
        if (nsn?.value) n.natoStockNumber = nsn.value;
        const qty = str('reqQuantity', d);
        if (qty) n.quantity = qty;
        const unit = str('reqQuantity/@unitOfMeasure', d);
        if (unit) n.unit = unit;
        // 備考: remarks か footnoteRemarks（どちらか一方）。footnoteRemarks の footnoteRef は、脚注への参照として返す
        const noteEl = firstChild(d, 'remarks') ?? firstChild(d, 'footnoteRemarks');
        const itemRefs: ContentRef[] = [];
        if (noteEl) {
          const remarks = elements(noteEl)
            .filter((r) => r.nodeName === 'simplePara')
            .map((r) => deepText(r))
            .filter(Boolean);
          if (remarks.length > 0) n.text = remarks.join(' ');
          for (const r of elements(noteEl)) {
            if (r.nodeName !== 'footnoteRef') continue;
            const target = attr(r, 'internalRefId');
            if (target) itemRefs.push({ kind: 'internalRef', target, note: 'footnoteRef' });
          }
        }
        // identNumber と 1 つ目の natoStockNumber 以外の識別子は、属性と名前と参照を identifiers に返す
        const identifiers: ContentIdentifier[] = [];
        for (const c of elements(d)) {
          if (ITEM_IDENTIFIERS.has(c.nodeName)) identifiers.push(this.identifier(c));
          else if (c.nodeName === 'natoStockNumber' && c !== nsns[0]) {
            const more = this.natoStockNumber(c);
            const id: ContentIdentifier = { element: c.nodeName, attrs: allAttrs(c) };
            if (more.value) id.text = more.value;
            identifiers.push(id);
          }
        }
        if (identifiers.length > 0) n.identifiers = identifiers;
        const attrs: Record<string, string> = {};
        // これまでの版との互換のため、識別子の要素名の並びも残す
        if (identifiers.length > 0)
          attrs.otherIdentifiers = [...new Set(identifiers.map((i) => i.element))].join(' ');
        if (nsn?.full) attrs.fullNatoStockNumber = nsn.full;
        put(attrs, 'shortName', str('shortName', d));
        put(attrs, 'materialUsage', attr(d, 'materialUsage'));
        put(attrs, 'supplyCategory', attr(d, 'supplyCategory'));
        if (noteEl?.nodeName === 'footnoteRemarks') {
          attrs.remarksElement = 'footnoteRemarks';
          put(attrs, 'remarksApplicRefId', attr(noteEl, 'applicRefId'));
        }
        if (Object.keys(attrs).length > 0) n.attrs = attrs;
        if (itemRefs.length > 0) n.refs = itemRefs;
        // 入れ子の品目（工具のセットの中身など）は同じ種類の子の節点、危険性（hazards）はその後ろの子の節点として読む
        n.children = [
          ...elements(d)
            .filter((c) => ITEM_EMBEDDED.has(c.nodeName))
            .map((c) => item(kind, c)),
          ...elements(d)
            .filter((c) => c.nodeName === 'hazards')
            .flatMap((c) => this.hazards(c)),
        ];
        return n;
      }
    };
    const items = (kind: 'equipment' | 'supply' | 'spare', expr: string) => {
      for (const d of this.engine.selectNodes(expr, el) as Element[]) out.push(item(kind, d));
    };
    // 品目の脚注（グループの直下の footnote。品目の footnoteRef が id で指す）は、その種類の品目の後ろに置く
    const footnotes = (expr: string) => {
      for (const f of this.engine.selectNodes(expr, el) as Element[]) {
        const n = base('para', f);
        const kids = this.readChildren(f);
        if (kids.length === 1 && kids[0].kind === 'para' && kids[0].children.length === 0) {
          n.text = kids[0].text;
          if (kids[0].refs) n.refs = kids[0].refs;
        } else n.children = kids;
        const mark = attr(f, 'footnoteMark');
        if (mark) n.attrs = { footnoteMark: mark };
        out.push(n);
      }
    };
    items('equipment', 'reqSupportEquips/supportEquipDescrGroup/supportEquipDescr');
    footnotes('reqSupportEquips/supportEquipDescrGroup/footnote');
    items('supply', 'reqSupplies/supplyDescrGroup/supplyDescr');
    footnotes('reqSupplies/supplyDescrGroup/footnote');
    items('spare', 'reqSpares/spareDescrGroup/spareDescr');
    footnotes('reqSpares/spareDescrGroup/footnote');

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
              const nsnEl = firstChild(i, 'natoStockNumber');
              const nsn = nsnEl ? this.natoStockNumber(nsnEl, false).value : undefined;
              const qty = this.engine.selectString('reqQuantity', i);
              return [
                name && norm(name),
                pn && `P/N ${norm(pn)}`,
                nsn && `NSN ${nsn}`,
                qty && `x${norm(qty)}`,
              ]
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
