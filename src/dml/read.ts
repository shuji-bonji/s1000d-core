/**
 * DML（`dml`）と DDN（`ddn`）を読む。要素の構造は Issue 7 の `dml.xsd` / `ddn.xsd` と Bike Samples で確認した。
 *
 * - `dmlEntry` は `dmRef` / `pmRef` / `infoEntityRef` / `commentRef` / `dmlRef` のいずれか 1 つ、`security`、
 *   `responsiblePartnerCompany`、`answer`、`remarks` を持ち、属性に `dmlEntryType` と `issueType` がある
 * - `deliveryListItem` は `dispatchFileName`、任意の `entityControlNumber` と `issueInfo` を持つ
 */
import { describeLocation } from '../brex/check.js';
import { readDmRef, readIssueInfo } from '../data-module.js';
import { formatDmc } from '../dmc.js';
import { formatPmc } from '../pmc.js';
import type { DmRef, ParseResult, PmCode } from '../types.js';
import type { Document, Element, Node, XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import { formatDmlCode } from './code.js';
import type { DdnCode, DdnDocument, DdnItem, DmlCode, DmlDocument, DmlEntry } from './types.js';

function attr(el: Element | undefined, name: string): string | undefined {
  const v = el?.getAttribute(name);
  return v === null || v === undefined || v === '' ? undefined : v;
}

function first(engine: XmlEngine, expr: string, ctx: Node): Element | undefined {
  const n = engine.selectNodes(expr, ctx)[0];
  return n && n.nodeType === 1 ? (n as Element) : undefined;
}

function text(engine: XmlEngine, expr: string, ctx: Node): string | undefined {
  const s = engine.selectString(expr, ctx)?.trim();
  return s ? s : undefined;
}

function toDocument(input: string | Document, engine: XmlEngine): Document {
  return typeof input === 'string' ? engine.parse(input).document : input;
}

function readIssueDate(engine: XmlEngine, ctx: Node): string | undefined {
  const el = first(engine, 'issueDate', ctx);
  const y = attr(el, 'year');
  const m = attr(el, 'month');
  const d = attr(el, 'day');
  return y && m && d ? `${y}-${m}-${d}` : undefined;
}

function readPmCodeElement(el: Element): PmCode {
  return {
    modelIdentCode: attr(el, 'modelIdentCode') ?? '',
    pmIssuer: attr(el, 'pmIssuer') ?? '',
    pmNumber: attr(el, 'pmNumber') ?? '',
    pmVolume: attr(el, 'pmVolume') ?? '',
  };
}

function readDmlCodeElement(el: Element | undefined): ParseResult<DmlCode> {
  const names = [
    'modelIdentCode',
    'senderIdent',
    'dmlType',
    'yearOfDataIssue',
    'seqNumber',
  ] as const;
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = attr(el, n);
    if (v === undefined) return { ok: false, error: `dmlCode lacks @${n}` };
    out[n] = v;
  }
  return { ok: true, value: out as unknown as DmlCode };
}

function readDdnCodeElement(el: Element | undefined): ParseResult<DdnCode> {
  const names = [
    'modelIdentCode',
    'senderIdent',
    'receiverIdent',
    'yearOfDataIssue',
    'seqNumber',
  ] as const;
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = attr(el, n);
    if (v === undefined) return { ok: false, error: `ddnCode lacks @${n}` };
    out[n] = v;
  }
  return { ok: true, value: out as unknown as DdnCode };
}

function titleOf(engine: XmlEngine, ctx: Node, base: string): string | undefined {
  const tech = text(engine, `${base}/techName`, ctx);
  const info = text(engine, `${base}/infoName`, ctx);
  const variant = text(engine, `${base}/infoNameVariant`, ctx);
  const parts = [tech, info && variant ? `${info} - ${variant}` : info].filter(Boolean);
  return parts.length > 0 ? parts.join(' - ') : undefined;
}

function readEntry(engine: XmlEngine, el: Element): DmlEntry | undefined {
  const base = {
    location: describeLocation(el),
    dmlEntryType: attr(el, 'dmlEntryType'),
    issueType: attr(el, 'issueType'),
    securityClassification: attr(first(engine, 'security', el), 'securityClassification'),
    remarks: text(engine, 'remarks', el),
  };
  const company = first(engine, 'responsiblePartnerCompany', el);
  const responsiblePartnerCompany = company
    ? {
        enterpriseCode: attr(company, 'enterpriseCode'),
        enterpriseName: text(engine, 'enterpriseName', company),
      }
    : undefined;
  const common = { ...base, responsiblePartnerCompany };

  const dmRefEl = first(engine, 'dmRef', el);
  if (dmRefEl) {
    const r = readDmRef(dmRefEl, engine);
    if (!r.ok) return undefined;
    const dmRef: DmRef = r.value;
    return {
      kind: 'dm',
      target: formatDmc(dmRef.dmCode),
      dmRef,
      title: titleOf(engine, dmRefEl, 'dmRefAddressItems/dmTitle'),
      ...common,
    };
  }
  const pmRefEl = first(engine, 'pmRef', el);
  if (pmRefEl) {
    const code = first(engine, 'pmRefIdent/pmCode', pmRefEl);
    if (!code) return undefined;
    const pmCode = readPmCodeElement(code);
    const issueInfo = readIssueInfo(first(engine, 'pmRefIdent/issueInfo', pmRefEl));
    return {
      kind: 'pm',
      target: formatPmc(pmCode),
      pmRef: issueInfo ? { pmCode, issueInfo } : { pmCode },
      title: text(engine, 'pmRefAddressItems/pmTitle', pmRefEl),
      ...common,
    };
  }
  const icnEl = first(engine, 'infoEntityRef', el);
  if (icnEl) {
    const ident = attr(icnEl, 'infoEntityRefIdent');
    if (!ident) return undefined;
    return { kind: 'icn', target: ident, infoEntityIdent: ident, ...common };
  }
  const dmlRefEl = first(engine, 'dmlRef', el);
  if (dmlRefEl) {
    const code = readDmlCodeElement(first(engine, 'dmlRefIdent/dmlCode', dmlRefEl));
    if (!code.ok) return undefined;
    const issueInfo = readIssueInfo(first(engine, 'dmlRefIdent/issueInfo', dmlRefEl));
    return {
      kind: 'dml',
      target: formatDmlCode(code.value),
      dmlRef: issueInfo ? { dmlCode: code.value, issueInfo } : { dmlCode: code.value },
      ...common,
    };
  }
  const commentEl = first(engine, 'commentRef', el);
  if (commentEl) {
    const code = first(engine, 'commentRefIdent/commentCode', commentEl);
    const target = code
      ? ['modelIdentCode', 'senderIdent', 'yearOfDataIssue', 'seqNumber', 'commentType']
          .map((n) => attr(code, n) ?? '')
          .join('-')
      : 'comment';
    return { kind: 'comment', target, ...common };
  }
  return undefined;
}

