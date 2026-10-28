/**
 * comment データモジュールの XML を組み立てる。
 *
 * 要素の並びは Issue 7 の `comment.xsd` に従う（2026-10-28 に確認）:
 * - comment: identAndStatusSection → commentContent
 * - identAndStatusSection: commentAddress（commentIdent: commentCode → language、
 *   commentAddressItems: commentTitle? → issueDate → commentOriginator/dispatchAddress）
 *   → commentStatus（security → commentPriority → commentResponse? → commentRefs → brexDmRef → remarks?、属性 issueType）
 * - dispatchAddress: enterprise（enterpriseName）→ dispatchPerson? → address（city と country が必須）
 * - commentRefs: noReferences / dmRefGroup / pmRefGroup / dmlRefGroup / ddnRefGroup のどれか 1 つ（混在不可）
 * - commentContent: simplePara（1 つ以上）。attachmentRef は作らない
 *
 * 決めること・決めないこと:
 * - 列挙（commentType / commentPriorityCode / responseType / issueType / securityClassification）は値の形だけを検査し、意味は付けない
 * - brexDmRef は XSD で必須。入力 → options.defaultBrex → 既定 BREX の探索の順に決め、無ければ入力の誤り
 * - 補ったこと（連番・年・日付・BREX の出どころ）と出せなかったこと（enterpriseCode）は `notes` に書く
 * - 入力の形の誤りは `CommentInputError`。XSD・BREX の検証はここではしない（呼び出し側が検証に通す）
 */
import { DOMImplementation, XMLSerializer } from '@xmldom/xmldom';
import { findDefaultBrex } from '../brex/locate.js';
import type { CsdbIndex } from '../csdb-index.js';
import { parseDmc } from '../dmc.js';
import { parseDdnCode, parseDmlCode } from '../dml/code.js';
import { parsePmc } from '../pmc.js';
import type { DmCode, DmRef, IssueInfo, Language } from '../types.js';
import type { Document, Element } from '../xml/engine.js';
import { COMMENT_TYPES, formatCommentFileName } from './code.js';
import { CommentInputError } from './errors.js';
import type {
  CommentAddress,
  CommentBuildResult,
  CommentCode,
  CommentInput,
  CommentRef,
  CommentRefKind,
  CommentType,
} from './types.js';

export interface BuildCommentOptions {
  /** 既存の comment を数える（`seqNumber` の採番）ために使う */
  index?: CsdbIndex;
  /** 入力に `brexDmRef` が無いときの BREX（`specDirs` より優先） */
  defaultBrex?: DmCode | DmRef;
  /** 既定 BREX を探すフォルダー群（`S1000D_SPEC_DIR` など）。`defaultBrex` が無いときに使う */
  specDirs?: string[];
  /** `yearOfDataIssue` と `issueDate` の既定（今日）を決める時計。テスト用 */
  now?: () => Date;
}

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const SCHEMA_LOCATION = 'http://www.s1000d.org/S1000D_7/xml_schema_flat/comment.xsd';

const pad = (n: number, width: number) => String(n).padStart(width, '0');

const MIC_RE = /^[A-Z0-9]{2,14}$/;
const IDENT_RE = /^[A-Z0-9]{5}$/;
const YEAR_RE = /^\d{4}$/;
const SEQ_RE = /^\d{5}$/;
/** security: 01〜99、cp: cp01〜cp99、rt: rt01〜rt99（XSD の列挙。00 は無い） */
const SECURITY_RE = /^(0[1-9]|[1-9]\d)$/;
const PRIORITY_RE = /^cp(0[1-9]|[1-9]\d)$/;
const RESPONSE_RE = /^rt(0[1-9]|[1-9]\d)$/;
/** `commentStatus/@issueType` の XSD の列挙 */
const ISSUE_TYPES = [
  'new',
  'changed',
  'deleted',
  'revised',
  'status',
  'rinstate-changed',
  'rinstate-revised',
  'rinstate-status',
];
const REF_KINDS: readonly CommentRefKind[] = ['dmRef', 'pmRef', 'dmlRef', 'ddnRef'];

const isString = (v: unknown): v is string => typeof v === 'string';

