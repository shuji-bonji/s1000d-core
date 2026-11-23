import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORE_INFO } from './index.js';

describe('CORE_INFO', () => {
  it('package.json の name と version を返す', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { name: string; version: string };
    expect(CORE_INFO).toEqual({ name: '@shuji-bonji/s1000d-core', version: pkg.version });
    expect(CORE_INFO.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('書き換えられない', () => {
    expect(Object.isFrozen(CORE_INFO)).toBe(true);
  });
});
