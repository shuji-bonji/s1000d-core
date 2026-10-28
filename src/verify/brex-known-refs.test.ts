/**
 * CSDB を渡さず BREX の解決器だけを渡したとき、BREX の工程でたどれた層を指す参照（brexDmRef）を
 * 参照の工程が未解決にしないこと。自作の BREX・データモジュールだけで動く部分と、
 * 配布物の既定 BREX を使う部分（`S1000D_SPEC_TESTS=1`）に分ける。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as F from '../__fixtures__/kenbaiki-drafts.js';
import { findDefaultBrex } from '../brex/index.js';
import { readBrex } from '../brex/read.js';
import { createBrexResolver } from '../csdb.js';
import { CsdbIndex } from '../csdb-index.js';
import { formatDmc } from '../dmc.js';
import { suggestFixes } from '../fix/suggest.js';
import { collectReferences } from '../refs/collect.js';
import { resolveReferences } from '../refs/resolve.js';
import type { DmRef } from '../types.js';
import { buildDataModule } from '../write/build.js';
import type { DraftDataModule } from '../write/types.js';
import { defaultXmlEngine } from '../xml/index.js';
import { verifyDataModule } from './verify.js';

const XSD_BASE = 'http://www.s1000d.org/S1000D_7/xml_schema_flat/';

/** 自作の BREX。自分自身を参照する（連鎖の終端）。proced.xsd の文脈に 1 ルールだけ持ち、descript には何も効かない */
const SELF_BREX = `<?xml version="1.0" encoding="UTF-8"?>
<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:noNamespaceSchemaLocation="${XSD_BASE}brex.xsd">
  <identAndStatusSection>
    <dmAddress>
      <dmIdent>
        <dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="00" subSystemCode="0"
          subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="022"
          infoCodeVariant="A" itemLocationCode="D"/>
        <language languageIsoCode="ja" countryIsoCode="JP"/>
        <issueInfo issueNumber="001" inWork="00"/>
      </dmIdent>
      <dmAddressItems>
        <issueDate year="2026" month="10" day="28"/>
        <dmTitle><techName>テスト</techName><infoName>ビジネスルール</infoName></dmTitle>
      </dmAddressItems>
    </dmAddress>
    <dmStatus issueType="new">
      <security securityClassification="01"/>
      <brexDmRef><dmRef><dmRefIdent>
        <dmCode modelIdentCode="KENBAIKI" systemDiffCode="A" systemCode="00" subSystemCode="0"
          subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="022"
          infoCodeVariant="A" itemLocationCode="D"/>
      </dmRefIdent></dmRef></brexDmRef>
    </dmStatus>
  </identAndStatusSection>
  <content>
    <brex defaultBrSeverityLevel="brsl02">
      <contextRules rulesContext="${XSD_BASE}proced.xsd">
        <structureObjectRuleGroup>
          <structureObjectRule>
            <brDecisionRef brDecisionIdentNumber="PR-001"/>
            <objectPath allowedObjectFlag="0">//identAndStatusSection</objectPath>
            <objectUse>proced 専用（descript には適用されない）</objectUse>
          </structureObjectRule>
        </structureObjectRuleGroup>
      </contextRules>
    </brex>
  </content>
</dmodule>`;

const parsed = readBrex(SELF_BREX);
if (!parsed.ok) throw new Error('fixture: BREX');
const brex = parsed.value;
const brexRef: DmRef = { dmCode: brex.dmCode };
const resolver = (ref: DmRef) =>
  formatDmc(ref.dmCode) === formatDmc(brex.dmCode) ? brex : undefined;

const FIXED_NOW = () => new Date(2026, 9, 28);

/** 参照が brexDmRef だけの説明 DM（図も他の dmRef も持たない） */
const plainDraft = (extra: DraftDataModule['body'] = []): DraftDataModule => ({
  ...F.descriptDraft(),
  body: [{ kind: 'para', text: '指定席券売機は、きっぷの購入ができる機械である。' }, ...extra],
});

const build = (draft: DraftDataModule, ref: DmRef = brexRef) =>
  buildDataModule(draft, F.kenbaikiAllocation(), { defaultBrexRef: ref, now: FIXED_NOW });

