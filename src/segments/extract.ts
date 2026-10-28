/**
 * 翻訳向けに、データモジュールから人が読む文を抜き出す。
 *
 * 翻訳も訳の採点もしない（文を出すだけ）。差し戻しは `applySegments`。
 * 設計: design/writer-mcp.md「extract_segments / apply_segments」
 */
import { readIdentAndStatus } from '../data-module.js';
import type { XmlEngine } from '../xml/index.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import { collectRuns, countTextyPlaceholders } from './collect.js';
import { SegmentsError } from './errors.js';
import { skeletonHashOfDocument } from './skeleton.js';
import {
  SEGMENT_CATEGORIES,
  type ExtractOptions,
  type ExtractResult,
  type Segment,
  type SegmentCounts,
} from './types.js';

export function extractSegments(
  xml: string,
  options: ExtractOptions = {},
  engine: XmlEngine = defaultXmlEngine,
): ExtractResult {
  const parsed = engine.parse(xml);
  const root = parsed.document.documentElement!;
  if (root.nodeName !== 'dmodule') {
    throw new SegmentsError(
      'not-a-data-module',
      `Root element is "${root.nodeName}", expected "dmodule"`,
    );
  }
  const ident = readIdentAndStatus(parsed.document, engine);
  if (!ident.ok) throw new SegmentsError('invalid-data-module', ident.error);

  const runs = collectRuns(parsed.document);
  const notes: string[] = [];
  const texty = countTextyPlaceholders(runs);
  if (texty > 0) {
    notes.push(
      `${texty} inline element(s) with text (emphasis, acronym, subScript, etc.) are kept as placeholders; the text inside them is not offered for translation.`,
    );
  }

  const include = new Set(options.include ?? SEGMENT_CATEGORIES);
  let selected = runs.filter((r) => include.has(r.category));
  const max = options.maxSegments;
  if (max !== undefined && max >= 0 && selected.length > max) {
    notes.push(
      `Only the first ${max} of ${selected.length} segment(s) are returned (maxSegments).`,
    );
    selected = selected.slice(0, max);
  }
  if (selected.length === 0) notes.push('No segments were found.');

  const segments: Segment[] = selected.map((r) => ({
    id: r.id,
    xpath: r.xpath,
    element: r.element.nodeName,
    category: r.category,
    context: r.context,
    text: r.text,
    placeholders: r.placeholders.map(({ index, element, xml }) => ({ index, element, xml })),
    location: r.location,
  }));

  const counts: SegmentCounts = {
    total: segments.length,
    title: 0,
    para: 0,
    step: 0,
    admonition: 0,
    table: 0,
    caption: 0,
  };
  for (const s of segments) counts[s.category]++;

  // 骨組みは読み直した文書で計算する（上の文書の節点は書き換えない）
  const skeletonHash = skeletonHashOfDocument(engine.parse(xml).document, xml);

  return {
    dmCode: ident.value.dmCode,
    language: ident.value.language,
    skeletonHash,
    segments,
    counts,
    notes,
  };
}
