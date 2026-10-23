/**
 * 利用者が入手した S1000D の配布物に対するテスト。
 * 配布物は再配布できないため（DECISIONS D-03）、`S1000D_SPEC_TESTS=1` のときだけ動かす。
 * 場所は `S1000D_SPEC_DIR`（既定: ../../specs/s1000d/issue-7 — s1000d-stack の配置に合わせた相対パス）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDataModuleInfo } from './data-module.js';
import { parseDmcFileName } from './dmc.js';
import { parseIcnFileName } from './icn.js';
import { defaultXmlEngine } from './xml/index.js';

const enabled = process.env.S1000D_SPEC_TESTS === '1';
const specDir = resolve(process.env.S1000D_SPEC_DIR ?? '../../specs/s1000d/issue-7');

/**
 * 配布物の中の「CSDB の形で置かれたファイル」だけを集める。
 * データ辞書（data_dictionary_*）の samples/ にある `DMC-…_01-06.xml` のような名前は、
 * 発行情報ではなく例の通し番号が付いた説明用のファイルなので対象から外す。
 */
function findFiles(dir: string, pattern: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (/^data_dictionary/i.test(e.name)) continue;
      findFiles(p, pattern, out);
    } else if (pattern.test(e.name)) out.push(p);
  }
  return out;
}

describe.skipIf(!enabled || !existsSync(specDir))('S1000D 配布物（利用者が入手したもの）', () => {
  const dmFiles = findFiles(specDir, /^DMC-.*\.XML$/i);
  const icnFiles = findFiles(specDir, /^ICN-.*\.(CGM|PNG|JPG|SVG|GIF)$/i);
  const brexFile = findFiles(specDir, /^DMC-S1000D-.*-04-10-0301-00A-022A-D.*\.XML$/i)[0];

  it('データモジュールのファイル名をすべて分解できる', () => {
    expect(dmFiles.length).toBeGreaterThan(0);
    const failed = dmFiles.filter((f) => !parseDmcFileName(f).ok);
    expect(failed).toEqual([]);
  });

  it('ICN のファイル名をすべて分解できる', () => {
    expect(icnFiles.length).toBeGreaterThan(0);
    const failed = icnFiles.filter((f) => !parseIcnFileName(f).ok);
    expect(failed).toEqual([]);
  });

  it('すべてのデータモジュールの識別・状態部を読み、ファイル名の DMC と一致する', () => {
    const mismatched: string[] = [];
    for (const f of dmFiles) {
      const info = readDataModuleInfo(readFileSync(f, 'utf8'));
      const fromName = parseDmcFileName(f);
      if (!info.identAndStatus || !fromName.ok) {
        mismatched.push(f);
        continue;
      }
      const a = JSON.stringify(info.identAndStatus.dmCode);
      const b = JSON.stringify(fromName.value.dmCode);
      if (a !== b) mismatched.push(f);
      if (!info.identAndStatus.brexDmRef) mismatched.push(`${f} (no brexDmRef)`);
    }
    expect(mismatched).toEqual([]);
  });

  it('既定 BREX の objectPath をすべて構文解析できる', () => {
    expect(brexFile).toBeDefined();
    const { document } = defaultXmlEngine.parse(readFileSync(brexFile, 'utf8'));
    const paths = defaultXmlEngine
      .selectNodes('//objectPath', document)
      .map((n) => n.textContent?.trim() ?? '');
    expect(paths.length).toBeGreaterThan(200);
    const failed = paths.filter((p) => !defaultXmlEngine.validateExpression(p).ok);
    expect(failed).toEqual([]);
  });
});
