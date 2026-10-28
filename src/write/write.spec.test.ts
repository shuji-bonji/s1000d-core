/**
 * 利用者が入手した S1000D の配布物に対するテスト（組み立てた XML を本物の XSD・既定 BREX に通す）。
 * 配布物は再配布できないため（DECISIONS D-03）、`S1000D_SPEC_TESTS=1` のときだけ動かす。
 * 場所は `S1000D_SPEC_DIR`（既定: ../../specs/s1000d/issue-7 — s1000d-stack の配置に合わせた相対パス）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as F from '../__fixtures__/kenbaiki-drafts.js';
import { checkAgainstBrexChain, findDefaultBrex } from '../brex/index.js';
import { createBrexResolver } from '../csdb.js';
import { CsdbIndex } from '../csdb-index.js';
import { formatDmc } from '../dmc.js';
import { findSchemaDirs, verifyDataModule } from '../verify/index.js';
import { Libxml2SchemaValidator } from '../xsd-libxml2.js';
import { buildDataModule, type BuildResult } from './build.js';
import type { DraftDataModule } from './types.js';

const enabled = process.env.S1000D_SPEC_TESTS === '1';
const specDir = resolve(process.env.S1000D_SPEC_DIR ?? '../../specs/s1000d/issue-7');

describe.skipIf(!enabled || !existsSync(specDir))(
  '組み立てた XML を配布物の XSD・既定 BREX に通す',
  () => {
    const found = findDefaultBrex([specDir]);
    const schemaDirs = findSchemaDirs([specDir]);
    const validator = new Libxml2SchemaValidator();
    const results: Array<{ name: string; draft: DraftDataModule; result: BuildResult }> = [];
    let csdb: string;
    let index: CsdbIndex;

    beforeAll(() => {
      let allocation = F.kenbaikiAllocation();
      const drafts: Array<[string, DraftDataModule]> = [
        ['descript', F.descriptDraft()],
        ['descript（箇条書き・用語）', F.descriptListsDraft()],
        ['proced', F.procedDraft()],
        ['process', F.processDraft()],
        ['fault', F.faultDraft()],
        ['pm', F.pmDraft()],
      ];
      csdb = mkdtempSync(join(tmpdir(), 's1000d-core-write-'));
      for (const [name, draft] of drafts) {
        // 既定 BREX は specDirs から探す（brexDmRef は既定 BREX を指す）
        const result = buildDataModule(draft, allocation, { specDirs: [specDir] });
        allocation = {
          ...allocation,
          ledger: result.ledger,
          icn: { ...allocation.icn, next: result.icnNext },
        };
        results.push({ name, draft, result });
        writeFileSync(join(csdb, result.fileName), result.xml);
        // 図の原本の代わりの空ファイル（参照の解決を確かめるため）
        for (const icn of Object.values(result.icns)) writeFileSync(join(csdb, `${icn}.PNG`), '');
      }
      // brexDmRef が指す既定 BREX は配布物のフォルダーにあるので、参照の解決には両方を CSDB として渡す
      index = CsdbIndex.fromDirs([csdb, dirname(found!.path)]);
    });

    afterAll(() => {
      validator.dispose();
      if (csdb) rmSync(csdb, { recursive: true, force: true });
    });

    it('既定 BREX と XSD の置き場所が見つかる', () => {
      expect(found).toBeDefined();
      expect(schemaDirs.length).toBeGreaterThan(0);
      expect(schemaDirs[0].issue).toBe('7');
      expect(results).toHaveLength(6);
    });

    it('brexDmRef は配布物の既定 BREX を指す', () => {
      for (const { result } of results) {
        expect(result.notes.join('\n')).toMatch(/the default BREX found at/);
        expect(result.xml).toContain(
          `infoCode="${found!.brex.dmCode.infoCode}" infoCodeVariant="A" itemLocationCode="D"/>`,
        );
        expect(result.xml).toContain(`systemDiffCode="${found!.brex.dmCode.systemDiffCode}"`);
      }
    });

    for (const name of [
      'descript',
      'descript（箇条書き・用語）',
      'proced',
      'process',
      'fault',
      'pm',
    ]) {
      it(`${name}: Issue 7 の XSD で valid、既定 BREX の違反 0 件、参照は PM の外部参照 1 件を除いて解決`, async () => {
        const { result } = results.find((r) => r.name === name)!;
        const resolver = createBrexResolver(CsdbIndex.fromDirs([specDir]));
        const v = await verifyDataModule(result.xml, {
          path: result.fileName,
          schema: { validator, schemaDirs },
          // PM も brexDmRef（pmStatus）から連鎖をたどる
          brex: { resolver },
          references: { csdb: index },
        });
        expect(v.schema.errors, JSON.stringify(v.schema.errors)).toEqual([]);
        expect(v.status.schema.state).toBe('valid');
        expect(v.status.brex.layers).toBeGreaterThanOrEqual(1);
        expect(v.status.brex.unresolved).toEqual([]);
        expect(v.status.brex.skippedRules).toBe(0);
        const violations = v.brex!.layers.flatMap((l) =>
          l.violations.map((x) => `${x.kind} ${x.objectPath}: ${x.objectUse}`),
        );
        expect(violations).toEqual([]);
        expect(v.status.brex.state).toBe('passed');
        // 参照: 作った CSDB に無いのは、PM が指す保守マニュアル（外部の PM）だけ
        const unresolved = v.references!.unresolved.map((u) => u.message);
        if (result.pmCode) {
          expect(unresolved).toHaveLength(1);
          expect(unresolved[0]).toMatch(/KENBAIKI-K0001-MAINT-00/);
        } else {
          expect(unresolved).toEqual([]);
        }
      });
    }

    it('checkAgainstBrexChain で直接照合しても、DM 5 件の違反は 0（既定 BREX の層で）', async () => {
      const resolver = createBrexResolver(CsdbIndex.fromDirs([specDir]));
      for (const { result } of results.filter((r) => r.result.dmCode)) {
        const report = await checkAgainstBrexChain(result.xml, resolver);
        expect(report.unresolved).toEqual([]);
        expect(report.layers).toHaveLength(1);
        expect(formatDmc(report.layers[0].brex.dmCode)).toBe(formatDmc(found!.brex.dmCode));
        expect(report.layers[0].violations).toEqual([]);
        expect(report.passed).toBe(true);
      }
    });

    it('組み立ての分岐を広げた入力も、XSD で valid・既定 BREX の違反 0 件', async () => {
      let allocation = F.kenbaikiAllocation();
      allocation.icn.next = 50;
      const resolver = createBrexResolver(CsdbIndex.fromDirs([specDir]));
      const problems: string[] = [];
      for (const [name, draft] of variantDrafts()) {
        const result = buildDataModule(draft, allocation, {
          specDirs: [specDir],
          assetFormats: { 'movie-1': { extension: 'SVG', notation: 'svg' } },
        });
        allocation = {
          ...allocation,
          ledger: result.ledger,
          icn: { ...allocation.icn, next: result.icnNext },
        };
        const v = await verifyDataModule(result.xml, {
          path: result.fileName,
          schema: { validator, schemaDirs },
          brex: { resolver },
        });
        if (v.status.schema.state !== 'valid') {
          problems.push(
            `${name}: schema ${v.status.schema.state} ${JSON.stringify(v.schema.errors.slice(0, 3))}`,
          );
        }
        for (const l of v.brex!.layers) {
          for (const x of l.violations)
            problems.push(`${name}: BREX ${x.kind} ${x.objectPath}: ${x.objectUse}`);
          for (const x of l.skipped)
            problems.push(`${name}: BREX skipped ${x.objectPath}: ${x.error}`);
        }
      }
      expect(problems).toEqual([]);
    });
  },
);

/** 組み立ての分岐を広げた入力（XSD と既定 BREX に通る形で書く）。往復の対象ではない */
function variantDrafts(): Array<[string, DraftDataModule]> {
  const base = {
    language: { languageIsoCode: 'ja', countryIsoCode: 'JP' },
    securityClassification: '01',
    applic: { displayText: '全機種' },
    issueDate: '2026-10-28',
    title: { techName: '指定席券売機', infoName: '変化形' },
  } as const;
  const proced = F.KENBAIKI_DMC.proced;
  return [
    [
      'descript: マルチメディア・入れ子の節・1 行だけの表・条件つきの適用性',
      {
        ...base,
        sourceId: 'v-descript',
        kind: 'descript',
        applic: {
          displayText: 'MV-60 の 2 号機以降',
          assert: [
            {
              applicPropertyIdent: 'model',
              applicPropertyType: 'prodattr',
              applicPropertyValues: 'MV-60',
            },
            {
              applicPropertyIdent: 'unit',
              applicPropertyType: 'prodattr',
              applicPropertyValues: '2~9',
            },
          ],
          andOr: 'and',
        },
        body: [
          {
            kind: 'section',
            title: '第 1 層',
            children: [
              {
                kind: 'section',
                title: '第 2 層',
                children: [
                  { kind: 'section', title: '第 3 層', children: [{ kind: 'para', text: '本文' }] },
                ],
              },
            ],
          },
          { kind: 'table', rows: [['項目', '値']] },
          {
            kind: 'figure',
            title: '説明動画',
            refs: [{ kind: 'multimedia', target: 'movie-1', multimediaType: 'video' }],
          },
          {
            kind: 'admonition',
            level: 'note',
            text: '詳細は',
            refs: [{ kind: 'dmRef', target: proced }],
          },
        ],
      },
    ],
    [
      'proced: 条件なし・題名なしの手順・手順の中の表と箇条書きと警告',
      {
        ...base,
        sourceId: 'v-proced',
        kind: 'proced',
        body: [
          {
            kind: 'step',
            text: '準備する。',
            children: [
              { kind: 'admonition', level: 'warning', text: '電源を切る' },
              {
                kind: 'list',
                ordered: true,
                children: [{ kind: 'listItem', text: '鍵を用意する' }],
              },
              {
                kind: 'table',
                rows: [
                  ['部品', '数量'],
                  ['鍵', '1'],
                ],
              },
              { kind: 'step', text: '確認する。' },
            ],
          },
          { kind: 'figure', title: '完成図', refs: [{ kind: 'graphic', target: 'v-asset' }] },
          { kind: 'step', text: '終える。' },
        ],
      },
    ],
    [
      'fault: 前提・事後条件・図・手順の注記',
      {
        ...base,
        sourceId: 'v-fault',
        kind: 'fault',
        body: [
          { kind: 'requirements', text: '電源が切れていること' },
          {
            kind: 'step',
            id: 'a1',
            title: '確認',
            text: '表示を見る。',
            question: '表示は出ているか。',
            choices: [
              { text: 'はい', next: 'a2' },
              { text: 'いいえ', next: 'a3' },
            ],
            children: [
              {
                kind: 'admonition',
                level: 'note',
                children: [{ kind: 'para', text: '暗い場所で見る' }],
              },
              { kind: 'para', text: '追加の確認文' },
            ],
          },
          { kind: 'step', id: 'a2', text: '終了する。' },
          { kind: 'figure', title: '基板', refs: [{ kind: 'graphic', target: 'v-asset' }] },
          { kind: 'step', id: 'a3', text: '基板を交換する。' },
          { kind: 'requirements', text: '扉が閉まっていること' },
        ],
      },
    ],
    [
      'process: sequence を省いた最上位・else の枝・入れ子の if',
      {
        ...base,
        sourceId: 'v-process',
        kind: 'process',
        body: [
          {
            kind: 'section',
            children: [
              { kind: 'step', title: '開始', text: '始める。' },
              { kind: 'figure', title: '図', refs: [{ kind: 'graphic', target: 'v-asset' }] },
            ],
          },
          {
            kind: 'if',
            id: 'outer',
            question: '外側の条件',
            children: [
              {
                kind: 'sequence',
                children: [
                  {
                    kind: 'if',
                    id: 'inner',
                    question: '内側の条件',
                    children: [
                      {
                        kind: 'sequence',
                        children: [{ kind: 'section', children: [{ kind: 'step', text: 'a' }] }],
                      },
                    ],
                  },
                ],
              },
              {
                kind: 'sequence',
                children: [{ kind: 'section', children: [{ kind: 'step', text: 'b' }] }],
              },
            ],
          },
        ],
      },
    ],
    [
      'pm: 最上位の entry だけ',
      {
        ...base,
        sourceId: 'v-pm',
        kind: 'pm',
        body: [
          { kind: 'entry', refs: [{ kind: 'dmRef', target: F.KENBAIKI_DMC.descript }] },
          { kind: 'entry', refs: [{ kind: 'dmRef', target: proced, title: '手順' }] },
        ],
      },
    ],
  ];
}
