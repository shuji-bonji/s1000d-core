/**
 * 利用者が入手した S1000D の配布物（Issue 4.0・4.1・4.2・7）の Bike のサンプルで、読む側と検証する側の数を固定する。
 * 配布物は再配布できないため（DECISIONS D-03）、`S1000D_SPEC_TESTS=1` のときだけ動かす。
 *
 * 場所は `S1000D_SPEC_ROOT`（既定: ../../specs/s1000d — s1000d-stack の配置に合わせた相対パス）の下の
 * `issue-4.0`・`issue-4.1`・`issue-4.2`・`issue-7`。展開のしかたは s1000d-stack の docs/notes/background.md の
 * 「仕様書の展開後のファイル構成」に合わせる。無い版は飛ばす。
 *
 * 数は 2026-11-28 の実測（s1000d-stack の docs/notes/issue-4.2-survey.md、issue-4.0-4.1-survey.md）。
 * - 読めない文書は 0（Issue 4.0 は XML 195 件のうち 126 件が BOM で始まる）
 * - 本文を構造として読む DM で、読み取りの結果に無いテキスト節点は 0（読む側は内容を落とさない。D-31）
 * 減らす方向・増やす方向のどちらに動いても、理由を確かめてから数を直す。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as F from './__fixtures__/kenbaiki-drafts.js';
import { measureTextCoverage } from './__fixtures__/text-coverage.js';
import { findDefaultBrex } from './brex/index.js';
import { readContentFromXml } from './content/index.js';
import type { ContentNode } from './content/types.js';
import { readDataModuleInfo } from './data-module.js';
import { findSchemaDirs, verifyDataModule } from './verify/index.js';
import { buildComment } from './comment/build.js';
import { buildDataModule } from './write/build.js';
import { DraftInputError } from './write/errors.js';
import type { DraftDataModule, DraftNode } from './write/types.js';
import { Libxml2SchemaValidator } from './xsd-libxml2.js';

const enabled = process.env.S1000D_SPEC_TESTS === '1';
const specRoot = resolve(process.env.S1000D_SPEC_ROOT ?? '../../specs/s1000d');

interface Expected {
  issue: string;
  /** 配布物を展開したフォルダー（`specRoot` から） */
  dir: string;
  /** サンプルの CSDB（`dir` から）。サブフォルダーも見る */
  csdb: string;
  /** XML の数、そのうち BOM で始まるもの */
  xml: number;
  bom: number;
  /** XSD の検証の結果 */
  valid: number;
  schemaNotFound: number;
  /** 見つかる xml_schema_flat/ の版（見つかる順） */
  schemaIssues: string[];
  /** 既定 BREX のファイル名の先頭（DMC と発行番号） */
  defaultBrex: string;
  /** 本文を構造として読む DM の数と、そのテキスト節点の数 */
  measured: number;
  textNodes: number;
}

const EXPECTED: Expected[] = [
  {
    issue: '4.0',
    dir: 'issue-4.0',
    csdb: 'bike-data-set',
    xml: 195,
    bom: 126,
    valid: 194,
    // 版の書かれていない SMC（scormcontentpackage）。3 つの版のどれにも XSD があるので決まらない
    schemaNotFound: 1,
    schemaIssues: ['4.0.1', '4.0.2', '4.0'],
    defaultBrex: 'DMC-S1000D-A-04-10-0301-00A-022A-D_005-00',
    measured: 58,
    textNodes: 1692,
  },
  {
    issue: '4.1',
    dir: 'issue-4.1',
    csdb: 'bike-data-set',
    xml: 103,
    bom: 1,
    valid: 103,
    schemaNotFound: 0,
    // 版が同じで中身の違う XSD が 3 組ある（Patch 4.1.A、直下、XML Schema Package）
    schemaIssues: ['4.1', '4.1', '4.1'],
    defaultBrex: 'DMC-S1000D-E-04-10-0301-00A-022A-D_013-00',
    measured: 58,
    textNodes: 1495,
  },
  {
    issue: '4.2',
    dir: 'issue-4.2',
    csdb: 'bike-sample-data-set',
    xml: 105,
    bom: 0,
    valid: 105,
    schemaNotFound: 0,
    schemaIssues: ['4.2'],
    defaultBrex: 'DMC-S1000D-F-04-10-0301-00A-022A-D_002-00',
    measured: 58,
    textNodes: 1458,
  },
  {
    issue: '7',
    dir: 'issue-7',
    csdb: 'bike-samples',
    xml: 118,
    bom: 0,
    valid: 118,
    schemaNotFound: 0,
    schemaIssues: ['7'],
    defaultBrex: 'DMC-S1000D-J-04-10-0301-00A-022A-D_001-00',
    measured: 59,
    textNodes: 1587,
  },
];