/** 必須の文字列を確かめる */
function need(value: unknown, path: string): string {
  if (!isString(value) || value === '') throw new CommentInputError(path, 'is required');
  return value;
}

/** 数字の文字列か数値を、桁数の決まった文字列にする（`year` は 4 桁、`seq` は 5 桁） */
function digits(value: string | number, path: string, re: RegExp, what: string): string {
  const s =
    typeof value === 'number'
      ? Number.isInteger(value) && value >= 0
        ? pad(value, what === 'year' ? 4 : 5)
        : String(value)
      : value;
  if (!re.test(s)) {
    throw new CommentInputError(
      path,
      `${what} must be ${what === 'year' ? '4' : '5'} digits, got "${String(value)}"`,
    );
  }
  return s;
}

function checkEnum(value: unknown, path: string, re: RegExp, expected: string): string {
  if (!isString(value) || !re.test(value)) {
    throw new CommentInputError(path, `must be ${expected}, got "${String(value)}"`);
  }
  return value;
}

function parseIssueDate(s: string): { year: string; month: string; day: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)) : undefined;
  if (
    !m ||
    !d ||
    d.getUTCFullYear() !== +m[1]! ||
    d.getUTCMonth() !== +m[2]! - 1 ||
    d.getUTCDate() !== +m[3]!
  ) {
    throw new CommentInputError(
      '/issueDate',
      `issueDate must be a real date in YYYY-MM-DD form, got "${s}"`,
    );
  }
  return { year: m[1]!, month: m[2]!, day: m[3]! };
}

/** 要素だけを子に持つ要素にインデントの空白を入れる（読みやすさのため。内容は変わらない） */
function indentTree(doc: Document, el: Element, depth: number): void {
  const kids = Array.from(el.childNodes);
  for (const k of kids) if (k.nodeType === 1) indentTree(doc, k as Element, depth + 1);
  if (kids.length === 0 || !kids.every((k) => k.nodeType === 1)) return;
  for (const k of kids) el.insertBefore(doc.createTextNode(`\n${'  '.repeat(depth + 1)}`), k);
  el.appendChild(doc.createTextNode(`\n${'  '.repeat(depth)}`));
}

/** 言語の大文字小文字を XSD の型（`[a-z]{2,3}` / `[A-Z]{2}`）に揃え、形が違えば入力の誤りにする */
function normalizeLanguage(l: Language | undefined, path: string, notes?: string[]): Language {
  const iso = need(l?.languageIsoCode, `${path}/languageIsoCode`);
  const country = need(l?.countryIsoCode, `${path}/countryIsoCode`);
  const out = { languageIsoCode: iso.toLowerCase(), countryIsoCode: country.toUpperCase() };
  if (!/^[a-z]{2,3}$/.test(out.languageIsoCode)) {
    throw new CommentInputError(`${path}/languageIsoCode`, `must be 2-3 letters, got "${iso}"`);
  }
  if (!/^[A-Z]{2}$/.test(out.countryIsoCode)) {
    throw new CommentInputError(`${path}/countryIsoCode`, `must be 2 letters, got "${country}"`);
  }
  if (notes && (out.languageIsoCode !== iso || out.countryIsoCode !== country)) {
    notes.push(
      `${path}: normalized the case of ${iso}-${country} to ${out.languageIsoCode}-${out.countryIsoCode}.`,
    );
  }
  return out;
}

function checkIssueInfo(i: IssueInfo, path: string): IssueInfo {
  if (!/^\d{3,5}$/.test(i.issueNumber ?? '')) {
    throw new CommentInputError(
      `${path}/issueNumber`,
      `must be 3-5 digits, got "${String(i.issueNumber)}"`,
    );
  }
  if (!/^\d{2}$/.test(i.inWork ?? '')) {
    throw new CommentInputError(`${path}/inWork`, `must be 2 digits, got "${String(i.inWork)}"`);
  }
  return i;
}

