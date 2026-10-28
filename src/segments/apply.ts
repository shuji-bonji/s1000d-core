/**
 * 訳した文を、元のデータモジュールに差し戻す。
 *
 * - `skeletonHash` が合わなければ `SkeletonMismatchError`（DM が抜き出しの後に変わっている）
 * - 各 `id` の要素の文字列部分を訳文で置き換え、`{n}` を元のインライン要素に戻す
 * - プレースホルダーの数・番号が揃わない文、知らない `id`、重複した `id` は `unapplied` にして元の文を残す
 * - `dmIdent/language` を訳先に変える。`issueInfo` は options があるときだけ変える
 * - 文書要素より前（XML 宣言・DOCTYPE の内部サブセット）は元の文字列のまま保つ
 */
import { formatDmcFileName } from '../dmc.js';
import { readIdentAndStatus } from '../data-module.js';
import type { Element, Node, XmlEngine } from '../xml/index.js';
import { serializeKeepingProlog } from '../xml/serialize.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import { collectRuns, type Run } from './collect.js';
import { SegmentsError, SkeletonMismatchError } from './errors.js';
import { skeletonHashOfDocument } from './skeleton.js';
import type { ApplyOptions, ApplyResult, UnappliedSegment } from './types.js';

type Part = { text: string } | { placeholder: number };

/** 訳文を、文字とプレースホルダーに分ける。`{{` `}}` は文字の `{` `}`。壊れた書式は undefined */
function parseTemplate(text: string): Part[] | undefined {
  const parts: Part[] = [];
  let buf = '';
  const flush = () => {
    if (buf) parts.push({ text: buf });
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '{') {
      if (text[i + 1] === '{') {
        buf += '{';
        i++;
        continue;
      }
      const m = /^\{(\d+)\}/.exec(text.slice(i));
      if (!m) return undefined;
      flush();
      parts.push({ placeholder: Number(m[1]) });
      i += m[0].length - 1;
    } else if (ch === '}') {
      if (text[i + 1] === '}') {
        buf += '}';
        i++;
      } else return undefined;
    } else buf += ch;
  }
  flush();
  return parts;
}

/** プレースホルダーが、元の 1..N をちょうど 1 回ずつ使っているか */
function placeholdersMatch(parts: Part[], run: Run): boolean {
  const used = parts.filter((p): p is { placeholder: number } => 'placeholder' in p);
  if (used.length !== run.placeholders.length) return false;
  const seen = new Set(used.map((u) => u.placeholder));
  if (seen.size !== used.length) return false;
  return run.placeholders.every((p) => seen.has(p.index));
}

function replaceRun(run: Run, parts: Part[]): void {
  const el = run.element;
  const doc = el.ownerDocument!;
  for (const n of run.nodes) el.removeChild(n);
  const byIndex = new Map(run.placeholders.map((p) => [p.index, p.node]));
  for (const part of parts) {
    const node: Node =
      'text' in part ? doc.createTextNode(part.text) : byIndex.get(part.placeholder)!;
    el.insertBefore(node, run.anchor);
  }
}

function firstElement(engine: XmlEngine, expr: string, ctx: Node): Element | undefined {
  const n = engine.selectNodes(expr, ctx)[0];
  return n && n.nodeType === 1 ? (n as Element) : undefined;
}

export function applySegments(
  xml: string,
  segments: Array<{ id: string; text: string }>,
  options: ApplyOptions,
  engine: XmlEngine = defaultXmlEngine,
): ApplyResult {
  const parsed = engine.parse(xml);
  const doc = parsed.document;
  const root = doc.documentElement!;
  if (root.nodeName !== 'dmodule') {
    throw new SegmentsError(
      'not-a-data-module',
      `Root element is "${root.nodeName}", expected "dmodule"`,
    );
  }
  const ident = readIdentAndStatus(doc, engine);
  if (!ident.ok) throw new SegmentsError('invalid-data-module', ident.error);

  const actual = skeletonHashOfDocument(engine.parse(xml).document, xml);
  if (actual !== options.skeletonHash)
    throw new SkeletonMismatchError(options.skeletonHash, actual);

  const langEl = firstElement(engine, 'identAndStatusSection/dmAddress/dmIdent/language', root);
  if (!langEl) {
    throw new SegmentsError('no-language', 'The data module has no dmIdent/language element.');
  }

  const notes: string[] = [];
  const unapplied: UnappliedSegment[] = [];
  const byId = new Map(collectRuns(doc).map((r) => [r.id, r]));
  const seen = new Set<string>();
  let applied = 0;
  let changed = false;

  for (const seg of segments) {
    if (seen.has(seg.id)) {
      unapplied.push({ id: seg.id, reason: 'duplicate-id' });
      continue;
    }
    seen.add(seg.id);
    const run = byId.get(seg.id);
    if (!run) {
      unapplied.push({ id: seg.id, reason: 'unknown-id' });
      continue;
    }
    const parts = typeof seg.text === 'string' ? parseTemplate(seg.text) : undefined;
    if (!parts || !placeholdersMatch(parts, run)) {
      unapplied.push({ id: seg.id, reason: 'placeholder-mismatch' });
      continue;
    }
    applied++;
    // 抜き出したままの文は触らない（元の空白・インデントをそのまま残す）
    if (seg.text === run.text) continue;
    if (seg.text.trim() === '') notes.push(`Segment ${seg.id}: the translated text is empty.`);
    replaceRun(run, parts);
    changed = true;
  }

  const lang = options.language;
  if (
    langEl.getAttribute('languageIsoCode') !== lang.languageIsoCode ||
    langEl.getAttribute('countryIsoCode') !== lang.countryIsoCode
  ) {
    langEl.setAttribute('languageIsoCode', lang.languageIsoCode);
    langEl.setAttribute('countryIsoCode', lang.countryIsoCode);
    changed = true;
  }

  let issueInfo = ident.value.issueInfo;
  if (options.issueInfo) {
    const issueEl = firstElement(engine, 'identAndStatusSection/dmAddress/dmIdent/issueInfo', root);
    if (issueEl) {
      if (
        issueEl.getAttribute('issueNumber') !== options.issueInfo.issueNumber ||
        issueEl.getAttribute('inWork') !== options.issueInfo.inWork
      ) {
        issueEl.setAttribute('issueNumber', options.issueInfo.issueNumber);
        issueEl.setAttribute('inWork', options.issueInfo.inWork);
        changed = true;
      }
      issueInfo = options.issueInfo;
    } else {
      notes.push('The data module has no dmIdent/issueInfo element; issueInfo was not changed.');
    }
  }

  const fileName = formatDmcFileName({
    dmCode: ident.value.dmCode,
    issueInfo,
    language: lang,
    extension: 'XML',
  });

  if (!changed) {
    notes.push('Nothing changed; the original XML is returned as is.');
    return { xml, fileName, applied, unapplied, notes };
  }
  const out = serializeKeepingProlog(doc, xml, () =>
    notes.push(
      'The prolog of the original could not be located; the whole document was serialized.',
    ),
  );
  return { xml: out, fileName, applied, unapplied, notes };
}
