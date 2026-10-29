/**
 * 検証状態（`VerificationStatus`）。
 *
 * s1000d-verify-mcp と s1000d-reader-mcp が同じ形で返すために core に置く（D-17、D-18）。
 * reader はすべての応答にこれを含め、「どこまで確認済みか」を LLM と利用者に伝える。
 * S1000D 準拠を 1 つの真偽値で表す項目は意図的に置かない（nonContextRules と人が読むビジネスルール文書が残るため）。
 */
import type { CommentCode } from '../comment/types.js';
import type { DmCode, IssueInfo, PmCode } from '../types.js';

export type SchemaState =
  /** XSD を見つけて検証し、違反が 0 */
  | 'valid'
  /** 違反が 1 つ以上 */
  | 'invalid'
  /** XSD が見つからない（S1000D_SPEC_DIR 未設定、xml_schema_flat 無し、schemaLocation 無し、版が合わない） */
  | 'schema-not-found'
  /** 検証を省いた */
  | 'not-run';

export type BrexState =
  /** すべての層で違反 0、評価できなかったルール 0、未解決の BREX 0 */
  | 'passed'
  /** 違反が 1 つ以上 */
  | 'violations'
  /** 違反は 0 だが、未解決の BREX か評価できなかったルールがある */
  | 'incomplete'
  /** BREX の工程を省いた、または照合した層が 0 件（brexDmRef が無く、層も渡されていない）。`reason` に理由 */
  | 'not-run';

export type ReferencesState = 'resolved' | 'unresolved' | 'not-run';

export interface VerificationStatus {
  target: {
    dmCode?: DmCode;
    /** ルートが pm のとき（dmCode は付かない） */
    pmCode?: PmCode;
    /** ルートが comment のとき（dmCode は付かない） */
    commentCode?: CommentCode;
    issueInfo?: IssueInfo;
    /** スキーマ名（descript / proced など） */
    schemaName?: string;
    /** schemaLocation から推定した S1000D の版 */
    issue?: string;
    path?: string;
  };
  wellFormed: boolean;
  schema: {
    state: SchemaState;
    /** 検証に使った XSD の版（brex.xsd から読んだもの） */
    issue?: string;
    xsdPath?: string;
    errorCount?: number;
    /** 実装名と版（例: "libxml2-wasm 0.7.2"） */
    validator?: string;
    /** schema-not-found / not-run の理由 */
    reason?: string;
  };
  brex: {
    state: BrexState;
    layers: number;
    violationCount: number;
    /** 見つからなかった BREX の DMC */
    unresolved: string[];
    /** nonContextRules の数（人が確認する項目） */
    manualChecks: number;
    /** XPath を評価できなかったルールの数 */
    skippedRules: number;
    reason?: string;
  };
  references: {
    state: ReferencesState;
    checked: number;
    unresolvedCount: number;
    reason?: string;
  };
  /** ISO 8601、実行環境のオフセット付き（例: 2026-10-24T23:50:00+09:00） */
  checkedAt: string;
}