class B {
  constructor(readonly doc: Document) {}
  el(name: string, attrs: Record<string, string | undefined> = {}): Element {
    const e = this.doc.createElement(name);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined) e.setAttribute(k, v);
    return e;
  }
  textEl(name: string, text: string, attrs: Record<string, string | undefined> = {}): Element {
    const e = this.el(name, attrs);
    if (text !== '') e.appendChild(this.doc.createTextNode(text));
    return e;
  }
  add(parent: Element, ...kids: (Element | undefined)[]): Element {
    for (const k of kids) if (k) parent.appendChild(k);
    return parent;
  }
  dmCodeEl(dm: DmCode): Element {
    return this.el('dmCode', {
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
    });
  }
  issueEl(i: IssueInfo): Element {
    return this.el('issueInfo', { issueNumber: i.issueNumber, inWork: i.inWork });
  }
  languageEl(l: Language): Element {
    return this.el('language', {
      languageIsoCode: l.languageIsoCode,
      countryIsoCode: l.countryIsoCode,
    });
  }
  dmRefEl(ref: DmRef): Element {
    const ident = this.add(this.el('dmRefIdent'), this.dmCodeEl(ref.dmCode));
    if (ref.issueInfo) this.add(ident, this.issueEl(ref.issueInfo));
    if (ref.language) this.add(ident, this.languageEl(ref.language));
    return this.add(this.el('dmRef'), ident);
  }
}

/** 1 件の参照の要素を作る。kind ごとに XSD が持たない項目（ddnRef の版、dml・ddn の言語）は入力の誤り */
function refEl(b: B, r: CommentRef, path: string): Element {
  const code = need(r.code, `${path}/code`);
  const hasIssue = r.issueInfo !== undefined;
  const hasLang = r.language !== undefined;
  const reject = (what: string): never => {
    throw new CommentInputError(
      `${path}/${what}`,
      `${what} is not allowed on a ${r.kind} (comment.xsd has no such element there)`,
    );
  };
  switch (r.kind) {
    case 'dmRef': {
      const dm = parseDmc(code);
      if (!dm.ok)
        throw new CommentInputError(`${path}/code`, `dmRef code is not a DMC: ${dm.error}`);
      const ref: DmRef = { dmCode: dm.value };
      if (hasIssue) ref.issueInfo = checkIssueInfo(r.issueInfo!, `${path}/issueInfo`);
      if (hasLang) ref.language = normalizeLanguage(r.language, `${path}/language`);
      return b.dmRefEl(ref);
    }
    case 'pmRef': {
      const pm = parsePmc(code);
      if (!pm.ok)
        throw new CommentInputError(`${path}/code`, `pmRef code is not a PMC: ${pm.error}`);
      const ident = b.add(b.el('pmRefIdent'), b.el('pmCode', { ...pm.value }));
      if (hasIssue) b.add(ident, b.issueEl(checkIssueInfo(r.issueInfo!, `${path}/issueInfo`)));
      if (hasLang) b.add(ident, b.languageEl(normalizeLanguage(r.language, `${path}/language`)));
      return b.add(b.el('pmRef'), ident);
    }
    case 'dmlRef': {
      if (hasLang) reject('language');
      const dml = parseDmlCode(code);
      if (!dml.ok)
        throw new CommentInputError(`${path}/code`, `dmlRef code is not a DML code: ${dml.error}`);
      const ident = b.add(b.el('dmlRefIdent'), b.el('dmlCode', { ...dml.value }));
      if (hasIssue) b.add(ident, b.issueEl(checkIssueInfo(r.issueInfo!, `${path}/issueInfo`)));
      return b.add(b.el('dmlRef'), ident);
    }
    case 'ddnRef': {
      if (hasIssue) reject('issueInfo');
      if (hasLang) reject('language');
      const ddn = parseDdnCode(code);
      if (!ddn.ok)
        throw new CommentInputError(`${path}/code`, `ddnRef code is not a DDN code: ${ddn.error}`);
      return b.add(b.el('ddnRef'), b.add(b.el('ddnRefIdent'), b.el('ddnCode', { ...ddn.value })));
    }
    default:
      throw new CommentInputError(
        `${path}/kind`,
        `must be one of ${REF_KINDS.join(', ')}, got "${String((r as CommentRef).kind)}"`,
      );
  }
}

