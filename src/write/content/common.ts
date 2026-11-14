/**
 * 内容部の組み立てに共通する部分: 節点の検査、段落・リスト・表・図・警告・手順などの要素の組み立て。
 *
 * 方針:
 * - reader（content/read.ts）の「要素名 → kind」の対応を逆向きに使う。読んだ木を書き戻すと同じ木になる
 * - `DraftDataModule.kind` ごと・親ごとに置ける `DraftNode.kind` を `ALLOWED` で固定し、合わないものは
 *   XML を組み立てる前に `DraftInputError`（XPath 風の位置付き）にする。XSD 検証の代わりではない
 * - 要素の並びは XSD の順序に合わせる（警告・注意は見出しの直後、入れ子の手順・節は最後 など）。
 *   警告・注意は入力の順にかかわらず先頭へ寄せる（XSD が先頭に置くことを要求するため）
 * - `text` の `<`・`&` は XML の直列化で実体参照になる（このファイルでは文字列をそのまま text 節点にする）
 */
import { DOMImplementation } from '@xmldom/xmldom';
import { parseDmc } from '../../dmc.js';
import { parseIcn } from '../../icn.js';
import { parsePmc } from '../../pmc.js';
import type { DmCode } from '../../types.js';
import type { Document, Element } from '../../xml/engine.js';
import { DraftInputError } from '../errors.js';
import type { DraftKind, DraftNode, DraftNodeKind, DraftRef } from '../types.js';

/** 空の文書を作る（要素は後から追加する） */
export function newDocument(): Document {
  return new DOMImplementation().createDocument(null, '');
}

/** 図・マルチメディアの参照 1 件 */
export interface AssetUse {
  /** 入力の target（assetId か ICN） */
  target: string;
  /** 解決した ICN */
  icn: string;
  kind: 'graphic' | 'multimedia';
}

export interface BuildContentContext {
  /** 要素を作る文書。省略すると新しい文書を作る（返す要素はその文書のもの） */
  document?: Document;
  /**
   * graphic / multimedia の target（assetId か ICN）から ICN を決める。
   * 省略すると、target が ICN の形のものだけを受け付ける（assetId は DraftInputError）
   */
  resolveIcn?: (target: string, kind: 'graphic' | 'multimedia', path: string) => string;
  /** 図の参照を見つけるたびに呼ぶ（DOCTYPE の ENTITY 宣言を作る材料） */
  onAsset?: (use: AssetUse) => void;
  /** 組み立てで補った点・動かした点の注記の出力先 */
  notes?: string[];
}

/** 親の種類（'body' は `DraftDataModule.body` の直下） */
type Parent = DraftNodeKind | 'body';

const LIST_PARTS: DraftNodeKind[] = ['listItem', 'definition'];

/** `DraftDataModule.kind` ごと・親ごとに置ける子の kind */
export const ALLOWED: Record<DraftKind, Partial<Record<Parent, readonly DraftNodeKind[]>>> = {
  descript: {
    body: ['para', 'admonition', 'section', 'figure', 'table', 'list'],
    section: ['para', 'admonition', 'section', 'figure', 'table', 'list'],
    para: ['list'],
    list: LIST_PARTS,
    listItem: ['para', 'admonition', 'list'],
    definition: ['para'],
    admonition: ['para'],
  },
  proced: {
    body: ['step', 'requirements', 'figure', 'table'],
    step: ['step', 'para', 'admonition', 'figure', 'table', 'list'],
    para: ['list'],
    list: LIST_PARTS,
    listItem: ['para', 'admonition', 'list'],
    definition: ['para'],
    admonition: ['para'],
    requirements: ['para', 'admonition', 'person', 'document', 'equipment', 'supply', 'spare'],
  },
  process: {
    body: ['sequence', 'section', 'if'],
    sequence: ['section', 'if'],
    section: ['step', 'figure', 'table', 'dialog'],
    if: ['sequence'],
    step: ['step', 'para', 'admonition', 'figure', 'table', 'list'],
    para: ['list'],
    list: LIST_PARTS,
    listItem: ['para', 'admonition', 'list'],
    definition: ['para'],
    admonition: ['para'],
  },
  fault: {
    body: ['step', 'requirements', 'figure', 'table'],
    step: ['para', 'admonition', 'figure', 'table'],
    admonition: ['para'],
    requirements: ['para', 'admonition', 'person', 'document', 'equipment', 'supply', 'spare'],
  },
  pm: {
    body: ['section', 'entry'],
    section: ['section', 'entry'],
  },
};

