/**
 * XML スキーマ（XSD）による検証を 1 つのインターフェースに閉じ込める（DECISIONS D-15、D-17）。
 *
 * 実装は `@shuji-bonji/s1000d-core/xsd-libxml2`（`libxml2-wasm`）。core の本体はこのインターフェースと型だけを持ち、
 * `libxml2-wasm` には依存しない。`xs:import` の解決に使う API が `@alpha` 表記のため、実装を差し替えられるようにしている。
 *
 * 使い方: CSDB 単位で XSD ごとに 1 つ `load()` して使い回し、最後に `dispose()` する。
 */

export interface SchemaValidationError {
  /** libxml2 などの検証器が出した文章。翻訳しない */
  message: string;
  line?: number;
  column?: number;
  /** 検証器の重大度（libxml2 では 1 = warning、2 = error、3 = fatal） */
  level?: number;
  /** 違反した節点への XPath（得られたとき） */
  xpath?: string;
}

export interface SchemaValidationResult {
  valid: boolean;
  /** 整形式でないなど、検証に入る前に読めなかったとき false */
  wellFormed: boolean;
  errors: SchemaValidationError[];
  /** 実装名と版（例: "libxml2-wasm 0.7.2"） */
  validator: string;
}

/** 読み込んで使い回せる 1 つの XSD */
export interface LoadedSchema {
  xsdPath: string;
  /** `url` は文書の名前（エラーの file に使われる）。省略可 */
  validate(xml: string, options?: { url?: string }): SchemaValidationResult;
  dispose(): void;
}

export interface SchemaValidator {
  /** 実装名と版 */
  readonly name: string;
  /** XSD を読み込む。同じパスは 2 度コンパイルせずに返す。読めなければ SchemaLoadError を投げる */
  load(xsdPath: string): Promise<LoadedSchema>;
  /** 読み込んだすべての XSD を破棄する（サーバーの終了時） */
  dispose(): void;
}

export class SchemaLoadError extends Error {
  constructor(
    message: string,
    public readonly xsdPath: string,
    public readonly details: SchemaValidationError[] = [],
  ) {
    super(message);
    this.name = 'SchemaLoadError';
  }
}
