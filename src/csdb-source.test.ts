import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrexResolver, createDirectoryBrexResolver } from './csdb.js';
import { CsdbIndex } from './csdb-index.js';
import {
  DirectoryCsdbSource,
  MemoryCsdbSource,
  classifyCsdbFileName,
  type CsdbSource,
} from './csdb-source.js';
import { formatDmc, parseDmc } from './dmc.js';
import { collectReferences, resolveReferences } from './refs/index.js';
import { verifyDataModule } from './verify/verify.js';
import { defaultXmlEngine } from './xml/xmldom-fontoxpath.js';

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');

const BREX = 'DMC-KENBAIKI-A-00-00-00-00A-022A-D_001-00_JA-JP.XML';
const BASE_BREX = 'DMC-KBWORKS-A-00-00-00-00A-022A-D_001-00_JA-JP.XML';
const DESCRIPT = 'DMC-KENBAIKI-A-10-20-00-00A-040A-D_001-00_JA-JP.XML';
const BREX_DMC = 'KENBAIKI-A-00-00-00-00A-022A-D';

const memory = () =>
  new MemoryCsdbSource(
    [
      { fileName: BREX, xml: fx('kenbaiki-brex.xml') },
      { fileName: BASE_BREX, xml: fx('kenbaiki-base-brex.xml') },
      { fileName: DESCRIPT, xml: fx('kenbaiki-descript.xml') },
      { fileName: 'ICN-K0001-00001-001-01.SVG' },
      { fileName: 'README.md', xml: 'not a CSDB object' },
    ],
    'test CSDB',
  );

describe('classifyCsdbFileName', () => {
  it('接頭辞から種類を決め、DMC・PMC を読む', () => {
    const dm = classifyCsdbFileName(BREX);
    expect(dm?.kind).toBe('dm');
    expect(dm?.dm && formatDmc(dm.dm.dmCode)).toBe(BREX_DMC);
    expect(classifyCsdbFileName('PMC-KENBAIKI-K0001-00001-00_001-00_JA-JP.XML')?.kind).toBe('pm');
    expect(classifyCsdbFileName('ICN-K0001-00001-001-01.SVG')?.kind).toBe('icn');
    expect(classifyCsdbFileName('DML-KENBAIKI-K0001-C-2026-00001.XML')?.kind).toBe('dml');
  });
  it('接頭辞が無い、XML でない（ICN 以外）、DMC として読めない名前は undefined', () => {
    expect(classifyCsdbFileName('README.md')).toBeUndefined();
    expect(classifyCsdbFileName('DMC-notes.txt')).toBeUndefined();
    expect(classifyCsdbFileName('DMC-BROKEN.XML')).toBeUndefined();
  });
});

describe('MemoryCsdbSource と CsdbIndex.fromSource', () => {
  it('一覧は CSDB の形の名前だけ、中身は readText で読める', () => {
    const source = memory();
    const index = CsdbIndex.fromSource(source);
    expect(index.description).toBe('test CSDB');
    expect(index.objects.map((o) => o.fileName).sort()).toEqual(
      [BREX, BASE_BREX, DESCRIPT, 'ICN-K0001-00001-001-01.SVG'].sort(),
    );
    const brex = index.findDataModules(parseDmc(BREX_DMC).value!)[0];
    expect(brex).toBeDefined();
    expect(index.read(brex!)).toContain('brex');
    expect(index.findByFileName('icn-k0001-00001-001-01.svg')).toHaveLength(1);
  });
  it('中身の無いオブジェクトを読むと throw する', () => {
    const index = CsdbIndex.fromSource(memory());
    const icn = index.findByFileName('ICN-K0001-00001-001-01.SVG')[0];
    expect(() => index.read(icn!)).toThrow(/No content for ICN-K0001-00001-001-01.SVG/);
  });
  it('path を別に与えると、それが識別子になる', () => {
    const source = new MemoryCsdbSource([
      { fileName: DESCRIPT, xml: '<dmodule/>', path: 'csdb://objects/42' },
    ]);
    const [o] = source.list();
    expect(o!.path).toBe('csdb://objects/42');
    expect(source.readText(o!)).toBe('<dmodule/>');
  });
});

