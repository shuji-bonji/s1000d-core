import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Libxml2SchemaValidator } from '../xsd-libxml2.js';
import { readBrex } from '../brex/read.js';
import { formatDmc } from '../dmc.js';
import type { DmRef } from '../types.js';
import { findSchemaDirs, locateXsd, readIssueFromXsd } from './schemas.js';
import { formatLocalIso, verifyDataModule } from './verify.js';

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), 'utf8');

/**
 * 自作の最小スキーマ。S1000D の XSD の内容は含まない。
 * `xs:import` の解決を確かめるため、`common.xsd` を import して `title` の型をそこから取る。
 */
const COMMON_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test:common" xmlns="urn:test:common" elementFormDefault="qualified">
  <xs:simpleType name="shortText"><xs:restriction base="xs:string"><xs:maxLength value="20"/></xs:restriction></xs:simpleType>
</xs:schema>`;

const BREX_XSD_STUB = (issue: string) => `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:annotation id="version"><xs:documentation>Issue number: ${issue}</xs:documentation></xs:annotation>
  <xs:element name="dmodule"/>
</xs:schema>`;

const NOTE_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:c="urn:test:common">
  <xs:import namespace="urn:test:common" schemaLocation="common.xsd"/>
  <xs:element name="note">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="title" type="c:shortText"/>
        <xs:element name="year" type="xs:gYear"/>
      </xs:sequence>
      <xs:attribute name="id" type="xs:ID" use="required"/>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const noteXml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<note xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://example.test/S1000D_7/xml_schema_flat/note.xsd" id="n1">
${body}
</note>`;

let root: string;
let flat7: string;
let flat42: string;
const validator = new Libxml2SchemaValidator();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 's1000d-core-verify-'));
  flat7 = join(root, 'Issue 7 Package', 'xml_schema_flat');
  flat42 = join(root, 'other', 'deeper', 'xml_schema_flat');
  mkdirSync(flat7, { recursive: true });
  mkdirSync(flat42, { recursive: true });
  for (const d of [flat7, flat42]) {
    writeFileSync(join(d, 'common.xsd'), COMMON_XSD);
    writeFileSync(join(d, 'note.xsd'), NOTE_XSD);
  }
  writeFileSync(join(flat7, 'brex.xsd'), BREX_XSD_STUB('7'));
  writeFileSync(join(flat42, 'brex.xsd'), BREX_XSD_STUB('4.2'));
  mkdirSync(join(root, 'node_modules', 'xml_schema_flat'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'xml_schema_flat', 'brex.xsd'), BREX_XSD_STUB('9'));
});

