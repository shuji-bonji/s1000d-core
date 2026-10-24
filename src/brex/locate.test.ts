import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDmc } from '../dmc.js';
import { BrexLocateError, findDefaultBrex, isDefaultBrexDmc, locateBrex } from './locate.js';

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), 'utf8');

/**
 * 自作の「既定 BREX の形をした」最小の BREX。配布物の既定 BREX の内容は含まない。
 * `self` が真なら brexDmRef は自分自身を指す（既定 BREX の性質）。
 */
function brexLike(systemDiffCode: string, refSystemDiffCode: string): string {
  const code = (sdc: string) =>
    `<dmCode modelIdentCode="S1000D" systemDiffCode="${sdc}" systemCode="04" subSystemCode="1" subSubSystemCode="0" assyCode="0301" disassyCode="00" disassyCodeVariant="A" infoCode="022" infoCodeVariant="A" itemLocationCode="D"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<dmodule xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_7/xml_schema_flat/brex.xsd">
  <identAndStatusSection>
    <dmAddress><dmIdent>${code(systemDiffCode)}<language languageIsoCode="en" countryIsoCode="US"/><issueInfo issueNumber="001" inWork="00"/></dmIdent>
      <dmAddressItems><issueDate year="2026" month="10" day="24"/><dmTitle><techName>Test</techName><infoName>Business rules</infoName></dmTitle></dmAddressItems></dmAddress>
    <dmStatus issueType="new"><security securityClassification="01"/>
      <responsiblePartnerCompany enterpriseCode="T0001"/><originator enterpriseCode="T0001"/>
      <applic><displayText><simplePara>All</simplePara></displayText></applic>
      <brexDmRef><dmRef><dmRefIdent>${code(refSystemDiffCode)}</dmRefIdent></dmRef></brexDmRef>
      <qualityAssurance><unverified/></qualityAssurance></dmStatus>
  </identAndStatusSection>
  <content><brex><contextRules><structureObjectRuleGroup><structureObjectRule>
    <brDecisionRef brDecisionIdentNumber="TEST-00001"/><objectPath allowedObjectFlag="2">//language/@countryIsoCode</objectPath><objectUse>country</objectUse>
  </structureObjectRule></structureObjectRuleGroup></contextRules></brex></content>
</dmodule>`;
}

const defaultName = (sdc: string) => `DMC-S1000D-${sdc}-04-10-0301-00A-022A-D_001-00_EN-US.XML`;

let root: string;
let good: string; // 中身の DMC がファイル名と一致し、自分自身を参照する
let decoy: string; // ファイル名は Z だが中身は X（データ辞書の見本と同じ食い違い）
let onlyDecoy: string;
let csdb: string; // 自作フィクスチャを DMC 名で置いた CSDB

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 's1000d-core-locate-'));
  good = join(root, 'good');
  decoy = join(root, 'decoy');
  onlyDecoy = join(root, 'only-decoy');
  csdb = join(root, 'csdb');
  for (const d of [good, decoy, onlyDecoy, csdb]) mkdirSync(d);
  writeFileSync(join(good, defaultName('Z')), brexLike('Z', 'Z'));
  writeFileSync(join(decoy, defaultName('Z')), brexLike('X', 'Z'));
  // decoy を含むフォルダー群でも good が選ばれることを確かめるため、両方を 1 つの親に置く
  writeFileSync(join(onlyDecoy, defaultName('Z')), brexLike('X', 'Z'));
  writeFileSync(
    join(csdb, 'DMC-KENBAIKI-A-00-00-00-00A-022A-D_002-00_JA-JP.XML'),
    fx('kenbaiki-brex.xml'),
  );
  writeFileSync(
    join(csdb, 'DMC-KBWORKS-A-00-00-00-00A-022A-D_003-00_JA-JP.XML'),
    fx('kenbaiki-base-brex.xml'),
  );
  writeFileSync(join(csdb, 'not-brex.xml'), fx('kenbaiki-descript.xml'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isDefaultBrexDmc', () => {
  it('システム差異コードが何であっても既定 BREX の DMC と判定する', () => {
    for (const sdc of ['I', 'J', 'X', 'ZZ']) {
      const dmc = parseDmc(`S1000D-${sdc}-04-10-0301-00A-022A-D`);
      expect(dmc.ok && isDefaultBrexDmc(dmc.value)).toBe(true);
    }
  });
  it('他の BREX や情報コードの違うものは判定しない', () => {
    const other = parseDmc('KENBAIKI-A-00-00-00-00A-022A-D');
    const brdoc = parseDmc('S1000D-J-04-10-0100-00A-024A-D');
    expect(other.ok && isDefaultBrexDmc(other.value)).toBe(false);
    expect(brdoc.ok && isDefaultBrexDmc(brdoc.value)).toBe(false);
  });
});

