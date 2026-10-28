import { describe, expect, it } from 'vitest';
import * as F from '../__fixtures__/kenbaiki-drafts.js';
import { CsdbIndex } from '../csdb-index.js';
import { classifyCsdbFileName } from '../csdb-source.js';
import { readContentFromXml } from '../content/index.js';
import type { ContentNode } from '../content/types.js';
import { readDataModuleInfo } from '../data-module.js';
import { formatDmc, parseDmc } from '../dmc.js';
import { parseIcn } from '../icn.js';
import { defaultXmlEngine } from '../xml/index.js';
import { buildDataModule, type BuildResult } from './build.js';
import { buildContent } from './content/index.js';
import { DraftInputError } from './errors.js';
import type { Allocation, DraftDataModule, DraftNode } from './types.js';

// ---- 往復の比較用: reader の ContentNode と DraftNode を同じ形に写す ----

interface Shape {
  kind: string;
  id?: string;
  title?: string;
  text?: string;
  level?: string;
  number?: string;
  rows?: string[][];
  question?: string;
  choices?: Array<{ text: string; next?: string }>;
  refs?: Array<{ kind: string; target: string; title?: string }>;
  children: Shape[];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
/** reader が文に埋め込む `[→ …]` を取り除く */
const stripRefs = (s: string) => norm(s.replace(/\s*\[→[^\]]*\]/g, ''));
/** 中身を比べない kind（reader が入れ子の構造で読む / 条件を式で読む） */
const OPAQUE = new Set(['dialog', 'if']);

const clean = (o: Shape): Shape => {
  for (const k of Object.keys(o) as (keyof Shape)[]) if (o[k] === undefined) delete o[k];
  return o;
};

function fromContent(nodes: ContentNode[]): Shape[] {
  return nodes
    .filter((n) => n.kind !== 'unknown' && n.kind !== 'requirements')
    .map((n) => {
      if (OPAQUE.has(n.kind)) return { kind: n.kind, children: [] };
      return clean({
        kind: n.kind,
        id: n.id,
        title: n.title,
        text: n.text === undefined ? undefined : stripRefs(n.text),
        level: n.level,
        number: n.number,
        rows: n.rows,
        question: n.question,
        choices: n.choices?.map((c) => ({ text: c.text, next: c.nextActionRefId })),
        refs: n.refs?.map((r) => ({
          kind: r.kind,
          target: r.target,
          title: r.kind === 'internalRef' ? undefined : r.title,
        })),
        children: fromContent(n.children),
      });
    });
}

interface Counter {
  n: number;
  prefix: string;
}

function fromDraft(nodes: DraftNode[], icns: Record<string, string>, counter: Counter): Shape[] {
  return nodes
    .filter((n) => n.kind !== 'requirements')
    .map((n) => {
      if (OPAQUE.has(n.kind)) return { kind: n.kind, children: [] };
      let number: string | undefined;
      let child = counter;
      if (n.kind === 'step') {
        counter.n++;
        number = counter.prefix ? `${counter.prefix}.${counter.n}` : String(counter.n);
        child = { n: 0, prefix: number };
      } else if (n.kind === 'section') child = { n: 0, prefix: '' };
      const refs = n.refs?.map((r) => ({
        kind: r.kind,
        target: icns[r.target] ?? r.target,
        title: r.kind === 'internalRef' ? undefined : r.title,
      }));
      if (n.kind === 'entry') {
        return clean({
          kind: 'entry',
          text: refs![0].target,
          title: refs![0].title,
          refs,
          children: [],
        });
      }
      const kids = [...(n.children ?? [])];
      // admonition の text は、reader では para の子として読まれる
      const admonitionText = n.kind === 'admonition' && n.text !== undefined;
      return clean({
        kind: n.kind,
        id: n.id,
        title: n.title,
        text: admonitionText ? undefined : n.text === undefined ? undefined : norm(n.text),
        level: n.level,
        number,
        rows: n.rows,
        question: n.question,
        choices: n.choices?.map((c) => ({ text: c.text, next: c.next })),
        // process の section が持つ dmRef は、reader は読まない
        refs: n.kind === 'section' ? undefined : refs,
        children: fromDraft(
          admonitionText ? [{ kind: 'para', text: n.text }, ...kids] : kids,
          icns,
          child,
        ),
      });
    });
}