afterAll(() => {
  validator.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe('findSchemaDirs / readIssueFromXsd / locateXsd', () => {
  it('brex.xsd を含む xml_schema_flat/ を再帰的に探し、版を brex.xsd から読む（node_modules は見ない）', () => {
    const dirs = findSchemaDirs([root]);
    expect(dirs.map((d) => d.issue).sort()).toEqual(['4.2', '7']);
    expect(dirs.find((d) => d.issue === '7')?.schemaNames).toEqual(['brex', 'common', 'note']);
    expect(readIssueFromXsd(join(flat42, 'brex.xsd'))).toBe('4.2');
  });
  it('候補が複数なら schemaLocation の版に合うものを選ぶ', () => {
    const dirs = findSchemaDirs([root]);
    const r = locateXsd('http://x/S1000D_4-2/xml_schema_flat/note.xsd', dirs);
    expect(r.ok && r.xsdPath).toBe(join(flat42, 'note.xsd'));
    const miss = locateXsd('http://x/S1000D_5-0/xml_schema_flat/note.xsd', dirs);
    expect(!miss.ok && miss.reason).toBe('issue-mismatch');
  });
  it('候補が 1 つなら版が合わなくてもそれを使う。XSD や schemaLocation が無ければ理由を返す', () => {
    const only7 = findSchemaDirs([join(root, 'Issue 7 Package')]);
    expect(locateXsd('http://x/S1000D_4-2/xml_schema_flat/note.xsd', only7).ok).toBe(true);
    const noXsd = locateXsd('http://x/S1000D_7/xml_schema_flat/proced.xsd', only7);
    expect(!noXsd.ok && noXsd.reason).toBe('xsd-not-found');
    const noLoc = locateXsd(undefined, only7);
    expect(!noLoc.ok && noLoc.reason).toBe('no-schema-location');
    const noDir = locateXsd('http://x/S1000D_7/xml_schema_flat/note.xsd', []);
    expect(!noDir.ok && noDir.reason).toBe('no-schema-dir');
  });
});

describe('Libxml2SchemaValidator', () => {
  it('xs:import を解決して検証でき、違反には行番号が付く', async () => {
    const schema = await validator.load(join(flat7, 'note.xsd'));
    const ok = schema.validate(noteXml('  <title>Hello</title>\n  <year>2026</year>'));
    expect(ok.valid).toBe(true);
    expect(ok.validator).toMatch(/^libxml2-wasm/);

    const bad = schema.validate(noteXml('  <title>Hello</title>\n  <year>abcd</year>\n  <extra/>'));
    expect(bad.valid).toBe(false);
    expect(bad.wellFormed).toBe(true);
    expect(bad.errors.map((e) => e.line)).toContain(4);
    expect(bad.errors.some((e) => /abcd|gYear/.test(e.message))).toBe(true);
  });
  it('整形式でない文書は wellFormed: false', async () => {
    const schema = await validator.load(join(flat7, 'note.xsd'));
    const r = schema.validate('<note><title>x</title>');
    expect(r.valid).toBe(false);
    expect(r.wellFormed).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
  it('同じ XSD は 2 度コンパイルしない', async () => {
    const a = await validator.load(join(flat7, 'note.xsd'));
    const b = await validator.load(join(flat7, 'note.xsd'));
    expect(a).toBe(b);
  });
  it('読めない XSD は SchemaLoadError', async () => {
    await expect(validator.load(join(flat7, 'missing.xsd'))).rejects.toThrow(/Cannot read XSD/);
  });
});

describe('verifyDataModule', () => {
  const projectBrex = readBrex(fx('kenbaiki-brex.xml'));
  const baseBrex = readBrex(fx('kenbaiki-base-brex.xml'));
  if (!projectBrex.ok || !baseBrex.ok) throw new Error('fixture BREX failed to parse');
  const resolver = (ref: DmRef) => {
    const dmc = formatDmc(ref.dmCode);
    if (dmc === 'KENBAIKI-A-00-00-00-00A-022A-D') return projectBrex.value;
    if (dmc === 'KBWORKS-A-00-00-00-00A-022A-D') return baseBrex.value;
    return undefined;
  };
  const fixedNow = () => new Date(2026, 9, 24, 23, 50, 0);

  it('XSD が無いと schema-not-found、BREX は照合できる', async () => {
    const r = await verifyDataModule(fx('kenbaiki-descript.xml'), {
      schema: { validator, schemaDirs: [] },
      brex: { resolver },
      now: fixedNow,
    });
    expect(r.status.wellFormed).toBe(true);
    expect(r.status.target.schemaName).toBe('descript');
    expect(r.status.target.issue).toBe('7');
    expect(r.status.schema.state).toBe('schema-not-found');
    expect(r.status.schema.reason).toMatch(/^no-schema-dir/);
    // 自作の説明 DM は、テスト用に自作 BREX への違反を意図的に含む（brex.test.ts と同じデータ）
    expect(r.status.brex.state).toBe('violations');
    expect(r.status.brex.layers).toBe(2);
    expect(r.status.brex.violationCount).toBeGreaterThan(0);
    expect(r.status.brex.unresolved).toEqual([]);
    expect(r.brex?.layers.length).toBe(2);
    expect(r.status.references.state).toBe('not-run');
    expect(r.status.checkedAt).toBe(formatLocalIso(fixedNow()));
  });
  it('省略した工程は not-run', async () => {
    const r = await verifyDataModule(fx('kenbaiki-descript.xml'), { now: fixedNow });
    expect(r.status.schema.state).toBe('not-run');
    expect(r.status.brex.state).toBe('not-run');
    expect(r.brex).toBeUndefined();
  });
  it('XSD の違反は invalid と errorCount、整形式でなければ wellFormed: false', async () => {
    const dirs = findSchemaDirs([join(root, 'Issue 7 Package')]);
    const bad = await verifyDataModule(noteXml('  <title>x</title>\n  <year>abcd</year>'), {
      schema: { validator, schemaDirs: dirs },
    });
    expect(bad.status.schema.state).toBe('invalid');
    expect(bad.status.schema.errorCount).toBe(1);
    expect(bad.status.schema.issue).toBe('7');
    expect(bad.schema.errors[0].line).toBe(4);

    const good = await verifyDataModule(noteXml('  <title>x</title>\n  <year>2026</year>'), {
      schema: { validator, schemaDirs: dirs },
    });
    expect(good.status.schema.state).toBe('valid');

    const broken = await verifyDataModule('<note><title>', {
      schema: { validator, schemaDirs: dirs },
    });
    expect(broken.status.wellFormed).toBe(false);
    expect(broken.status.schema.state).toBe('not-run');
    expect(broken.status.schema.reason).toMatch(/not well-formed/);
  });
});
