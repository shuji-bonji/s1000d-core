/**
 * データモジュールの XML を読み、識別・状態部（identAndStatusSection）を取り出す。
 *
 * 根拠: S1000D Chap 3.9.5.1（Identification and status section）。
 * 対象はデータモジュール（ルート `dmodule`）。パブリケーションモジュールなど他の CSDB オブジェクトは
 * `readDataModuleInfo` で種類だけ分かり、`identAndStatus` は undefined になる。
 */
import type { CommentCode, CommentType } from './comment/types.js';
import { parseSchemaLocation } from './schema-location.js';
import type {
  DataModuleInfo,
  DmCode,
  DmRef,
  IdentAndStatus,
  IssueInfo,
  Language,
  ParseResult,
  PmCode,
} from './types.js';
import { defaultXmlEngine } from './xml/xmldom-fontoxpath.js';
import type { Document, Element, Node, XmlEngine } from './xml/engine.js';

function attr(el: Element | undefined, name: string): string | undefined {
  const v = el?.getAttribute(name);
  return v === null || v === undefined || v === '' ? undefined : v;
}

function firstElement(engine: XmlEngine, expr: string, ctx: Node): Element | undefined {
  const n = engine.selectNodes(expr, ctx)[0];
  return n && n.nodeType === 1 ? (n as Element) : undefined;
}

/** `dmCode` 要素の属性から DmCode を組み立てる。 */
export function readDmCodeElement(el: Element): ParseResult<DmCode> {
  const required = [
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
  ] as const;
  const value: Partial<DmCode> = {};
  for (const name of required) {
    const v = attr(el, name);
    if (v === undefined) return { ok: false, error: `dmCode is missing attribute ${name}` };
    value[name] = v;
  }
  const learnCode = attr(el, 'learnCode');
  const learnEventCode = attr(el, 'learnEventCode');
  if (learnCode !== undefined) value.learnCode = learnCode;
  if (learnEventCode !== undefined) value.learnEventCode = learnEventCode;
  return { ok: true, value: value as DmCode };
}

export function readIssueInfo(el: Element | undefined): IssueInfo | undefined {
  const issueNumber = attr(el, 'issueNumber');
  const inWork = attr(el, 'inWork');
  return issueNumber !== undefined ? { issueNumber, inWork: inWork ?? '00' } : undefined;
}

function readLanguage(el: Element | undefined): Language | undefined {
  const languageIsoCode = attr(el, 'languageIsoCode');
  const countryIsoCode = attr(el, 'countryIsoCode');
  return languageIsoCode !== undefined && countryIsoCode !== undefined
    ? { languageIsoCode, countryIsoCode }
    : undefined;
}

function readEnterprise(el: Element | undefined, engine: XmlEngine) {
  if (!el) return undefined;
  return {
    enterpriseCode: attr(el, 'enterpriseCode'),
    enterpriseName: engine.selectString('enterpriseName', el)?.trim(),
  };
}

/** `dmRef` 要素（`dmRefIdent` を含む）から DmRef を読む。 */
export function readDmRef(
  dmRefEl: Element,
  engine: XmlEngine = defaultXmlEngine,
): ParseResult<DmRef> {
  const codeEl = firstElement(engine, 'dmRefIdent/dmCode', dmRefEl);
  if (!codeEl) return { ok: false, error: 'dmRef has no dmRefIdent/dmCode' };
  const dmCode = readDmCodeElement(codeEl);
  if (!dmCode.ok) return dmCode;
  const value: DmRef = { dmCode: dmCode.value };
  const issueInfo = readIssueInfo(firstElement(engine, 'dmRefIdent/issueInfo', dmRefEl));
  const language = readLanguage(firstElement(engine, 'dmRefIdent/language', dmRefEl));
  if (issueInfo) value.issueInfo = issueInfo;
  if (language) value.language = language;
  return { ok: true, value };
}