/** 券売機の 6 件（5 種 + 箇条書きの説明）を、台帳と連番を引き継ぎながら順に組み立てる */
function buildAll(): Record<string, { draft: DraftDataModule; result: BuildResult }> {
  let allocation = F.kenbaikiAllocation();
  const out: Record<string, { draft: DraftDataModule; result: BuildResult }> = {};
  const drafts: Record<string, DraftDataModule> = {
    descript: F.descriptDraft(),
    lists: F.descriptListsDraft(),
    proced: F.procedDraft(),
    process: F.processDraft(),
    fault: F.faultDraft(),
    pm: F.pmDraft(),
  };
  for (const [name, draft] of Object.entries(drafts)) {
    const result = buildDataModule(draft, allocation, {
      defaultBrexRef: { dmCode: defaultBrex },
    });
    allocation = {
      ...allocation,
      ledger: result.ledger,
      icn: { ...allocation.icn, next: result.icnNext },
    };
    out[name] = { draft, result };
  }
  return out;
}

const defaultBrexResult = parseDmc('S1000D-J-04-10-0301-00A-022A-D');
if (!defaultBrexResult.ok) throw new Error('fixture');
const defaultBrex = defaultBrexResult.value;

describe('buildDataModule: 識別・状態部', () => {
  const all = buildAll();

  it('DMC・言語・版・日付・題名・機密区分・BREX を識別・状態部に書き、読み戻せる', () => {
    const { result } = all.descript;
    expect(result.fileName).toBe('DMC-KENBAIKI-A-10-20-00-00A-040A-D_001-00_JA-JP.XML');
    expect(formatDmc(result.dmCode!)).toBe(F.KENBAIKI_DMC.descript);
    const info = readDataModuleInfo(result.xml);
    expect(info.rootElement).toBe('dmodule');
    expect(info.schemaLocation).toBe('http://www.s1000d.org/S1000D_7/xml_schema_flat/descript.xsd');
    expect(info.schemaName).toBe('descript');
    expect(info.issue).toBe('7');
    expect(info.identAndStatus).toMatchObject({
      language: { languageIsoCode: 'ja', countryIsoCode: 'JP' },
      issueInfo: { issueNumber: '001', inWork: '00' },
      issueDate: '2026-10-28',
      techName: '指定席券売機',
      infoName: '説明',
      securityClassification: '01',
      responsiblePartnerCompany: { enterpriseCode: 'K0001' },
      originator: { enterpriseCode: 'K0001' },
      applicDisplayText: 'タッチパネル式、2 号機以降',
      qualityAssurance: 'unverified',
    });
    expect(info.identAndStatus?.brexDmRef?.dmCode).toEqual(defaultBrex);
  });

  it('識別・状態部の要素は XSD の順序で並ぶ', () => {
    const { document } = defaultXmlEngine.parse(all.descript.result.xml);
    const names = (expr: string) =>
      (defaultXmlEngine.selectNodes(expr, document) as Element[]).map((e) => e.nodeName);
    expect(names('/dmodule/*')).toEqual(['identAndStatusSection', 'content']);
    expect(names('/dmodule/identAndStatusSection/*')).toEqual(['dmAddress', 'dmStatus']);
    expect(names('//dmIdent/*')).toEqual(['dmCode', 'language', 'issueInfo']);
    expect(names('//dmAddressItems/*')).toEqual(['issueDate', 'dmTitle']);
    expect(names('//dmStatus/*')).toEqual([
      'security',
      'responsiblePartnerCompany',
      'originator',
      'applic',
      'brexDmRef',
      'qualityAssurance',
    ]);
  });

  it('DOCTYPE の ENTITY / NOTATION 宣言は、図の参照がある DM にだけ付く', () => {
    expect(all.descript.result.xml).toMatch(
      /<!ENTITY ICN-K0001-00001-001-01 SYSTEM "ICN-K0001-00001-001-01\.PNG" NDATA png>/,
    );
    expect(all.descript.result.xml).toMatch(/<!NOTATION png PUBLIC/);
    expect(readDataModuleInfo(all.descript.result.xml).hasEntityDeclarations).toBe(true);
    expect(all.proced.result.xml).toMatch(/<!ENTITY ICN-K0001-00002-001-01 /);
    // 同じ assetId は同じ ICN（台帳）。NOTATION 宣言は 1 つ
    expect(all.process.result.xml).toMatch(/<!ENTITY ICN-K0001-00001-001-01 /);
    expect(all.process.result.xml.match(/<!NOTATION/g)).toHaveLength(1);
    // 図が無い DM には DOCTYPE を付けない
    for (const k of ['lists', 'fault', 'pm']) {
      expect(all[k].result.xml).not.toMatch(/<!DOCTYPE/);
      expect(readDataModuleInfo(all[k].result.xml).hasEntityDeclarations).toBe(false);
    }
  });

  it('ICN は parseIcn で分解でき、連番と台帳が引き継がれる', () => {
    expect(all.descript.result.icns).toEqual({ 'asset-home': 'ICN-K0001-00001-001-01' });
    expect(all.proced.result.icns).toEqual({ 'asset-door': 'ICN-K0001-00002-001-01' });
    expect(all.process.result.icns).toEqual({ 'asset-home': 'ICN-K0001-00001-001-01' });
    expect(all.pm.result.icnNext).toBe(3);
    for (const icn of Object.values(all.pm.result.ledger).filter((v) => v.startsWith('ICN-'))) {
      expect(parseIcn(icn).ok).toBe(true);
    }
    expect(all.pm.result.ledger['asset-door']).toBe('ICN-K0001-00002-001-01');
  });

  it('PM は pmAddress / pmStatus を持ち、PMC とファイル名が付く', () => {
    const { result } = all.pm;
    expect(result.dmCode).toBeUndefined();
    expect(result.pmCode?.pmIssuer).toBe('K0001');
    expect(result.fileName).toMatch(/^PMC-KENBAIKI-K0001-[A-Z0-9]{5}-00_001-00_JA-JP\.XML$/);
    const { document } = defaultXmlEngine.parse(result.xml);
    const names = (expr: string) =>
      (defaultXmlEngine.selectNodes(expr, document) as Element[]).map((e) => e.nodeName);
    expect(names('/pm/*')).toEqual(['identAndStatusSection', 'content']);
    expect(names('//pmAddress/*')).toEqual(['pmIdent', 'pmAddressItems']);
    expect(names('//pmIdent/*')).toEqual(['pmCode', 'language', 'issueInfo']);
    expect(names('//pmStatus/*')).toEqual([
      'security',
      'responsiblePartnerCompany',
      'originator',
      'applic',
      'brexDmRef',
      'qualityAssurance',
    ]);
    expect(defaultXmlEngine.selectString('//pmTitle', document)).toBe('指定席券売機 - 取扱説明');
  });

  it('同じ入力と台帳からは、同じ DMC・ICN・XML ができる（再変換で番号が変わらない）', () => {
    const allocation = F.kenbaikiAllocation();
    const first = buildDataModule(F.descriptDraft(), allocation, {
      defaultBrexRef: { dmCode: defaultBrex },
    });
    const second = buildDataModule(
      F.descriptDraft(),
      { ...allocation, ledger: first.ledger, icn: { ...allocation.icn, next: first.icnNext } },
      { defaultBrexRef: { dmCode: defaultBrex } },
    );
    expect(second.dmCode).toEqual(first.dmCode);
    expect(second.icns).toEqual(first.icns);
    expect(second.xml).toBe(first.xml);
    expect(second.icnNext).toBe(first.icnNext);
  });
});

