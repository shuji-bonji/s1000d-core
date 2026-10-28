import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as F from '../__fixtures__/kenbaiki-drafts.js';
import { DRAFT_KINDS, DRAFT_NODE_KINDS, DRAFT_REF_KINDS, DRAFT_REQUIRED } from './types.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const schema = JSON.parse(read('../../schema/draft.schema.json')) as {
  $schema: string;
  $ref: string;
  $defs: Record<string, Schema>;
};

interface Schema {
  $ref?: string;
  type?: string;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  items?: Schema;
  anyOf?: Schema[];
}

/** 使っている範囲だけの JSON Schema 検証（外部の検証器を依存に足さないため）。違反の一覧を返す */
function validate(value: unknown, s: Schema, path = '$'): string[] {
  if (s.$ref) {
    const def = schema.$defs[s.$ref.replace('#/$defs/', '')];
    if (!def) return [`${path}: unknown $ref ${s.$ref}`];
    return validate(value, def, path);
  }
  const errors: string[] = [];
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: not in enum`);
  if (s.anyOf && !s.anyOf.some((b) => validate(value, b, path).length === 0)) {
    errors.push(`${path}: matches none of anyOf`);
  }
  switch (s.type) {
    case 'string':
      if (typeof value !== 'string') return [`${path}: not a string`];
      if (s.pattern && !new RegExp(s.pattern).test(value))
        errors.push(`${path}: pattern ${s.pattern}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return [`${path}: not a boolean`];
      break;
    case 'integer':
      if (!Number.isInteger(value)) return [`${path}: not an integer`];
      if (s.minimum !== undefined && (value as number) < s.minimum)
        errors.push(`${path}: below minimum`);
      break;
    case 'array':
      if (!Array.isArray(value)) return [`${path}: not an array`];
      if (s.items) value.forEach((v, i) => errors.push(...validate(v, s.items!, `${path}[${i}]`)));
      break;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return [`${path}: not an object`];
      const obj = value as Record<string, unknown>;
      for (const r of s.required ?? [])
        if (obj[r] === undefined) errors.push(`${path}: missing ${r}`);
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        const prop = s.properties?.[k];
        if (prop) errors.push(...validate(v, prop, `${path}.${k}`));
        else if (s.additionalProperties === false) errors.push(`${path}: unexpected property ${k}`);
        else if (typeof s.additionalProperties === 'object') {
          errors.push(...validate(v, s.additionalProperties, `${path}.${k}`));
        }
      }
      break;
    }
  }
  // type を持たず required だけの枝（anyOf の識別情報の検査）
  if (!s.type && s.required && typeof value === 'object' && value !== null) {
    for (const r of s.required) {
      if ((value as Record<string, unknown>)[r] === undefined) errors.push(`${path}: missing ${r}`);
    }
  }
  return errors;
}

const check = (name: string, value: unknown) => validate(value, schema.$defs[name]);

describe('schema/draft.schema.json', () => {
  it('JSON Schema draft 2020-12 で、ルートは DraftDataModule を指す', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$ref).toBe('#/$defs/DraftDataModule');
  });

  it('型の required と Schema の required が一致する', () => {
    for (const [name, required] of Object.entries(DRAFT_REQUIRED)) {
      const def = schema.$defs[name];
      expect(def, name).toBeDefined();
      expect([...(def.required ?? [])].sort(), name).toEqual([...required].sort());
    }
  });

  it('kind の列挙が型の列挙と一致する', () => {
    const enumOf = (def: string, prop: string) => schema.$defs[def].properties![prop].enum;
    expect(enumOf('DraftDataModule', 'kind')).toEqual([...DRAFT_KINDS]);
    expect(enumOf('DraftNode', 'kind')).toEqual([...DRAFT_NODE_KINDS]);
    expect(enumOf('DraftRef', 'kind')).toEqual([...DRAFT_REF_KINDS]);
    expect(
      Object.keys(schema.$defs.Allocation.properties!.rules.properties!.infoCodeByKind.properties!),
    ).toEqual([...DRAFT_KINDS]);
  });

  it('DMC の必須項目は readDmCodeElement と同じ 11 個（学習コードは任意）', () => {
    expect(schema.$defs.DmCode.required).toHaveLength(11);
    expect(schema.$defs.DmCode.required).not.toContain('learnCode');
    expect(Object.keys(schema.$defs.DmCode.properties!)).toContain('learnEventCode');
    expect(schema.$defs.DmCodePartial.required).toBeUndefined();
  });

  it('自作の入力データ（券売機）と採番の規則は Schema に合う', () => {
    expect(check('Allocation', F.kenbaikiAllocation())).toEqual([]);
    for (const draft of [
      F.descriptDraft(),
      F.descriptListsDraft(),
      F.procedDraft(),
      F.processDraft(),
      F.faultDraft(),
      F.pmDraft(),
    ]) {
      expect(check('DraftDataModule', draft)).toEqual([]);
    }
  });

  it('JSON を通しても（MCP の入力と同じ形）合う。台帳つきの Allocation も合う', () => {
    const allocation = {
      ...F.kenbaikiAllocation(),
      ledger: { a: 'KENBAIKI-A-10-20-00-00A-040A-D' },
      map: { a: { infoCode: '041' } },
    };
    expect(check('Allocation', JSON.parse(JSON.stringify(allocation)))).toEqual([]);
    expect(check('DraftDataModule', JSON.parse(JSON.stringify(F.processDraft())))).toEqual([]);
  });

  it('必須の欠落、知らないプロパティ、列挙外の値、識別情報の欠落を弾く', () => {
    const base = F.descriptDraft();
    const noSecurity: Record<string, unknown> = { ...base };
    delete noSecurity.securityClassification;
    expect(check('DraftDataModule', noSecurity).join()).toMatch(/missing securityClassification/);
    expect(check('DraftDataModule', { ...base, xml: '<dmodule/>' }).join()).toMatch(
      /unexpected property xml/,
    );
    expect(check('DraftDataModule', { ...base, kind: 'brex' }).join()).toMatch(/not in enum/);
    expect(check('DraftDataModule', { ...base, sourceId: undefined }).join()).toMatch(/anyOf/);
    expect(check('DraftNode', { kind: 'para', location: {} }).join()).toMatch(
      /unexpected property location/,
    );
    expect(check('DraftNode', { kind: 'unknown' }).join()).toMatch(/not in enum/);
    expect(check('DraftNode', { kind: 'admonition', level: 'danger' }).join()).toMatch(
      /not in enum/,
    );
    expect(check('DraftRef', { kind: 'dmRef' }).join()).toMatch(/missing target/);
    expect(
      check('Allocation', { ...F.kenbaikiAllocation(), icn: { cageCode: 'K0001' } }).join(),
    ).toMatch(/missing next/);
    expect(check('DmCode', { modelIdentCode: 'x' }).join()).toMatch(/missing/);
  });

  it('package.json の files に schema/ が入っている', () => {
    const pkg = JSON.parse(read('../../package.json')) as {
      files: string[];
      exports: Record<string, unknown>;
    };
    expect(pkg.files).toContain('schema');
    // MCP から `@shuji-bonji/s1000d-core/schema/draft.schema.json` で読めるようにする
    expect(pkg.exports['./schema/draft.schema.json']).toBe('./schema/draft.schema.json');
  });
});
