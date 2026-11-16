/**
 * 条件付きで禁止する BREX ルール（`allowedObjectFlag="0"` で、objectPath に述語 `[...]` がある）の修正候補。
 *
 * こういうルールが禁じているのは要素そのものではなく、「述語の条件が成り立っている状態」である
 * （既定 BREX の禁止ルール 160 件のうち 158 件がこの形）。要素を取り除く候補だけを返すと、
 * `identAndStatusSection` や文書要素を取り除く、という選べない候補になる。
 *
 * ここでは、objectPath に書いてある属性の比較（`@a = "v"`、`@a != "v"`）と、要素が無いこと（`not(child::e)`）を
 * 拾い、文書を実際に 1 か所だけ変えて objectPath を評価し直す。変えた後にその要素が選ばれなくなる変更だけを候補にする。
 * 条件の and / or / not の組み立ては解釈しない（評価し直した結果だけを信じる）。
 *
 * 候補にしないもの:
 * - 対象そのものの識別（`dmAddress` などの下の属性: コード、issueNumber、inWork、言語）。変えるとファイル名と、
 *   ほかの対象からの参照が合わなくなる
 *
 * 属性が無いこと（`not(@a)`・`not(attribute::a)`）が条件のときは、その属性が無い要素に属性を足して評価し直す。
 * 候補にするのは、1 か所に足すだけで違反が消え、足す値の出どころがあるときだけ（XSD が値を列挙している属性と、
 * 文書の中の `applic` の `id` を値にできる `applicRefId`）。属性が無い場所が複数あって 1 か所では消えないとき、
 * 値の出どころが無いときは候補にせず、場所の数と使える値を `notes` に書く（どの値を付けるかは内容の判断なので、人が決める）
 */
import type { Document, Element, Node, XmlEngine } from '../xml/engine.js';
import type { FixCandidate } from './types.js';
import type { XsdIndex } from './xsd-index.js';

const ELEMENT_NODE = 1;

export interface ConditionContext {
  doc: Document;
  engine: XmlEngine;
  /** 属性の列挙値と、要素を置ける親を調べるのに使う。無ければ objectPath に書いてある値だけを試す */
  xsd?: XsdIndex;
}

/** objectPath に述語があるか（条件付きのルールか） */
export function isConditionalPath(objectPath: string | undefined): boolean {
  return !!objectPath && objectPath.includes('[');
}

const ATTR_CMP_RE = /(?:@|attribute::)([A-Za-z_][\w.-]*)\s*(?:!=|=)\s*(?:"([^"]*)"|'([^']*)')/g;
const ABSENT_ATTR_RE = /not\(\s*(?:@|attribute::)([A-Za-z_][\w.-]*)\s*\)/g;
const ABSENT_EL_RE =
  /not\(\s*(?:(?:child|descendant|descendant-or-self)::)?([A-Za-z_][\w.-]*)\s*\)/g;

/** 1 つの属性名について文書の中で試す属性の数の上限（`@id` のように多いものは、どれを直すか決められない） */
const MAX_ATTR_NODES = 4;
/** 1 つの属性に試す値の数の上限 */
const MAX_TRIAL_VALUES = 40;
/** 要素を足す親の候補の数の上限 */
const MAX_PARENTS = 4;
/** 属性を足して試す場所の数の上限 */
const MAX_ATTR_PLACES = 4;
/** 注記に書く場所・値の数の上限 */
const MAX_NOTED = 3;

/**
 * objectPath の `index` の位置を囲んでいる述語 `名前[ … ]` の、要素名。
 * `dmRef[not(@a)]` の `not(` の位置なら `dmRef`。名前で始まらない段（`*[`・`)[`）なら undefined
 */
function predicateOwner(objectPath: string, index: number): string | undefined {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const ch = objectPath[i];
    if (ch === ']') depth++;
    else if (ch === '[') {
      if (depth > 0) {
        depth--;
        continue;
      }
      const m = /([A-Za-z_][\w.-]*)\s*$/.exec(objectPath.slice(0, i));
      return m ? m[1] : undefined;
    }
  }
  return undefined;
}

const localName = (el: Element): string => el.localName ?? el.nodeName;

function elementChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling)
    if (n.nodeType === ELEMENT_NODE) out.push(n as Element);
  return out;
}