/** 識別・状態部を読む。`dmodule` 以外のルートでは失敗を返す。 */
export function readIdentAndStatus(
  document: Document,
  engine: XmlEngine = defaultXmlEngine,
): ParseResult<IdentAndStatus> {
  const root = document.documentElement;
  if (!root || root.nodeName !== 'dmodule') {
    return {
      ok: false,
      error: `Root element is "${root?.nodeName ?? '(none)'}", expected "dmodule"`,
    };
  }
  const section = firstElement(engine, 'identAndStatusSection', root);
  if (!section) return { ok: false, error: 'dmodule has no identAndStatusSection' };

  const codeEl = firstElement(engine, 'dmAddress/dmIdent/dmCode', section);
  if (!codeEl) return { ok: false, error: 'identAndStatusSection has no dmAddress/dmIdent/dmCode' };
  const dmCode = readDmCodeElement(codeEl);
  if (!dmCode.ok) return dmCode;

  const value: IdentAndStatus = { dmCode: dmCode.value };
  const language = readLanguage(firstElement(engine, 'dmAddress/dmIdent/language', section));
  const issueInfo = readIssueInfo(firstElement(engine, 'dmAddress/dmIdent/issueInfo', section));
  if (language) value.language = language;
  if (issueInfo) value.issueInfo = issueInfo;

  const dateEl = firstElement(engine, 'dmAddress/dmAddressItems/issueDate', section);
  const y = attr(dateEl, 'year');
  const mo = attr(dateEl, 'month');
  const d = attr(dateEl, 'day');
  if (y && mo && d) value.issueDate = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;

  const title = 'dmAddress/dmAddressItems/dmTitle/';
  value.techName = engine.selectString(title + 'techName', section)?.trim();
  value.infoName = engine.selectString(title + 'infoName', section)?.trim();
  value.infoNameVariant = engine.selectString(title + 'infoNameVariant', section)?.trim();

  const status = firstElement(engine, 'dmStatus', section);
  if (status) {
    value.issueType = attr(status, 'issueType');
    value.securityClassification = attr(
      firstElement(engine, 'security', status),
      'securityClassification',
    );
    value.responsiblePartnerCompany = readEnterprise(
      firstElement(engine, 'responsiblePartnerCompany', status),
      engine,
    );
    value.originator = readEnterprise(firstElement(engine, 'originator', status), engine);
    value.applicDisplayText = engine
      .selectString('applic/displayText', status)
      ?.replace(/\s+/g, ' ')
      .trim();
    const brexRef = firstElement(engine, 'brexDmRef/dmRef', status);
    if (brexRef) {
      const ref = readDmRef(brexRef, engine);
      if (ref.ok) value.brexDmRef = ref.value;
    }
    const qa = firstElement(engine, 'qualityAssurance/*', status);
    if (qa) value.qualityAssurance = qa.nodeName;
  }
  return { ok: true, value };
}

/** ルート要素ごとの状態部（`brexDmRef` を持つ要素）への経路。探す順に並べる。 */
const STATUS_PATHS = [
  'identAndStatusSection/dmStatus', // dmodule
  'identAndStatusSection/pmStatus', // pm
  'identAndStatusSection/commentStatus', // comment
] as const;

/**
 * ルートが `dmodule` / `pm` / `comment` のどれでも、状態部（`dmStatus` / `pmStatus` / `commentStatus`）の
 * `brexDmRef/dmRef` を読む。BREX の連鎖をたどる最初の参照になる。
 * 参照が無い、または読めないときは undefined。
 */
export function readBrexDmRefOf(
  document: Document,
  engine: XmlEngine = defaultXmlEngine,
): DmRef | undefined {
  const root = document.documentElement;
  if (!root) return undefined;
  for (const path of STATUS_PATHS) {
    const ref = firstElement(engine, `${path}/brexDmRef/dmRef`, root);
    if (!ref) continue;
    const r = readDmRef(ref, engine);
    return r.ok ? r.value : undefined;
  }
  return undefined;
}