/** 節点の kind ごとに使えるプロパティ（kind と共通の id・applicRefId・securityClassification は別） */
const FIELDS: Record<DraftNodeKind, readonly (keyof DraftNode)[]> = {
  section: ['title', 'refs', 'children'],
  para: ['text', 'refs', 'children'],
  list: ['title', 'ordered', 'children'],
  listItem: ['text', 'refs', 'children'],
  definition: ['title', 'text', 'refs', 'children'],
  table: ['title', 'rows'],
  figure: ['title', 'refs'],
  admonition: ['level', 'text', 'refs', 'children'],
  step: ['title', 'text', 'refs', 'children', 'question', 'choices'],
  requirements: ['text', 'children'],
  person: ['text', 'count'],
  document: ['title', 'text', 'refs'],
  equipment: ['title', 'text', 'quantity', 'unit', 'partNumber', 'manufacturerCode'],
  supply: ['title', 'text', 'quantity', 'unit', 'partNumber', 'manufacturerCode'],
  spare: ['title', 'text', 'quantity', 'unit', 'partNumber', 'manufacturerCode'],
  sequence: ['children'],
  if: ['question', 'children'],
  dialog: ['title', 'text', 'choices'],
  entry: ['title', 'text', 'refs'],
};

const COMMON_FIELDS = new Set<string>(['kind', 'id', 'applicRefId', 'securityClassification']);

/** 複数形の説明用 */
const list = (xs: readonly string[]) => xs.map((x) => `"${x}"`).join(', ');

/** 要素の集まりを作る・見つける道具を持った、内容部の組み立て役 */
export class Writer {
  readonly doc: Document;
  readonly notes: string[];
  /** 入力の木にある id（internalRef・fault の next の行き先の検査に使う） */
  readonly ids = new Set<string>();
  /** process の変数（名前 → valueType） */
  readonly variables = new Map<string, 'string' | 'boolean'>();

  constructor(
    readonly dmKind: DraftKind,
    readonly ctx: BuildContentContext,
    body: DraftNode[],
  ) {
    this.doc = ctx.document ?? newDocument();
    this.notes = ctx.notes ?? [];
    this.collectIds(body);
  }

  private collectIds(nodes: DraftNode[]): void {
    for (const n of nodes) {
      if (n.id !== undefined) this.ids.add(n.id);
      if (n.children) this.collectIds(n.children);
    }
  }

  // ---- 要素の作成 ----

