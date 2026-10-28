/**
 * ルートが pm / comment の対象でも BREX の連鎖をたどり、rulesContext（pm.xsd / comment.xsd）の層が効くことを確かめる。
 * 自作の PM・comment・BREX だけで動く部分と、配布物（`S1000D_SPEC_TESTS=1`）を使う部分に分ける。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as F from '../__fixtures__/kenbaiki-drafts.js';
import { buildComment } from '../comment/build.js';
import { createBrexResolver } from '../csdb.js';
import { CsdbIndex } from '../csdb-index.js';
import { readBrexDmRefOf, readNonDmIdent } from '../data-module.js';
import { formatDmc } from '../dmc.js';
import type { DmRef } from '../types.js';
import { verifyDataModule } from '../verify/verify.js';
import { buildDataModule } from '../write/build.js';
import { defaultXmlEngine } from '../xml/index.js';
import { checkAgainstBrexChain, findDefaultBrex } from './index.js';
import { readBrex } from './read.js';

const XSD_BASE = 'http://www.s1000d.org/S1000D_7/xml_schema_flat/';

/** 自作の BREX。自分自身を参照する（連鎖の終端）。pm.xsd / comment.xsd / proced.xsd の文脈に 1 ルールずつ持つ。 */
const MINI_BREX = `<?xml version="1.0" encoding="UTF-8"?>
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
      <contextRules rulesContext="${XSD_BASE}pm.xsd">
        <structureObjectRuleGroup>
          <structureObjectRule>
            <brDecisionRef brDecisionIdentNumber="PM-001"/>
            <objectPath allowedObjectFlag="0">//pmTitle</objectPath>
            <objectUse>pm 専用: 題名を書かない</objectUse>
          </structureObjectRule>
        </structureObjectRuleGroup>
      </contextRules>
      <contextRules rulesContext="${XSD_BASE}comment.xsd">
        <structureObjectRuleGroup>
          <structureObjectRule>
            <brDecisionRef brDecisionIdentNumber="CM-001"/>
            <objectPath allowedObjectFlag="0">//commentTitle</objectPath>
            <objectUse>comment 専用: 題名を書かない</objectUse>
          </structureObjectRule>
        </structureObjectRuleGroup>
      </contextRules>
      <contextRules rulesContext="${XSD_BASE}proced.xsd">
        <structureObjectRuleGroup>
          <structureObjectRule>
            <brDecisionRef brDecisionIdentNumber="PR-001"/>
            <objectPath allowedObjectFlag="0">//identAndStatusSection</objectPath>
            <objectUse>proced 専用（pm / comment には適用されない）</objectUse>
          </structureObjectRule>
        </structureObjectRuleGroup>
      </contextRules>
    </brex>
  </content>
</dmodule>`;

const parsed = readBrex(MINI_BREX);
if (!parsed.ok) throw new Error('fixture: BREX');
const brex = parsed.value;
const brexRef: DmRef = { dmCode: brex.dmCode };
const resolver = (ref: DmRef) =>
  formatDmc(ref.dmCode) === formatDmc(brex.dmCode) ? brex : undefined;

const FIXED_NOW = () => new Date(2026, 9, 28);
const pm = buildDataModule(F.pmDraft(), F.kenbaikiAllocation(), {
  defaultBrexRef: brexRef,
  now: FIXED_NOW,
});
const commentXml = buildComment(
  {
    refs: [],
    commentType: 'q',
    commentPriorityCode: 'cp01',
    title: '題名あり',
    paragraphs: ['本文'],
    originator: {
      enterpriseCode: 'K0001',
      enterpriseName: 'Kenbaiki Works',
      address: { city: 'Tokyo', country: 'Japan' },
    },
    senderIdent: 'K0001',
    modelIdentCode: 'KENBAIKI',
    securityClassification: '01',
    language: { languageIsoCode: 'ja', countryIsoCode: 'JP' },
    brexDmRef: brex.dmCode,
  },
  { now: FIXED_NOW },
).xml;

describe('readBrexDmRefOf / readNonDmIdent', () => {
  it('pm と comment のルートでも brexDmRef を読む', () => {
    for (const xml of [pm.xml, commentXml]) {
      const doc = defaultXmlEngine.parse(xml).document;
      const ref = readBrexDmRefOf(doc);
      expect(ref && formatDmc(ref.dmCode)).toBe(formatDmc(brex.dmCode));
    }
  });

  it('pm は pmCode、comment は commentCode を読む', () => {
    const p = readNonDmIdent(defaultXmlEngine.parse(pm.xml).document);
    expect(p.pmCode).toEqual(pm.pmCode);
    expect(p.issueInfo).toBeDefined();
    const c = readNonDmIdent(defaultXmlEngine.parse(commentXml).document);
    expect(c.commentCode).toMatchObject({
      modelIdentCode: 'KENBAIKI',
      senderIdent: 'K0001',
      commentType: 'q',
    });
  });

  it('dmodule では従来どおり dmStatus から読み、readNonDmIdent は空', () => {
    const doc = defaultXmlEngine.parse(MINI_BREX).document;
    expect(readBrexDmRefOf(doc)?.dmCode).toEqual(brex.dmCode);
    expect(readNonDmIdent(doc)).toEqual({});
  });

  it('brexDmRef が無い文書では undefined', () => {
    const doc = defaultXmlEngine.parse(
      '<pm><identAndStatusSection><pmStatus/></identAndStatusSection></pm>',
    ).document;
    expect(readBrexDmRefOf(doc)).toBeUndefined();
  });
});

