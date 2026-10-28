/**
 * データモジュール（と PM）の XML を組み立てる。
 *
 * 識別・状態部（identAndStatusSection）は XSD の順序どおりに組み立てる:
 * - dmodule: dmAddress（dmIdent: dmCode → language → issueInfo、dmAddressItems: issueDate → dmTitle）
 *   → dmStatus（security → responsiblePartnerCompany → originator → applic → brexDmRef → qualityAssurance）
 * - pm: pmAddress（pmIdent: pmCode → language → issueInfo、pmAddressItems: issueDate → pmTitle）
 *   → pmStatus（同じ並び）
 * 内容部は `buildContent`（content/）に任せる。採番は `allocate.ts`。
 *
 * 決めること・決めないこと:
 * - 情報コードの既定は持たない（D-27）。qualityAssurance は検証していない `unverified` にする（検証の事実を作らない）
 * - 機密区分は入力のまま（省略を許さない）。値の意味は解釈しない
 * - 補ったこと（版・日付・BREX の出どころ・「なし」で埋めた要素・動かした警告）は `notes` に書く
 * - DOCTYPE の ENTITY / NOTATION 宣言は、graphic / multimedia の参照がある DM にだけ付ける
 * - 入力の形の誤りは `DraftInputError`。XSD・BREX の検証はここではしない（呼び出し側が verifyDataModule に通す）
 */
import { XMLSerializer } from '@xmldom/xmldom';
import { findDefaultBrex } from '../brex/locate.js';
import type { CsdbIndex } from '../csdb-index.js';
import { formatDmc, formatDmcFileName } from '../dmc.js';
import { formatPmc } from '../pmc.js';
import type { DmCode, DmRef, IssueInfo, PmCode } from '../types.js';
import type { Document, Element } from '../xml/engine.js';
import { allocateDmc, allocateIcn, allocatePmc } from './allocate.js';
import { Writer, newDocument, type AssetUse } from './content/common.js';
import { buildContent } from './content/index.js';
import { DraftInputError } from './errors.js';
import {
  DRAFT_KINDS,
  type Allocation,
  type DraftApplic,
  type DraftDataModule,
  type IssuePolicy,
} from './types.js';

/** 図の原本の形式。ICN の ENTITY 宣言（`SYSTEM "<ICN>.<extension>" NDATA <notation>`）と NOTATION 宣言になる */
export interface GraphicFormat {
  /** ファイルの拡張子（例: 'PNG'） */
  extension: string;
  /** NOTATION の名前（例: 'png'） */
  notation: string;
  /** NOTATION の公開識別子。png・jpg・gif・svg・cgm・pdf は省略できる */
  publicId?: string;
}

export interface BuildOptions {
  /** 既存の DMC・ICN・PMC を数える（採番）、既存の版を調べる（`issuePolicy`）ために使う */
  index?: CsdbIndex;
  /** 既定 BREX を探すフォルダー群（`S1000D_SPEC_DIR` など）。brexDmRef が入力にも allocation にも無いときに使う */
  specDirs?: string[];
  /** 既定 BREX への参照を直接渡す（`specDirs` より優先） */
  defaultBrexRef?: DmRef;
  /** 同じ DMC が `index` にあり、入力に issueInfo が無いときの版の上げ方（既定 'increment-issue'） */
  issuePolicy?: IssuePolicy;
  /** issueDate の既定（今日）を決める時計。テスト用 */
  now?: () => Date;
  /** graphic の原本の形式の既定（既定は PNG） */
  graphicFormat?: GraphicFormat;
  /** target（assetId か ICN）ごとの形式。multimedia は必ずここで与える（形式の既定は持たない） */
  assetFormats?: Record<string, GraphicFormat>;
}