  el(name: string, attrs: Record<string, string | undefined> = {}): Element {
    const e = this.doc.createElement(name);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined) e.setAttribute(k, v);
    return e;
  }

  /** 文字だけを持つ要素 */
  textEl(name: string, text: string, attrs: Record<string, string | undefined> = {}): Element {
    const e = this.el(name, attrs);
    if (text !== '') e.appendChild(this.doc.createTextNode(text));
    return e;
  }

  /** 節点が持つ共通の属性（id・applicRefId・securityClassification）を要素に付ける */
  common(e: Element, node: DraftNode): Element {
    if (node.id !== undefined) e.setAttribute('id', node.id);
    if (node.applicRefId !== undefined) e.setAttribute('applicRefId', node.applicRefId);
    if (node.securityClassification !== undefined) {
      e.setAttribute('securityClassification', node.securityClassification);
    }
    return e;
  }

  // ---- 検査 ----

  /** 節点の kind に使えないプロパティが付いていないか */
  checkFields(node: DraftNode, path: string): void {
    const allowed = FIELDS[node.kind];
    if (!allowed) {
      throw new DraftInputError(path, `unknown node kind "${String(node.kind)}"`);
    }
    for (const [k, v] of Object.entries(node)) {
      if (v === undefined || COMMON_FIELDS.has(k)) continue;
      if (!(allowed as readonly string[]).includes(k)) {
        throw new DraftInputError(
          path,
          `property "${k}" is not accepted on a "${node.kind}" node (accepted: ${list([...COMMON_FIELDS, ...allowed])})`,
        );
      }
    }
  }

  /** kind が親の下に置けるか。置けなければ位置付きで投げる */
  checkKind(node: DraftNode, parent: Parent, path: string): void {
    const allowed = ALLOWED[this.dmKind][parent] ?? [];
    if (!(allowed as readonly string[]).includes(node.kind)) {
      const where = parent === 'body' ? 'the body' : `a "${parent}" node`;
      throw new DraftInputError(
        path,
        `node kind "${node.kind}" cannot be placed in ${where} of a "${this.dmKind}" data module` +
          (allowed.length > 0 ? ` (accepted: ${list(allowed)})` : ' (it takes no child nodes)'),
      );
    }
    this.checkFields(node, path);
  }

  /** 子をすべて検査して返す（親が子を取れないときは、子があれば投げる） */
  childrenOf(node: DraftNode, parent: Parent, path: string): DraftNode[] {
    const kids = node.children ?? [];
    kids.forEach((c, i) => this.checkKind(c, parent, `${path}/children[${i + 1}]`));
    return kids;
  }

  // ---- 参照 ----

  dmCodeEl(dm: DmCode): Element {
    const attrs: Record<string, string | undefined> = {
      modelIdentCode: dm.modelIdentCode,
      systemDiffCode: dm.systemDiffCode,
      systemCode: dm.systemCode,
      subSystemCode: dm.subSystemCode,
      subSubSystemCode: dm.subSubSystemCode,
      assyCode: dm.assyCode,
      disassyCode: dm.disassyCode,
      disassyCodeVariant: dm.disassyCodeVariant,
      infoCode: dm.infoCode,
      infoCodeVariant: dm.infoCodeVariant,
      itemLocationCode: dm.itemLocationCode,
      learnCode: dm.learnCode,
      learnEventCode: dm.learnEventCode,
    };
    return this.el('dmCode', attrs);
  }

  private dmRefEl(ref: DraftRef, path: string): Element {
    const dm = parseDmc(ref.target);
    if (!dm.ok) throw new DraftInputError(path, `dmRef target is not a DMC: ${dm.error}`);
    const e = this.el('dmRef');
    const ident = this.el('dmRefIdent');
    ident.appendChild(this.dmCodeEl(dm.value));
    e.appendChild(ident);
    if (ref.title !== undefined) {
      const items = this.el('dmRefAddressItems');
      const title = this.el('dmTitle');
      title.appendChild(this.textEl('techName', ref.title));
      items.appendChild(title);
      e.appendChild(items);
    }
    return e;
  }

  private pmRefEl(ref: DraftRef, path: string): Element {
    const pm = parsePmc(ref.target);
    if (!pm.ok) throw new DraftInputError(path, `pmRef target is not a PMC: ${pm.error}`);
    const e = this.el('pmRef');
    const ident = this.el('pmRefIdent');
    ident.appendChild(
      this.el('pmCode', {
        modelIdentCode: pm.value.modelIdentCode,
        pmIssuer: pm.value.pmIssuer,
        pmNumber: pm.value.pmNumber,
        pmVolume: pm.value.pmVolume,
      }),
    );
    e.appendChild(ident);
    if (ref.title !== undefined) {
      const items = this.el('pmRefAddressItems');
      items.appendChild(this.textEl('pmTitle', ref.title));
      e.appendChild(items);
    }
    return e;
  }

  private internalRefEl(ref: DraftRef, path: string): Element {
    if (!this.ids.has(ref.target)) {
      throw new DraftInputError(
        path,
        `internalRef target "${ref.target}" is not the id of any node in this data module`,
      );
    }
    const e = this.el('internalRef', { internalRefId: ref.target });
    if (ref.title !== undefined) e.appendChild(this.doc.createTextNode(ref.title));
    return e;
  }

  /** ICN を決めて、使ったことを知らせる */
  private resolveIcn(ref: DraftRef, kind: 'graphic' | 'multimedia', path: string): string {
    let icn: string;
    if (this.ctx.resolveIcn) {
      icn = this.ctx.resolveIcn(ref.target, kind, path);
    } else {
      if (!/^ICN-/i.test(ref.target) || !parseIcn(ref.target).ok) {
        throw new DraftInputError(
          path,
          `${kind} target "${ref.target}" is not an ICN (an assetId needs an Allocation to be turned into an ICN)`,
        );
      }
      icn = ref.target;
    }
    this.ctx.onAsset?.({ target: ref.target, icn, kind });
    return icn;
  }

  /** 文の中の参照（dmRef / pmRef / internalRef）の要素 */
  inlineRef(ref: DraftRef, path: string): Element {
    switch (ref.kind) {
      case 'dmRef':
        return this.dmRefEl(ref, path);
      case 'pmRef':
        return this.pmRefEl(ref, path);
      case 'internalRef':
        return this.internalRefEl(ref, path);
      default:
        throw new DraftInputError(
          path,
          `${ref.kind} can only be placed in the refs of a "figure" node, not inside a sentence`,
        );
    }
  }

  /** 要素の中に、文と、その後ろに参照を並べる */
  inline(parent: Element, text: string | undefined, refs: DraftRef[] | undefined, path: string) {
    if (text !== undefined && text !== '') parent.appendChild(this.doc.createTextNode(text));
    (refs ?? []).forEach((r, i) => {
      parent.appendChild(this.inlineRef(r, `${path}/refs[${i + 1}]`));
    });
  }

  // ---- 段落・警告・リスト・表・図 ----

  /** 文を持つ要素（para / action / notePara など）。子の list は文の後ろに入れる */
  textBlock(name: string, node: DraftNode, path: string, withLists = false): Element {
    const e = this.common(this.el(name), node);
    this.inline(e, node.text, node.refs, path);
    if (withLists) {
      this.childrenOf(node, 'para', path).forEach((c, i) => {
        e.appendChild(this.listEl(c, `${path}/children[${i + 1}]`));
      });
    }
    return e;
  }

  para(node: DraftNode, path: string): Element {
    return this.textBlock('para', node, path, true);
  }

  /** リスト。para の中に入れて返す（XSD ではリストは para の中にしか置けない） */
  wrappedList(node: DraftNode, path: string): Element {
    const p = this.el('para');
    p.appendChild(this.listEl(node, path));
    return p;
  }

  /** warning / caution / note */
  admonition(node: DraftNode, path: string): Element {
    if (node.level === undefined) {
      throw new DraftInputError(
        path,
        'an "admonition" node needs level (warning, caution or note)',
      );
    }
    const paraName = node.level === 'note' ? 'notePara' : 'warningAndCautionPara';
    const e = this.common(this.el(node.level), node);
    const paras: Element[] = [];
    if (node.text !== undefined || (node.refs?.length ?? 0) > 0) {
      paras.push(
        this.textBlock(paraName, { kind: 'para', text: node.text, refs: node.refs }, path),
      );
    }
    this.childrenOf(node, 'admonition', path).forEach((c, i) => {
      paras.push(this.textBlock(paraName, c, `${path}/children[${i + 1}]`));
    });
    if (paras.length === 0) {
      throw new DraftInputError(path, 'an "admonition" node needs text or at least one para child');
    }
    paras.forEach((p) => e.appendChild(p));
    return e;
  }

  /** リストの項目の中身（para / note / 入れ子のリスト）。1 つ以上要る */
  private itemBody(e: Element, node: DraftNode, parent: 'listItem' | 'definition', path: string) {
    let count = 0;
    if (node.text !== undefined || (node.refs?.length ?? 0) > 0) {
      e.appendChild(
        this.textBlock('para', { kind: 'para', text: node.text, refs: node.refs }, path),
      );
      count++;
    }
    this.childrenOf(node, parent, path).forEach((c, i) => {
      const cp = `${path}/children[${i + 1}]`;
      if (c.kind === 'para') e.appendChild(this.para(c, cp));
      else if (c.kind === 'list') e.appendChild(this.wrappedList(c, cp));
      else {
        if (c.level !== 'note') {
          throw new DraftInputError(cp, 'only a "note" admonition can be placed in a list item');
        }
        e.appendChild(this.admonition(c, cp));
      }
      count++;
    });
    if (count === 0) {
      throw new DraftInputError(path, `a "${node.kind}" node needs text or at least one child`);
    }
  }

  /** list（randomList / sequentialList / definitionList） */
  listEl(node: DraftNode, path: string): Element {
    if (node.kind !== 'list') {
      throw new DraftInputError(path, `expected a "list" node, got "${node.kind}"`);
    }
    const parts = this.childrenOf(node, 'list', path);
    if (parts.length === 0)
      throw new DraftInputError(path, 'a "list" node needs at least one item');
    const definitions = parts.filter((p) => p.kind === 'definition').length;
    if (definitions !== 0 && definitions !== parts.length) {
      throw new DraftInputError(path, 'a "list" cannot mix "definition" and "listItem" children');
    }
    const isDefinition = definitions > 0;
    const name = isDefinition ? 'definitionList' : node.ordered ? 'sequentialList' : 'randomList';
    const e = this.common(this.el(name), node);
    if (node.title !== undefined) e.appendChild(this.textEl('title', node.title));
    parts.forEach((p, i) => {
      const pp = `${path}/children[${i + 1}]`;
      if (isDefinition) {
        if (p.title === undefined) {
          throw new DraftInputError(pp, 'a "definition" node needs title (the term)');
        }
        const item = this.common(this.el('definitionListItem'), p);
        item.appendChild(this.textEl('listItemTerm', p.title));
        const def = this.el('listItemDefinition');
        this.itemBody(def, p, 'definition', pp);
        item.appendChild(def);
        e.appendChild(item);
      } else {
        const item = this.common(this.el('listItem'), p);
        this.itemBody(item, p, 'listItem', pp);
        e.appendChild(item);
      }
    });
    return e;
  }

  /** table。rows の 1 行目が見出し行（行が 1 つだけのときは本体） */
  table(node: DraftNode, path: string): Element {
    const rows = node.rows;
    if (!rows || rows.length === 0 || rows.some((r) => r.length === 0)) {
      throw new DraftInputError(path, 'a "table" node needs rows with at least one cell each');
    }
    const cols = rows[0].length;
    const bad = rows.findIndex((r) => r.length !== cols);
    if (bad >= 0) {
      throw new DraftInputError(
        `${path}/rows[${bad + 1}]`,
        `every row must have the same number of cells (${cols}), got ${rows[bad].length}`,
      );
    }
    const e = this.common(this.el('table'), node);
    if (node.title !== undefined) e.appendChild(this.textEl('title', node.title));
    const tgroup = this.el('tgroup', { cols: String(cols) });
    const rowEl = (cells: string[]) => {
      const row = this.el('row');
      for (const c of cells) {
        const entry = this.el('entry');
        if (c !== '') entry.appendChild(this.textEl('para', c));
        row.appendChild(entry);
      }
      return row;
    };
    let bodyRows = rows;
    if (rows.length > 1) {
      const thead = this.el('thead');
      thead.appendChild(rowEl(rows[0]));
      tgroup.appendChild(thead);
      bodyRows = rows.slice(1);
    }
    const tbody = this.el('tbody');
    for (const r of bodyRows) tbody.appendChild(rowEl(r));
    tgroup.appendChild(tbody);
    e.appendChild(tgroup);
    return e;
  }

  /** figure（graphic の参照）または multimedia（multimedia の参照）。title と参照が要る */
  figure(node: DraftNode, path: string): Element {
    const refs = node.refs ?? [];
    if (node.title === undefined) {
      throw new DraftInputError(path, 'a "figure" node needs title');
    }
    if (refs.length === 0) {
      throw new DraftInputError(path, 'a "figure" node needs refs (graphic or multimedia)');
    }
    const kinds = new Set(refs.map((r) => r.kind));
    const bad = refs.findIndex((r) => r.kind !== 'graphic' && r.kind !== 'multimedia');
    if (bad >= 0) {
      throw new DraftInputError(
        `${path}/refs[${bad + 1}]`,
        `a "figure" node takes only graphic or multimedia refs, got ${refs[bad].kind}`,
      );
    }
    if (kinds.size > 1) {
      throw new DraftInputError(
        `${path}/refs`,
        'a "figure" node cannot mix graphic and multimedia refs',
      );
    }
    const isMedia = refs[0].kind === 'multimedia';
    const e = this.common(this.el(isMedia ? 'multimedia' : 'figure'), node);
    e.appendChild(this.textEl('title', node.title));
    refs.forEach((r, i) => {
      const rp = `${path}/refs[${i + 1}]`;
      const icn = this.resolveIcn(r, isMedia ? 'multimedia' : 'graphic', rp);
      e.appendChild(
        isMedia
          ? this.el('multimediaObject', {
              multimediaType: r.multimediaType ?? 'other',
              infoEntityIdent: icn,
            })
          : this.el('graphic', { infoEntityIdent: icn }),
      );
    });
    return e;
  }

  /** para・note・figure・table・list を、置ける場所（ncp と fmft）に置く要素にする */
  ncp(node: DraftNode, path: string): Element {
    switch (node.kind) {
      case 'para':
        return this.para(node, path);
      case 'list':
        return this.wrappedList(node, path);
      case 'table':
        return this.table(node, path);
      case 'figure':
        return this.figure(node, path);
      case 'admonition':
        return this.admonition(node, path);
      default:
        throw new DraftInputError(path, `node kind "${node.kind}" cannot be placed here`);
    }
  }

  /**
   * 子を「警告 → 注意 → それ以外（入力の順）→ 入れ子の節・手順」の順に分ける。
   * 警告・注意は XSD が見出しの直後に置くことを要求するので、入力の位置にかかわらず先頭へ寄せる。
   * 入れ子の節・手順より後ろに本文がある並びは、XSD が許さないので DraftInputError にする
   */
  partition(
    kids: DraftNode[],
    path: string,
    nested: DraftNodeKind,
  ): { warnings: number[]; cautions: number[]; blocks: number[]; nested: number[] } {
    const out = {
      warnings: [] as number[],
      cautions: [] as number[],
      blocks: [] as number[],
      nested: [] as number[],
    };
    kids.forEach((c, i) => {
      if (c.kind === nested) out.nested.push(i);
      else if (c.kind === 'admonition' && c.level === 'warning') out.warnings.push(i);
      else if (c.kind === 'admonition' && c.level === 'caution') out.cautions.push(i);
      else {
        if (out.nested.length > 0) {
          throw new DraftInputError(
            `${path}/children[${i + 1}]`,
            `a "${c.kind}" node cannot come after a nested "${nested}" node (the nested ones must come last)`,
          );
        }
        out.blocks.push(i);
      }
    });
    const firstOther = Math.min(...out.blocks, ...out.nested);
    if ([...out.warnings, ...out.cautions].some((i) => i > firstOther)) {
      this.notes.push(
        `${path}: warning/caution nodes were moved to the front of the node, as the schema requires.`,
      );
    }
    return out;
  }

  // ---- 手順（proced・process 共通） ----

  /** proceduralStep。title・警告・注意・本文・入れ子の手順の順 */
  proceduralStep(node: DraftNode, path: string): Element {
    const e = this.common(this.el('proceduralStep'), node);
    const kids = this.childrenOf(node, 'step', path);
    const p = this.partition(kids, path, 'step');
    const hasText = node.text !== undefined || (node.refs?.length ?? 0) > 0;
    if (node.title === undefined && !hasText && p.blocks.length === 0) {
      throw new DraftInputError(
        path,
        'a "step" node needs title, text or a para/figure/table child',
      );
    }
    if (node.title !== undefined) e.appendChild(this.textEl('title', node.title));
    const at = (i: number) => `${path}/children[${i + 1}]`;
    for (const i of p.warnings) e.appendChild(this.admonition(kids[i], at(i)));
    for (const i of p.cautions) e.appendChild(this.admonition(kids[i], at(i)));
    if (hasText)
      e.appendChild(
        this.textBlock('para', { kind: 'para', text: node.text, refs: node.refs }, path),
      );
    for (const i of p.blocks) e.appendChild(this.ncp(kids[i], at(i)));
    for (const i of p.nested) e.appendChild(this.proceduralStep(kids[i], at(i)));
    return e;
  }

  // ---- 前提条件・事後条件（proced・fault 共通） ----

  /** body の `requirements` を、前提（本体より前）と事後（本体より後）に分ける */
  splitRequirements(
    body: DraftNode[],
    isMain: (n: DraftNode) => boolean,
  ): { pre?: { node: DraftNode; path: string }; close?: { node: DraftNode; path: string } } {
    const out: {
      pre?: { node: DraftNode; path: string };
      close?: { node: DraftNode; path: string };
    } = {};
    let seenMain = false;
    body.forEach((n, i) => {
      const path = `/body[${i + 1}]`;
      if (isMain(n)) seenMain = true;
      else if (n.kind === 'requirements') {
        const slot = seenMain ? 'close' : 'pre';
        if (out[slot]) {
          throw new DraftInputError(
            path,
            `at most one "requirements" node is accepted ${seenMain ? 'after' : 'before'} the main procedure`,
          );
        }
        out[slot] = { node: n, path };
      }
    });
    return out;
  }

  /**
   * reqCondGroup: 文があれば reqCondNoRef/reqCond に、無ければ noConds。
   * 子のうち条件になるのは para だけ。admonition・person・document・equipment・supply・spare は preliminaryRqmts が書く
   */
  reqCondGroup(req?: { node: DraftNode; path: string }): Element {
    const group = this.el('reqCondGroup');
    const texts: string[] = [];
    if (req) {
      this.checkFields(req.node, req.path);
      if (req.node.text !== undefined) texts.push(req.node.text);
      this.childrenOf(req.node, 'requirements', req.path).forEach((c, i) => {
        if (c.kind !== 'para') return;
        if (c.text === undefined) {
          throw new DraftInputError(`${req.path}/children[${i + 1}]`, 'a requirement needs text');
        }
        if ((c.refs?.length ?? 0) > 0) {
          throw new DraftInputError(
            `${req.path}/children[${i + 1}]`,
            'a requirement takes no refs',
          );
        }
        texts.push(c.text);
      });
    }
    if (texts.length === 0) group.appendChild(this.el('noConds'));
    for (const t of texts) {
      const c = this.el('reqCondNoRef');
      c.appendChild(this.textEl('reqCond', t));
      group.appendChild(c);
    }
    return group;
  }

  /**
   * reqSafety: `requirements` の子の admonition を safetyRqmts の warning / caution / note に書く。無ければ noSafety。
   * XSD が警告 → 注意 → 備考の順を要求するので、入力の位置にかかわらずこの順に並べる
   */
  private reqSafety(req?: { node: DraftNode; path: string }): { element: Element; count: number } {
    const e = this.el('reqSafety');
    const found = (req?.node.children ?? [])
      .map((c, i) => ({ c, path: `${req!.path}/children[${i + 1}]` }))
      .filter((x) => x.c.kind === 'admonition');
    if (found.length === 0) {
      e.appendChild(this.el('noSafety'));
      return { element: e, count: 0 };
    }
    const order = { warning: 0, caution: 1, note: 2 } as const;
    const rank = (n: DraftNode) => (n.level ? order[n.level] : 3);
    const sorted = [...found].sort((a, b) => rank(a.c) - rank(b.c));
    if (sorted.some((x, i) => x !== found[i])) {
      this.notes.push(
        `${req!.path}: the safety requirements were written as warnings, then cautions, then notes, as the schema requires.`,
      );
    }
    const safety = this.el('safetyRqmts');
    for (const { c, path } of sorted) safety.appendChild(this.admonition(c, path));
    e.appendChild(safety);
    return { element: e, count: found.length };
  }

  /** requirements の子のうち、指定した種類のものを位置付きで返す */
  private reqChildren(
    req: { node: DraftNode; path: string } | undefined,
    kind: DraftNodeKind,
  ): Array<{ c: DraftNode; path: string }> {
    return (req?.node.children ?? [])
      .map((c, i) => ({ c, path: `${req!.path}/children[${i + 1}]` }))
      .filter((x) => x.c.kind === kind);
  }

  /** reqPersons: person を personnel（`@numRequired` と trade）に書く。無ければ要素を置かない（XSD で任意） */
  private reqPersons(req?: { node: DraftNode; path: string }): Element | undefined {
    const found = this.reqChildren(req, 'person');
    if (found.length === 0) return undefined;
    const e = this.el('reqPersons');
    for (const { c, path } of found) {
      if (c.text === undefined && c.count === undefined) {
        throw new DraftInputError(path, 'a "person" node needs text (the role) or count');
      }
      if (c.count !== undefined && !(Number.isInteger(c.count) && c.count >= 1)) {
        throw new DraftInputError(`${path}/count`, 'count must be an integer of at least 1');
      }
      const p = this.common(
        this.el('personnel', { numRequired: c.count === undefined ? undefined : String(c.count) }),
        c,
      );
      if (c.text !== undefined) p.appendChild(this.textEl('trade', c.text));
      e.appendChild(p);
    }
    return e;
  }

  /**
   * reqTechInfoGroup: document を reqTechInfo に書く。`refs` に dmRef / pmRef が 1 つあればその参照、
   * 無ければ `title`（題名）と `text`（番号）から externalPubRef。無ければ要素を置かない（XSD で任意）
   */
  private reqTechInfoGroup(req?: { node: DraftNode; path: string }): Element | undefined {
    const found = this.reqChildren(req, 'document');
    if (found.length === 0) return undefined;
    const e = this.el('reqTechInfoGroup');
    for (const { c, path } of found) {
      const info = this.el('reqTechInfo');
      const refs = c.refs ?? [];
      if (refs.length > 1) {
        throw new DraftInputError(`${path}/refs`, 'a "document" node takes at most one ref');
      }
      if (refs.length === 1) {
        const ref = refs[0];
        if (ref.kind !== 'dmRef' && ref.kind !== 'pmRef') {
          throw new DraftInputError(
            `${path}/refs[1]`,
            `a "document" node takes a dmRef or a pmRef, not ${ref.kind}`,
          );
        }
        if (c.text !== undefined) {
          throw new DraftInputError(
            `${path}/text`,
            'a "document" node with a ref takes no text (the document number is for a document outside the CSDB)',
          );
        }
        info.appendChild(
          this.inlineRef(
            ref.title === undefined && c.title !== undefined ? { ...ref, title: c.title } : ref,
            `${path}/refs[1]`,
          ),
        );
      } else {
        if (c.title === undefined && c.text === undefined) {
          throw new DraftInputError(
            path,
            'a "document" node needs a ref, or title (the title of the document) or text (its number)',
          );
        }
        const pub = this.el('externalPubRef');
        const ident = this.el('externalPubRefIdent');
        if (c.text !== undefined) ident.appendChild(this.textEl('externalPubCode', c.text));
        if (c.title !== undefined) ident.appendChild(this.textEl('externalPubTitle', c.title));
        pub.appendChild(ident);
        info.appendChild(pub);
      }
      e.appendChild(info);
    }
    return e;
  }

  /**
   * reqSupportEquips / reqSupplies / reqSpares: 品目を name・identNumber・reqQuantity（・remarks）に書く。無ければ「なし」の要素。
   * XSD は品目に識別子を 1 つ以上と reqQuantity を要求する。値を補うことはしないので、
   * `manufacturerCode`（identNumber に必須）か `quantity` が無い品目は DraftInputError にする
   */
  private reqItems(
    req: { node: DraftNode; path: string } | undefined,
    kind: 'equipment' | 'supply' | 'spare',
  ): { element: Element; count: number } {
    const names = {
      equipment: [
        'reqSupportEquips',
        'noSupportEquips',
        'supportEquipDescrGroup',
        'supportEquipDescr',
      ],
      supply: ['reqSupplies', 'noSupplies', 'supplyDescrGroup', 'supplyDescr'],
      spare: ['reqSpares', 'noSpares', 'spareDescrGroup', 'spareDescr'],
    } as const;
    const [outer, none, group, descr] = names[kind];
    const e = this.el(outer);
    const found = this.reqChildren(req, kind);
    if (found.length === 0) {
      e.appendChild(this.el(none));
      return { element: e, count: 0 };
    }
    const g = this.el(group);
    for (const { c, path } of found) {
      if (c.manufacturerCode === undefined || c.manufacturerCode === '') {
        throw new DraftInputError(
          `${path}/manufacturerCode`,
          `a "${kind}" node needs manufacturerCode (the schema requires an identifier for each item; none is made up here)`,
        );
      }
      if (c.quantity === undefined || c.quantity === '') {
        throw new DraftInputError(
          `${path}/quantity`,
          `a "${kind}" node needs quantity (the schema requires reqQuantity)`,
        );
      }
      const d = this.common(this.el(descr), c);
      if (c.title !== undefined) d.appendChild(this.textEl('name', c.title));
      const ident = this.el('identNumber');
      ident.appendChild(this.textEl('manufacturerCode', c.manufacturerCode));
      if (c.partNumber !== undefined) {
        const pn = this.el('partAndSerialNumber');
        pn.appendChild(this.textEl('partNumber', c.partNumber));
        ident.appendChild(pn);
      }
      d.appendChild(ident);
      d.appendChild(this.textEl('reqQuantity', c.quantity, { unitOfMeasure: c.unit }));
      if (c.text !== undefined) {
        const remarks = this.el('remarks');
        remarks.appendChild(this.textEl('simplePara', c.text));
        d.appendChild(remarks);
      }
      g.appendChild(d);
    }
    e.appendChild(g);
    return { element: e, count: found.length };
  }

  /**
   * preliminaryRqmts。XSD は条件・支援機材・消耗品・予備品・安全の 5 つをすべて要求し、人員と参照する文書は任意。
   * 入力の `requirements` は、条件の文（text と子の para）、人員（person）、文書（document）、
   * 品目（equipment / supply / spare）、安全の要件（admonition）を受け取る。
   * 入力に無い必須の区分は「なし」の要素で埋め、notes に書く
   */
  preliminaryRqmts(req?: { node: DraftNode; path: string }): Element {
    const e = this.el('preliminaryRqmts');
    e.appendChild(this.reqCondGroup(req));
    const persons = this.reqPersons(req);
    if (persons) e.appendChild(persons);
    const techInfo = this.reqTechInfoGroup(req);
    if (techInfo) e.appendChild(techInfo);
    const filled: string[] = [];
    for (const [kind, none] of [
      ['equipment', 'noSupportEquips'],
      ['supply', 'noSupplies'],
      ['spare', 'noSpares'],
    ] as const) {
      const r = this.reqItems(req, kind);
      e.appendChild(r.element);
      if (r.count === 0) filled.push(none);
    }
    const safety = this.reqSafety(req);
    e.appendChild(safety.element);
    if (safety.count === 0) filled.push('noSafety');
    if (filled.length > 0) {
      this.notes.push(
        `preliminaryRqmts: the input has no ${filled
          .map(
            (f) =>
              ({
                noSupportEquips: 'support equipment ("equipment" nodes)',
                noSupplies: 'supplies ("supply" nodes)',
                noSpares: 'spares ("spare" nodes)',
                noSafety: 'safety requirements ("admonition" nodes)',
              })[f],
          )
          .join(
            ', ',
          )} in the "requirements" node, so ${filled.join(', ')} ${filled.length > 1 ? 'were' : 'was'} written (the schema requires these elements).`,
      );
    }
    return e;
  }

  closeRqmts(req?: { node: DraftNode; path: string }): Element {
    (req?.node.children ?? []).forEach((c, i) => {
      if (c.kind !== 'para') {
        throw new DraftInputError(
          `${req!.path}/children[${i + 1}]`,
          `a "${c.kind}" node is accepted only in the "requirements" node before the main procedure (closeRqmts takes conditions only)`,
        );
      }
    });
    const e = this.el('closeRqmts');
    e.appendChild(this.reqCondGroup(req));
    return e;
  }
}
