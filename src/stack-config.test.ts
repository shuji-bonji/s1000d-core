import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveStackConfig, specDirHowTo, stackConfigPath } from './stack-config.js';

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 's1000d-core-config-'));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const writeConfig = (path: string, body: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
};

describe('stackConfigPath', () => {
  it('既定は ~/.config/s1000d-stack/config.json。XDG_CONFIG_HOME と S1000D_CONFIG で変えられる', () => {
    expect(stackConfigPath({ env: {}, home })).toBe(
      join(home, '.config', 's1000d-stack', 'config.json'),
    );
    expect(stackConfigPath({ env: { XDG_CONFIG_HOME: '/xdg' }, home })).toBe(
      join('/xdg', 's1000d-stack', 'config.json'),
    );
    expect(stackConfigPath({ env: { S1000D_CONFIG: '~/my.json' }, home })).toBe(
      join(home, 'my.json'),
    );
  });
});

describe('resolveStackConfig', () => {
  it('環境変数も設定ファイルも無ければ何も決まらない', () => {
    const r = resolveStackConfig({ env: {}, home });
    expect(r).toMatchObject({ csdbDirs: [], configFound: false, warnings: [] });
    expect(r.specDir).toBeUndefined();
    expect(specDirHowTo(r)).toContain(join(home, '.config', 's1000d-stack', 'config.json'));
  });

  it('環境変数が無ければ設定ファイルを読む（~ と、設定ファイルからの相対パスを展開する）', () => {
    const path = join(home, 'a', 'config.json');
    writeConfig(
      path,
      JSON.stringify({ specDir: '~/specs/issue-7', csdbDirs: ['csdb', '/abs/csdb'] }),
    );
    const r = resolveStackConfig({ env: { S1000D_CONFIG: path }, home });
    expect(r).toMatchObject({
      specDir: join(home, 'specs', 'issue-7'),
      specDirSource: 'config',
      csdbDirs: [join(home, 'a', 'csdb'), '/abs/csdb'],
      csdbDirsSource: 'config',
      configFound: true,
    });
  });

  it('環境変数があれば設定ファイルより優先する。CSDB は区切り文字で複数', () => {
    const path = join(home, 'b', 'config.json');
    writeConfig(path, JSON.stringify({ specDir: '/from/file', csdbDirs: '/file/csdb' }));
    const r = resolveStackConfig({
      env: {
        S1000D_CONFIG: path,
        S1000D_SPEC_DIR: '/from/env',
        S1000D_CSDB_DIR: ['/x', '/y'].join(delimiter),
      },
      home,
    });
    expect(r).toMatchObject({
      specDir: '/from/env',
      specDirSource: 'env',
      csdbDirs: ['/x', '/y'],
      csdbDirsSource: 'env',
    });
  });

  it('ホストが置き換えなかった ${VAR} は使わず、設定ファイルに戻って注記する', () => {
    const path = join(home, 'c', 'config.json');
    writeConfig(path, JSON.stringify({ specDir: '/from/file' }));
    const r = resolveStackConfig({
      env: { S1000D_CONFIG: path, S1000D_SPEC_DIR: '${S1000D_SPEC_DIR}' },
      home,
    });
    expect(r.specDir).toBe('/from/file');
    expect(r.specDirSource).toBe('config');
    expect(r.warnings[0]).toContain('unexpanded');
  });

  it('読めない設定ファイルは理由を返し、例外を投げない', () => {
    const path = join(home, 'd', 'config.json');
    writeConfig(path, '{ not json');
    const r = resolveStackConfig({ env: { S1000D_CONFIG: path }, home });
    expect(r.configFound).toBe(true);
    expect(r.configError).toBeTruthy();
    expect(r.specDir).toBeUndefined();
    expect(specDirHowTo(r)).toContain('currently unreadable');
  });
});
