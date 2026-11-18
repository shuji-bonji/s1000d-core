/**
 * 識別・状態部に、更新の理由（`reasonForUpdate`）を 1 つ足す。本文には触らず、変更の印も付けない。
 *
 * 設計: s1000d-stack の docs/design/core-revision.md、DECISIONS D-33（R-4 の補足）。
 *
 * 使う場面は、変更の印を付けない変更の理由を書くときである。
 * - 編集上の変更（`updateReasonType` が urt01）。この理由に結び付く変更の印があってはならない（Chap 3.9.5.2.1.1 Para 2.2）
 * - `issueType` が `revised`・`status` の版。変更の印を持てないが、`reasonForUpdate` は要る（BREX-S1-00038）
 *
 * 変更の印を付ける編集の理由は、`editContent` の `marking.reason` が足す。ここで足した理由を、後の編集の印から指すときは
 * `marking.reasonRefId` に `id` を渡す。
 */
import {
  applySplices,
  descendantsAndSelf,
  layoutOf,
  reasonForUpdateSplice,
  signature,
  statusElementOf,
} from '../edit/edit.js';
import type { Document, Element, Node, XmlEngine } from '../xml/engine.js';
import { rangesMatchDocument, scanElementRanges } from '../xml/ranges.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import type {
  AddReasonForUpdateOptions,
  AddReasonForUpdateResult,
  AddReasonRefusal,
  AddReasonRefusalReason,
  ReasonForUpdateInput,
} from './types.js';

const isElement = (n: Node | null | undefined): n is Element => !!n && n.nodeType === 1;

export function addReasonForUpdate(
  xml: string,
  reason: ReasonForUpdateInput,
  options: AddReasonForUpdateOptions = {},
): AddReasonForUpdateResult {
  const engine: XmlEngine = options.engine ?? defaultXmlEngine;
  const notes: string[] = [];
  const refusals: AddReasonRefusal[] = [];
  const fail = (): AddReasonForUpdateResult => ({ added: false, xml, refusals, notes });
  const refuse = (r: AddReasonRefusalReason, message: string) => {
    refusals.push({ reason: r, message });
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
  const status = statusElementOf(doc);
  if (!status) {
    refuse(
      'no-status-element',
      'The document has no status element (dmStatus) to add reasonForUpdate to.',
    );
    return fail();
  }
  const issueInfo = engine.selectNodes('/*/identAndStatusSection/*/*/issueInfo', doc)[0];
  if (isElement(issueInfo) && (issueInfo.getAttribute('inWork') ?? '00') === '00') {
    refuse(
      'released-issue',
      'The document is a released issue (issueInfo/@inWork is "00"). Reasons for update are added to an in-work issue: start one with startRevision first.',
    );
  }

  const ids = new Set<string>();
  for (const el of descendantsAndSelf(root)) {
    const id = el.getAttribute('id');
    if (id) ids.add(id);
  }
  const bad = (message: string) => refuse('reason-input-error', message);
  if (!reason || typeof reason.text !== 'string' || reason.text.trim() === '') {
    bad('reason.text is required (the text of the reason for update).');
  }
  if (
    !reason ||
    typeof reason.updateReasonType !== 'string' ||
    !/^urt\d{2}$/.test(reason.updateReasonType)
  ) {
    bad('reason.updateReasonType is required (urt01 … urt99; it is never filled in).');
  }
  if (
    reason?.updateHighlight !== undefined &&
    reason.updateHighlight !== '0' &&
    reason.updateHighlight !== '1'
  ) {
    bad('reason.updateHighlight must be "0" or "1".');
  }
  if (reason?.id !== undefined && !/^[A-Za-z_][\w.-]*$/.test(reason.id)) {
    bad(`reason.id "${reason.id}" is not a valid XML ID.`);
  } else if (reason?.id !== undefined && ids.has(reason.id)) {
    refuse('id-duplicate', `reason.id "${reason.id}" is already used in the document.`);
  }
  if (refusals.length > 0) return fail();

  let id = reason.id ?? '';
  for (let n = 1; id === ''; n++) {
    const candidate = `rfu-${String(n).padStart(4, '0')}`;
    if (!ids.has(candidate)) id = candidate;
  }
  const placed = reasonForUpdateSplice(layoutOf(xml, rootRange), rootRange, status, {
    ...reason,
    id,
  });
  if (!placed) {
    refuse('ranges-unavailable', 'The place for reasonForUpdate was not found.');
    return fail();
  }
  const out = applySplices(xml, [placed.splice]);

  // DOM で同じ操作をして、結果を比べる
  status.insertBefore(doc.importNode(placed.element, true), placed.before ?? null);
  let reparsed: Document;
  try {
    reparsed = engine.parse(out).document;
  } catch (e) {
    refuse('internal-mismatch', `The edited text is not well-formed: ${(e as Error).message}`);
    return fail();
  }
  if (signature(reparsed.documentElement!) !== signature(root)) {
    refuse(
      'internal-mismatch',
      'The edited text does not match the result of the same change on the DOM. Nothing was applied.',
    );
    return fail();
  }

  notes.push(
    'Only the status element was changed: the content, the issue information and change markup were not changed.',
  );
  if (reason.updateReasonType === 'urt01') {
    notes.push(
      'updateReasonType "urt01" is an editorial change: no change markup may refer to this reason (editContent refuses marking.reasonRefId for it).',
    );
  } else {
    notes.push(
      `No change markup refers to "${id}" yet. To mark later edits with this reason, pass marking.reasonRefId "${id}" to editContent.`,
    );
  }
  return {
    added: true,
    xml: out,
    refusals,
    reasonForUpdate: {
      id,
      updateReasonType: reason.updateReasonType,
      ...(reason.updateHighlight !== undefined ? { updateHighlight: reason.updateHighlight } : {}),
    },
    notes,
  };
}