describe('checkAgainstBrexChain: pm / comment', () => {
  it('pm: 連鎖をたどり、pm.xsd の文脈だけが効く', async () => {
    const report = await checkAgainstBrexChain(pm.xml, resolver);
    expect(report.unresolved).toEqual([]);
    expect(report.layers).toHaveLength(1);
    expect(report.target.pmCode).toEqual(pm.pmCode);
    expect(report.target.dmCode).toBeUndefined();
    // pmTitle は複数箇所にあり得るので、ルール ID の種類で確かめる（proced.xsd の PR-001 は混ざらない）
    expect([...new Set(report.layers[0].violations.map((v) => v.ruleId))]).toEqual(['PM-001']);
    expect(report.passed).toBe(false);
  });

  it('comment: 連鎖をたどり、comment.xsd の文脈だけが効く', async () => {
    const report = await checkAgainstBrexChain(commentXml, resolver);
    expect(report.unresolved).toEqual([]);
    expect(report.layers).toHaveLength(1);
    expect(report.target.commentCode?.senderIdent).toBe('K0001');
    expect([...new Set(report.layers[0].violations.map((v) => v.ruleId))]).toEqual(['CM-001']);
  });

  it('参照先が見つからなければ unresolved に載る', async () => {
    const report = await checkAgainstBrexChain(pm.xml, () => undefined);
    expect(report.layers).toHaveLength(0);
    expect(report.unresolved).toHaveLength(1);
  });
});

describe('verifyDataModule: pm / comment の BREX の工程と target', () => {
  it('pm: 層が 1 件以上、target に pmCode と版が入る', async () => {
    const v = await verifyDataModule(pm.xml, { brex: { resolver }, now: FIXED_NOW });
    expect(v.status.brex.layers).toBeGreaterThanOrEqual(1);
    expect(v.status.brex.state).toBe('violations');
    expect(v.status.brex.violationCount).toBeGreaterThanOrEqual(1);
    expect(v.status.target.pmCode).toEqual(pm.pmCode);
    expect(v.status.target.issueInfo).toBeDefined();
    expect(v.status.target.dmCode).toBeUndefined();
    expect(v.status.target.schemaName).toBe('pm');
  });

  it('comment: 層が 1 件以上、target に commentCode が入る', async () => {
    const v = await verifyDataModule(commentXml, { brex: { resolver }, now: FIXED_NOW });
    expect(v.status.brex.layers).toBeGreaterThanOrEqual(1);
    expect(v.status.brex.violationCount).toBeGreaterThanOrEqual(1);
    expect(v.status.target.commentCode?.modelIdentCode).toBe('KENBAIKI');
    expect(v.status.target.dmCode).toBeUndefined();
    expect(v.status.target.schemaName).toBe('comment');
  });
});

// ---- 配布物（再配布できないため S1000D_SPEC_TESTS=1 のときだけ）----
const enabled = process.env.S1000D_SPEC_TESTS === '1';
const specDir = resolve(process.env.S1000D_SPEC_DIR ?? '../../specs/s1000d/issue-7');

function findPmFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && /^PMC-.*\.XML$/i.test(e.name) && e.parentPath.includes('Bike Samples'))
      out.push(join(e.parentPath, e.name));
  }
  return out.sort();
}

describe.skipIf(!enabled || !existsSync(specDir))('Bike Samples の PM（配布物）', () => {
  it('既定 BREX の層をたどれ、extraLayers 方式と違反数が同じ', async () => {
    const found = findDefaultBrex([specDir]);
    expect(found).toBeDefined();
    const files = findPmFiles(specDir);
    expect(files).toHaveLength(4);
    const resolver = createBrexResolver(CsdbIndex.fromDirs([specDir]));
    for (const f of files) {
      const xml = readFileSync(f, 'utf8');
      const viaChain = await checkAgainstBrexChain(xml, resolver);
      expect(viaChain.unresolved, f).toEqual([]);
      expect(viaChain.layers.length, f).toBeGreaterThanOrEqual(1);
      // 従来の回避策: 連鎖をたどらず、既定 BREX を層として直接渡す
      const viaExtra = await checkAgainstBrexChain(xml, () => undefined, {
        extraLayers: [found!.brex],
      });
      const count = (r: typeof viaChain) => r.layers.flatMap((l) => l.violations).length;
      expect(viaExtra.layers).toHaveLength(1);
      expect(count(viaChain), f).toBe(count(viaExtra));
      expect(viaChain.target.pmCode, f).toBeDefined();
    }
  });
});
