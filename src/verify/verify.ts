/**
 * データモジュール 1 件の検証をまとめて行い、`VerificationStatus` と各工程の詳細を返す。
 *
 * 工程: 1. 整形式と識別・状態部 → 2. XSD（SchemaValidator）→ 3. BREX（checkAgainstBrexChain）→ 4. 参照（段階 2 の作業 3 で実装）。
 * XSD に違反があっても BREX の照合は続ける（XSD の誤りが BREX の違反を生むことがあるので、呼び出し側が注記する）。
 */
import { formatDmc } from '../dmc.js';
import { readDataModuleInfo } from '../data-module.js';
import type { DataModuleInfo } from '../types.js';
import { XmlParseError, type XmlEngine } from '../xml/engine.js';
import { defaultXmlEngine } from '../xml/xmldom-fontoxpath.js';
import {
  SchemaLoadError,
  type SchemaValidationError,
  type SchemaValidator,
} from '../xml/schema-validator.js';
import { checkAgainstBrexChain, type BrexResolver } from '../brex/chain.js';
import type { BrexCheckReport, BrexDocument } from '../brex/types.js';
import { findSchemaDirs, locateXsd, type LocateXsdResult, type SchemaDir } from './schemas.js';
import type { VerificationStatus } from './types.js';

export interface VerifySchemaOptions {
  validator: SchemaValidator;
  /** `xml_schema_flat/` の一覧（findSchemaDirs の結果）か、探す元のフォルダー群 */
  schemaDirs: SchemaDir[] | string[];
  /** 版を明示するとき（schemaLocation からの推定より優先） */
  issue?: string;
}

export interface VerifyBrexOptions {
  resolver: BrexResolver;
  extraLayers?: BrexDocument[];
}

export interface VerifyOptions {
  /** 報告用のパス */
  path?: string;
  /** 省略か false で XSD 検証を省く（state: not-run） */
  schema?: VerifySchemaOptions | false;
  /** 省略か false で BREX の照合を省く（state: not-run） */
  brex?: VerifyBrexOptions | false;
  engine?: XmlEngine;
  /** テスト用。省略時は現在時刻 */
  now?: () => Date;
}

export interface SchemaDetail {
  xsdPath?: string;
  validator?: string;
  errors: SchemaValidationError[];
  /** XSD を決められなかったときの詳細 */
  locate?: LocateXsdResult;
}

export interface VerifyResult {
  status: VerificationStatus;
  info?: DataModuleInfo;
  schema: SchemaDetail;
  brex?: BrexCheckReport;
}

function isSchemaDirArray(v: SchemaDir[] | string[]): v is SchemaDir[] {
  return v.length === 0 || typeof v[0] !== 'string';
}

/** 実行環境のオフセット付き ISO 8601（秒まで） */
export function formatLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export async function verifyDataModule(
  xml: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const engine = options.engine ?? defaultXmlEngine;
  const now = options.now ?? (() => new Date());

  const status: VerificationStatus = {
    target: { path: options.path },
    wellFormed: true,
    schema: { state: 'not-run' },
    brex: {
      state: 'not-run',
      layers: 0,
      violationCount: 0,
      unresolved: [],
      manualChecks: 0,
      skippedRules: 0,
    },
    references: { state: 'not-run', checked: 0, unresolvedCount: 0, reason: 'not implemented yet' },
    checkedAt: formatLocalIso(now()),
  };
  const schema: SchemaDetail = { errors: [] };

  // 1. 整形式と識別・状態部
  let info: DataModuleInfo | undefined;
  try {
    info = readDataModuleInfo(xml, engine);
  } catch (e) {
    status.wellFormed = false;
    const msg =
      e instanceof XmlParseError
        ? e.issues.map((i) => i.message).join('; ') || e.message
        : String(e);
    status.schema = { state: 'not-run', reason: `not well-formed: ${msg}` };
    status.brex.reason = 'not well-formed';
    return { status, schema };
  }
  status.target = {
    path: options.path,
    dmCode: info.identAndStatus?.dmCode,
    issueInfo: info.identAndStatus?.issueInfo,
    schemaName: info.schemaName,
    issue: info.issue,
  };

  // 2. XSD
  if (options.schema) {
    const dirs = isSchemaDirArray(options.schema.schemaDirs)
      ? options.schema.schemaDirs
      : findSchemaDirs(options.schema.schemaDirs);
    const located = locateXsd(info.schemaLocation, dirs, { issue: options.schema.issue });
    schema.locate = located;
    if (!located.ok) {
      status.schema = {
        state: 'schema-not-found',
        reason: `${located.reason}: ${located.message}`,
      };
    } else {
      try {
        const loaded = await options.schema.validator.load(located.xsdPath);
        const r = loaded.validate(xml, { url: options.path });
        schema.xsdPath = located.xsdPath;
        schema.validator = r.validator;
        schema.errors = r.errors;
        if (!r.wellFormed) status.wellFormed = false;
        status.schema = {
          state: r.valid ? 'valid' : 'invalid',
          issue: located.issue,
          xsdPath: located.xsdPath,
          errorCount: r.errors.length,
          validator: r.validator,
        };
      } catch (e) {
        const msg = e instanceof SchemaLoadError ? e.message : String(e);
        schema.xsdPath = located.xsdPath;
        status.schema = {
          state: 'schema-not-found',
          xsdPath: located.xsdPath,
          reason: `failed to load XSD: ${msg}`,
        };
      }
    }
  } else {
    status.schema = { state: 'not-run', reason: 'skipped' };
  }

  // 3. BREX
  let brexReport: BrexCheckReport | undefined;
  if (options.brex) {
    brexReport = await checkAgainstBrexChain(xml, options.brex.resolver, {
      extraLayers: options.brex.extraLayers,
      engine,
    });
    const violationCount = brexReport.layers.reduce((n, l) => n + l.violations.length, 0);
    const skippedRules = brexReport.layers.reduce((n, l) => n + l.skipped.length, 0);
    const manualChecks = brexReport.layers.reduce((n, l) => n + l.manualChecks.length, 0);
    status.brex = {
      state:
        violationCount > 0
          ? 'violations'
          : brexReport.unresolved.length > 0 || skippedRules > 0
            ? 'incomplete'
            : 'passed',
      layers: brexReport.layers.length,
      violationCount,
      unresolved: brexReport.unresolved.map((u) => formatDmc(u.dmCode)),
      manualChecks,
      skippedRules,
    };
  } else {
    status.brex.reason = 'skipped';
  }

  return { status, info, schema, brex: brexReport };
}