describe('findDefaultBrex', () => {
  it('中身の DMC がファイル名と一致し自分自身を参照するものを優先する', () => {
    const found = findDefaultBrex([decoy, good]);
    expect(found?.path).toBe(join(good, defaultName('Z')));
    expect(found?.brex.dmCode.systemDiffCode).toBe('Z');
  });
  it('一致するものが無ければ最初に読めたものを返す', () => {
    const found = findDefaultBrex([onlyDecoy]);
    expect(found?.path).toBe(join(onlyDecoy, defaultName('Z')));
    expect(found?.brex.dmCode.systemDiffCode).toBe('X');
  });
  it('無いフォルダーや既定 BREX の無いフォルダーでは undefined', () => {
    expect(findDefaultBrex([csdb])).toBeUndefined();
    expect(findDefaultBrex([join(root, 'missing')])).toBeUndefined();
    expect(findDefaultBrex([])).toBeUndefined();
  });
});

describe('locateBrex', () => {
  it('省略なら既定 BREX（source: default）', async () => {
    const located = await locateBrex(undefined, { dirs: [csdb, good] });
    expect(located.source).toBe('default');
    expect(located.path).toBe(join(good, defaultName('Z')));
  });
  it('ファイルのパス（source: file）', async () => {
    const p = join(csdb, 'DMC-KENBAIKI-A-00-00-00-00A-022A-D_002-00_JA-JP.XML');
    const located = await locateBrex(p, { dirs: [] });
    expect(located.source).toBe('file');
    expect(located.brex.dmCode.modelIdentCode).toBe('KENBAIKI');
  });
  it('DMC（DMC- 付きでも無しでも。source: dmc）', async () => {
    const a = await locateBrex('KBWORKS-A-00-00-00-00A-022A-D', { dirs: [csdb] });
    const b = await locateBrex('DMC-KBWORKS-A-00-00-00-00A-022A-D', { dirs: [csdb] });
    expect(a.source).toBe('dmc');
    expect(a.brex.dmCode.modelIdentCode).toBe('KBWORKS');
    expect(b.brex.dmCode.modelIdentCode).toBe('KBWORKS');
  });
  it('見つからないときは reason 付きの BrexLocateError', async () => {
    const reason = async (spec: string | undefined, dirs: string[]) => {
      try {
        await locateBrex(spec, { dirs });
        return undefined;
      } catch (e) {
        return e instanceof BrexLocateError ? e.reason : `other: ${String(e)}`;
      }
    };
    expect(await reason(undefined, [csdb])).toBe('default-not-found');
    expect(await reason(join(csdb, 'nothing.xml'), [])).toBe('file-not-found');
    expect(await reason(join(csdb, 'not-brex.xml'), [])).toBe('not-brex');
    expect(await reason('this is not a dmc', [csdb])).toBe('invalid-spec');
    expect(await reason('KENBAIKI-A-99-00-00-00A-022A-D', [csdb])).toBe('dmc-not-found');
  });
});