/** 仕様書の章（モデル識別コード S1000D、情報コード 040）への dmRef を 1 件含む説明 DM の XML */
const withSpecRef = () => {
  const xml = build(plainDraft()).xml;
  const specRef = `<para>仕様書 <dmRef><dmRefIdent><dmCode modelIdentCode="S1000D" systemDiffCode="G" systemCode="04" subSystemCode="1" subSubSystemCode="0" assyCode="0301" disassyCode="00" disassyCodeVariant="A" infoCode="040" infoCodeVariant="A" itemLocationCode="D"/></dmRefIdent></dmRef> を参照。</para>`;
  expect(xml).toContain('</description>');
  return xml.replace('</description>', `${specRef}</description>`);
};

describe('verifyDataModule: BREX の層を指す参照', () => {
  it('(a) CSDB なし・BREX の解決器あり: brexDmRef は BREX の層として解決され、修正提案も出ない', async () => {
    const dm = build(plainDraft());
    const v = await verifyDataModule(dm.xml, {
      brex: { resolver },
      references: {},
      now: FIXED_NOW,
    });
    expect(v.status.brex.state).toBe('passed');
    expect(v.status.brex.layers).toBe(1);
    expect(v.status.references).toEqual({ state: 'resolved', checked: 1, unresolvedCount: 0 });
    expect(v.references?.unresolved).toEqual([]);
    const r = v.references!.resolved[0];
    expect(r.reference.kind).toBe('dmRef');
    expect(r.source).toBe('brex-chain');
    expect(r.target).toBe(formatDmc(brex.dmCode));
    expect(r.foundIssueInfo).toEqual(brex.issueInfo);
    expect(r.issueMismatch).toBeUndefined();
    expect(suggestFixes(v, { xml: dm.xml })).toEqual([]);
  });

  it('CSDB を渡しても（BREX がそこに無ければ）BREX の層として解決される', async () => {
    const dm = build(plainDraft());
    const withoutBrexStage = await verifyDataModule(dm.xml, { references: { csdb: [] } });
    expect(withoutBrexStage.references?.unresolved.map((u) => u.reason)).toEqual(['not-found']);
    const v = await verifyDataModule(dm.xml, {
      brex: { resolver },
      references: { csdb: [] },
    });
    expect(v.status.references.unresolvedCount).toBe(0);
    expect(v.references?.resolved[0].source).toBe('brex-chain');
  });

  it('resolveReferences: knownObjects は CSDB に無い dmRef だけを解決する（CSDB が空の索引でも同じ）', () => {
    const dm = build(plainDraft());
    const { document } = defaultXmlEngine.parse(dm.xml);
    const csdb = CsdbIndex.fromDirs([]);
    const report = resolveReferences(collectReferences(document), {
      csdb,
      knownObjects: [{ kind: 'brex', dmCode: brex.dmCode, issueInfo: brex.issueInfo }],
    });
    expect(report.resolved[0].source).toBe('brex-chain');
    expect(report.unresolved).toEqual([]);
  });

  it('版が違えば issueMismatch、修正提案は BREX の層の版への置き換え', async () => {
    const dm = build(plainDraft(), {
      dmCode: brex.dmCode,
      issueInfo: { issueNumber: '002', inWork: '00' },
    });
    const v = await verifyDataModule(dm.xml, { brex: { resolver }, references: {} });
    expect(v.status.references.unresolvedCount).toBe(0);
    const r = v.references!.resolved[0];
    expect(r.source).toBe('brex-chain');
    expect(r.issueMismatch).toBe(true);
    expect(r.foundIssueInfo).toEqual(brex.issueInfo);
    const fixes = suggestFixes(v, { xml: dm.xml });
    expect(fixes).toHaveLength(1);
    expect(fixes[0].source).toBe('BREX chain');
    expect(fixes[0].problem).toMatch(/not in the BREX layers/);
    expect(fixes[0].candidates[0]).toMatchObject({ action: 'replace', value: '001-00' });
  });

  it('(b) BREX の工程を省くと、従来どおり brexDmRef は未解決（no-csdb）で、提案は CSDB を渡す案内', async () => {
    const dm = build(plainDraft());
    const v = await verifyDataModule(dm.xml, { brex: false, references: {} });
    expect(v.status.brex.reason).toBe('skipped');
    expect(v.status.references).toEqual({ state: 'unresolved', checked: 1, unresolvedCount: 1 });
    expect(v.references?.unresolved[0].reason).toBe('no-csdb');
    expect(v.references?.resolved).toEqual([]);
    const fixes = suggestFixes(v, { xml: dm.xml });
    expect(fixes).toHaveLength(1);
    expect(fixes[0].note).toMatch(/Give the CSDB folders/);
  });

  it('BREX の連鎖が途中で切れたとき、たどれなかった層は未解決のまま', async () => {
    const dm = build(plainDraft());
    const v = await verifyDataModule(dm.xml, {
      brex: { resolver: () => undefined },
      references: {},
    });
    expect(v.status.brex.layers).toBe(0);
    expect(v.status.references.unresolvedCount).toBe(1);
  });

  it('(c) CSDB なしで仕様書の章を指す dmRef の提案は、CSDB を渡す案内ではなく仕様書への参照の注記', async () => {
    const xml = withSpecRef();
    const v = await verifyDataModule(xml, { brex: { resolver }, references: {} });
    // brexDmRef は解決され、仕様書の章への dmRef だけが残る
    expect(v.status.references).toEqual({ state: 'unresolved', checked: 2, unresolvedCount: 1 });
    expect(v.references?.unresolved[0].reason).toBe('no-csdb');
    const fixes = suggestFixes(v, { xml });
    expect(fixes).toHaveLength(1);
    expect(fixes[0].source).toBe('modelIdentCode S1000D');
    expect(fixes[0].confidence).toBe('none');
    expect(fixes[0].candidates).toEqual([]);
    expect(fixes[0].note).toMatch(/chapter of the S1000D specification/);
    expect(fixes[0].note).not.toMatch(/Give the CSDB folders/);
  });

  it('(c) BREX の工程を省いても、仕様書の章への dmRef は仕様書への参照の注記', async () => {
    const xml = withSpecRef();
    const v = await verifyDataModule(xml, { references: {} });
    const fixes = suggestFixes(v, { xml });
    expect(fixes.map((f) => f.source).sort()).toEqual(['CsdbIndex', 'modelIdentCode S1000D']);
  });
});

