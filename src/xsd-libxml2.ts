/**
 * `SchemaValidator` の `libxml2-wasm` 実装（D-15、D-17）。
 *
 * サブパス `@shuji-bonji/s1000d-core/xsd-libxml2` から読み込む。`libxml2-wasm` は任意の peerDependency なので、
 * XSD 検証を使わないパッケージ（s1000d-brex-mcp）はこのサブパスを読まなければ `libxml2-wasm` を入れなくてよい。
 *
 * 実装上の注意（U-08 の比較結果）:
 * - S1000D の XSD は `xml.xsd` / `xlink.xsd` / `rdf.xsd` を `xs:import` する。libxml2 がこれを探せるように、
 *   XSD と同じフォルダーの全 `.xsd` を `XmlBufferInputProvider` に登録する（`xmlRegisterInputProvider` は `@alpha`）。
 * - `XsdValidator` は XSD ごとに 1 つ作って使い回す（106 件で 0.27 秒）。`XmlDocument` は検証のたびに `dispose()` する。
 * - DOCTYPE の内部サブセット（ENTITY / NOTATION 宣言）は libxml2 がそのまま読む。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import {
  XmlBufferInputProvider,
  XmlDocument,
  XmlParseError,
  XmlValidateError,
  XsdValidator,
  xmlRegisterInputProvider,
  type ErrorDetail,
} from 'libxml2-wasm';
import {
  SchemaLoadError,
  type LoadedSchema,
  type SchemaValidationError,
  type SchemaValidationResult,
  type SchemaValidator,
} from './xml/schema-validator.js';

function libVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('libxml2-wasm/package.json') as { version?: string };
    return pkg.version ? `libxml2-wasm ${pkg.version}` : 'libxml2-wasm';
  } catch {
    return 'libxml2-wasm';
  }
}

function toError(d: ErrorDetail): SchemaValidationError {
  return { message: d.message, line: d.line, column: d.col, level: d.level, xpath: d.xpath };
}

/** 入力プロバイダーは libxml2 全体で 1 つ。読み込んだ XSD のフォルダーの `.xsd` をすべてここに足す */
let provider: XmlBufferInputProvider | undefined;
const registeredDirs = new Set<string>();

function registerSchemaDir(dir: string): void {
  const abs = resolve(dir);
  if (registeredDirs.has(abs)) return;
  if (!provider) {
    provider = new XmlBufferInputProvider({});
    xmlRegisterInputProvider(provider);
  }
  for (const name of readdirSync(abs)) {
    if (!/\.xsd$/i.test(name)) continue;
    // import は `xml.xsd` のようにファイル名だけで書かれているので、ファイル名で登録する
    provider.addBuffer(name, readFileSync(join(abs, name)));
  }
  registeredDirs.add(abs);
}

class Libxml2LoadedSchema implements LoadedSchema {
  constructor(
    public readonly xsdPath: string,
    private validator: XsdValidator | undefined,
    /** XsdValidator が参照し続ける可能性があるので、検証器と同時に破棄する */
    private xsdDoc: XmlDocument | undefined,
    private readonly validatorName: string,
  ) {}

  validate(xml: string, options: { url?: string } = {}): SchemaValidationResult {
    if (!this.validator) throw new Error(`Schema ${this.xsdPath} has been disposed`);
    let doc: XmlDocument | undefined;
    try {
      try {
        doc = XmlDocument.fromString(xml, { url: options.url ?? basename(this.xsdPath) });
      } catch (e) {
        if (e instanceof XmlParseError) {
          return {
            valid: false,
            wellFormed: false,
            errors: e.details.map(toError),
            validator: this.validatorName,
          };
        }
        throw e;
      }
      try {
        this.validator.validate(doc);
        return { valid: true, wellFormed: true, errors: [], validator: this.validatorName };
      } catch (e) {
        if (e instanceof XmlValidateError) {
          return {
            valid: false,
            wellFormed: true,
            errors: e.details.map(toError),
            validator: this.validatorName,
          };
        }
        throw e;
      }
    } finally {
      doc?.dispose();
    }
  }

  dispose(): void {
    this.validator?.dispose();
    this.validator = undefined;
    this.xsdDoc?.dispose();
    this.xsdDoc = undefined;
  }
}

export class Libxml2SchemaValidator implements SchemaValidator {
  readonly name = libVersion();
  private readonly loaded = new Map<string, Libxml2LoadedSchema>();

  async load(xsdPath: string): Promise<LoadedSchema> {
    const abs = resolve(xsdPath);
    const cached = this.loaded.get(abs);
    if (cached) return cached;
    registerSchemaDir(dirname(abs));
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (e) {
      throw new SchemaLoadError(`Cannot read XSD ${abs}: ${String(e)}`, abs);
    }
    let xsdDoc: XmlDocument | undefined;
    try {
      xsdDoc = XmlDocument.fromString(text, { url: basename(abs) });
      const validator = XsdValidator.fromDoc(xsdDoc);
      const schema = new Libxml2LoadedSchema(abs, validator, xsdDoc, this.name);
      this.loaded.set(abs, schema);
      return schema;
    } catch (e) {
      xsdDoc?.dispose();
      const details =
        e instanceof XmlParseError || e instanceof XmlValidateError ? e.details.map(toError) : [];
      const msg = e instanceof Error ? e.message : String(e);
      throw new SchemaLoadError(`Cannot compile XSD ${abs}: ${msg}`, abs, details);
    }
  }

  dispose(): void {
    for (const s of this.loaded.values()) s.dispose();
    this.loaded.clear();
  }
}

export { SchemaLoadError } from './xml/schema-validator.js';
export type {
  LoadedSchema,
  SchemaValidationError,
  SchemaValidationResult,
  SchemaValidator,
} from './xml/schema-validator.js';
