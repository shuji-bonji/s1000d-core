import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrexResolver, createDirectoryBrexResolver } from './csdb.js';
import { CsdbIndex } from './csdb-index.js';
import {
  CsdbWriteConflictError,
  DirectoryCsdbSource,
  MemoryCsdbSource,
  classifyCsdbFileName,
  fingerprintDirs,
  isWritableCsdbSource,
  listCsdbObjects,
  type CsdbSource,
  type WritableCsdbSource,
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

/** Memory と Directory で同じ約束（書いたものが list() と readText() で読める、write-conflict、overwrite、索引に入る）を確かめる */
function writableContract(name: string, make: () => { source: WritableCsdbSource; dir?: string }) {
  describe(`WritableCsdbSource: ${name}`, () => {
    it('型ガードで書き込める置き場所だと分かる。読むだけの CsdbSource は違う', () => {
      expect(isWritableCsdbSource(make().source)).toBe(true);
      expect(isWritableCsdbSource({ description: 'x', list: () => [], readText: () => '' })).toBe(
        false,
      );
    });
    it('書いた DM が list() と readText() で読め、CsdbIndex.fromSource の索引に入る', () => {
      const { source } = make();
      const written = source.writeText(DESCRIPT, fx('kenbaiki-descript.xml'));
      const listed = source.list().find((o) => o.fileName === DESCRIPT);
      expect(listed).toBeDefined();
      expect(listed!.path).toBe(written);
      expect(source.readText(listed!)).toBe(fx('kenbaiki-descript.xml'));
      const index = CsdbIndex.fromSource(source);
      const dm = index.findDataModules(parseDmc('KENBAIKI-A-10-20-00-00A-040A-D').value!);
      expect(dm).toHaveLength(1);
      expect(index.read(dm[0]!)).toContain('指定席券売機');
    });
    it('相対パスの置き場所を指定でき、ICN の原本をバイトで書ける', () => {
      const { source } = make();
      const icn = source.writeBytes(
        'icn/ICN-K0001-00001-001-01.PNG',
        new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      );
      const obj = source.list().find((o) => o.fileName === 'ICN-K0001-00001-001-01.PNG');
      expect(obj?.kind).toBe('icn');
      expect(obj?.path).toBe(icn);
    });
    it('同じ path があれば write-conflict。overwrite: true なら置き換える（一覧は増えない）', () => {
      const { source } = make();
      source.writeText(DESCRIPT, '<dmodule id="1"/>');
      const err = (() => {
        try {
          source.writeText(DESCRIPT, '<dmodule id="2"/>');
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(CsdbWriteConflictError);
      expect((err as CsdbWriteConflictError).code).toBe('write-conflict');
      expect(source.readText(source.list()[0]!)).toBe('<dmodule id="1"/>');
      source.writeText(DESCRIPT, '<dmodule id="3"/>', { overwrite: true });
      expect(source.list()).toHaveLength(1);
      expect(source.readText(source.list()[0]!)).toBe('<dmodule id="3"/>');
    });
    it('CSDB の形でない名前は書けるが一覧には出ない', () => {
      const { source } = make();
      source.writeText('notes/README.md', 'memo');
      expect(source.list()).toHaveLength(0);
      expect(() => source.writeText('notes/README.md', 'again')).toThrow(CsdbWriteConflictError);
    });
  });
}

writableContract('MemoryCsdbSource', () => ({ source: new MemoryCsdbSource([], 'empty') }));

const tmpDirs: string[] = [];
writableContract('DirectoryCsdbSource（os.tmpdir の一時フォルダー）', () => {
  const dir = mkdtempSync(join(tmpdir(), 's1000d-core-write-'));
  tmpDirs.push(dir);
  return { source: new DirectoryCsdbSource([dir]), dir };
});
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('DirectoryCsdbSource の書き込み先', () => {
  it('最初のフォルダーに書き、親フォルダーを作り、前回の戻り値（絶対パス）で上書きできる', () => {
    const a = mkdtempSync(join(tmpdir(), 's1000d-core-write-a-'));
    const b = mkdtempSync(join(tmpdir(), 's1000d-core-write-b-'));
    tmpDirs.push(a, b);
    const source = new DirectoryCsdbSource([a, b]);
    const path = source.writeText(`sub/dir/${DESCRIPT}`, 'one');
    expect(path).toBe(join(a, 'sub', 'dir', DESCRIPT));
    expect(readFileSync(path, 'utf8')).toBe('one');
    expect(existsSync(join(b, 'sub'))).toBe(false);
    source.writeText(path, 'two', { overwrite: true });
    expect(readFileSync(path, 'utf8')).toBe('two');
    expect(() => source.writeText(path, 'three')).toThrow(CsdbWriteConflictError);
  });
  it('置き場所の外には書かない', () => {
    const a = mkdtempSync(join(tmpdir(), 's1000d-core-write-c-'));
    tmpDirs.push(a);
    const source = new DirectoryCsdbSource([a]);
    expect(() => source.writeText('../outside.xml', 'x')).toThrow(/outside/);
    expect(() => source.writeText(join(tmpdir(), 'abs.xml'), 'x')).toThrow(/outside/);
    expect(() => new DirectoryCsdbSource([]).writeText('a.xml', 'x')).toThrow(/no directory/);
  });
});

describe('fingerprintDirs', () => {
  it('ファイルの追加・大きさ・更新時刻の変化で変わり、対象外のファイルと順序では変わらない', () => {
    const a = mkdtempSync(join(tmpdir(), 's1000d-core-fp-a-'));
    const b = mkdtempSync(join(tmpdir(), 's1000d-core-fp-b-'));
    tmpDirs.push(a, b);
    const empty = fingerprintDirs([a, b]);
    expect(fingerprintDirs([b, a, a])).toBe(empty);
    expect(fingerprintDirs([join(a, 'missing')])).toBe(fingerprintDirs([]));

    const dm = join(a, 'sub', DESCRIPT);
    mkdirSync(join(a, 'sub'));
    writeFileSync(dm, 'one');
    const one = fingerprintDirs([a, b]);
    expect(one).not.toBe(empty);
    expect(fingerprintDirs([b, a])).toBe(one);

    // 大きさが変わる
    writeFileSync(dm, 'three');
    const sized = fingerprintDirs([a, b]);
    expect(sized).not.toBe(one);
    // 大きさが同じでも更新時刻が違えば変わる
    utimesSync(dm, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const timed = fingerprintDirs([a, b]);
    expect(timed).not.toBe(sized);
    // 2 つ目のフォルダーに増えても変わる
    writeFileSync(join(b, BREX), 'x');
    expect(fingerprintDirs([a, b])).not.toBe(timed);

    // CSDB の形でないファイル、node_modules、. で始まるフォルダーは索引と同じく見ない
    const before = fingerprintDirs([a, b]);
    writeFileSync(join(a, 'README.md'), 'x');
    mkdirSync(join(a, 'node_modules'));
    writeFileSync(join(a, 'node_modules', DESCRIPT.replace('_001', '_002')), 'x');
    mkdirSync(join(a, '.hidden'));
    writeFileSync(join(a, '.hidden', BREX.replace('_001', '_002')), 'x');
    expect(fingerprintDirs([a, b])).toBe(before);
    // 索引が見るものと同じ範囲
    expect(listCsdbObjects([a, b])).toHaveLength(2);
  });
});