describe('buildDataModule: brexDmRef・版・日付の決め方', () => {
  const allocation = F.kenbaikiAllocation();
  const mk = (s: string) => {
    const r = parseDmc(s);
    if (!r.ok) throw new Error(s);
    return r.value;
  };

  it('brexDmRef は 入力 → allocation → 既定 BREX の順', () => {
    const own = mk('KENBAIKI-A-00-00-00-00A-022A-D');
    const org = mk('KENBAIKI-B-00-00-00-00A-022A-D');
    const fromDraft = buildDataModule(
      { ...F.descriptDraft(), brexDmRef: own },
      { ...allocation, brexDmRef: org },
      { defaultBrexRef: { dmCode: defaultBrex } },
    );
    expect(readDataModuleInfo(fromDraft.xml).identAndStatus?.brexDmRef?.dmCode).toEqual(own);
    expect(fromDraft.notes.join('\n')).toMatch(/brexDmRef: taken from the input/);
    const fromAlloc = buildDataModule(
      F.descriptDraft(),
      { ...allocation, brexDmRef: org },
      { defaultBrexRef: { dmCode: defaultBrex } },
    );
    expect(readDataModuleInfo(fromAlloc.xml).identAndStatus?.brexDmRef?.dmCode).toEqual(org);
    expect(fromAlloc.notes.join('\n')).toMatch(/allocation\.brexDmRef/);
    const fromDefault = buildDataModule(F.descriptDraft(), allocation, {
      defaultBrexRef: { dmCode: defaultBrex, issueInfo: { issueNumber: '001', inWork: '00' } },
    });
    expect(readDataModuleInfo(fromDefault.xml).identAndStatus?.brexDmRef).toMatchObject({
      dmCode: defaultBrex,
      issueInfo: { issueNumber: '001', inWork: '00' },
    });
  });

  it('既定 BREX が無いときは brexDmRef を省いて notes に書く', () => {
    const r = buildDataModule(F.descriptDraft(), allocation);
    expect(readDataModuleInfo(r.xml).identAndStatus?.brexDmRef).toBeUndefined();
    expect(r.notes.join('\n')).toMatch(/default BREX was not found/);
  });

  it('issueDate を省くと今日の日付（now で固定できる）を使い、notes に書く', () => {
    const draft = { ...F.descriptDraft(), issueDate: undefined };
    const r = buildDataModule(draft, allocation, { now: () => new Date(2027, 0, 5) });
    expect(readDataModuleInfo(r.xml).identAndStatus?.issueDate).toBe('2027-01-05');
    expect(r.notes.join('\n')).toMatch(/issueDate: not given/);
    expect(() =>
      buildDataModule({ ...F.descriptDraft(), issueDate: '2026-02-30' }, allocation),
    ).toThrowError(/real date/);
  });

  it('同じ DMC が CsdbIndex にあるとき、issuePolicy に従って版を決める', () => {
    const index = new CsdbIndex([
      classifyCsdbFileName('DMC-KENBAIKI-A-10-20-00-00A-040A-D_002-01_JA-JP.XML')!,
    ]);
    const draft = {
      ...F.descriptDraft(),
      sourceId: undefined,
      dmCode: mk(F.KENBAIKI_DMC.descript),
    };
    const issue = (policy?: 'increment-issue' | 'increment-inwork' | 'keep') =>
      buildDataModule(draft, allocation, { index, issuePolicy: policy }).issueInfo;
    expect(issue()).toEqual({ issueNumber: '003', inWork: '00' });
    expect(issue('increment-inwork')).toEqual({ issueNumber: '002', inWork: '02' });
    expect(issue('keep')).toEqual({ issueNumber: '002', inWork: '01' });
    // 入力の issueInfo が優先
    const given = buildDataModule(
      { ...draft, issueInfo: { issueNumber: '010', inWork: '00' } },
      allocation,
      { index },
    );
    expect(given.issueInfo).toEqual({ issueNumber: '010', inWork: '00' });
    expect(given.fileName).toBe('DMC-KENBAIKI-A-10-20-00-00A-040A-D_010-00_JA-JP.XML');
  });

  it('適用性: assert が 2 件以上のときは evaluate で束ね、andOr が要る', () => {
    const assert = [
      {
        applicPropertyIdent: 'model',
        applicPropertyType: 'prodattr' as const,
        applicPropertyValues: 'MV-60',
      },
      {
        applicPropertyIdent: 'unit',
        applicPropertyType: 'prodattr' as const,
        applicPropertyValues: '2~9',
      },
    ];
    const r = buildDataModule(
      {
        ...F.descriptDraft(),
        applic: { displayText: 'MV-60 の 2 号機以降', assert, andOr: 'and' },
      },
      allocation,
    );
    const { document } = defaultXmlEngine.parse(r.xml);
    expect(
      defaultXmlEngine.selectNodes('//applic/evaluate[@andOr="and"]/assert', document),
    ).toHaveLength(2);
    expect(() =>
      buildDataModule({ ...F.descriptDraft(), applic: { displayText: 'x', assert } }, allocation),
    ).toThrowError(/andOr/);
    const one = buildDataModule(
      { ...F.descriptDraft(), applic: { displayText: 'x', assert: [assert[0]] } },
      allocation,
    );
    expect(
      defaultXmlEngine.selectNodes('//applic/assert', defaultXmlEngine.parse(one.xml).document),
    ).toHaveLength(1);
  });

  it('applic を省くと applic 要素を置かず、notes に書く', () => {
    const r = buildDataModule({ ...F.descriptDraft(), applic: undefined }, allocation);
    expect(r.xml).not.toMatch(/<applic>/);
    expect(r.notes.join('\n')).toMatch(/applic: not given/);
  });
});

