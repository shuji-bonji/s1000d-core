/**
 * BREX の所在を解決する。
 *
 * 利用者（MCP のツール引数）は BREX を次のどれかで指定する。
 * - ファイルのパス（`.xml`）
 * - DMC（`DMC-` 付きでも無しでも）。渡されたフォルダー群から探す
 * - 省略。配布物の既定 BREX（`DMC-S1000D-*-04-10-0301-00A-022A-D`）をフォルダー群から探す
 *
 * s1000d-brex-mcp と s1000d-verify-mcp が同じ探索をするために core に置く（ROADMAP 段階 2 の作業 1）。
 * 環境変数（`S1000D_SPEC_DIR` など）の解釈は MCP 側の責務で、ここはフォルダーの配列だけを受け取る。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createDirectoryBrexResolver, listDataModules } from '../csdb.js';
import { isBrexDmc, parseDmc, sameDmc } from '../dmc.js';
import type { DmCode } from '../types.js';
import type { XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import { readBrex } from './read.js';
import type { BrexDocument } from './types.js';

/**
 * 既定 BREX の DMC か。
 * 仕様書は `S1000D-Y-04-10-0301-00A-022A-D` と定める（Chap 4.10.3）。システム差異コード（Y）は版ごとに変わり、
 * 仕様書本文・配布ファイル・データ辞書の見本で食い違うため、この桁は見ない。
 */
export function isDefaultBrexDmc(dmc: DmCode): boolean {
  return (
    dmc.modelIdentCode === 'S1000D' &&
    dmc.systemCode === '04' &&
    dmc.subSystemCode === '1' &&
    dmc.subSubSystemCode === '0' &&
    dmc.assyCode === '0301' &&
    dmc.disassyCode === '00' &&
    dmc.disassyCodeVariant === 'A' &&
    isBrexDmc(dmc) &&
    dmc.infoCodeVariant === 'A' &&
    dmc.itemLocationCode === 'D'
  );
}

export interface FoundBrex {
  path: string;
  brex: BrexDocument;
}

/**
 * フォルダー群の中から既定 BREX を探す。無ければ undefined。
 *
 * 配布物のデータ辞書には、ファイル名と中身の DMC が一致しない見本がある。
 * 中身の DMC がファイル名と一致し、かつ自分自身を参照しているもの（既定 BREX の性質。Chap 4.10.3）を優先し、
 * 無ければ最初に読めたものを返す。
 */
export function findDefaultBrex(
  dirs: string[],
  engine: XmlEngine = defaultXmlEngine,
): FoundBrex | undefined {
  const entries = listDataModules(dirs).filter(
    (e) => isDefaultBrexDmc(e.name.dmCode) && e.name.issueInfo !== undefined,
  );
  let fallback: FoundBrex | undefined;
  for (const e of entries) {
    let r;
    try {
      r = readBrex(readFileSync(e.path, 'utf8'), engine);
    } catch {
      continue;
    }
    if (!r.ok) continue;
    const consistent = sameDmc(r.value.dmCode, e.name.dmCode);
    const selfRef =
      r.value.brexDmRef !== undefined && sameDmc(r.value.brexDmRef.dmCode, r.value.dmCode);
    if (consistent && selfRef) return { path: e.path, brex: r.value };
    fallback ??= { path: e.path, brex: r.value };
  }
  return fallback;
}

export interface LocatedBrex {
  brex: BrexDocument;
  /** どう見つけたか: ファイルのパス / DMC で探索 / 既定 BREX */
  source: 'file' | 'dmc' | 'default';
  path?: string;
}

export type BrexLocateReason =
  /** 指定が無く、既定 BREX もフォルダー群に無い */
  | 'default-not-found'
  /** パスのファイルが無い */
  | 'file-not-found'
  /** 読めたが BREX データモジュールではない */
  | 'not-brex'
  /** パスでも DMC でもない */
  | 'invalid-spec'
  /** DMC に一致する BREX がフォルダー群に無い */
  | 'dmc-not-found';

export class BrexLocateError extends Error {
  constructor(
    public readonly reason: BrexLocateReason,
    message: string,
    /** 探したフォルダー */
    public readonly searched: string[],
  ) {
    super(message);
    this.name = 'BrexLocateError';
  }
}

export interface LocateBrexOptions {
  /** 探すフォルダー（優先順）。既定 BREX もここから探す */
  dirs: string[];
  engine?: XmlEngine;
}

/**
 * 指定（パス・DMC・省略）から BREX を 1 つ決める。見つからなければ BrexLocateError を投げる。
 * 呼び出し側（MCP）は `reason` を見て、環境変数の設定方法などの案内を付け足す。
 */
export async function locateBrex(
  spec: string | undefined,
  options: LocateBrexOptions,
): Promise<LocatedBrex> {
  const engine = options.engine ?? defaultXmlEngine;
  const dirs = options.dirs.filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });

  if (spec === undefined || spec.trim() === '') {
    const d = findDefaultBrex(dirs, engine);
    if (!d) {
      throw new BrexLocateError(
        'default-not-found',
        `No BREX specified and no S1000D default BREX (DMC-S1000D-*-04-10-0301-00A-022A-D) found in: ${dirs.join(', ') || '(no folders)'}`,
        dirs,
      );
    }
    return { brex: d.brex, source: 'default', path: d.path };
  }

  const trimmed = spec.trim();
  if (/\.xml$/i.test(trimmed) || existsSync(trimmed)) {
    if (!existsSync(trimmed)) {
      throw new BrexLocateError('file-not-found', `BREX file not found: ${trimmed}`, dirs);
    }
    const r = readBrex(readFileSync(trimmed, 'utf8'), engine);
    if (!r.ok) {
      throw new BrexLocateError(
        'not-brex',
        `Not a BREX data module (${trimmed}): ${r.error}`,
        dirs,
      );
    }
    return { brex: r.value, source: 'file', path: trimmed };
  }

  const dmc = parseDmc(trimmed);
  if (!dmc.ok) {
    throw new BrexLocateError(
      'invalid-spec',
      `BREX must be given as a file path or a DMC: ${dmc.error}`,
      dirs,
    );
  }
  const brex = await createDirectoryBrexResolver(dirs, engine)({ dmCode: dmc.value });
  if (!brex) {
    throw new BrexLocateError(
      'dmc-not-found',
      `BREX ${trimmed} was not found in: ${dirs.join(', ') || '(no folders)'}`,
      dirs,
    );
  }
  return { brex, source: 'dmc' };
}
