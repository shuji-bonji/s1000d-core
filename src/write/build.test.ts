import { XMLSerializer } from '@xmldom/xmldom';
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
  return (
    nodes
      // 変数の宣言（variableDeclarations）は、writer が dialog の変数から作る。DraftNode には無いので比べない
      .filter(
        (n) =>
          n.kind !== 'unknown' && n.kind !== 'requirements' && n.element !== 'variableDeclarations',
      )
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
      })
  );
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
        refs,
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
  const serialize = (e: unknown) => new XMLSerializer().serializeToString(e as never);
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

  it('requirements の子の admonition は安全の要件になり、警告 → 注意 → 備考の順に並ぶ', () => {
    const notes: string[] = [];
    const xml = serialize(
      buildContent(
        'proced',
        [
          {
            kind: 'requirements',
            text: '電源が切れていること',
            children: [
              { kind: 'admonition', level: 'note', text: '作業は 2 人で行う。' },
              { kind: 'para', text: '扉が開いていること' },
              { kind: 'admonition', level: 'caution', text: '扉は重い。' },
              {
                kind: 'admonition',
                level: 'warning',
                children: [
                  { kind: 'para', text: '高電圧。' },
                  { kind: 'para', text: '電源を切ってから触れる。' },
                ],
              },
            ],
          },
          { kind: 'step', text: 'x' },
        ],
        { notes },
      ),
    );
    expect(xml).toContain(
      '<reqCondGroup><reqCondNoRef><reqCond>電源が切れていること</reqCond></reqCondNoRef><reqCondNoRef><reqCond>扉が開いていること</reqCond></reqCondNoRef></reqCondGroup>',
    );
    expect(xml).toContain(
      '<reqSafety><safetyRqmts><warning><warningAndCautionPara>高電圧。</warningAndCautionPara><warningAndCautionPara>電源を切ってから触れる。</warningAndCautionPara></warning><caution><warningAndCautionPara>扉は重い。</warningAndCautionPara></caution><note><notePara>作業は 2 人で行う。</notePara></note></safetyRqmts></reqSafety>',
    );
    expect(xml).not.toContain('noSafety');
    expect(notes.join('\n')).toMatch(/warnings, then cautions, then notes/);
    expect(notes.join('\n')).toMatch(
      /the input has no support equipment \("equipment" nodes\), supplies \("supply" nodes\), spares \("spare" nodes\) in the "requirements" node, so noSupportEquips, noSupplies, noSpares were written/,
    );
    // fault でも同じ。条件が無ければ noConds のまま、安全の要件だけを書く
    const fault = serialize(
      buildContent('fault', [
        {
          kind: 'requirements',
          children: [{ kind: 'admonition', level: 'warning', text: '高電圧。' }],
        },
        { kind: 'step', id: 'a', text: '係員を呼ぶ。' },
      ]),
    );
    expect(fault).toContain(
      '<reqCondGroup><noConds/></reqCondGroup><reqSupportEquips><noSupportEquips/></reqSupportEquips><reqSupplies><noSupplies/></reqSupplies><reqSpares><noSpares/></reqSpares><reqSafety><safetyRqmts><warning>',
    );
  });

  it('後ろの requirements（事後条件）に admonition は置けない', () => {
    const e = fail(() =>
      build('proced', [
        { kind: 'step', text: 'x' },
        {
          kind: 'requirements',
          text: '扉が閉まっていること',
          children: [{ kind: 'admonition', level: 'warning', text: '高電圧。' }],
        },
      ]),
    );
    expect(e.path).toBe('/body[2]/children[1]');
    expect(e.detail).toMatch(/closeRqmts takes conditions only/);
  });

  it('requirements の子の person・document・equipment・supply・spare を preliminaryRqmts の各区分に書く', () => {
    const notes: string[] = [];
    const xml = serialize(
      buildContent(
        'proced',
        [
          {
            kind: 'requirements',
            children: [
              { kind: 'spare', title: 'ヒューズ', manufacturerCode: 'K0001', quantity: '2' },
              {
                kind: 'equipment',
                id: 'seq-0001',
                title: '保守鍵',
                manufacturerCode: 'K0001',
                partNumber: 'KEY-01',
                quantity: '1',
                unit: 'EA',
                text: '係員が持つ',
              },
              {
                kind: 'document',
                title: '保守の手引き',
                text: 'KB-M-001',
                reqTechInfoCategory: 'ti01',
              },
              {
                kind: 'document',
                title: '指定席券売機',
                refs: [{ kind: 'dmRef', target: 'KENBAIKI-A-10-20-00-00A-040A-D' }],
              },
              { kind: 'person', text: '係員', count: 2 },
              { kind: 'person', text: '補助者' },
              {
                kind: 'person',
                man: 'A',
                text: '整備員',
                personCategoryCode: 'Operator',
                skillLevelCode: 'sk02',
                estimatedTime: '1,5',
                estimatedTimeUnit: 'h',
              },
              { kind: 'person' },
              { kind: 'para', text: '発売を停止していること' },
              {
                kind: 'para',
                id: 'cond-0001',
                text: '電源を切ってあること',
                refs: [{ kind: 'dmRef', target: 'KENBAIKI-A-10-20-00-00A-520A-D' }],
              },
            ],
          },
          { kind: 'step', text: 'x' },
        ],
        { notes },
      ),
    );
    // XSD の順: 条件 → 人員 → 文書 → 支援機材 → 消耗品 → 予備品 → 安全
    expect(xml.replace(/<dmCode [^>]*\/>/g, '<dmCode/>')).toContain(
      '<preliminaryRqmts>' +
        '<reqCondGroup><reqCondNoRef><reqCond>発売を停止していること</reqCond></reqCondNoRef>' +
        '<reqCondDm id="cond-0001"><reqCond>電源を切ってあること</reqCond><dmRef><dmRefIdent><dmCode/></dmRefIdent></dmRef></reqCondDm></reqCondGroup>' +
        '<reqPersons><personnel numRequired="2"><trade>係員</trade></personnel><personnel><trade>補助者</trade></personnel>' +
        '<person man="A"><personCategory personCategoryCode="Operator"/><personSkill skillLevelCode="sk02"/><trade>整備員</trade><estimatedTime unitOfMeasure="h">1,5</estimatedTime></person>' +
        '<personnel/></reqPersons>' +
        '<reqTechInfoGroup>' +
        '<reqTechInfo reqTechInfoCategory="ti01"><externalPubRef><externalPubRefIdent><externalPubCode>KB-M-001</externalPubCode><externalPubTitle>保守の手引き</externalPubTitle></externalPubRefIdent></externalPubRef></reqTechInfo>' +
        '<reqTechInfo><dmRef><dmRefIdent><dmCode/></dmRefIdent><dmRefAddressItems><dmTitle><techName>指定席券売機</techName></dmTitle></dmRefAddressItems></dmRef></reqTechInfo>' +
        '</reqTechInfoGroup>' +
        '<reqSupportEquips><supportEquipDescrGroup><supportEquipDescr id="seq-0001"><name>保守鍵</name><identNumber><manufacturerCode>K0001</manufacturerCode><partAndSerialNumber><partNumber>KEY-01</partNumber></partAndSerialNumber></identNumber><reqQuantity unitOfMeasure="EA">1</reqQuantity><remarks><simplePara>係員が持つ</simplePara></remarks></supportEquipDescr></supportEquipDescrGroup></reqSupportEquips>' +
        '<reqSupplies><noSupplies/></reqSupplies>' +
        '<reqSpares><spareDescrGroup><spareDescr><name>ヒューズ</name><identNumber><manufacturerCode>K0001</manufacturerCode></identNumber><reqQuantity>2</reqQuantity></spareDescr></spareDescrGroup></reqSpares>' +
        '<reqSafety><noSafety/></reqSafety>' +
        '</preliminaryRqmts>',
    );
    expect(notes.join('\n')).toMatch(/so noSupplies, noSafety were written/);
  });

  it('組み立てた preliminaryRqmts を読むと、同じ種類の節点が返る（書いて読んで同じ）', () => {
    const children: DraftNode[] = [
      { kind: 'para', text: '発売を停止していること' },
      { kind: 'person', text: '係員', count: 2 },
      {
        kind: 'person',
        text: '整備員',
        man: 'A',
        personCategoryCode: 'Operator',
        skillLevelCode: 'sk02',
        estimatedTime: '1,5',
        estimatedTimeUnit: 'h',
      },
      { kind: 'document', title: '保守の手引き', text: 'KB-M-001', reqTechInfoCategory: 'ti06' },
      {
        kind: 'equipment',
        title: '保守鍵',
        text: '係員が持つ',
        quantity: '1',
        unit: 'EA',
        partNumber: 'KEY-01',
        manufacturerCode: 'K0001',
      },
      { kind: 'supply', title: 'ウエス', quantity: '1', manufacturerCode: 'K0001' },
      { kind: 'spare', title: 'ヒューズ', quantity: '2', manufacturerCode: 'K0001' },
      { kind: 'admonition', level: 'warning', children: [{ kind: 'para', text: '高電圧。' }] },
    ];
    const draft = F.procedDraft();
    draft.body = [
      { kind: 'requirements', children },
      { kind: 'step', text: 'x' },
    ];
    const { xml } = buildDataModule(draft, F.kenbaikiAllocation(), {
      defaultBrexRef: { dmCode: defaultBrex },
    });
    const pre = readContentFromXml(xml).blocks[0];
    const pick = (n: ContentNode): DraftNode => ({
      kind: n.kind as DraftNode['kind'],
      ...(n.title !== undefined ? { title: n.title } : {}),
      ...(n.text !== undefined ? { text: n.text } : {}),
      ...(n.level !== undefined ? { level: n.level } : {}),
      ...(n.count !== undefined ? { count: n.count } : {}),
      ...(n.man !== undefined ? { man: n.man } : {}),
      ...(n.personCategoryCode !== undefined ? { personCategoryCode: n.personCategoryCode } : {}),
      ...(n.skillLevelCode !== undefined ? { skillLevelCode: n.skillLevelCode } : {}),
      ...(n.estimatedTime !== undefined ? { estimatedTime: n.estimatedTime } : {}),
      ...(n.estimatedTimeUnit !== undefined ? { estimatedTimeUnit: n.estimatedTimeUnit } : {}),
      ...(n.reqTechInfoCategory !== undefined
        ? { reqTechInfoCategory: n.reqTechInfoCategory }
        : {}),
      ...(n.quantity !== undefined ? { quantity: n.quantity } : {}),
      ...(n.unit !== undefined ? { unit: n.unit } : {}),
      ...(n.partNumber !== undefined ? { partNumber: n.partNumber } : {}),
      ...(n.manufacturerCode !== undefined ? { manufacturerCode: n.manufacturerCode } : {}),
      ...(n.children.length > 0 ? { children: n.children.map(pick) } : {}),
    });
    expect(pre.children.map(pick)).toEqual(children);
    expect(pre.children[3].refs).toEqual([
      { kind: 'externalPubRef', target: 'KB-M-001', title: '保守の手引き' },
    ]);
  });

  it('品目の natoStockNumber を 3 つの属性に書き、読むと同じ番号が返る', () => {
    const children: DraftNode[] = [
      // NSN だけ（部品番号の無い品目）
      {
        kind: 'supply',
        title: '柔軟なじょうご',
        quantity: 'As required',
        natoStockNumber: '4940-01-120-6793',
      },
      // NSN と identNumber の両方。数字だけで書いた NSN は、0 で始まる桁をそのまま書く
      {
        kind: 'supply',
        title: '燃料',
        quantity: 'As required',
        natoStockNumber: '9140000000184',
        partNumber: 'AA 52557',
        manufacturerCode: '58536',
      },
      { kind: 'equipment', title: '懐中電灯', quantity: '1', natoStockNumber: '6230-00-163-1856' },
      { kind: 'spare', title: 'フィルター', quantity: '1', natoStockNumber: '1660-99-783-4056' },
    ];
    const draft = F.procedDraft();
    draft.body = [
      { kind: 'requirements', children },
      { kind: 'step', text: 'x' },
    ];
    const { xml } = buildDataModule(draft, F.kenbaikiAllocation(), {
      defaultBrexRef: { dmCode: defaultBrex },
    });
    // 整形された XML から、要素の間の空白を取り除いて比べる
    const flat = xml.replace(/>\s+</g, '><');
    expect(flat).toContain(
      '<supplyDescr><name>柔軟なじょうご</name><natoStockNumber natoSupplyClass="4940" natoCodificationBureau="01" natoItemIdentNumberCore="1206793"/><reqQuantity>As required</reqQuantity></supplyDescr>',
    );
    expect(flat).toContain(
      '<supplyDescr><name>燃料</name><natoStockNumber natoSupplyClass="9140" natoCodificationBureau="00" natoItemIdentNumberCore="0000184"/><identNumber><manufacturerCode>58536</manufacturerCode><partAndSerialNumber><partNumber>AA 52557</partNumber></partAndSerialNumber></identNumber><reqQuantity>As required</reqQuantity></supplyDescr>',
    );
    const content = readContentFromXml(xml);
    const pre = content.blocks[0];
    expect(
      pre.children.map((n) => [n.kind, n.title, n.natoStockNumber, n.manufacturerCode, n.attrs]),
    ).toEqual([
      ['equipment', '懐中電灯', '6230-00-163-1856', undefined, undefined],
      ['supply', '柔軟なじょうご', '4940-01-120-6793', undefined, undefined],
      ['supply', '燃料', '9140-00-000-0184', '58536', undefined],
      ['spare', 'フィルター', '1660-99-783-4056', undefined, undefined],
    ]);
    expect(pre.text).toContain('柔軟なじょうご NSN 4940-01-120-6793 xAs required');
    expect(pre.text).toContain('燃料 P/N AA 52557 NSN 9140-00-000-0184 xAs required');
    expect(content.notReadElements).toEqual({});
    expect(content.unknownElements).toEqual({});
  });

  it('人員の適用性は reqPersons にまとめ、参照は版・言語・場所・適用性を書く', () => {
    const xml = serialize(
      buildContent('proced', [
        {
          kind: 'requirements',
          children: [
            { kind: 'person', text: '係員', applicRefId: 'app-1', id: 'per-1' },
            { kind: 'person', text: '補助者', applicRefId: 'app-1' },
            { kind: 'person', text: '監督者' },
            { kind: 'person', text: '係員', applicRefId: 'app-1' },
            {
              kind: 'para',
              text: '電源を切ってあること',
              refs: [
                {
                  kind: 'dmRef',
                  target: 'KENBAIKI-A-10-20-00-00A-520A-D',
                  title: '指定席券売機',
                  infoName: '電源を切る',
                  issueInfo: { issueNumber: '002', inWork: '00' },
                  language: { languageIsoCode: 'ja', countryIsoCode: 'JP' },
                  fragment: 'stp-0003',
                  applicRefId: 'app-1',
                },
              ],
            },
          ],
        },
        { kind: 'step', text: 'x' },
      ]),
    );
    // personnel / person には applicRefId が無い（XSD）。同じ applicRefId が続く人員を 1 つの reqPersons にまとめる
    expect(xml).toContain(
      '<reqPersons applicRefId="app-1"><personnel id="per-1"><trade>係員</trade></personnel><personnel><trade>補助者</trade></personnel></reqPersons>' +
        '<reqPersons><personnel><trade>監督者</trade></personnel></reqPersons>' +
        '<reqPersons applicRefId="app-1"><personnel><trade>係員</trade></personnel></reqPersons>',
    );
    expect(xml).not.toMatch(/<personnel[^>]*applicRefId/);
    expect(xml.replace(/<dmCode [^>]*\/>/, '<dmCode/>')).toContain(
      '<reqCondDm><reqCond>電源を切ってあること</reqCond>' +
        '<dmRef referredFragment="stp-0003" applicRefId="app-1"><dmRefIdent><dmCode/><issueInfo issueNumber="002" inWork="00"/><language languageIsoCode="ja" countryIsoCode="JP"/></dmRefIdent>' +
        '<dmRefAddressItems><dmTitle><techName>指定席券売機</techName><infoName>電源を切る</infoName></dmTitle></dmRefAddressItems></dmRef></reqCondDm>',
    );
    // 読み戻すと、人員に適用性が、参照に版・言語・場所・適用性が返る
    const pre = readContentFromXml(
      `<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_7/xml_schema_flat/proced.xsd">${xml}</dmodule>`,
    ).blocks[0];
    expect(pre.children.filter((n) => n.kind === 'person').map((n) => n.applicRefId)).toEqual([
      'app-1',
      'app-1',
      undefined,
      'app-1',
    ]);
    expect(pre.children[0].refs).toEqual([
      {
        kind: 'dmRef',
        target: 'KENBAIKI-A-10-20-00-00A-520A-D',
        title: '指定席券売機 - 電源を切る',
        techName: '指定席券売機',
        infoName: '電源を切る',
        issueInfo: { issueNumber: '002', inWork: '00' },
        language: { languageIsoCode: 'ja', countryIsoCode: 'JP' },
        fragment: 'stp-0003',
        applicRefId: 'app-1',
      },
    ]);
  });

  it('品目は識別子と数量が要る（値は補わない）。人員・文書・事後条件の形も確かめる', () => {
    const req = (child: DraftNode) =>
      fail(() =>
        build('proced', [
          { kind: 'requirements', children: [child] },
          { kind: 'step', text: 'x' },
        ]),
      );
    expect(req({ kind: 'supply', title: 'ウエス', quantity: '1' })).toMatchObject({
      path: '/body[1]/children[1]/manufacturerCode',
    });
    // 部品番号は identNumber に書くので、製造者のコードが要る（NSN があっても同じ）
    expect(
      req({
        kind: 'supply',
        title: 'ウエス',
        quantity: '1',
        partNumber: '8722-0088',
        natoStockNumber: '7920-00-140-0869',
      }),
    ).toMatchObject({ path: '/body[1]/children[1]/manufacturerCode' });
    // NSN は 13 桁の数字。ハイフンは 4-2-3-4 桁の間だけ
    expect(
      req({ kind: 'supply', title: 'ウエス', quantity: '1', natoStockNumber: '7920-00-140-869' }),
    ).toMatchObject({ path: '/body[1]/children[1]/natoStockNumber' });
    expect(req({ kind: 'equipment', title: '鍵', manufacturerCode: 'K0001' })).toMatchObject({
      path: '/body[1]/children[1]/quantity',
    });
    // 人員: man があれば person（人数は持てない）。見積もり時間は単位が要る
    expect(req({ kind: 'person', text: '係員', man: 'A', count: 2 }).path).toBe(
      '/body[1]/children[1]/count',
    );
    expect(req({ kind: 'person', text: '係員', estimatedTime: '5' }).path).toBe(
      '/body[1]/children[1]/estimatedTimeUnit',
    );
    // 条件の参照は dmRef か pmRef を 1 つ
    expect(
      req({ kind: 'para', text: '電源', refs: [{ kind: 'internalRef', target: 'a' }] }).detail,
    ).toMatch(/takes a dmRef or a pmRef/);
    expect(req({ kind: 'person', text: '係員', count: 0 }).path).toBe('/body[1]/children[1]/count');
    expect(req({ kind: 'document' }).detail).toMatch(/needs a ref, or title/);
    expect(req({ kind: 'document', refs: [{ kind: 'internalRef', target: 'a' }] }).detail).toMatch(
      /takes a dmRef or a pmRef/,
    );
    expect(req({ kind: 'person', text: '係員', quantity: '1' }).detail).toMatch(
      /property "quantity" is not accepted on a "person" node/,
    );
    // 手順の中や説明には置けない
    expect(
      fail(() =>
        build('proced', [
          { kind: 'step', text: 'x', children: [{ kind: 'person', text: '係員' }] },
        ]),
      ).path,
    ).toBe('/body[1]/children[1]');
    // 事後条件は条件の文だけ
    expect(
      fail(() =>
        build('proced', [
          { kind: 'step', text: 'x' },
          { kind: 'requirements', children: [{ kind: 'person', text: '係員' }] },
        ]),
      ).detail,
    ).toMatch(/closeRqmts takes conditions only/);
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

describe('buildDataModule: 対象とする S1000D の版（options.issue）', () => {
  const brex = { defaultBrexRef: { dmCode: defaultBrex } };
  it('省くと Issue 7 の URL になり、notes には何も足さない', () => {
    const r = buildDataModule(F.descriptDraft(), F.kenbaikiAllocation(), brex);
    expect(r.issue).toBe('7');
    expect(r.xml).toContain('http://www.s1000d.org/S1000D_7/xml_schema_flat/descript.xsd');
    expect(r.notes.some((n) => n.startsWith('issue:'))).toBe(false);
  });
  it('"4.2" を渡すと URL の版だけが変わり、ほかの XML は同じ', () => {
    const base = buildDataModule(F.descriptDraft(), F.kenbaikiAllocation(), brex);
    const r = buildDataModule(F.descriptDraft(), F.kenbaikiAllocation(), { ...brex, issue: '4.2' });
    expect(r.issue).toBe('4.2');
    expect(r.xml).toContain('http://www.s1000d.org/S1000D_4-2/xml_schema_flat/descript.xsd');
    expect(r.xml.replace('S1000D_4-2/', 'S1000D_7/')).toBe(base.xml);
    expect(readDataModuleInfo(r.xml).issue).toBe('4.2');
    expect(r.notes.some((n) => n.startsWith('issue: built for S1000D Issue 4.2'))).toBe(true);
  });
  it('版の書き方として読めないものは DraftInputError（/options/issue）', () => {
    for (const bad of ['4-2', 'Issue 7', '']) {
      try {
        buildDataModule(F.descriptDraft(), F.kenbaikiAllocation(), { ...brex, issue: bad });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(DraftInputError);
        expect((e as DraftInputError).path).toBe('/options/issue');
      }
    }
  });
});

describe('buildDataModule: その版に置けないものは、組み立てずに入力の誤りにする', () => {
  const brex = { defaultBrexRef: { dmCode: defaultBrex } };
  const pathOf = (f: () => unknown): string | undefined => {
    try {
      f();
      return undefined;
    } catch (e) {
      expect(e).toBeInstanceOf(DraftInputError);
      return (e as DraftInputError).path;
    }
  };
  it('プロセスの節（dmNode になる）の題名は、Issue 4.2 より前の版では置けない', () => {
    const build = (issue?: string) =>
      buildDataModule(F.processDraft(), F.kenbaikiAllocation(), { ...brex, issue });
    expect(pathOf(() => build())).toBeUndefined();
    expect(pathOf(() => build('4.2'))).toBeUndefined();
    expect(pathOf(() => build('4.1'))).toMatch(/\/title$/);
    expect(pathOf(() => build('4.0'))).toMatch(/\/title$/);
    try {
      build('4.1');
    } catch (e) {
      expect((e as DraftInputError).detail).toContain('Issue 4.1');
    }
  });
  it('パブリケーションモジュールは、Issue 4.1 より前の版では brexDmRef を書かない（pmStatus に brexDmRef が無い）', () => {
    const build = (issue: string, over: Partial<DraftDataModule> = {}) =>
      buildDataModule({ ...F.pmDraft(), ...over }, F.kenbaikiAllocation(), { ...brex, issue });
    expect(build('4.1').xml).toContain('<brexDmRef>');
    for (const issue of ['4.0', '4.0.1']) {
      const r = build(issue);
      expect(r.xml).not.toContain('brexDmRef');
      expect(r.xml).toContain('<qualityAssurance>');
      expect(r.notes.some((n) => n.startsWith('brexDmRef: not written.'))).toBe(true);
    }
    // 下書きが brexDmRef を名指ししているときは、黙って落とさない
    expect(pathOf(() => build('4.0', { brexDmRef: defaultBrex }))).toBe('/brexDmRef');
    expect(pathOf(() => build('4.1', { brexDmRef: defaultBrex }))).toBeUndefined();
  });
});

describe('管理された内容の印（authority → authorityName・authorityDocument。Issue 4.0〜4.2）', () => {
  const xmlOf = (
    kind: DraftDataModule['kind'],
    body: DraftNode[],
    issue: string | undefined,
  ): string => new XMLSerializer().serializeToString(buildContent(kind, body, { issue }));
  const pathOf = (f: () => unknown): string | undefined => {
    try {
      f();
      return undefined;
    } catch (e) {
      expect(e).toBeInstanceOf(DraftInputError);
      return (e as DraftInputError).path;
    }
  };
  const step = (over: Partial<DraftNode> = {}): DraftNode => ({
    kind: 'step',
    text: '受け取った側が足した手順。',
    authority: { name: 'xyz', document: 'xyz-prod-1' },
    ...over,
  });

  it('Issue 4.0・4.1・4.2 では、要素に authorityName・authorityDocument を書き、読み戻せる', () => {
    for (const issue of ['4.0', '4.1', '4.2']) {
      const xml = xmlOf('proced', [{ kind: 'step', text: '元の手順。' }, step()], issue);
      expect(xml).toContain('<proceduralStep authorityName="xyz" authorityDocument="xyz-prod-1">');
      const read = readContentFromXml(
        `<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_${issue.replace('.', '-')}/xml_schema_flat/proced.xsd">${xml}</dmodule>`,
      );
      const steps = read.blocks.filter((n) => n.kind === 'step');
      expect(steps.map((n) => n.authority)).toEqual([
        undefined,
        { name: 'xyz', document: 'xyz-prod-1' },
      ]);
      // その他の属性（attrs）には重ねて入れない
      expect(JSON.stringify(steps[1]!.attrs ?? {})).not.toContain('authority');
    }
  });
  it('document は省ける。name が無ければ入力の誤り', () => {
    const xml = xmlOf('proced', [step({ authority: { name: 'xyz' } })], '4.2');
    expect(xml).toContain('<proceduralStep authorityName="xyz">');
    expect(pathOf(() => xmlOf('proced', [step({ authority: { name: '' } })], '4.2'))).toBe(
      '/body[1]/authority/name',
    );
  });
  it('Issue 4.2 より後の版（既定の Issue 7 を含む）では、組み立てずに入力の誤り', () => {
    for (const issue of [undefined, '7', '6', '5.0']) {
      expect(pathOf(() => xmlOf('proced', [step()], issue))).toBe('/body[1]/authority');
    }
  });
  it('印を付けられない要素になる節点では、黙って落とさずに入力の誤り', () => {
    // para は authorityName を持てない
    expect(
      pathOf(() =>
        xmlOf('descript', [{ kind: 'para', text: '本文。', authority: { name: 'xyz' } }], '4.2'),
      ),
    ).toMatch(/\/authority$/);
    // 節（levelledPara）には付けられる
    expect(
      xmlOf(
        'descript',
        [
          {
            kind: 'section',
            title: '概要',
            authority: { name: 'xyz' },
            children: [{ kind: 'para', text: '本文。' }],
          },
        ],
        '4.0',
      ),
    ).toContain('<levelledPara authorityName="xyz">');
  });
  it('pm の項目（pmEntry）は Issue 4.1 から。Issue 4.0 では入力の誤り', () => {
    const body: DraftNode[] = [
      {
        kind: 'section',
        title: '概要',
        authority: { name: 'xyz' },
        children: [
          { kind: 'entry', refs: [{ kind: 'dmRef', target: 'KENBAIKI-A-10-20-00-00A-040A-D' }] },
        ],
      },
    ];
    expect(xmlOf('pm', body, '4.1')).toContain('<pmEntry authorityName="xyz">');
    expect(pathOf(() => xmlOf('pm', body, '4.0'))).toBe('/body[1]/authority');
  });
});

describe('内容を管理する機関（controlAuthorities と controlAuthorityRefs。Issue 7）', () => {
  const authorities = [
    {
      id: 'ca-0001',
      type: 'cat01',
      source: 'XYZ',
      value: 'XYZ-2026-01',
      text: '変更してはならない文。',
    },
    { id: 'ca-0002', type: 'cat10', source: 'XYZ' },
  ];
  const draft = (over: Partial<DraftDataModule> = {}): DraftDataModule => ({
    ...F.procedDraft(),
    controlAuthorities: authorities,
    body: [
      { kind: 'step', text: '元の手順。' },
      {
        kind: 'step',
        controlAuthorityRefs: ['ca-0001', 'ca-0002'],
        children: [{ kind: 'para', text: '管理された手順。', controlAuthorityRefs: ['ca-0002'] }],
      },
    ],
    ...over,
  });
  const build = (d: DraftDataModule, issue?: string) =>
    buildDataModule(d, F.kenbaikiAllocation(), {
      defaultBrexRef: { dmCode: defaultBrex },
      ...(issue ? { issue } : {}),
    });
  const pathOf = (f: () => unknown): string | undefined => {
    try {
      f();
      return undefined;
    } catch (e) {
      expect(e).toBeInstanceOf(DraftInputError);
      return (e as DraftInputError).path;
    }
  };

  it('dmStatus の security の後ろに controlAuthorityGroup を書き、節点に controlAuthorityRefs を書く。読み戻せる', () => {
    const { xml } = build(draft());
    expect(xml.replace(/\s+/g, ' ')).toContain(
      '<security securityClassification="01"/> <controlAuthorityGroup> ' +
        '<controlAuthority id="ca-0001" controlAuthorityType="cat01" controlAuthoritySource="XYZ" controlAuthorityValue="XYZ-2026-01"> ' +
        '<controlAuthorityText> <para>変更してはならない文。</para> </controlAuthorityText> </controlAuthority> ' +
        '<controlAuthority id="ca-0002" controlAuthorityType="cat10" controlAuthoritySource="XYZ"/> ' +
        '</controlAuthorityGroup> <responsiblePartnerCompany',
    );
    expect(xml).toContain('<proceduralStep controlAuthorityRefs="ca-0001 ca-0002">');
    expect(xml).toContain('<para controlAuthorityRefs="ca-0002">');
    // 読み戻し
    const info = readDataModuleInfo(xml);
    expect(info.identAndStatus?.controlAuthorities).toEqual([
      {
        id: 'ca-0001',
        type: 'cat01',
        source: 'XYZ',
        value: 'XYZ-2026-01',
        text: '変更してはならない文。',
      },
      { id: 'ca-0002', type: 'cat10', source: 'XYZ' },
    ]);
    const steps = readContentFromXml(xml).blocks.filter((n) => n.kind === 'step');
    expect(steps.map((n) => n.controlAuthorityRefs)).toEqual([undefined, ['ca-0001', 'ca-0002']]);
    expect(JSON.stringify(steps[1]!.attrs ?? {})).not.toContain('controlAuthorityRefs');
  });
  it('Issue 4.2 以前では、controlAuthorities も controlAuthorityRefs も入力の誤り', () => {
    for (const issue of ['4.2', '4.1', '4.0']) {
      expect(pathOf(() => build(draft(), issue))).toBe('/controlAuthorities');
      expect(pathOf(() => build(draft({ controlAuthorities: undefined }), issue))).toBe(
        '/body[2]/controlAuthorityRefs',
      );
    }
  });
  it('controlAuthorities に無い id を指す節点は、入力の誤り', () => {
    expect(pathOf(() => build(draft({ controlAuthorities: [authorities[0]!] })))).toBe(
      '/body[2]/controlAuthorityRefs[2]',
    );
    expect(pathOf(() => build(draft({ controlAuthorities: undefined })))).toBe(
      '/body[2]/controlAuthorityRefs[1]',
    );
  });
  it('type は cat01〜cat99。省略や別の値、重なる id は入力の誤り', () => {
    const one = (a: Record<string, unknown>) =>
      pathOf(() =>
        build(draft({ controlAuthorities: [a as never], body: [{ kind: 'step', text: 'x' }] })),
      );
    expect(one({ id: 'ca-0001' })).toBe('/controlAuthorities[1]/type');
    expect(one({ id: 'ca-0001', type: 'cat00' })).toBe('/controlAuthorities[1]/type');
    expect(one({ type: 'cat01' })).toBe('/controlAuthorities[1]/id');
    expect(one({ id: 'ca-0001', type: 'cat01', name: 'x' })).toBe('/controlAuthorities[1]/name');
    expect(
      pathOf(() =>
        build(
          draft({
            controlAuthorities: [authorities[0]!, { ...authorities[1]!, id: 'ca-0001' }],
            body: [{ kind: 'step', text: 'x' }],
          }),
        ),
      ),
    ).toBe('/controlAuthorities[2]/id');
    expect(pathOf(() => build(draft({ body: [{ kind: 'step', id: 'ca-0001', text: 'x' }] })))).toBe(
      '/controlAuthorities[1]/id',
    );
  });
  it('authority（Issue 4.0〜4.2 の印）を Issue 7 で使うと、controlAuthorities を案内して断る', () => {
    try {
      build(draft({ body: [{ kind: 'step', text: 'x', authority: { name: 'xyz' } }] }));
      expect.unreachable();
    } catch (e) {
      expect((e as DraftInputError).path).toBe('/body[1]/authority');
      expect((e as Error).message).toContain('controlAuthorities');
    }
  });
});