function commentRefsEl(b: B, refs: CommentRef[] | undefined): Element {
  const out = b.el('commentRefs');
  if (refs === undefined || refs.length === 0) return b.add(out, b.el('noReferences'));
  if (!Array.isArray(refs)) throw new CommentInputError('/refs', 'refs must be an array');
  const kind = refs[0]!.kind;
  refs.forEach((r, i) => {
    if (r.kind !== kind) {
      throw new CommentInputError(
        `/refs[${i + 1}]/kind`,
        `a comment can reference only one kind of object (commentRefs allows one group): the first ref is "${String(kind)}", this one is "${String(r.kind)}"`,
      );
    }
  });
  const group = b.el(`${kind}Group`);
  refs.forEach((r, i) => b.add(group, refEl(b, r, `/refs[${i + 1}]`)));
  return b.add(out, group);
}

function addressEl(b: B, a: CommentAddress | undefined): Element {
  const path = '/originator/address';
  if (!a) {
    throw new CommentInputError(
      path,
      'is required: comment.xsd requires dispatchAddress/address with city and country',
    );
  }
  const city = need(a.city, `${path}/city`);
  const country = need(a.country, `${path}/country`);
  const e = b.el('address');
  const opt = (name: string, v: string | undefined) => {
    if (v !== undefined && v !== '') b.add(e, b.textEl(name, v));
  };
  const many = (name: string, vs: string[] | undefined) => {
    for (const v of vs ?? []) if (v !== '') b.add(e, b.textEl(name, v));
  };
  // XSD の順序: department, street, postOfficeBox, postalZipCode, city, country, state, province, building, room,
  //             phoneNumber*, faxNumber*, email*, internet*, SITA
  opt('department', a.department);
  opt('street', a.street);
  opt('postOfficeBox', a.postOfficeBox);
  opt('postalZipCode', a.postalZipCode);
  b.add(e, b.textEl('city', city), b.textEl('country', country));
  opt('state', a.state);
  opt('province', a.province);
  opt('building', a.building);
  opt('room', a.room);
  many('phoneNumber', a.phoneNumber);
  many('faxNumber', a.faxNumber);
  many('email', a.email);
  many('internet', a.internet);
  opt('SITA', a.SITA);
  return e;
}

function originatorEl(b: B, o: CommentInput['originator'], notes: string[]): Element {
  if (!o) throw new CommentInputError('/originator', 'is required');
  const name = need(o.enterpriseName, '/originator/enterpriseName');
  if (o.enterpriseCode !== undefined && o.enterpriseCode !== '') {
    notes.push(
      `originator.enterpriseCode ("${o.enterpriseCode}") was not written: comment.xsd's enterprise element has no enterpriseCode attribute (the sender is identified by senderIdent).`,
    );
  }
  const enterprise = b.add(b.el('enterprise'), b.textEl('enterpriseName', name));
  if (o.division) b.add(enterprise, b.textEl('division', o.division));
  if (o.enterpriseUnit) b.add(enterprise, b.textEl('enterpriseUnit', o.enterpriseUnit));
  const dispatch = b.add(b.el('dispatchAddress'), enterprise);
  if (o.person) {
    const p = b.el('dispatchPerson', { personPrefix: o.person.personPrefix });
    b.add(p, b.textEl('lastName', need(o.person.lastName, '/originator/person/lastName')));
    if (o.person.firstName) b.add(p, b.textEl('firstName', o.person.firstName));
    if (o.person.jobTitle) b.add(p, b.textEl('jobTitle', o.person.jobTitle));
    b.add(dispatch, p);
  }
  b.add(dispatch, addressEl(b, o.address));
  return b.add(b.el('commentOriginator'), dispatch);
}

/** index にある同じモデル・送り手・年の comment の最大の連番（無ければ 0） */
function maxSeq(index: CsdbIndex, mic: string, sender: string, year: string): number {
  let max = 0;
  for (const o of index.objects) {
    const c = o.comment?.commentCode;
    if (!c || c.modelIdentCode !== mic || c.senderIdent !== sender || c.yearOfDataIssue !== year)
      continue;
    max = Math.max(max, Number(c.seqNumber));
  }
  return max;
}