/** `pmCode` 要素の属性から PmCode を組み立てる。属性が欠けていれば undefined。 */
export function readPmCodeElement(el: Element): PmCode | undefined {
  const modelIdentCode = attr(el, 'modelIdentCode');
  const pmIssuer = attr(el, 'pmIssuer');
  const pmNumber = attr(el, 'pmNumber');
  const pmVolume = attr(el, 'pmVolume');
  return modelIdentCode && pmIssuer && pmNumber && pmVolume
    ? { modelIdentCode, pmIssuer, pmNumber, pmVolume }
    : undefined;
}

/** `commentCode` 要素の属性から CommentCode を組み立てる。属性が欠けていれば undefined。 */
export function readCommentCodeElement(el: Element): CommentCode | undefined {
  const modelIdentCode = attr(el, 'modelIdentCode');
  const senderIdent = attr(el, 'senderIdent');
  const yearOfDataIssue = attr(el, 'yearOfDataIssue');
  const seqNumber = attr(el, 'seqNumber');
  const commentType = attr(el, 'commentType');
  return modelIdentCode && senderIdent && yearOfDataIssue && seqNumber && commentType
    ? {
        modelIdentCode,
        senderIdent,
        yearOfDataIssue,
        seqNumber,
        commentType: commentType as CommentType,
      }
    : undefined;
}

/**
 * ルートが `pm` / `comment` の文書の識別コードを読む（`dmodule` では空）。
 * `readIdentAndStatus` は `dmodule` 専用なので、PM・comment の対象情報（報告用）はこちらで補う。
 */
export function readNonDmIdent(
  document: Document,
  engine: XmlEngine = defaultXmlEngine,
): { pmCode?: PmCode; issueInfo?: IssueInfo; commentCode?: CommentCode } {
  const root = document.documentElement;
  if (!root) return {};
  if (root.nodeName === 'pm') {
    const codeEl = firstElement(engine, 'identAndStatusSection/pmAddress/pmIdent/pmCode', root);
    const issueInfo = readIssueInfo(
      firstElement(engine, 'identAndStatusSection/pmAddress/pmIdent/issueInfo', root),
    );
    const pmCode = codeEl && readPmCodeElement(codeEl);
    return { ...(pmCode ? { pmCode } : {}), ...(issueInfo ? { issueInfo } : {}) };
  }
  if (root.nodeName === 'comment') {
    const codeEl = firstElement(
      engine,
      'identAndStatusSection/commentAddress/commentIdent/commentCode',
      root,
    );
    const commentCode = codeEl && readCommentCodeElement(codeEl);
    return commentCode ? { commentCode } : {};
  }
  return {};
}

/**
 * XML 文字列からデータモジュールの要約を読む。
 * 種類（スキーマ名）と版は `xsi:noNamespaceSchemaLocation` から推定し、
 * ルートが `dmodule` なら識別・状態部も読む。
 */
export function readDataModuleInfo(
  xml: string,
  engine: XmlEngine = defaultXmlEngine,
): DataModuleInfo {
  const parsed = engine.parse(xml);
  const root = parsed.document.documentElement!;
  const schemaLocation =
    attr(root, 'xsi:noNamespaceSchemaLocation') ?? attr(root, 'noNamespaceSchemaLocation');
  const loc = parseSchemaLocation(schemaLocation);
  const info: DataModuleInfo = {
    rootElement: root.nodeName,
    schemaLocation,
    schemaName: loc.schemaName,
    issue: loc.issue,
    hasEntityDeclarations: parsed.hasEntityDeclarations,
  };
  if (root.nodeName === 'dmodule') {
    const ident = readIdentAndStatus(parsed.document, engine);
    if (ident.ok) info.identAndStatus = ident.value;
  }
  return info;
}
