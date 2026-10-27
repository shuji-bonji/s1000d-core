/**
 * @shuji-bonji/s1000d-core
 *
 * S1000D® の CSDB オブジェクトを読むための共通ライブラリ。
 * s1000d-brex-mcp / reader / verify / writer が共有する。
 *
 * S1000D® は ASD の登録商標です。このライブラリは ASD とは無関係で、仕様書・スキーマ・公式サンプルを含みません。
 */
export * from './types.js';
export {
  BREX_INFO_CODE,
  formatDmc,
  formatDmcFileName,
  isBrexDmc,
  parseDmc,
  parseDmcFileName,
  sameDmc,
} from './dmc.js';
export { formatIcn, parseIcn, parseIcnFileName } from './icn.js';
export { parseSchemaLocation, type SchemaLocationInfo } from './schema-location.js';
export {
  readDataModuleInfo,
  readDmCodeElement,
  readDmRef,
  readIdentAndStatus,
} from './data-module.js';
export * from './xml/index.js';
export * from './xml/schema-validator.js';
export * from './verify/index.js';
export * from './brex/index.js';
export {
  createDirectoryBrexResolver,
  findDataModule,
  listDataModules,
  type CsdbEntry,
} from './csdb.js';
export { formatPmc, parsePmc, parsePmcFileName, samePmc } from './pmc.js';
export { CsdbIndex, listCsdbObjects, type CsdbObject, type CsdbObjectKind } from './csdb-index.js';
export * from './refs/index.js';
export * from './applic/index.js';
export * from './content/index.js';
export * from './fix/index.js';
export {
  CONFIG_PATH_ENV,
  CSDB_DIR_ENV,
  SPEC_DIR_ENV,
  resolveStackConfig,
  specDirHowTo,
  stackConfigPath,
  type ResolveStackConfigOptions,
  type ResolvedStackConfig,
  type StackConfigFile,
  type StackConfigSource,
} from './stack-config.js';
