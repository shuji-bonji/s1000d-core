/**
 * 利用者が入手した S1000D の配布物の場所（`specDir`）と、プロジェクトの CSDB の場所（`csdbDirs`）を決める。
 *
 * 読む順番: 環境変数（`S1000D_SPEC_DIR` / `S1000D_CSDB_DIR`）→ 設定ファイル。
 * 設定ファイルの既定の場所は `$XDG_CONFIG_HOME/s1000d-stack/config.json`（`XDG_CONFIG_HOME` が無ければ `~/.config`）。
 * `S1000D_CONFIG` で別の場所を指せる。
 *
 * 設定ファイルを足した理由: Claude Desktop などの MCP ホストは、設定に `env` が無いと子プロセスへ限られた環境変数
 * （HOME・PATH など）しか渡さず、plugin の `env` に書いた `${VAR}` も置き換えない。そのため plugin で入れたサーバーに
 * 配布物の場所を環境変数で渡せない。設定ファイルなら HOME さえ渡れば読める（DECISIONS D-23 の補足）。
 *
 * 配布物そのものはこのパッケージに含めない（D-03）。ここは場所を決めるだけ。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export const SPEC_DIR_ENV = 'S1000D_SPEC_DIR';
export const CSDB_DIR_ENV = 'S1000D_CSDB_DIR';
export const CONFIG_PATH_ENV = 'S1000D_CONFIG';

/** 設定ファイルの中身 */
export interface StackConfigFile {
  /** 配布物を展開したフォルダー */
  specDir?: string;
  /** プロジェクトの CSDB のフォルダー（1 つなら文字列でもよい） */
  csdbDirs?: string[] | string;
}

/** どこから決まったか */
export type StackConfigSource = 'env' | 'config';

export interface ResolvedStackConfig {
  specDir?: string;
  specDirSource?: StackConfigSource;
  csdbDirs: string[];
  csdbDirsSource?: StackConfigSource;
  /** 見に行った設定ファイルのパス */
  configPath: string;
  /** 設定ファイルがあったか */
  configFound: boolean;
  /** 設定ファイルを読めなかった理由（JSON の誤りなど） */
  configError?: string;
  /** 環境変数を使わなかった理由（`${VAR}` が置き換えられずに渡ってきた、など） */
  warnings: string[];
}

export interface ResolveStackConfigOptions {
  /** 既定は process.env */
  env?: NodeJS.ProcessEnv;
  /** 既定は os.homedir() */
  home?: string;
}

/** 設定ファイルの場所 */
export function stackConfigPath(options: ResolveStackConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const explicit = env[CONFIG_PATH_ENV]?.trim();
  if (explicit) return expandHome(explicit, home);
  const base = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return join(base, 's1000d-stack', 'config.json');
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}

/** ホストが置き換えなかった `${VAR}` / `$VAR` がそのまま渡ってきたか */
function isUnexpanded(v: string): boolean {
  return /^\$\{[^}]*\}$|^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim());
}

/** 環境変数を読む。空・未置換は undefined（未置換は warnings に書く） */
function readEnv(env: NodeJS.ProcessEnv, name: string, warnings: string[]): string | undefined {
  const v = env[name]?.trim();
  if (!v) return undefined;
  if (isUnexpanded(v)) {
    warnings.push(
      `${name} is the unexpanded text "${v}" (the host did not substitute it); it is ignored and the config file is used instead.`,
    );
    return undefined;
  }
  return v;
}

export function resolveStackConfig(options: ResolveStackConfigOptions = {}): ResolvedStackConfig {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const configPath = stackConfigPath({ env, home });
  const warnings: string[] = [];
  const out: ResolvedStackConfig = { csdbDirs: [], configPath, configFound: false, warnings };

  let file: StackConfigFile | undefined;
  try {
    const text = readFileSync(configPath, 'utf8');
    out.configFound = true;
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      file = parsed as StackConfigFile;
    else out.configError = 'the config file is not a JSON object';
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') out.configError = err.message;
  }
  // 設定ファイルの相対パスは、設定ファイルのあるフォルダーを基準にする
  const fromFile = (p: string) => {
    const x = expandHome(p.trim(), home);
    return isAbsolute(x) ? x : resolve(join(configPath, '..'), x);
  };

  const envSpec = readEnv(env, SPEC_DIR_ENV, warnings);
  if (envSpec) {
    out.specDir = envSpec;
    out.specDirSource = 'env';
  } else if (typeof file?.specDir === 'string' && file.specDir.trim() !== '') {
    out.specDir = fromFile(file.specDir);
    out.specDirSource = 'config';
  }

  const envCsdb = readEnv(env, CSDB_DIR_ENV, warnings);
  if (envCsdb) {
    out.csdbDirs = envCsdb
      .split(delimiter)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    out.csdbDirsSource = 'env';
  } else if (file?.csdbDirs !== undefined) {
    const list = Array.isArray(file.csdbDirs) ? file.csdbDirs : [file.csdbDirs];
    out.csdbDirs = list
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .map(fromFile);
    if (out.csdbDirs.length > 0) out.csdbDirsSource = 'config';
  }
  return out;
}

/** 配布物の場所が決まらないときに、利用者へ示す設定の方法（MCP の応答の注記に使う） */
export function specDirHowTo(resolved: ResolvedStackConfig): string {
  return `Set ${SPEC_DIR_ENV} to the folder where the S1000D distribution is extracted, or write {"specDir": "/absolute/path"} to ${resolved.configPath}${resolved.configError ? ` (currently unreadable: ${resolved.configError})` : ''}.`;
}