const walk = (d: string, out: string[] = []): string[] => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.xml$/i.test(n)) out.push(p);
  }
  return out;
};

const validator = new Libxml2SchemaValidator();
afterAll(() => validator.dispose());

describe.skipIf(!enabled)('配布物の Bike のサンプル（Issue 4.0・4.1・4.2・7）', () => {
  for (const e of EXPECTED) {
    const spec = join(specRoot, e.dir);
    const csdb = join(spec, e.csdb);
    it.skipIf(!existsSync(csdb))(
      `Issue ${e.issue}: 読めない文書が無く、XSD の検証と本文の読み取りの数が記録どおり`,
      async () => {
        const schemaDirs = findSchemaDirs([spec]);
        expect(schemaDirs.map((d) => d.issue)).toEqual(e.schemaIssues);
        expect(basename(findDefaultBrex([spec])?.path ?? '')).toContain(e.defaultBrex);

        const got = { xml: 0, bom: 0, unreadable: [] as string[], valid: 0, schemaNotFound: 0 };
        const cov = {
          measured: 0,
          textNodes: 0,
          lost: 0,
          lostByParent: {} as Record<string, number>,
        };
        for (const p of walk(csdb).sort()) {
          const xml = readFileSync(p, 'utf8');
          got.xml++;
          if (xml.charCodeAt(0) === 0xfeff) got.bom++;
          const v = await verifyDataModule(xml, { path: p, schema: { schemaDirs, validator } });
          if (!v.status.wellFormed) {
            got.unreadable.push(basename(p));
            continue;
          }
          if (v.status.schema.state === 'valid') got.valid++;
          else if (v.status.schema.state === 'schema-not-found') got.schemaNotFound++;
          if (!/^DMC-/i.test(basename(p))) continue;
          const c = measureTextCoverage(xml);
          if (!c) continue;
          cov.measured++;
          cov.textNodes += c.total;
          cov.lost += c.lost;
          for (const [k, n] of Object.entries(c.lostByParent))
            cov.lostByParent[k] = (cov.lostByParent[k] ?? 0) + n;
        }
        expect(got).toEqual({
          xml: e.xml,
          bom: e.bom,
          unreadable: [],
          valid: e.valid,
          schemaNotFound: e.schemaNotFound,
        });
        expect(cov).toEqual({
          measured: e.measured,
          textNodes: e.textNodes,
          lost: 0,
          lostByParent: {},
        });
      },
      180_000,
    );
  }
});

/** 入力の誤りの位置（DraftInputError の path）。組み立てられたら undefined */
function refusedAt(build: () => unknown): string | undefined {
  try {
    build();
    return undefined;
  } catch (e) {
    if (e instanceof DraftInputError) return e.path;
    throw e;
  }
}

/** プロセスの節（dmNode になる節点）から題名を取り除いた下書き */
function withoutSectionTitles(draft: DraftDataModule): DraftDataModule {
  const strip = (n: DraftNode): DraftNode => ({
    ...n,
    ...(n.kind === 'section' ? { title: undefined } : {}),
    ...(n.children ? { children: n.children.map(strip) } : {}),
  });
  return { ...draft, body: draft.body.map(strip) };
}

/** 最初に見つかった、その種類の節点に、管理された内容の印を付けた下書き */
function withAuthority(draft: DraftDataModule, kind: DraftNode['kind']): DraftDataModule {
  let done = false;
  const mark = (n: DraftNode): DraftNode => {
    if (!done && n.kind === kind) {
      done = true;
      return { ...n, authority: { name: 'xyz', document: 'xyz-prod-1' } };
    }
    return n.children ? { ...n, children: n.children.map(mark) } : n;
  };
  const body = draft.body.map(mark);
  if (!done) throw new Error(`no "${kind}" node in the draft`);
  return { ...draft, body };
}

/**
 * 作る側。自作の下書き 6 件を、版を指定して組み立て、その版の配布物の XSD にかける。
 * その版に置けないと分かっているものは、組み立てずに入力の誤りにする（s1000d-stack の DECISIONS D-43）。
 * 誤りにならずに組み立てられたものは、その版の XSD で valid になる。
 */