function isDmRef(x: DmCode | DmRef): x is DmRef {
  return (x as DmRef).dmCode !== undefined;
}

/**
 * comment データモジュールを組み立てる。
 *
 * @param input 入力（writer-mcp の `create_comment` の入力に対応）
 * @param options 索引（採番）・既定 BREX・時計
 * @throws CommentInputError 入力の形の誤り（列挙外の値、参照の種類の混在、BREX が決まらない、必須項目の欠落 など）
 */
export function buildComment(
  input: CommentInput,
  options: BuildCommentOptions = {},
): CommentBuildResult {
  const notes: string[] = [];
  const now = (options.now ?? (() => new Date()))();

  // 1. 入力の検査（列挙は形だけ。意味は付けない）
  if (!COMMENT_TYPES.includes(input.commentType)) {
    throw new CommentInputError(
      '/commentType',
      `must be one of ${COMMENT_TYPES.join(', ')}, got "${String(input.commentType)}"`,
    );
  }
  const commentType: CommentType = input.commentType;
  const priority = checkEnum(
    input.commentPriorityCode,
    '/commentPriorityCode',
    PRIORITY_RE,
    'cp01 to cp99',
  );
  const security = checkEnum(
    input.securityClassification,
    '/securityClassification',
    SECURITY_RE,
    '01 to 99',
  );
  const responseType =
    input.responseType === undefined
      ? undefined
      : checkEnum(input.responseType, '/responseType', RESPONSE_RE, 'rt01 to rt99');
  if (input.issueType !== undefined && !ISSUE_TYPES.includes(input.issueType)) {
    throw new CommentInputError(
      '/issueType',
      `must be one of ${ISSUE_TYPES.join(', ')}, got "${String(input.issueType)}"`,
    );
  }
  const mic = checkEnum(
    input.modelIdentCode,
    '/modelIdentCode',
    MIC_RE,
    '2-14 characters of A-Z0-9',
  );
  const sender = checkEnum(input.senderIdent, '/senderIdent', IDENT_RE, '5 characters of A-Z0-9');
  const language = normalizeLanguage(input.language, '/language', notes);
  if (!Array.isArray(input.paragraphs) || input.paragraphs.length === 0) {
    throw new CommentInputError(
      '/paragraphs',
      'needs at least one paragraph (commentContent requires simplePara)',
    );
  }
  input.paragraphs.forEach((p, i) => {
    if (!isString(p)) throw new CommentInputError(`/paragraphs[${i + 1}]`, 'must be a string');
  });

  // 2. 年・日付・連番
  let year: string;
  if (input.yearOfDataIssue !== undefined)
    year = digits(input.yearOfDataIssue, '/yearOfDataIssue', YEAR_RE, 'year');
  else {
    year = pad(now.getFullYear(), 4);
    notes.push(`yearOfDataIssue: not given; used this year (${year}) of the running environment.`);
  }
  let issueDateText = input.issueDate;
  if (issueDateText === undefined) {
    issueDateText = `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`;
    notes.push(
      `issueDate: not given; used today's date of the running environment (${issueDateText}).`,
    );
  }
  const date = parseIssueDate(issueDateText);

  let seqNumber: string;
  if (input.seqNumber !== undefined) {
    seqNumber = digits(input.seqNumber, '/seqNumber', SEQ_RE, 'seqNumber');
    if (Number(seqNumber) < 1)
      throw new CommentInputError('/seqNumber', 'must be a positive number (00001 or more)');
    const dup = options.index?.objects.some((o) => {
      const c = o.comment?.commentCode;
      return (
        c &&
        c.modelIdentCode === mic &&
        c.senderIdent === sender &&
        c.yearOfDataIssue === year &&
        c.seqNumber === seqNumber
      );
    });
    if (dup)
      notes.push(
        `seqNumber: the CSDB already has a comment with ${mic}-${sender}-${year}-${seqNumber} (any commentType); the identity may collide.`,
      );
  } else {
    const max = options.index ? maxSeq(options.index, mic, sender, year) : 0;
    if (max >= 99999) {
      throw new CommentInputError(
        '/seqNumber',
        `no sequence number is left for ${mic}-${sender}-${year} (99999 is used)`,
      );
    }
    seqNumber = pad(max + 1, 5);
    notes.push(
      options.index
        ? `seqNumber: not given; used ${seqNumber}, the next number after the CSDB's comments for ${mic}-${sender}-${year} (counted across all commentType values).`
        : `seqNumber: not given and no CSDB index was given; used ${seqNumber}.`,
    );
  }

  // 3. brexDmRef: 入力 → options.defaultBrex → 既定 BREX の探索。XSD が必須とするので、決まらなければ入力の誤り
  let brexRef: DmRef | undefined;
  const asRef = (x: DmCode | DmRef): DmRef => (isDmRef(x) ? x : { dmCode: x });
  if (input.brexDmRef) {
    brexRef = asRef(input.brexDmRef);
    notes.push('brexDmRef: taken from the input.');
  } else if (options.defaultBrex) {
    brexRef = asRef(options.defaultBrex);
    notes.push('brexDmRef: the default BREX given in options.defaultBrex.');
  } else {
    const found = options.specDirs ? findDefaultBrex(options.specDirs) : undefined;
    if (found) {
      brexRef = { dmCode: found.brex.dmCode, issueInfo: found.brex.issueInfo };
      notes.push(`brexDmRef: the default BREX found at ${found.path}.`);
    }
  }
  if (!brexRef) {
    throw new CommentInputError(
      '/brexDmRef',
      'is required by comment.xsd: give brexDmRef, options.defaultBrex, or options.specDirs where the default BREX can be found',
    );
  }
  if (brexRef.issueInfo) checkIssueInfo(brexRef.issueInfo, '/brexDmRef/issueInfo');

  // 4. 組み立て
  const doc = new DOMImplementation().createDocument(null, '');
  const b = new B(doc);
  const root = b.el('comment');
  root.setAttribute('xmlns:xsi', XSI);
  root.setAttribute('xsi:noNamespaceSchemaLocation', SCHEMA_LOCATION);

  const code: CommentCode = {
    modelIdentCode: mic,
    senderIdent: sender,
    yearOfDataIssue: year,
    seqNumber,
    commentType,
  };
  const commentIdent = b.add(
    b.el('commentIdent'),
    b.el('commentCode', { ...code }),
    b.languageEl(language),
  );
  const items = b.el('commentAddressItems');
  if (input.title !== undefined && input.title !== '')
    b.add(items, b.textEl('commentTitle', input.title));
  b.add(items, b.el('issueDate', date), originatorEl(b, input.originator, notes));

  const status = b.el('commentStatus', { issueType: input.issueType });
  b.add(
    status,
    b.el('security', { securityClassification: security }),
    b.el('commentPriority', { commentPriorityCode: priority }),
  );
  if (responseType !== undefined) b.add(status, b.el('commentResponse', { responseType }));
  b.add(status, commentRefsEl(b, input.refs), b.add(b.el('brexDmRef'), b.dmRefEl(brexRef)));
  const remarks =
    input.remarks === undefined
      ? []
      : Array.isArray(input.remarks)
        ? input.remarks
        : [input.remarks];
  const remarkTexts = remarks.filter((r) => r !== '');
  if (remarkTexts.length > 0)
    b.add(status, b.add(b.el('remarks'), ...remarkTexts.map((r) => b.textEl('simplePara', r))));

  const content = b.add(
    b.el('commentContent'),
    ...input.paragraphs.map((p) => b.textEl('simplePara', p)),
  );
  b.add(
    root,
    b.add(
      b.el('identAndStatusSection'),
      b.add(b.el('commentAddress'), commentIdent, items),
      status,
    ),
    content,
  );
  doc.appendChild(root);
  indentTree(doc, root, 0);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(root)}\n`;
  const fileName = formatCommentFileName(code, language);
  notes.push(
    'fileName: the COM-… rule is inferred from one sample in the distributed data dictionary (COM-AJ-I9034-2006-00365-R_SX-US.XML) and not confirmed in the specification; comment has no issueInfo, so no issue number is in the name.',
  );
  return { xml, commentCode: code, fileName, notes };
}