describe('BREX の解決と参照の解決は CsdbSource から読む', () => {
  it('createBrexResolver はメモリー上の CSDB から連鎖をたどる', () => {
    const resolve = createBrexResolver(CsdbIndex.fromSource(memory()));
    const brex = resolve({ dmCode: parseDmc(BREX_DMC).value! });
    expect(brex).toBeDefined();
    expect(brex?.brexDmRef && formatDmc(brex.brexDmRef.dmCode)).toBe(
      'KBWORKS-A-00-00-00-00A-022A-D',
    );
    expect(resolve(brex!.brexDmRef!)).toBeDefined();
    expect(resolve({ dmCode: parseDmc('NOPE-A-00-00-00-00A-022A-D').value! })).toBeUndefined();
  });
  it('resolveReferences は索引だけで dmRef を解決する（ファイルは読まない）', () => {
    const index = CsdbIndex.fromSource(memory());
    const collected = collectReferences(
      defaultXmlEngine.parse(fx('kenbaiki-descript.xml')).document,
    );
    const report = resolveReferences(collected, { csdb: index });
    const brexRef = report.resolved.find((r) => r.reference.kind === 'dmRef');
    expect(brexRef?.path).toBe(BREX);
  });
  it('verifyDataModule は references.csdb に CsdbSource を受け取る', async () => {
    const r = await verifyDataModule(fx('kenbaiki-descript.xml'), {
      references: { csdb: memory() },
    });
    // 説明 DM には ICN など CSDB に無い参照もあるので state は見ない。BREX への dmRef が CsdbSource から解決されていればよい
    expect(r.status.references.state).not.toBe('not-run');
    expect(r.status.references.checked).toBeGreaterThan(0);
    expect(r.references?.resolved.some((x) => x.path === BREX)).toBe(true);
  });
});

describe('DirectoryCsdbSource（既定）', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 's1000d-core-source-'));
    writeFileSync(join(dir, BREX), fx('kenbaiki-brex.xml'));
    writeFileSync(join(dir, BASE_BREX), fx('kenbaiki-base-brex.xml'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('fromDirs は DirectoryCsdbSource の上に索引を作り、path はファイルのパス', () => {
    const index = CsdbIndex.fromDirs([dir]);
    expect(index.source).toBeInstanceOf(DirectoryCsdbSource);
    expect(index.description).toBe(`directories: ${dir}`);
    const brex = index.findDataModules(parseDmc(BREX_DMC).value!)[0]!;
    expect(brex.path).toBe(join(dir, BREX));
    expect(index.read(brex)).toBe(fx('kenbaiki-brex.xml'));
  });
  it('createDirectoryBrexResolver は createBrexResolver(fromDirs) と同じ結果', () => {
    const a = createDirectoryBrexResolver([dir])({ dmCode: parseDmc(BREX_DMC).value! });
    const b = createBrexResolver(CsdbIndex.fromDirs([dir]))({ dmCode: parseDmc(BREX_DMC).value! });
    expect(a).toBeDefined();
    expect(formatDmc(a!.dmCode)).toBe(formatDmc(b!.dmCode));
  });
  it('source 無しの new CsdbIndex(objects) は path をファイルとして読む（互換）', () => {
    const index = new CsdbIndex(new DirectoryCsdbSource([dir]).list());
    expect(index.source).toBeUndefined();
    expect(index.description).toBe('files');
    expect(index.read(index.objects[0]!)).toContain('<dmodule');
  });
  it('自作の CsdbSource を差し込める', () => {
    const calls: string[] = [];
    const custom: CsdbSource = {
      description: 'custom',
      list: () => [classifyCsdbFileName(BREX)!],
      readText: (o) => {
        calls.push(o.path);
        return fx('kenbaiki-brex.xml');
      },
    };
    const index = CsdbIndex.fromSource(custom);
    expect(index.read(index.objects[0]!)).toContain('<dmodule');
    expect(calls).toEqual([BREX]);
  });
});