/** 対象そのものの識別（`identAndStatusSection` の直下の `…Address`）の中か */
function inAddress(el: Element): boolean {
  for (let n: Node | null = el; n && n.nodeType === ELEMENT_NODE; n = n.parentNode) {
    const p = n.parentNode;
    if (
      /Address$/.test(localName(n as Element)) &&
      p &&
      p.nodeType === ELEMENT_NODE &&
      localName(p as Element) === 'identAndStatusSection'
    )
      return true;
  }
  return false;
}

/** 文書要素からの段（同じ名前の兄弟があるときだけ番号を付ける） */
function steps(el: Element): string[] {
  const out: string[] = [];
  for (let n: Node | null = el; n && n.nodeType === ELEMENT_NODE; n = n.parentNode) {
    const e = n as Element;
    const p = e.parentNode;
    let step = e.nodeName;
    if (p && p.nodeType === ELEMENT_NODE) {
      const same = elementChildren(p as Element).filter((s) => s.nodeName === e.nodeName);
      if (same.length > 1) step += `[${same.indexOf(e) + 1}]`;
    }
    out.unshift(step);
  }
  return out;
}

/**
 * `base` から見た `el` の場所。`el` が `base` 自身なら ''、子孫なら相対の道（`a/b`）、それ以外は `/` で始まる絶対の道
 */
function pathFrom(base: Element, el: Element): string {
  if (el === base) return '';
  const b = steps(base);
  const e = steps(el);
  let inside = false;
  for (let n: Node | null = el.parentNode; n; n = n.parentNode)
    if (n === base) {
      inside = true;
      break;
    }
  return inside ? e.slice(b.length).join('/') : `/${e.join('/')}`;
}