export interface BuildResult {
  /** 組み立てた XML（XML 宣言付き） */
  xml: string;
  kind: DraftDataModule['kind'];
  /** pm 以外 */
  dmCode?: DmCode;
  /** pm のみ */
  pmCode?: PmCode;
  issueInfo: IssueInfo;
  /** `DMC-….XML` か `PMC-….XML`（発行情報と言語付き） */
  fileName: string;
  /** この組み立てで増えた分を加えた台帳（入力の台帳は書き換えない） */
  ledger: Record<string, string>;
  /** この DM で使った図（target → ICN） */
  icns: Record<string, string>;
  /** 次に使う ICN の連番（`Allocation.icn.next` に戻して使う） */
  icnNext: number;
  /** 補ったこと・動かしたことの注記 */
  notes: string[];
}

/** 公開識別子の既知の表（Bike Samples の DOCTYPE で使われている書式） */
const NOTATION_PUBLIC_IDS: Record<string, string> = {
  png: '-//W3C//NOTATION Portable Network Graphics//EN',
  cgm: '-//USA-DOD//NOTATION Computer Graphics Metafile//EN',
  jpg: '+//ISBN 0-7923-9432-1::Graphic Notation//NOTATION Joint Photographic Experts Group Raster//EN',
  gif: '+//ISBN 0-7923-9432-1::Graphic Notation//NOTATION CompuServe Graphic Interchange Format//EN',
  svg: '-//TEI//NOTATION W3C Scalable Vector Graphics Format//EN',
  pdf: '-//Adobe Inc.//NOTATION Portable Document Format//EN',
};

const DEFAULT_GRAPHIC_FORMAT: GraphicFormat = { extension: 'PNG', notation: 'png' };

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';

/** 文の途中に空白を入れてはいけない（混在内容になりうる）要素。インデントを付けない */
const NO_INDENT = new Set([
  'para',
  'action',
  'warningAndCautionPara',
  'notePara',
  'simplePara',
  'title',
  'listItemTerm',
  'reqCond',
  'choice',
  'internalRef',
]);