describe('往復: DraftNode → XML → readContentFromXml', () => {
  const all = buildAll();

  for (const name of ['descript', 'proced', 'process', 'fault', 'pm']) {
    it(`${name}: 読み戻した木が DraftNode と同じ（kind / id / title / text / level / number / rows / refs / children）`, () => {
      const { draft, result } = all[name];
      const content = readContentFromXml(result.xml);
      expect(content.kind).toBe(name);
      expect(content.structured).toBe(true);
      const actual = fromContent(content.blocks);
      const expected = fromDraft(draft.body, result.icns, { n: 0, prefix: '' });
      expect(actual).toEqual(expected);
      // 組み立てたのは reader が全部知っている要素だけ（知らない要素は process の条件式 expression とその変数参照だけ）
      expect(
        Object.keys(content.unknownElements).filter(
          (k) => k !== 'expression' && k !== 'variableRef',
        ),
      ).toEqual([]);
    });
  }

  it('proced: 前提・事後条件が requirements として読める', () => {
    const content = readContentFromXml(all.proced.result.xml);
    const reqs = content.blocks.filter((b) => b.kind === 'requirements');
    expect(reqs).toHaveLength(2);
    expect(reqs[0].text).toMatch(/^conditions: 電源が入っていること/);
    expect(reqs[0].text).toMatch(/support equipment: none/);
    expect(reqs[1].text).toBe('conditions: 扉が閉まっていること');
    expect(all.proced.result.notes.join('\n')).toMatch(/preliminaryRqmts: the input has no/);
  });

  it('process: 変数が宣言され、dialog と if が読める', () => {
    const { document } = defaultXmlEngine.parse(all.process.result.xml);
    const vars = (
      defaultXmlEngine.selectNodes('//variableDeclarations/variable', document) as Element[]
    ).map((v) => `${v.getAttribute('variableName')}:${v.getAttribute('valueType')}`);
    expect(vars).toEqual(['persons:string', 'isGroup:boolean', 'name:string']);
    expect(defaultXmlEngine.selectString('//dmIf/expression/@humanReadableForm', document)).toBe(
      '2 人以上のとき',
    );
    expect(
      defaultXmlEngine.selectNodes('//dmIf/dmThenSeq/dmNode | //dmIf/dmElseSeq/dmNode', document),
    ).toHaveLength(2);
    expect(defaultXmlEngine.selectNodes('//dmNode/dmRef', document)).toHaveLength(1);
    expect(defaultXmlEngine.selectNodes('//menu/menuChoice', document)).toHaveLength(2);
    const flat = (ns: ContentNode[]): ContentNode[] => ns.flatMap((n) => [n, ...flat(n.children)]);
    const blocks = flat(readContentFromXml(all.process.result.xml).blocks);
    expect(
      blocks.filter((b) => b.kind === 'dialog' && b.text === '人数を選んでください。').length,
    ).toBeGreaterThan(0);
    expect(blocks.filter((b) => b.kind === 'if')).toHaveLength(1);
  });

  it('descript（箇条書き・用語）: 警告・注意が先頭に並び、リストは para の中に入る', () => {
    const { document } = defaultXmlEngine.parse(all.lists.result.xml);
    const names = (defaultXmlEngine.selectNodes('//levelledPara/*', document) as Element[]).map(
      (e) => e.nodeName,
    );
    expect(names).toEqual(['title', 'warning', 'caution', 'para', 'para', 'para', 'para']);
    expect(defaultXmlEngine.selectNodes('//para/randomList/listItem', document)).toHaveLength(2);
    expect(
      defaultXmlEngine.selectNodes('//para/sequentialList/listItem/note/notePara', document),
    ).toHaveLength(1);
    expect(
      defaultXmlEngine.selectNodes(
        '//para/definitionList/definitionListItem/listItemTerm',
        document,
      ),
    ).toHaveLength(2);
  });

  it('text の < と & は実体参照になり、読み戻すと元の文字に戻る', () => {
    const draft: DraftDataModule = {
      ...F.descriptDraft(),
      body: [{ kind: 'para', text: '圧力 < 100 かつ A & B のとき "OK" > 0' }],
    };
    const r = buildDataModule(draft, F.kenbaikiAllocation());
    expect(r.xml).toContain('圧力 &lt; 100 かつ A &amp; B のとき "OK" &gt; 0');
    expect(readContentFromXml(r.xml).blocks[0].text).toBe('圧力 < 100 かつ A & B のとき "OK" > 0');
    expect(() => defaultXmlEngine.parse(r.xml)).not.toThrow();
  });

  it('警告・注意が本文より後ろに書かれていたら先頭へ寄せ、notes に書く', () => {
    const draft: DraftDataModule = {
      ...F.descriptDraft(),
      body: [
        {
          kind: 'section',
          children: [
            { kind: 'para', text: '本文' },
            { kind: 'admonition', level: 'warning', text: '先に読む' },
          ],
        },
      ],
    };
    const r = buildDataModule(draft, F.kenbaikiAllocation());
    const { document } = defaultXmlEngine.parse(r.xml);
    expect(
      (defaultXmlEngine.selectNodes('//levelledPara/*', document) as Element[]).map(
        (e) => e.nodeName,
      ),
    ).toEqual(['warning', 'para']);
    expect(r.notes.join('\n')).toMatch(/\/body\[1\]: warning\/caution nodes were moved/);
  });
});