// ---- 配布物（再配布できないため S1000D_SPEC_TESTS=1 のときだけ）----
const enabled = process.env.S1000D_SPEC_TESTS === '1';
const specDir = resolve(process.env.S1000D_SPEC_DIR ?? '../../specs/s1000d/issue-7');

describe.skipIf(!enabled || !existsSync(specDir))('既定 BREX を参照する自作 DM（配布物）', () => {
  it('(d) CSDB なし・BREX の解決器あり: 既定 BREX の層として解決され、未解決 0・修正提案なし', async () => {
    const found = findDefaultBrex([specDir]);
    expect(found).toBeDefined();
    // 既定 BREX は specDirs から探す（brexDmRef は既定 BREX を指す）
    const dm = buildDataModule(plainDraft(), F.kenbaikiAllocation(), {
      specDirs: [specDir],
      now: FIXED_NOW,
    });
    const defaultResolver = createBrexResolver(CsdbIndex.fromDirs([specDir]));
    const v = await verifyDataModule(dm.xml, {
      brex: { resolver: defaultResolver },
      references: {},
      now: FIXED_NOW,
    });
    expect(v.status.brex.state).toBe('passed');
    expect(v.status.brex.layers).toBe(1);
    expect(v.status.references).toEqual({ state: 'resolved', checked: 1, unresolvedCount: 0 });
    const r = v.references!.resolved[0];
    expect(r.source).toBe('brex-chain');
    expect(r.target).toBe(formatDmc(found!.brex.dmCode));
    expect(suggestFixes(v, { xml: dm.xml })).toEqual([]);
    // 比較: BREX の解決器を渡さなければ従来どおり未解決
    const without = await verifyDataModule(dm.xml, { references: {} });
    expect(without.status.references.unresolvedCount).toBe(1);
    // CSDB を渡しても既定 BREX はそこに無い（S1000D_SPEC_DIR にある）ので not-found
    const withCsdb = await verifyDataModule(dm.xml, { references: { csdb: [] } });
    expect(withCsdb.references?.unresolved.map((u) => u.reason)).toEqual(['not-found']);
  });
});
