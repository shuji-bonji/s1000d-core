import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatDmc } from '../dmc.js';
import type { DmRef } from '../types.js';
import { checkAgainstBrexChain, resolveBrexChain } from './chain.js';
import {
  allowedNotations,
  notationPolicy,
  checkAgainstBrexLayers,
  contextApplies,
  usedNotations,
} from './check.js';
import { readBrex } from './read.js';
import { lookupSns } from './sns.js';
import { matchesPattern, matchesRange } from './values.js';
import { defaultXmlEngine } from '../xml/index.js';

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), 'utf8');
const dmXml = fx('kenbaiki-descript.xml');
const projectBrex = readBrex(fx('kenbaiki-brex.xml'));
const baseBrex = readBrex(fx('kenbaiki-base-brex.xml'));
if (!projectBrex.ok || !baseBrex.ok) throw new Error('fixture BREX failed to parse');

const resolver = (ref: DmRef) => {
  const dmc = formatDmc(ref.dmCode);
  if (dmc === 'KENBAIKI-A-00-00-00-00A-022A-D') return projectBrex.value;
  if (dmc === 'KBWORKS-A-00-00-00-00A-022A-D') return baseBrex.value;
  return undefined;
};

describe('readBrex', () => {
  it('ルールの種類ごとに読み取る', () => {
    const b = projectBrex.value;
    expect(formatDmc(b.dmCode)).toBe('KENBAIKI-A-00-00-00-00A-022A-D');
    expect(b.title).toBe('指定席券売機 - ビジネスルール');
    expect(b.defaultBrSeverityLevel).toBe('brsl02');
    expect(b.brexDmRef && formatDmc(b.brexDmRef.dmCode)).toBe('KBWORKS-A-00-00-00-00A-022A-D');
    expect(b.contextRules).toHaveLength(2);
    expect(b.contextRules[0].rulesContext).toBeUndefined();
    expect(b.contextRules[0].structureRules).toHaveLength(6);
    expect(b.contextRules[0].notationRules.map((n) => n.notationName)).toEqual(['png', 'cgm']);
    expect(b.contextRules[1].rulesContext).toContain('proced.xsd');
    expect(b.nonContextRules).toEqual([
      {
        kind: 'nonContext',
        ruleId: 'KB-00100',
        id: undefined,
        text: '月末に CSDB を同期する',
        brSeverityLevel: undefined,
      },
    ]);
    const r3 = b.contextRules[0].structureRules[2];
    expect(r3.ruleId).toBe('KB-00003');
    expect(r3.allowedObjectFlag).toBe('2');
    expect(
      r3.objectValues.map((v) => [v.valueForm, v.valueAllowed, v.valueTailoring, v.description]),
    ).toEqual([
      ['single', '040', 'closed', '説明'],
      ['range', '500~599', 'closed', '手順'],
      ['pattern', '[0-9]{2}[A-Z]', 'closed', 'プロジェクト拡張'],
    ]);
    expect(b.contextRules[0].structureRules[0].brSeverityLevel).toBe('brsl01');
  });

  it('BREX でない DM は失敗を返す', () => {
    expect(readBrex(dmXml).ok).toBe(false);
  });

  it('SNS を引く', () => {
    const b = projectBrex.value;
    expect(lookupSns(b, { systemCode: '10', subSystemCode: '2', subSubSystemCode: '0' })).toEqual({
      levels: [
        { snsCode: '10', snsTitle: '発券部' },
        { snsCode: '2', snsTitle: '画面' },
        { snsCode: '0', snsTitle: '全般' },
      ],
      exact: true,
    });
    expect(lookupSns(b, { systemCode: '10', subSystemCode: '9' })?.exact).toBe(false);
    expect(lookupSns(b, { systemCode: '99' })).toBeUndefined();
  });
});

describe('値の照合', () => {
  it('range は接頭辞と桁数を見る', () => {
    expect(matchesRange('brsl60', 'brsl51~brsl99')).toBe(true);
    expect(matchesRange('brsl50', 'brsl51~brsl99')).toBe(false);
    expect(matchesRange('brsx60', 'brsl51~brsl99')).toBe(false);
    expect(matchesRange('010', '000~022')).toBe(true);
    expect(matchesRange('10', '000~022')).toBe(false);
    expect(matchesRange('B', 'A|B|C')).toBe(true);
  });
  it('pattern は全体一致', () => {
    expect(matchesPattern('ICN-K0001-KENB0001', '((ICN-[A-Z0-9]{5}-[A-Z0-9]{5,10})|(X))')).toBe(
      true,
    );
    expect(matchesPattern('xICN-K0001-KENB0001', '((ICN-[A-Z0-9]{5}-[A-Z0-9]{5,10})|(X))')).toBe(
      false,
    );
    expect(
      matchesPattern('csc01 csc52', '((csc0[1-5])|(csc5[1-9]))((\\ )+((csc0[1-5])|(csc5[1-9])))*'),
    ).toBe(true);
  });
});