describe('入力の形の検査（DraftInputError）', () => {
  const allocation = F.kenbaikiAllocation();
  const build = (kind: DraftDataModule['kind'], body: DraftNode[]) => buildContent(kind, body);
  const fail = (fn: () => unknown): DraftInputError => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(DraftInputError);
      return e as DraftInputError;
    }
    throw new Error('DraftInputError was not thrown');
  };

  it('descript に step は置けない（位置と受け付ける kind を示す）', () => {
    const e = fail(() =>
      build('descript', [
        { kind: 'para', text: 'a' },
        { kind: 'step', text: 'b' },
      ]),
    );
    expect(e.path).toBe('/body[2]');
    expect(e.detail).toMatch(/"step" cannot be placed in the body of a "descript"/);
    expect(e.detail).toMatch(/accepted: "para", "admonition", "section"/);
  });

  it('入れ子の位置も XPath 風に示す', () => {
    const e = fail(() =>
      build('descript', [
        {
          kind: 'section',
          children: [
            { kind: 'para', text: 'a' },
            { kind: 'section', children: [{ kind: 'step', text: 'x' }] },
          ],
        },
      ]),
    );
    expect(e.path).toBe('/body[1]/children[2]/children[1]');
  });

  it('kind ごとに受け付ける DraftNode.kind が決まっている', () => {
    expect(fail(() => build('proced', [{ kind: 'section', title: 'x' }])).path).toBe('/body[1]');
    expect(fail(() => build('proced', [{ kind: 'dialog', id: 'a', text: 'b' }])).path).toBe(
      '/body[1]',
    );
    expect(
      fail(() =>
        build('fault', [
          { kind: 'step', id: 'a', text: 'x', children: [{ kind: 'step', id: 'b', text: 'y' }] },
        ]),
      ).path,
    ).toBe('/body[1]/children[1]');
    expect(fail(() => build('process', [{ kind: 'step', text: 'x' }])).path).toBe('/body[1]');
    expect(fail(() => build('pm', [{ kind: 'para', text: 'x' }])).path).toBe('/body[1]');
    expect(
      fail(() => build('pm', [{ kind: 'section', children: [{ kind: 'para', text: 'x' }] }])).path,
    ).toBe('/body[1]/children[1]');
  });

  it('その kind が使えないプロパティは受け付けない', () => {
    const e = fail(() => build('descript', [{ kind: 'para', text: 'a', rows: [['x']] }]));
    expect(e.path).toBe('/body[1]');
    expect(e.detail).toMatch(/property "rows" is not accepted on a "para" node/);
  });

  it('必須のプロパティが無い節点を知らせる', () => {
    expect(fail(() => build('descript', [{ kind: 'admonition', text: 'x' }])).detail).toMatch(
      /needs level/,
    );
    expect(
      fail(() =>
        build('descript', [
          { kind: 'figure', refs: [{ kind: 'graphic', target: 'ICN-K0001-00001-001-01' }] },
        ]),
      ).detail,
    ).toMatch(/needs title/);
    expect(fail(() => build('descript', [{ kind: 'table', rows: [['a', 'b'], ['c']] }])).path).toBe(
      '/body[1]/rows[2]',
    );
    expect(
      fail(() =>
        build('descript', [
          {
            kind: 'list',
            children: [
              { kind: 'listItem', text: 'a' },
              { kind: 'definition', title: 't', text: 'x' },
            ],
          },
        ]),
      ).detail,
    ).toMatch(/cannot mix/);
    expect(fail(() => build('proced', [{ kind: 'step' }])).detail).toMatch(/needs title, text or/);
    expect(fail(() => build('pm', [{ kind: 'entry' }])).detail).toMatch(
      /exactly one dmRef or pmRef/,
    );
    expect(fail(() => build('process', [{ kind: 'section', title: 'x' }])).detail).toMatch(
      /needs child nodes or one dmRef/,
    );
    expect(
      fail(() => build('process', [{ kind: 'section', children: [{ kind: 'dialog', text: 'x' }] }]))
        .detail,
    ).toMatch(/needs id/);
  });

  it('fault の step: id、question か text、next の行き先を確かめる', () => {
    expect(fail(() => build('fault', [{ kind: 'step', text: 'x' }])).detail).toMatch(/needs id/);
    expect(fail(() => build('fault', [{ kind: 'step', id: 'a' }])).detail).toMatch(
      /needs question or text/,
    );
    expect(fail(() => build('fault', [{ kind: 'step', id: 'a', question: 'q?' }])).detail).toMatch(
      /needs choices/,
    );
    expect(
      fail(() =>
        build('fault', [
          { kind: 'step', id: 'a', question: 'q?', choices: [{ text: 'はい', next: 'zzz' }] },
        ]),
      ).path,
    ).toBe('/body[1]/choices[1]');
    expect(
      fail(() =>
        build('fault', [{ kind: 'step', id: 'a', question: 'q?', choices: [{ text: 'はい' }] }]),
      ).detail,
    ).toMatch(/needs next/);
  });

  it('internalRef の行き先は同じ DM の id でなければならない', () => {
    const e = fail(() =>
      build('proced', [
        { kind: 'step', text: 'x', refs: [{ kind: 'internalRef', target: 'nowhere' }] },
      ]),
    );
    expect(e.path).toBe('/body[1]/refs[1]');
    expect(e.detail).toMatch(/not the id of any node/);
  });

  it('参照: DMC / PMC の形が誤っていれば知らせ、graphic は文の中に置けない', () => {
    expect(
      fail(() =>
        build('descript', [{ kind: 'para', text: 'x', refs: [{ kind: 'dmRef', target: 'XX' }] }]),
      ).detail,
    ).toMatch(/not a DMC/);
    expect(
      fail(() =>
        build('descript', [{ kind: 'para', text: 'x', refs: [{ kind: 'pmRef', target: 'XX' }] }]),
      ).detail,
    ).toMatch(/not a PMC/);
    expect(
      fail(() =>
        build('descript', [
          {
            kind: 'para',
            text: 'x',
            refs: [{ kind: 'graphic', target: 'ICN-K0001-00001-001-01' }],
          },
        ]),
      ).detail,
    ).toMatch(/only be placed in the refs of a "figure"/);
    // assetId は Allocation が無ければ ICN にできない
    expect(
      fail(() =>
        build('descript', [
          { kind: 'figure', title: 'x', refs: [{ kind: 'graphic', target: 'asset' }] },
        ]),
      ).detail,
    ).toMatch(/is not an ICN/);
  });

  it('process: dialog は最後、変数名は重複不可、if は 1〜2 個の sequence', () => {
    const dlg = { kind: 'dialog' as const, id: 'v', text: 'q' };
    expect(
      fail(() =>
        build('process', [{ kind: 'section', children: [dlg, { kind: 'step', text: 'x' }] }]),
      ).detail,
    ).toMatch(/must be the last child/);
    expect(
      fail(() =>
        build('process', [
          { kind: 'section', children: [dlg] },
          { kind: 'section', children: [dlg] },
        ]),
      ).detail,
    ).toMatch(/used more than once/);
    expect(fail(() => build('process', [{ kind: 'if', id: 'c', question: 'q' }])).detail).toMatch(
      /one or two "sequence"/,
    );
    expect(
      fail(() =>
        build('process', [
          {
            kind: 'sequence',
            children: [
              {
                kind: 'section',
                title: 'a',
                refs: [{ kind: 'dmRef', target: F.KENBAIKI_DMC.proced }],
              },
            ],
          },
          { kind: 'section', title: 'b' },
        ]),
      ).detail,
    ).toMatch(/only node in body/);
  });

  it('入れ子の手順より後ろに本文は置けない', () => {
    const e = fail(() =>
      build('proced', [
        {
          kind: 'step',
          text: 'a',
          children: [
            { kind: 'step', text: 'b' },
            { kind: 'para', text: 'c' },
          ],
        },
      ]),
    );
    expect(e.path).toBe('/body[1]/children[2]');
  });

  it('requirements は前後に 1 つずつまで', () => {
    const r = { kind: 'requirements' as const, text: '条件' };
    expect(fail(() => build('proced', [r, r, { kind: 'step', text: 'x' }])).path).toBe('/body[2]');
  });

  it('buildDataModule: 採番の規則が足りなければ DraftInputError、必須の入力が無くても', () => {
    const noInfo = F.kenbaikiAllocation();
    noInfo.rules.infoCodeByKind = {};
    expect(() => buildDataModule(F.descriptDraft(), noInfo)).toThrowError(DraftInputError);
    expect(
      fail(() => buildDataModule({ ...F.descriptDraft(), sourceId: undefined }, allocation)).path,
    ).toBe('/sourceId');
    expect(
      fail(() => buildDataModule({ ...F.descriptDraft(), securityClassification: '' }, allocation))
        .path,
    ).toBe('/securityClassification');
    expect(
      fail(() => buildDataModule({ ...F.descriptDraft(), kind: 'nope' as 'pm' }, allocation)).path,
    ).toBe('/kind');
    // エラーの path は図の参照の位置に付け替えられる
    const bad: Allocation = { ...allocation, icn: { cageCode: 'K0001', next: 100000 } };
    expect(fail(() => buildDataModule(F.descriptDraft(), bad)).path).toBe(
      '/body[2]/children[2]/refs[1]',
    );
  });

  it('multimedia の形式の既定は持たない（assetFormats で与える）', () => {
    const draft: DraftDataModule = {
      ...F.descriptDraft(),
      body: [
        {
          kind: 'figure',
          title: '動画',
          refs: [{ kind: 'multimedia', target: 'movie-1', multimediaType: 'video' }],
        },
      ],
    };
    expect(fail(() => buildDataModule(draft, allocation)).detail).toMatch(
      /needs a format in options\.assetFormats/,
    );
    const r = buildDataModule(draft, allocation, {
      assetFormats: {
        'movie-1': { extension: 'MP4', notation: 'mp4', publicId: '-//EXAMPLE//NOTATION MP4//EN' },
      },
    });
    expect(r.xml).toMatch(/<multimedia>/);
    expect(r.xml).toMatch(
      /<multimediaObject multimediaType="video" infoEntityIdent="ICN-K0001-00001-001-01"\/>/,
    );
    expect(r.xml).toMatch(/NDATA mp4>/);
    expect(r.xml).toMatch(/<!NOTATION mp4 PUBLIC "-\/\/EXAMPLE\/\/NOTATION MP4\/\/EN">/);
    const read = readContentFromXml(r.xml);
    expect(read.blocks[0]).toMatchObject({ kind: 'figure', title: '動画' });
    expect(read.blocks[0].refs?.[0]).toMatchObject({
      kind: 'multimedia',
      target: 'ICN-K0001-00001-001-01',
    });
  });
});