describe.skipIf(!enabled)('版を指定して組み立てた XML を、その版の XSD にかける', () => {
  const cases: Array<{ issue: string; dir: string; refused: Record<string, string> }> = [
    { issue: '4.2', dir: 'issue-4.2', refused: {} },
    // dmNode に title を置けるのは Issue 4.2 から
    { issue: '4.1', dir: 'issue-4.1', refused: { process: '/title' } },
    // Issue 4.0 の PM とコメントは、brexDmRef を書かずに組み立てる（pmStatus・commentStatus に brexDmRef が無い）
    { issue: '4.0', dir: 'issue-4.0', refused: { process: '/title' } },
  ];
  for (const c of cases) {
    const spec = join(specRoot, c.dir);
    it.skipIf(!existsSync(spec))(
      `Issue ${c.issue}: 置けないものは入力の誤りになり、組み立てられたものは valid`,
      async () => {
        const schemaDirs = findSchemaDirs([spec]);
        const drafts: Array<[string, DraftDataModule]> = [
          ['descript', F.descriptDraft()],
          ['descriptLists', F.descriptListsDraft()],
          ['proced', F.procedDraft()],
          ['process', F.processDraft()],
          ['processWithoutSectionTitles', withoutSectionTitles(F.processDraft())],
          ['fault', F.faultDraft()],
          ['pm', F.pmDraft()],
          // 管理された内容の印（authorityName・authorityDocument）。Issue 4.0〜4.2 の XSD にある
          ['descriptWithAuthority', withAuthority(F.descriptDraft(), 'section')],
          ['procedWithAuthority', withAuthority(F.procedDraft(), 'step')],
          ['faultWithAuthority', withAuthority(F.faultDraft(), 'step')],
        ];
        const refused: Record<string, string> = {};
        const invalid: Record<string, string[]> = {};
        let allocation = F.kenbaikiAllocation();
        for (const [name, draft] of drafts) {
          let built;
          const at = refusedAt(() => {
            built = buildDataModule(draft, allocation, { specDirs: [spec], issue: c.issue });
          });
          if (at !== undefined) {
            refused[name] = at.replace(/^.*(\/title)$/, '$1');
            continue;
          }
          const r = built as unknown as ReturnType<typeof buildDataModule>;
          allocation = {
            ...allocation,
            ledger: r.ledger,
            icn: { ...allocation.icn, next: r.icnNext },
          };
          const v = await verifyDataModule(r.xml, { schema: { schemaDirs, validator } });
          if (v.status.schema.state !== 'valid' || v.status.schema.issue !== c.issue)
            invalid[name] = [
              `${v.status.schema.state} (${v.status.schema.issue ?? '?'}): ${v.status.schema.reason ?? ''}`,
              ...(v.schema?.errors ?? []).map((e) => e.message.slice(0, 120)),
            ];
        }
        // コメント
        const comment = buildComment(
          {
            refs: [{ kind: 'dmRef', code: 'KENBAIKI-A-10-20-00-00A-040A-D' }],
            commentType: 'q',
            commentPriorityCode: 'cp01',
            title: '用語の確認',
            paragraphs: ['「予約」の定義を確認してほしい。'],
            originator: {
              enterpriseCode: 'K0001',
              enterpriseName: 'Kenbaiki Works',
              address: { city: 'Tokyo', country: 'Japan' },
            },
            senderIdent: 'K0001',
            modelIdentCode: 'KENBAIKI',
            securityClassification: '01',
            language: { languageIsoCode: 'ja', countryIsoCode: 'JP' },
          },
          { specDirs: [spec], issue: c.issue },
        );
        const cv = await verifyDataModule(comment.xml, { schema: { schemaDirs, validator } });
        if (cv.status.schema.state !== 'valid')
          invalid.comment = [
            `${cv.status.schema.state}: ${cv.status.schema.reason ?? ''}`,
            ...(cv.schema?.errors ?? []).map((e) => e.message.slice(0, 160)),
          ];
        expect(invalid).toEqual({});
        expect(refused).toEqual(c.refused);
      },
      180_000,
    );
  }
});

