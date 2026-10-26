/**
 * XSD 違反（libxml2 の文章）から修正候補を作る。
 *
 * libxml2 の文章の多くは、許される値や要素をそれ自身に含む（`… is not an element of the set {'a', 'b'}`、
 * `Expected is ( b )`）。その場合はそれを候補にし、XSD の定義（XsdIndex）があれば出どころの名前を添える。
 * 文章に候補が無い違反（型の不一致、`This element is not expected.` だけのもの、許されない属性）は XSD の定義を引いて候補を作る。
 * 文章は翻訳しない。読めない文章は候補なし（confidence: none）で返す。
 */
import type { NodeLocation } from '../brex/types.js';
import type { SchemaValidationError } from '../xml/schema-validator.js';
import { nearMatches } from './similar.js';
import { confidenceOf, type Fix, type FixCandidate } from './types.js';
import type { ValueConstraint, XsdIndex } from './xsd-index.js';

const HEAD_RE = /^Element '([^']+)'(?:, attribute '([^']+)')?: ([\s\S]*)$/;

function quotedList(s: string): string[] {
  return [...s.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

/** `( a, b, ##other{...}* )` の中身を名前の並びにする */
function expectedList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim().replace(/[*+?]$/, ''))
    .filter((x) => x !== '' && !x.startsWith('##'));
}

/** XPath（/a/b[2]）の最後と、その親の要素名 */
function lastNames(xpath: string | undefined): { self?: string; parent?: string } {
  if (!xpath) return {};
  const parts = xpath
    .split('/')
    .filter(Boolean)
    .map((p) => p.replace(/\[\d+\]$/, '').replace(/^[^:]+:/, ''));
  return { self: parts[parts.length - 1], parent: parts[parts.length - 2] };
}

function locationOf(err: SchemaValidationError, attr?: string): NodeLocation | undefined {
  if (!err.xpath && err.line === undefined) return undefined;
  const loc: NodeLocation = { path: (err.xpath ?? '') + (attr ? `/@${attr}` : '') };
  if (err.line !== undefined) loc.line = err.line;
  if (err.column) loc.column = err.column;
  return loc;
}

function constraintCandidates(
  c: ValueConstraint,
  action: 'replace' | 'add',
  target: string,
): FixCandidate[] {
  const where = c.typeName ? `xs:simpleType "${c.typeName}"` : 'the XSD';
  if (c.enumerations.length > 0) {
    return c.enumerations.map((v) => ({
      action,
      value: v,
      target,
      description: `an enumerated value of ${where}`,
    }));
  }
  return c.patterns.map((p) => ({
    action,
    value: p,
    valueForm: 'pattern' as const,
    target,
    description: `a value matching the pattern of ${where}`,
  }));
}

function constraintSource(
  xsd: XsdIndex | undefined,
  c: ValueConstraint | undefined,
  fallback: string,
) {
  if (c?.typeName) return xsd?.describe('simpleTypes', c.typeName) ?? `${c.file} ${c.typeName}`;
  return fallback;
}

export interface SchemaFixOptions {
  /** XSD の定義。無ければ libxml2 の文章にある候補だけを返す */
  xsd?: XsdIndex;
  /** 出どころに書く XSD のファイル名 */
  xsdName?: string;
}

/** XSD 違反の並びから修正候補を作る（1 違反につき 1 件。型の不一致が facet の違反と重なるときは facet の方だけ） */
export function suggestSchemaFixes(
  errors: SchemaValidationError[],
  options: SchemaFixOptions = {},
): Fix[] {
  const { xsd } = options;
  const libxml = `libxml2 message${options.xsdName ? ` (${options.xsdName})` : ''}`;
  const fixes: Fix[] = [];
  const facetSeen = new Set<string>();

  for (const err of errors) {
    const problem = err.message.trim();
    const head = HEAD_RE.exec(problem);
    const element = head?.[1];
    const attr = head?.[2];
    const body = head?.[3] ?? problem;
    const location = locationOf(err, attr);
    const key = `${err.xpath ?? ''}|${err.line ?? ''}|${attr ?? ''}`;
    const push = (
      candidates: FixCandidate[],
      source: string,
      note?: string,
      confidence = confidenceOf(candidates),
    ) => {
      const fix: Fix = { kind: 'schema', location, problem, candidates, confidence, source };
      if (note) fix.note = note;
      fixes.push(fix);
    };
    const target = attr ? `@${attr}` : element;
    const attrConstraint = attr ? xsd?.attributeConstraint(attr, element) : undefined;

    let m: RegExpExecArray | null;
    if (
      (m =
        /\[facet 'enumeration'\] The value '([\s\S]*)' is not an element of the set \{([\s\S]*)\}/.exec(
          body,
        ))
    ) {
      facetSeen.add(key);
      const values = quotedList(m[2]);
      push(
        values.map((v) => ({
          action: 'replace',
          value: v,
          target,
          description: 'an enumerated value listed by the XSD',
        })),
        constraintSource(xsd, attrConstraint, libxml),
      );
      continue;
    }
    if (
      (m =
        /\[facet 'pattern'\] The value '([\s\S]*)' is not accepted by the pattern '([\s\S]*)'\./.exec(
          body,
        ))
    ) {
      facetSeen.add(key);
      push(
        [
          {
            action: 'replace',
            value: m[2],
            valueForm: 'pattern',
            target,
            description: 'a value matching the XSD pattern',
          },
        ],
        constraintSource(xsd, attrConstraint, libxml),
      );
      continue;
    }
    if (/\[facet '[A-Za-z]+'\]/.test(body)) {
      facetSeen.add(key);
      push(
        [],
        libxml,
        'A length or range facet of the XSD type is not met; the message states the limit.',
      );
      continue;
    }
    if (
      (m =
        /'([\s\S]*)' is not a valid value of the (local )?(?:atomic|union|list) type(?: '([^']+)')?/.exec(
          body,
        ))
    ) {
      if (facetSeen.has(key)) continue; // 直前の facet の違反と同じもの
      const c = m[3] && !m[2] ? xsd?.typeConstraint(m[3]) : attrConstraint;
      const cands = c && target ? constraintCandidates(c, 'replace', target) : [];
      const note =
        cands.length === 0 && c?.builtin ? `The value must be a valid ${c.builtin}.` : undefined;
      push(cands, constraintSource(xsd, c, libxml), note);
      continue;
    }
    if ((m = /The attribute '([^']+)' is required but missing\./.exec(body))) {
      const name = m[1];
      const c = xsd?.attributeConstraint(name, element);
      const cands = c ? constraintCandidates(c, 'add', `@${name}`) : [];
      if (cands.length === 0) {
        cands.push({
          action: 'add',
          target: `@${name}`,
          description: c?.builtin ? `add the attribute (type ${c.builtin})` : 'add the attribute',
        });
      }
      push(cands, constraintSource(xsd, c, libxml));
      continue;
    }
    if ((m = /The attribute '([^']+)' is not allowed\./.exec(body))) {
      const name = m[1];
      const allowed = element ? xsd?.allowedAttributes(element) : undefined;
      const cands: FixCandidate[] = [
        { action: 'remove', target: `@${name}`, description: 'remove the attribute' },
      ];
      for (const n of nearMatches(name, allowed ?? [], 3)) {
        cands.push({
          action: 'replace',
          value: n.value,
          target: `@${name}`,
          description: `rename to the allowed attribute "${n.value}"`,
        });
      }
      const fix: Fix = {
        kind: 'schema',
        location: err.xpath ? { path: err.xpath, line: err.line } : location,
        problem,
        candidates: cands,
        confidence: confidenceOf(cands),
        source: element && allowed ? (xsd!.describe('elements', element) ?? libxml) : libxml,
      };
      if (allowed) fix.note = `Attributes allowed on ${element}: ${allowed.join(', ') || '(none)'}`;
      fixes.push(fix);
      continue;
    }
    if (
      (m = /This element is not expected\.(?: Expected is (?:one of )?\( ([\s\S]*?) \)\.)?/.exec(
        body,
      ))
    ) {
      const expected = m[1] ? expectedList(m[1]) : [];
      const { parent } = lastNames(err.xpath);
      const cands: FixCandidate[] = [
        {
          action: 'remove',
          target: element,
          description: 'remove this element (or move it to where the parent allows it)',
        },
      ];
      for (const e of expected) {
        cands.push({
          action: 'replace',
          value: e,
          target: element,
          description: `use the element the XSD expects here ("${e}")`,
        });
      }
      let note: string | undefined;
      let source = libxml;
      if (expected.length === 0 && parent && xsd) {
        const allowed = xsd.allowedChildren(parent);
        if (allowed) {
          source = xsd.describe('elements', parent) ?? libxml;
          note =
            element && allowed.includes(element)
              ? `${element} is allowed in ${parent}, but not at this position or this many times. Allowed children of ${parent}: ${allowed.join(', ')}`
              : `Allowed children of ${parent}: ${allowed.join(', ') || '(none)'}`;
        }
      }
      // 「取り除く」と「動かす」の 2 通りがあるので、候補が 1 つでも several にする
      push(cands, source, note, 'several');
      continue;
    }
    if (
      (m = /Missing child element\(s\)\. Expected is (?:one of )?\( ([\s\S]*?) \)\./.exec(body))
    ) {
      const expected = expectedList(m[1]);
      push(
        expected.map((e) => ({
          action: 'add',
          value: e,
          target: element,
          description: `add a child element "${e}"`,
        })),
        libxml,
      );
      continue;
    }
    if (/Character content other than whitespace is not allowed/.test(body)) {
      push(
        [
          {
            action: 'remove',
            target: element,
            description:
              'remove the text directly inside this element (wrap it in an allowed child element if it must stay)',
          },
        ],
        libxml,
      );
      continue;
    }
    if (/Element content is not allowed/.test(body)) {
      push(
        [
          {
            action: 'remove',
            target: element,
            description: 'remove the child elements of this element',
          },
        ],
        libxml,
      );
      continue;
    }
    push([], libxml, 'No candidate could be derived from this message.');
  }
  return fixes;
}
