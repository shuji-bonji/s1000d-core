/**
 * 作業中の版を始める。発行済みの版（`inWork` が "00"）の XML から、`inWork` が "01" の XML を作る。
 *
 * 設計: s1000d-stack の docs/design/core-revision.md、DECISIONS D-33（R-1・R-2・R-6・R-7）。
 *
 * - `issueNumber` はそのまま、`inWork` を "01" にし、`issueType` を入力の値にする
 * - 前の版の変更の印を消す: 印の属性、`changeInline` のタグ（中身は残す）、`reasonForUpdate`。
 *   `changeType="delete"` の要素は取り除く（仕様書に明記は無く、「前の版で示した変更は版を上げるときに消す」からの解釈）
 * - 元の文字列の、書き換える範囲だけを書き換える（`xml/ranges.ts`）。`issueDate`・`qualityAssurance`・本文は変えない
 * - 発行（`inWork` を "00" に戻し、`issueNumber` を上げる）は扱わない
 */
import { describeLocation } from '../brex/check.js';
import type { NodeLocation } from '../brex/types.js';
import { readDmCodeElement, readIssueInfo } from '../data-module.js';
import { formatDmcFileName } from '../dmc.js';
import {
  CHANGE_ATTRIBUTES,
  ID_REFERENCE_ATTRIBUTE,
  applySplices,
  descendantsAndSelf,
  removalSpan,
  signature,
  statusElementOf,
} from '../edit/edit.js';
import type { Document, Element, Node, XmlEngine } from '../xml/engine.js';
import {
  rangeOfElement,
  rangesMatchDocument,
  removeAttributeSplice,
  scanElementRanges,
  setAttributeSplice,
  type TextSplice,
} from '../xml/ranges.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import type {
  RevisionRefusal,
  RevisionRefusalReason,
  StartRevisionOptions,
  StartRevisionResult,
} from './types.js';

const ELEMENT_NODE = 1;
const isElement = (n: Node | null | undefined): n is Element => !!n && n.nodeType === ELEMENT_NODE;
const isInside = (node: Node, ancestor: Node): boolean => {
  for (let n: Node | null = node; n; n = n.parentNode) if (n === ancestor) return true;
  return false;
};

const ISSUE_TYPES = ['changed', 'revised', 'status', 'new'];