/**
 * 内容を管理する機関（Issue 7 の controlAuthorityGroup と controlAuthorityRefs）。
 * 自作の下書きに付けて組み立てたものが Issue 7 の XSD に通ることと、Bike Samples の実物を読めることを確かめる。
 */
describe.skipIf(!enabled)('内容を管理する機関（Issue 7 の controlAuthority）', () => {
  const spec = join(specRoot, 'issue-7');
  const controlAuthorities = [
    { id: 'ca-0001', type: 'cat01', source: 'XYZ', value: 'XYZ-2026-01', text: '変更しない文。' },
    { id: 'ca-0002', type: 'cat10', source: 'XYZ' },
  ];
  /** 最初に見つかった、その種類の節点に controlAuthorityRefs を付けた下書き */
  const withRefs = (draft: DraftDataModule, kind: DraftNode['kind']): DraftDataModule => {
    let done = false;
    const mark = (n: DraftNode): DraftNode => {
      if (!done && n.kind === kind) {
        done = true;
        return { ...n, controlAuthorityRefs: ['ca-0001', 'ca-0002'] };
      }
      return n.children ? { ...n, children: n.children.map(mark) } : n;
    };
    const body = draft.body.map(mark);
    if (!done) throw new Error(`no "${kind}" node in the draft`);
    return { ...draft, body, controlAuthorities };
  };

  it.skipIf(!existsSync(spec))(
    '下書きに付けて組み立てたものは、Issue 7 の XSD で valid',
    async () => {
      const schemaDirs = findSchemaDirs([spec]);
      const drafts: Array<[string, DraftDataModule]> = [
        ['descript section', withRefs(F.descriptDraft(), 'section')],
        ['descript para', withRefs(F.descriptDraft(), 'para')],
        ['proced step', withRefs(F.procedDraft(), 'step')],
        ['fault step', withRefs(F.faultDraft(), 'step')],
        ['pm section', withRefs(F.pmDraft(), 'section')],
      ];
      const invalid: Record<string, string[]> = {};
      let allocation = F.kenbaikiAllocation();
      for (const [name, draft] of drafts) {
        const r = buildDataModule(draft, allocation, { specDirs: [spec] });
        allocation = {
          ...allocation,
          ledger: r.ledger,
          icn: { ...allocation.icn, next: r.icnNext },
        };
        expect(r.xml).toContain('controlAuthorityRefs="ca-0001 ca-0002"');
        const v = await verifyDataModule(r.xml, { schema: { schemaDirs, validator } });
        if (v.status.schema.state !== 'valid')
          invalid[name] = [
            `${v.status.schema.state}: ${v.status.schema.reason ?? ''}`,
            ...(v.schema?.errors ?? []).map((e) => e.message.slice(0, 160)),
          ];
      }
      expect(invalid).toEqual({});
    },
    180_000,
  );

  it.skipIf(!existsSync(spec))('Bike Samples の実物から、機関の一覧と節点の参照を読める', () => {
    const dir = join(spec, 'bike-samples', 'S1000D Issue 7 Bike Samples');
    const xml = readFileSync(
      join(dir, 'DMC-S1000DBIKE-AAA-D00-00-01-00AA-720A-A_005-00_EN-US.XML'),
      'utf8',
    );
    const authorities = readDataModuleInfo(xml).identAndStatus?.controlAuthorities ?? [];
    expect(authorities.map((a) => [a.id, a.type, a.source, a.text !== undefined])).toEqual([
      ['controlAuthority-001', 'cat01', 'FAA', true],
      ['controlAuthority-002', 'cat06', 'FAA', true],
      ['controlAuthority-003', 'cat10', 'FAA', false],
      ['controlAuthority-004', 'cat05', 'FAA', false],
      ['controlAuthority-005', 'cat13', 'ZAP', false],
    ]);
    // 記号（symbol）の ICN も落とさない
    expect(authorities.map((a) => a.symbols?.length ?? 0)).toEqual([1, 1, 0, 0, 0]);
    const refs: string[][] = [];
    const walk = (nodes: ContentNode[]) => {
      for (const n of nodes) {
        if (n.controlAuthorityRefs) refs.push(n.controlAuthorityRefs);
        walk(n.children);
      }
    };
    walk(readContentFromXml(xml).blocks);
    expect(refs).toEqual([
      ['controlAuthority-001'],
      ['controlAuthority-002'],
      ['controlAuthority-003', 'controlAuthority-004'],
      ['controlAuthority-005'],
    ]);
  });
});