/** DML を読む。ルートが `dml` でなければ失敗を返す */
export function readDml(
  input: string | Document,
  engine: XmlEngine = defaultXmlEngine,
): ParseResult<DmlDocument> {
  const doc = toDocument(input, engine);
  const root = doc.documentElement;
  if (!root || root.nodeName !== 'dml')
    return {
      ok: false,
      error: `Not a data module list (root element is <${root?.nodeName ?? ''}>)`,
    };
  const ident = first(engine, 'identAndStatusSection/dmlAddress/dmlIdent', root);
  const code = readDmlCodeElement(first(engine, 'dmlCode', ident ?? root));
  if (!code.ok) return code;
  const status = first(engine, 'identAndStatusSection/dmlStatus', root);
  const value: DmlDocument = { dmlCode: code.value, entries: [] };
  const issueInfo = readIssueInfo(ident ? first(engine, 'issueInfo', ident) : undefined);
  if (issueInfo) value.issueInfo = issueInfo;
  const addressItems = first(engine, 'identAndStatusSection/dmlAddress/dmlAddressItems', root);
  const issueDate = addressItems ? readIssueDate(engine, addressItems) : undefined;
  if (issueDate) value.issueDate = issueDate;
  if (status) {
    const issueType = attr(status, 'issueType');
    if (issueType) value.issueType = issueType;
    const sec = attr(first(engine, 'security', status), 'securityClassification');
    if (sec) value.securityClassification = sec;
    const brexEl = first(engine, 'brexDmRef/dmRef', status);
    if (brexEl) {
      const r = readDmRef(brexEl, engine);
      if (r.ok) value.brexDmRef = r.value;
    }
  }
  for (const n of engine.selectNodes('dmlContent/dmlEntry', root)) {
    const entry = readEntry(engine, n as Element);
    if (entry) value.entries.push(entry);
  }
  return { ok: true, value };
}

/** DDN を読む。ルートが `ddn` でなければ失敗を返す */
export function readDdn(
  input: string | Document,
  engine: XmlEngine = defaultXmlEngine,
): ParseResult<DdnDocument> {
  const doc = toDocument(input, engine);
  const root = doc.documentElement;
  if (!root || root.nodeName !== 'ddn')
    return {
      ok: false,
      error: `Not a data dispatch note (root element is <${root?.nodeName ?? ''}>)`,
    };
  const code = readDdnCodeElement(
    first(engine, 'identAndStatusSection/ddnAddress/ddnIdent/ddnCode', root),
  );
  if (!code.ok) return code;
  const value: DdnDocument = { ddnCode: code.value, items: [] };
  const addressItems = first(engine, 'identAndStatusSection/ddnAddress/ddnAddressItems', root);
  if (addressItems) {
    const issueDate = readIssueDate(engine, addressItems);
    if (issueDate) value.issueDate = issueDate;
    const to = text(engine, 'dispatchTo/dispatchAddress/enterprise/enterpriseName', addressItems);
    const from = text(
      engine,
      'dispatchFrom/dispatchAddress/enterprise/enterpriseName',
      addressItems,
    );
    if (to) value.dispatchTo = to;
    if (from) value.dispatchFrom = from;
  }
  const sec = attr(
    first(engine, 'identAndStatusSection/ddnStatus/security', root),
    'securityClassification',
  );
  if (sec) value.securityClassification = sec;
  const media = attr(first(engine, 'ddnContent/mediaIdent', root), 'label');
  if (media) value.mediaIdent = media;
  for (const n of engine.selectNodes('ddnContent/deliveryList/deliveryListItem', root)) {
    const el = n as Element;
    const fileName = text(engine, 'dispatchFileName', el);
    if (!fileName) continue;
    const item: DdnItem = { fileName, location: describeLocation(el) };
    const ecn = text(engine, 'entityControlNumber', el);
    if (ecn) item.entityControlNumber = ecn;
    const issueInfo = readIssueInfo(first(engine, 'issueInfo', el));
    if (issueInfo) item.issueInfo = issueInfo;
    value.items.push(item);
  }
  return { ok: true, value };
}