export function conditionCandidates(
  ctx: ConditionContext,
  objectPath: string,
  locationPath: string,
  /** 候補にできなかった理由のうち、人が直すときの手がかりになるもの（属性が無い場所の数など）を足す先 */
  notes: string[] = [],
): FixCandidate[] {
  const { doc, engine, xsd } = ctx;
  let node: Element;
  let selected: () => boolean;
  try {
    const at = engine.selectNodes(locationPath, doc);
    if (at.length !== 1 || at[0]!.nodeType !== ELEMENT_NODE) return [];
    node = at[0] as Element;
    selected = () => engine.selectNodes(objectPath, doc).includes(node);
    // いまの文書で違反を再現できなければ、変えた後の結果も信じられない
    if (!selected()) return [];
  } catch {
    return [];
  }
  const check = (): boolean => {
    try {
      return !selected();
    } catch {
      return false;
    }
  };

  const out: FixCandidate[] = [];

  // --- 属性の値を変える ---
  const literals = new Map<string, Set<string>>();
  for (const m of objectPath.matchAll(ATTR_CMP_RE)) {
    const set = literals.get(m[1]!) ?? new Set<string>();
    set.add(m[2] ?? m[3] ?? '');
    literals.set(m[1]!, set);
  }
  for (const [name, values] of literals) {
    let attrs: Node[];
    try {
      attrs = engine.selectNodes(`//@${name}`, doc);
    } catch {
      continue;
    }
    if (attrs.length === 0 || attrs.length > MAX_ATTR_NODES) continue;
    for (const a of attrs) {
      const owner = (a as unknown as { ownerElement?: Element | null }).ownerElement;
      if (!owner || inAddress(owner)) continue;
      const current = owner.getAttribute(name) ?? '';
      const allowed = xsd?.attributeConstraint(name, localName(owner))?.enumerations ?? [];
      // XSD が値を列挙しているなら、その中だけを試す（objectPath の値が XSD に無いこともある）
      const trials = (allowed.length > 0 ? allowed : [...values].filter((v) => v !== '')).filter(
        (v) => v !== current,
      );
      const rel = pathFrom(node, owner);
      const target = rel === '' ? `@${name}` : `${rel}/@${name}`;
      for (const v of trials.slice(0, MAX_TRIAL_VALUES)) {
        owner.setAttribute(name, v);
        const ok = check();
        owner.setAttribute(name, current);
        if (ok)
          out.push({
            action: 'replace',
            target,
            value: v,
            description: `set ${owner.nodeName}/@${name} to "${v}" (now "${current}"); the condition of the rule no longer holds`,
          });
      }
    }
  }

  // --- 無い属性を足す ---
  const absentAttrs = new Map<string, Set<string>>();
  for (const m of objectPath.matchAll(ABSENT_ATTR_RE)) {
    const owner = predicateOwner(objectPath, m.index);
    if (!owner) continue;
    const set = absentAttrs.get(m[1]!) ?? new Set<string>();
    set.add(owner);
    absentAttrs.set(m[1]!, set);
  }
  for (const [name, owners] of absentAttrs) {
    for (const ownerName of owners) {
      // 属性が無い要素。違反の要素とその子孫を先に見て、無ければ文書の全体
      const lacking = (els: Element[]) =>
        els.filter((e) => localName(e) === ownerName && !e.hasAttribute(name));
      let places = lacking([node, ...(Array.from(node.getElementsByTagName('*')) as Element[])]);
      if (places.length === 0)
        places = lacking(Array.from(doc.getElementsByTagName('*')) as Element[]);
      places = places.filter((e) => !inAddress(e));
      if (places.length === 0) continue;
      // 足す値の出どころ: XSD の列挙値。applicRefId は、文書の中の applic の id
      let values = xsd?.attributeConstraint(name, ownerName)?.enumerations ?? [];
      let source = 'enumerated in the XSD';
      if (values.length === 0 && name === 'applicRefId') {
        source = 'ids of the applic elements in the document';
        try {
          values = engine
            .selectNodes('//applic/@id', doc)
            .map((a) => (a as unknown as { value?: string }).value ?? '')
            .filter((v) => v !== '');
        } catch {
          values = [];
        }
      }
      values = [...new Set(values)];
      const cleared: Element[] = [];
      for (const p of places.slice(0, MAX_ATTR_PLACES)) {
        p.setAttribute(name, values[0] ?? 'x');
        const ok = check();
        p.removeAttribute(name);
        if (ok) cleared.push(p);
      }
      const where = (els: Element[]) =>
        els
          .slice(0, MAX_NOTED)
          .map((e) => pathFrom(node, e) || node.nodeName)
          .join(', ') + (els.length > MAX_NOTED ? ', …' : '');
      const available =
        values.length > 0
          ? ` Values available (${source}): ${values.slice(0, MAX_TRIAL_VALUES).join(', ')}.`
          : ' No source for its value was found (the XSD does not enumerate it, and the document has no value to reuse).';
      if (cleared.length === 0) {
        notes.push(
          `@${name} is absent on ${places.length} <${ownerName}> element(s) (${where(places)}). Adding it at one place does not end the condition${places.length > 1 ? '; every place must get a value' : ''}.${available}`,
        );
        continue;
      }
      if (values.length === 0) {
        notes.push(
          `@${name} is absent on <${ownerName}> (${where(cleared)}); adding it would end the condition.${available}`,
        );
        continue;
      }
      for (const p of cleared) {
        const rel = pathFrom(node, p);
        const target = rel === '' ? `@${name}` : `${rel}/@${name}`;
        for (const v of values.slice(0, MAX_TRIAL_VALUES))
          out.push({
            action: 'add',
            target,
            value: v,
            description: `add @${name}="${v}" to <${p.nodeName}>; the rule applies only while the attribute is absent (which value is right must be decided by a person)`,
          });
      }
    }
  }

  // --- 無い要素を足す ---
  const absent = new Set<string>();
  for (const m of objectPath.matchAll(ABSENT_EL_RE)) absent.add(m[1]!);
  for (const name of absent) {
    // 足せる親: XSD があれば、その要素を子に持てる要素。無ければ違反の要素だけ
    const parents: Element[] = [];
    if (xsd) {
      const all = [node, ...(Array.from(node.getElementsByTagName('*')) as Element[])];
      for (const p of all) {
        if (xsd.allowedChildren(localName(p))?.includes(name)) parents.push(p);
        if (parents.length >= MAX_PARENTS) break;
      }
    } else {
      parents.push(node);
    }
    for (const p of parents) {
      const child = doc.createElementNS(p.namespaceURI, name);
      p.appendChild(child);
      const ok = check();
      p.removeChild(child);
      if (!ok) continue;
      const rel = pathFrom(node, p);
      out.push({
        action: 'add',
        target: rel === '' ? node.nodeName : rel,
        value: name,
        description: `add <${name}> to <${p.nodeName}>; the rule applies only while it is absent (its content must be written by a person)`,
      });
    }
  }

  return out;
}