export function startRevision(xml: string, options: StartRevisionOptions): StartRevisionResult {
  const engine: XmlEngine = options.engine ?? defaultXmlEngine;
  const notes: string[] = [];
  const refusals: RevisionRefusal[] = [];
  const removedCounts: StartRevisionResult['removed'] = {
    markedElements: 0,
    changeInline: 0,
    reasonForUpdate: 0,
    deletedElements: [],
  };
  const fail = (): StartRevisionResult => ({
    started: false,
    xml,
    refusals,
    removed: { markedElements: 0, changeInline: 0, reasonForUpdate: 0, deletedElements: [] },
    notes,
  });
  const refuse = (
    reason: RevisionRefusalReason,
    message: string,
    extra: Partial<RevisionRefusal> = {},
  ) => {
    refusals.push({ reason, message, ...extra });
  };

  let doc: Document;
  try {
    doc = engine.parse(xml).document;
  } catch (e) {
    refuse('xml-not-well-formed', (e as Error).message);
    return fail();
  }
  const root = doc.documentElement!;
  const rootRange = scanElementRanges(xml);
  if (!rootRange || !rangesMatchDocument(rootRange, root)) {
    refuse(
      'ranges-unavailable',
      'The elements of the parsed document could not be matched to positions in the original text.',
    );
    return fail();
  }

  const issueInfoEl = engine.selectNodes('/*/identAndStatusSection/*/*/issueInfo', doc)[0];
  const status = statusElementOf(doc);
  const previousIssue = isElement(issueInfoEl) ? readIssueInfo(issueInfoEl) : undefined;
  if (!isElement(issueInfoEl) || !previousIssue || !status) {
    refuse('no-issue-info', 'The document has no issueInfo or no status element (dmStatus).');
    return fail();
  }
  const previousType = status.getAttribute('issueType') ?? undefined;
  const previous = {
    issueInfo: previousIssue,
    ...(previousType ? { issueType: previousType } : {}),
  };
  if (previousIssue.inWork !== '00') {
    refuse(
      'already-in-work',
      `The document is already an in-work issue (${previousIssue.issueNumber}-${previousIssue.inWork}). inWork is raised only once, when the revision starts.`,
    );
  }
  if (previousType === 'deleted') {
    refuse(
      'deleted-issue',
      'The issue is marked deleted. Reinstating a data module is not supported.',
    );
  }
  const issueType = options.issueType;
  if (!ISSUE_TYPES.includes(issueType)) {
    refuse(
      'issue-type-input-error',
      'issueType is required: "changed", "revised" or "status" ("new" only when starting from 001-00). It is never chosen for you.',
    );
  } else if (issueType === 'new' && !/^0*1$/.test(previousIssue.issueNumber)) {
    refuse(
      'issue-type-input-error',
      `issueType "new" can be kept only when starting from issue 001-00 (this is ${previousIssue.issueNumber}-${previousIssue.inWork}).`,
    );
  }
  if (refusals.length > 0) return { ...fail(), previous };

  const all = descendantsAndSelf(root);

  // 取り除く要素: changeType="delete" の要素（いちばん外側だけ）と、状態の要素の reasonForUpdate
  const deleted = all.filter((el) => el.getAttribute('changeType') === 'delete');
  const outerDeleted = deleted.filter((el) => !deleted.some((o) => o !== el && isInside(el, o)));
  const reasons = Array.from(status.childNodes).filter(
    (c) => isElement(c) && c.nodeName === 'reasonForUpdate',
  ) as unknown as Element[];
  const gone = (el: Node) => [...outerDeleted, ...reasons].some((r) => isInside(el, r));
  const rest = all.filter((el) => !gone(el));

  const deletedLocations = new Map<Element, NodeLocation>();
  for (const el of outerDeleted) {
    const location = describeLocation(el);
    deletedLocations.set(el, location);
    const ids = new Set(
      descendantsAndSelf(el)
        .map((d) => d.getAttribute('id'))
        .filter((id): id is string => !!id),
    );
    if (ids.size === 0) continue;
    const by = rest.filter((r) =>
      Array.from(r.attributes).some(
        (a) =>
          a.name !== 'id' &&
          ID_REFERENCE_ATTRIBUTE.test(a.name) &&
          a.value.split(/\s+/).some((v) => ids.has(v)),
      ),
    );
    if (by.length > 0) {
      refuse(
        'id-referenced',
        `An element marked changeType="delete" (or a descendant) has an id that ${by.length} element(s) in the rest of the document refer to (${[...ids].join(', ')}). It is removed when the revision starts, so remove the references first.`,
        { location, referencedBy: by.map((r) => describeLocation(r)) },
      );
    }
  }
  if (refusals.length > 0) return { ...fail(), previous };

  const splices: TextSplice[] = [];
  const rangeOf = (el: Element) => {
    const r = rangeOfElement(rootRange, el);
    if (!r) throw new Error(`no range for <${el.nodeName}>`);
    return r;
  };
  for (const el of [...outerDeleted, ...reasons]) {
    const span = removalSpan(xml, rangeOf(el));
    splices.push({ pos: span.from, del: span.to - span.from, ins: '' });
  }
  const inline: Element[] = [];
  const marked: Element[] = [];
  for (const el of rest) {
    if (el.nodeName === 'changeInline') {
      const r = rangeOf(el);
      splices.push({ pos: r.start, del: r.openEnd - r.start, ins: '' });
      if (!r.selfClosing) splices.push({ pos: r.closeStart, del: r.end - r.closeStart, ins: '' });
      inline.push(el);
      continue;
    }
    if (!CHANGE_ATTRIBUTES.some((a) => el.hasAttribute(a))) continue;
    const r = rangeOf(el);
    for (const a of CHANGE_ATTRIBUTES) {
      const s = removeAttributeSplice(xml, r, a);
      if (s) splices.push(s);
    }
    marked.push(el);
  }
  splices.push(setAttributeSplice(xml, rangeOf(issueInfoEl), 'inWork', '01'));
  splices.push(setAttributeSplice(xml, rangeOf(status), 'issueType', issueType));
  const out = applySplices(xml, splices);

  // DOM で同じ操作をして、結果を比べる
  for (const el of [...outerDeleted, ...reasons]) el.parentNode?.removeChild(el);
  for (const el of inline) {
    const parent = el.parentNode!;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }
  for (const el of marked) for (const a of CHANGE_ATTRIBUTES) el.removeAttribute(a);
  issueInfoEl.setAttribute('inWork', '01');
  status.setAttribute('issueType', issueType);
  (root as unknown as { normalize(): void }).normalize();
  let reparsed: Document;
  try {
    reparsed = engine.parse(out).document;
  } catch (e) {
    refuse('internal-mismatch', `The edited text is not well-formed: ${(e as Error).message}`);
    return { ...fail(), previous };
  }
  (reparsed.documentElement as unknown as { normalize(): void }).normalize();
  if (signature(reparsed.documentElement!) !== signature(root)) {
    refuse(
      'internal-mismatch',
      'The edited text does not match the result of the same changes on the DOM. Nothing was applied.',
    );
    return { ...fail(), previous };
  }

  removedCounts.markedElements = marked.length;
  removedCounts.changeInline = inline.length;
  removedCounts.reasonForUpdate = reasons.length;
  removedCounts.deletedElements = outerDeleted.map((el) => deletedLocations.get(el)!);

  const issueInfo = { issueNumber: previousIssue.issueNumber, inWork: '01' };
  notes.push(
    'The original issue is not changed: write the result under the new file name and keep the released issue in the CSDB. issueDate and qualityAssurance were not changed.',
  );
  if (outerDeleted.length > 0) {
    notes.push(
      `${outerDeleted.length} element(s) marked changeType="delete" in the previous issue were removed. Validate the result against the XSD: a parent can be left without a required child.`,
    );
  }
  const firstIssues = /^0*[01]$/.test(previousIssue.issueNumber);
  if (issueType === 'new') {
    notes.push(
      'issueType "new" on an in-work issue after 001-00 follows Chap 3.9.5.1 Table 3 but is reported as a violation of BREX-S1-00030 by the default BREX. The two disagree; the project decides.',
    );
  }
  if (issueType !== 'changed' && !firstIssues) {
    notes.push(
      `The reasons for update of the previous issue were removed and issueType is "${issueType}": the default BREX (BREX-S1-00038) requires at least one reasonForUpdate before this issue is released. Add it with addReasonForUpdate.`,
    );
  }
  if (issueType === 'revised' || issueType === 'new') {
    notes.push(
      `issueType "${issueType}" must not carry change markup (BREX-S1-00033, BREX-S1-00036): editContent refuses marking on this issue.`,
    );
  }

  let fileName: string | undefined;
  if (root.nodeName === 'dmodule') {
    const dmCodeEl = engine.selectNodes(
      '/*/identAndStatusSection/dmAddress/dmIdent/dmCode',
      doc,
    )[0];
    const langEl = engine.selectNodes(
      '/*/identAndStatusSection/dmAddress/dmIdent/language',
      doc,
    )[0];
    const dmCode = isElement(dmCodeEl) ? readDmCodeElement(dmCodeEl) : undefined;
    const languageIsoCode = isElement(langEl) ? langEl.getAttribute('languageIsoCode') : null;
    const countryIsoCode = isElement(langEl) ? langEl.getAttribute('countryIsoCode') : null;
    if (dmCode?.ok) {
      fileName = formatDmcFileName({
        dmCode: dmCode.value,
        issueInfo,
        ...(languageIsoCode && countryIsoCode
          ? { language: { languageIsoCode, countryIsoCode } }
          : {}),
        extension: 'XML',
      });
    }
  }

  return {
    started: true,
    xml: out,
    refusals,
    previous,
    issueInfo,
    issueType,
    ...(fileName ? { fileName } : {}),
    removed: removedCounts,
    notes,
  };
}