describe('文脈と NOTATION', () => {
  it('rulesContext はスキーマ名で一致させる', () => {
    expect(contextApplies(undefined, 'x')).toBe(true);
    expect(
      contextApplies(
        'http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd',
        'http://www.s1000d.org/S1000D_7/xml_schema_flat/proced.xsd',
      ),
    ).toBe(true);
    expect(
      contextApplies(
        'http://www.s1000d.org/S1000D_7/xml_schema_flat/proced.xsd',
        'file:///x/descript.xsd',
      ),
    ).toBe(false);
  });
  it('使っている NOTATION と許可された NOTATION', () => {
    const { document } = defaultXmlEngine.parse(dmXml);
    expect(usedNotations(document)).toEqual(['png']);
    expect([...allowedNotations(projectBrex.value, 'file:///descript.xsd')!]).toEqual([
      'PNG',
      'CGM',
    ]);
    expect([...allowedNotations(projectBrex.value, 'file:///proced.xsd')!]).toEqual(['CGM']);
    expect(allowedNotations(baseBrex.value, 'file:///descript.xsd')).toBeUndefined();
  });
});

describe('checkAgainstBrexChain', () => {
  it('連鎖をたどり、各層に照合する', async () => {
    const chain = await resolveBrexChain({ dmCode: projectBrex.value.dmCode }, resolver);
    expect(chain.layers.map((l) => formatDmc(l.dmCode))).toEqual([
      'KENBAIKI-A-00-00-00-00A-022A-D',
      'KBWORKS-A-00-00-00-00A-022A-D',
    ]);
    expect(chain.unresolved).toEqual([]);

    const report = await checkAgainstBrexChain(dmXml, resolver);
    expect(report.target.schemaName).toBe('descript');
    expect(report.layers).toHaveLength(2);
    expect(report.passed).toBe(false);

    const [project, base] = report.layers;
    expect(project.evaluatedRules).toBe(6); // proced.xsd の文脈は除外される
    expect(project.skipped).toEqual([]);
    expect(project.manualChecks.map((m) => m.ruleId)).toEqual(['KB-00100']);
    const byRule = Object.fromEntries(project.violations.map((v) => [v.ruleId, v]));
    expect(Object.keys(byRule).sort()).toEqual(['KB-00004', 'KB-00005']);
    expect(byRule['KB-00004']).toMatchObject({
      kind: 'value',
      actualValue: 'K0001',
      allowedValues: ['K0002'],
      brSeverityLevel: 'brsl02',
      location: {
        path: '/dmodule/identAndStatusSection/dmStatus/responsiblePartnerCompany/@enterpriseCode',
      },
    });
    expect(byRule['KB-00005']).toMatchObject({
      kind: 'forbidden',
      brSeverityLevel: 'brsl02',
      actualValue: '画面の構成',
    });
    expect(byRule['KB-00005'].location?.line).toBeGreaterThan(0);
    expect(base.violations).toEqual([]);
    expect(base.evaluatedRules).toBe(2);
  });

  it('解決できない参照は unresolved に入り、合格にならない', async () => {
    const report = await checkAgainstBrexChain(dmXml, () => undefined);
    expect(report.layers).toEqual([]);
    expect(report.unresolved.map((r) => formatDmc(r.dmCode))).toEqual([
      'KENBAIKI-A-00-00-00-00A-022A-D',
    ]);
    expect(report.passed).toBe(false);
  });

  it('flag=1 の欠落と NOTATION の違反を検出する', () => {
    const xml = dmXml
      .replace('<security securityClassification="01"/>', '')
      .replace('NDATA png', 'NDATA jpg');
    const report = checkAgainstBrexLayers(xml, [projectBrex.value]);
    const kinds = report.layers[0].violations
      .map((v) => `${v.kind}:${v.ruleId ?? v.actualValue}`)
      .sort();
    expect(kinds).toContain('missing:KB-00002');
    expect(kinds).toContain('notation:jpg');
  });

  it('除外（flag=0）だけの NOTATION ルールは、挙げたものだけを違反にする（Chap 4.10.2.2 Para 2.2.2）', () => {
    const excludeOnly = {
      ...projectBrex.value,
      contextRules: [
        {
          structureRules: [],
          notationRules: [
            {
              kind: 'notation' as const,
              notationName: 'swf',
              allowedNotationFlag: '0' as const,
              objectUse: 'Flash は使わない',
            },
          ],
        },
      ],
    };
    expect(notationPolicy(excludeOnly, 'file:///descript.xsd')).toEqual({
      mode: 'open',
      excluded: new Set(['SWF']),
    });
    expect(allowedNotations(excludeOnly, 'file:///descript.xsd')).toBeUndefined();
    const ok = checkAgainstBrexLayers(dmXml, [excludeOnly]);
    expect(ok.layers[0].violations.filter((v) => v.kind === 'notation')).toEqual([]);
    const bad = checkAgainstBrexLayers(dmXml.replace('NDATA png', 'NDATA swf'), [excludeOnly]);
    const v = bad.layers[0].violations.find((x) => x.kind === 'notation');
    expect(v).toMatchObject({ actualValue: 'swf', objectUse: 'Flash は使わない' });
    expect(v?.allowedValues).toBeUndefined();
  });

  it('真偽値を返す objectPath を扱う', () => {
    const xml = dmXml.replace(/<applic>[\s\S]*?<\/applic>/, '');
    const report = checkAgainstBrexLayers(xml, [projectBrex.value]);
    const v = report.layers[0].violations.find((x) => x.ruleId === 'KB-00006');
    expect(v?.kind).toBe('forbidden');
    expect(v?.location).toBeUndefined();
  });
});