/** 要素だけを子に持つ要素にインデントの空白を入れる（読みやすさのため。内容は変わらない） */
function indentTree(doc: Document, el: Element, depth: number): void {
  const kids = Array.from(el.childNodes);
  for (const k of kids) if (k.nodeType === 1) indentTree(doc, k as Element, depth + 1);
  if (kids.length === 0 || NO_INDENT.has(el.nodeName) || !kids.every((k) => k.nodeType === 1))
    return;
  for (const k of kids) el.insertBefore(doc.createTextNode(`\n${'  '.repeat(depth + 1)}`), k);
  el.appendChild(doc.createTextNode(`\n${'  '.repeat(depth)}`));
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

function nextIssue(existing: IssueInfo, policy: IssuePolicy): IssueInfo {
  switch (policy) {
    case 'keep':
      return { ...existing };
    case 'increment-inwork':
      return {
        issueNumber: existing.issueNumber,
        inWork: pad(Number(existing.inWork) + 1, 2),
      };
    default:
      return { issueNumber: pad(Number(existing.issueNumber) + 1, 3), inWork: '00' };
  }
}

/** 今日（実行環境の日付）を YYYY-MM-DD にする */
function today(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`;
}

function parseIssueDate(s: string): { year: string; month: string; day: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : undefined;
  if (
    !m ||
    !d ||
    d.getUTCFullYear() !== +m[1] ||
    d.getUTCMonth() !== +m[2] - 1 ||
    d.getUTCDate() !== +m[3]
  ) {
    throw new DraftInputError(
      '/issueDate',
      `issueDate must be a real date in YYYY-MM-DD form, got "${s}"`,
    );
  }
  return { year: m[1], month: m[2], day: m[3] };
}

function applicEl(w: Writer, a: DraftApplic): Element {
  const e = w.el('applic');
  const dt = w.el('displayText');
  dt.appendChild(w.textEl('simplePara', a.displayText));
  e.appendChild(dt);
  const asserts = a.assert ?? [];
  const assertEl = (x: (typeof asserts)[number]) =>
    w.el('assert', {
      applicPropertyIdent: x.applicPropertyIdent,
      applicPropertyType: x.applicPropertyType,
      applicPropertyValues: x.applicPropertyValues,
    });
  if (asserts.length === 1) e.appendChild(assertEl(asserts[0]));
  else if (asserts.length >= 2) {
    if (a.andOr === undefined) {
      throw new DraftInputError(
        '/applic/andOr',
        'andOr is required when applic has two or more asserts',
      );
    }
    const ev = w.el('evaluate', { andOr: a.andOr });
    for (const x of asserts) ev.appendChild(assertEl(x));
    e.appendChild(ev);
  }
  return e;
}

/** 必須の文字列プロパティを確かめる */
function need(value: string | undefined, path: string): string {
  if (value === undefined || value === '') {
    throw new DraftInputError(path, 'is required');
  }
  return value;
}

/**
 * `DraftDataModule` から XML を組み立てる。
 *
 * @param draft 入力（kind が pm なら PM）
 * @param allocation 採番の規則と台帳
 * @param options 索引・既定 BREX の場所・版の上げ方など
 * @throws DraftInputError 入力の形の誤り（置けない kind、足りない採番の規則、参照先 id が無い など）
 */
export function buildDataModule(
  draft: DraftDataModule,
  allocation: Allocation,
  options: BuildOptions = {},
): BuildResult {
  if (!(DRAFT_KINDS as readonly string[]).includes(draft.kind)) {
    throw new DraftInputError('/kind', `unknown data module kind "${String(draft.kind)}"`);
  }
  if (!Array.isArray(draft.body)) throw new DraftInputError('/body', 'body must be an array');
  const techName = need(draft.title?.techName, '/title/techName');
  const security = need(draft.securityClassification, '/securityClassification');
  need(draft.language?.languageIsoCode, '/language/languageIsoCode');
  need(draft.language?.countryIsoCode, '/language/countryIsoCode');
  const isPm = draft.kind === 'pm';
  const notes: string[] = [];
  const index = options.index;

  // 1. 識別: DMC / PMC
  let ledger: Record<string, string> = { ...(allocation.ledger ?? {}) };
  let dmCode: DmCode | undefined;
  let pmCode: PmCode | undefined;
  if (isPm) {
    if (draft.pmCode) {
      pmCode = draft.pmCode;
      if (draft.sourceId) ledger[draft.sourceId] = formatPmc(pmCode);
    } else {
      const sourceId = need(draft.sourceId, '/sourceId');
      const a = allocatePmc(sourceId, draft, { ...allocation, ledger }, index);
      pmCode = a.pmCode;
      ledger = a.ledger;
    }
  } else if (draft.dmCode) {
    dmCode = draft.dmCode;
    if (draft.sourceId) ledger[draft.sourceId] = formatDmc(dmCode);
  } else {
    const sourceId = need(draft.sourceId, '/sourceId');
    const a = allocateDmc(sourceId, draft, { ...allocation, ledger }, index);
    dmCode = a.dmCode;
    ledger = a.ledger;
  }

  // 2. 版と日付
  let issueInfo: IssueInfo;
  if (draft.issueInfo) issueInfo = draft.issueInfo;
  else {
    const policy = options.issuePolicy ?? 'increment-issue';
    const lang = draft.language;
    const sameLang = (l?: { languageIsoCode: string; countryIsoCode: string }) =>
      !l ||
      (l.languageIsoCode.toLowerCase() === lang.languageIsoCode.toLowerCase() &&
        l.countryIsoCode.toLowerCase() === lang.countryIsoCode.toLowerCase());
    const found = index
      ? isPm
        ? index
            .findPublicationModules(pmCode!)
            .find((o) => o.pm?.issueInfo && sameLang(o.pm.language))?.pm
        : index.findDataModules(dmCode!).find((o) => o.dm?.issueInfo && sameLang(o.dm.language))?.dm
      : undefined;
    if (found?.issueInfo) {
      issueInfo = nextIssue(found.issueInfo, policy);
      notes.push(
        `issueInfo: the CSDB already has ${found.issueInfo.issueNumber}-${found.issueInfo.inWork}; used ${issueInfo.issueNumber}-${issueInfo.inWork} (issuePolicy "${policy}").`,
      );
    } else {
      issueInfo = { issueNumber: '001', inWork: '00' };
      notes.push('issueInfo: not given and not in the CSDB; used 001-00.');
    }
  }
  let issueDateText = draft.issueDate;
  if (issueDateText === undefined) {
    issueDateText = today((options.now ?? (() => new Date()))());
    notes.push(
      `issueDate: not given; used today's date of the running environment (${issueDateText}).`,
    );
  }
  const date = parseIssueDate(issueDateText);

  // 3. brexDmRef: 入力 → allocation → 既定 BREX
  let brexRef: DmRef | undefined;
  if (draft.brexDmRef) {
    brexRef = { dmCode: draft.brexDmRef };
    notes.push('brexDmRef: taken from the input.');
  } else if (allocation.brexDmRef) {
    brexRef = { dmCode: allocation.brexDmRef };
    notes.push('brexDmRef: taken from allocation.brexDmRef.');
  } else if (options.defaultBrexRef) {
    brexRef = options.defaultBrexRef;
    notes.push('brexDmRef: the default BREX given in options.defaultBrexRef.');
  } else {
    const found = options.specDirs ? findDefaultBrex(options.specDirs) : undefined;
    if (found) {
      brexRef = { dmCode: found.brex.dmCode, issueInfo: found.brex.issueInfo };
      notes.push(`brexDmRef: the default BREX found at ${found.path}.`);
    } else {
      notes.push(
        'brexDmRef: not given in the input or allocation, and the default BREX was not found; the brexDmRef element was omitted (the schema requires it).',
      );
    }
  }

  // 4. 内容部（図の ICN の採番もここで行う）
  const doc = newDocument();
  let icnNext = allocation.icn.next;
  const icns: Record<string, string> = {};
  const assets: AssetUse[] = [];
  const content = buildContent(draft.kind, draft.body, {
    document: doc,
    notes,
    resolveIcn: (target, _kind, path) => {
      if (icns[target]) return icns[target];
      let a;
      try {
        a = allocateIcn(
          target,
          { ...allocation, ledger, icn: { ...allocation.icn, next: icnNext } },
          index,
          {
            securityClassification: security,
          },
        );
      } catch (e) {
        if (e instanceof DraftInputError) throw new DraftInputError(path, e.detail);
        throw e;
      }
      ledger = a.ledger;
      icnNext = a.next;
      icns[target] = a.icn;
      return a.icn;
    },
    onAsset: (u) => assets.push(u),
  });

  // 5. 識別・状態部
  const w = new Writer(draft.kind, { document: doc, notes }, []);
  const eCode = draft.responsiblePartnerCompany ?? allocation.icn.cageCode;
  const oCode = draft.originator ?? allocation.icn.cageCode;
  if (draft.responsiblePartnerCompany === undefined) {
    notes.push(`responsiblePartnerCompany: not given; used allocation.icn.cageCode (${eCode}).`);
  }
  if (draft.originator === undefined) {
    notes.push(`originator: not given; used allocation.icn.cageCode (${oCode}).`);
  }
  if (!draft.applic) {
    notes.push(
      'applic: not given; the applic element was omitted (the schema requires applic or applicRef).',
    );
  }

  const append = (p: Element, ...kids: Element[]) => {
    for (const k of kids) p.appendChild(k);
    return p;
  };
  const rootName = isPm ? 'pm' : 'dmodule';
  const root = w.el(rootName);
  root.setAttribute('xmlns:xsi', XSI);
  root.setAttribute(
    'xsi:noNamespaceSchemaLocation',
    `http://www.s1000d.org/S1000D_7/xml_schema_flat/${draft.kind}.xsd`,
  );

  const language = w.el('language', {
    languageIsoCode: draft.language.languageIsoCode,
    countryIsoCode: draft.language.countryIsoCode,
  });
  const issueEl = w.el('issueInfo', {
    issueNumber: issueInfo.issueNumber,
    inWork: issueInfo.inWork,
  });
  const dateEl = w.el('issueDate', date);

  let address: Element;
  if (isPm) {
    const title = [techName, draft.title.infoName]
      .filter((s) => s !== undefined && s !== '')
      .join(' - ');
    const code = w.el('pmCode', { ...pmCode! });
    address = append(
      w.el('pmAddress'),
      append(w.el('pmIdent'), code, language, issueEl),
      append(w.el('pmAddressItems'), dateEl, w.textEl('pmTitle', title)),
    );
  } else {
    const dmTitle = append(w.el('dmTitle'), w.textEl('techName', techName));
    if (draft.title.infoName !== undefined && draft.title.infoName !== '') {
      dmTitle.appendChild(w.textEl('infoName', draft.title.infoName));
    }
    address = append(
      w.el('dmAddress'),
      append(w.el('dmIdent'), w.dmCodeEl(dmCode!), language, issueEl),
      append(w.el('dmAddressItems'), dateEl, dmTitle),
    );
  }

  const status = w.el(isPm ? 'pmStatus' : 'dmStatus');
  append(
    status,
    w.el('security', { securityClassification: security }),
    w.el('responsiblePartnerCompany', { enterpriseCode: eCode }),
    w.el('originator', { enterpriseCode: oCode }),
  );
  if (draft.applic) status.appendChild(applicEl(w, draft.applic));
  if (brexRef) {
    const ident = w.el('dmRefIdent');
    ident.appendChild(w.dmCodeEl(brexRef.dmCode));
    if (brexRef.issueInfo) {
      ident.appendChild(
        w.el('issueInfo', {
          issueNumber: brexRef.issueInfo.issueNumber,
          inWork: brexRef.issueInfo.inWork,
        }),
      );
    }
    status.appendChild(append(w.el('brexDmRef'), append(w.el('dmRef'), ident)));
  }
  status.appendChild(append(w.el('qualityAssurance'), w.el('unverified')));

  append(root, append(w.el('identAndStatusSection'), address, status), content);
  doc.appendChild(root);
  indentTree(doc, root, 0);

  // 6. DOCTYPE（図の参照がある DM にだけ ENTITY / NOTATION 宣言を付ける）
  const entities: string[] = [];
  const notations = new Map<string, string>();
  const seen = new Set<string>();
  for (const a of assets) {
    if (seen.has(a.icn)) continue;
    seen.add(a.icn);
    const fmt =
      options.assetFormats?.[a.target] ??
      options.assetFormats?.[a.icn] ??
      (a.kind === 'graphic' ? (options.graphicFormat ?? DEFAULT_GRAPHIC_FORMAT) : undefined);
    if (!fmt) {
      throw new DraftInputError(
        '/options/assetFormats',
        `multimedia asset "${a.target}" needs a format in options.assetFormats (there is no default format for multimedia)`,
      );
    }
    const publicId = fmt.publicId ?? NOTATION_PUBLIC_IDS[fmt.notation];
    if (!publicId) {
      throw new DraftInputError(
        '/options/assetFormats',
        `notation "${fmt.notation}" has no known public identifier: give publicId`,
      );
    }
    entities.push(`<!ENTITY ${a.icn} SYSTEM "${a.icn}.${fmt.extension}" NDATA ${fmt.notation}>`);
    notations.set(fmt.notation, `<!NOTATION ${fmt.notation} PUBLIC "${publicId}">`);
  }
  const doctype =
    entities.length > 0
      ? `<!DOCTYPE ${rootName} [\n${[...entities, ...notations.values()].join('\n')}\n]>\n`
      : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${doctype}${new XMLSerializer().serializeToString(root)}\n`;

  const fileName = isPm
    ? `PMC-${formatPmc(pmCode!)}_${issueInfo.issueNumber}-${issueInfo.inWork}_${draft.language.languageIsoCode.toUpperCase()}-${draft.language.countryIsoCode.toUpperCase()}.XML`
    : formatDmcFileName({ dmCode: dmCode!, issueInfo, language: draft.language, extension: 'XML' });

  return {
    xml,
    kind: draft.kind,
    dmCode,
    pmCode,
    issueInfo,
    fileName,
    ledger,
    icns,
    icnNext,
    notes,
  };
}
