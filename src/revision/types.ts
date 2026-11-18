/**
 * 作業中の版を始める操作（`startRevision`）の型。
 * 設計: s1000d-stack の docs/design/core-revision.md、DECISIONS D-33。
 */
import type { NodeLocation } from '../brex/types.js';
import type { IssueInfo } from '../types.js';
import type { XmlEngine } from '../xml/engine.js';

/** 作業中の版に書ける `issueType`。`new` は `001-00` から始めるときだけ */
export type RevisionIssueType = 'changed' | 'revised' | 'status' | 'new';

export interface StartRevisionOptions {
  /**
   * 作業中の版の `issueType`。必須（変更の種類は書き手が決める。D-33 の R-1）。
   * - `changed`: 変更があり、変更の印で示す
   * - `revised`: 改訂。変更の印を持たない
   * - `status`: 識別・状態部だけの更新
   * - `new`: `001-00` から始めるときだけ（仕様書の Chap 3.9.5.1 の Table 3 の書き方。既定 BREX の BREX-S1-00030 には違反する）
   */
  issueType: RevisionIssueType;
  engine?: XmlEngine;
}

export type RevisionRefusalReason =
  | 'xml-not-well-formed'
  /** 元の文字列の中で、要素の範囲を求められなかった */
  | 'ranges-unavailable'
  /** `issueInfo` か、状態の要素（`dmStatus`）が無い */
  | 'no-issue-info'
  /** 既に作業中の版（`issueInfo/@inWork` が "00" でない） */
  | 'already-in-work'
  /** `issueType` が `deleted` の版（復帰は扱わない） */
  | 'deleted-issue'
  /** `options.issueType` が受け付けられない */
  | 'issue-type-input-error'
  /** 取り除く `changeType="delete"` の要素（子孫を含む）の id を、残る部分の属性が指している */
  | 'id-referenced'
  /** 文字列を書き換えた結果が、DOM で同じ操作をした結果と合わない（適用しない） */
  | 'internal-mismatch';

export interface RevisionRefusal {
  reason: RevisionRefusalReason;
  message: string;
  location?: NodeLocation;
  /** `id-referenced` のとき、その id を指している属性を持つ要素 */
  referencedBy?: NodeLocation[];
}

export interface StartRevisionResult {
  /** 作業中の版を始めたか。false のとき、`xml` は渡された文字列のまま */
  started: boolean;
  xml: string;
  refusals: RevisionRefusal[];
  /** 元の版 */
  previous?: { issueInfo: IssueInfo; issueType?: string };
  /** 作業中の版（`issueNumber` は元のまま、`inWork` は "01"） */
  issueInfo?: IssueInfo;
  issueType?: RevisionIssueType;
  /** 作業中の版のファイル名（DM のときだけ。元のファイルは変えずに、この名前で書く） */
  fileName?: string;
  /** 取り除いた、前の版の変更の印 */
  removed: {
    /** 変更の印の属性（`changeType`・`changeMark`・`reasonForUpdateRefIds`）を取り除いた要素の数 */
    markedElements: number;
    /** タグだけを取り除いた `changeInline` の数（中身は残る） */
    changeInline: number;
    /** 取り除いた `reasonForUpdate` の数 */
    reasonForUpdate: number;
    /** 取り除いた、`changeType="delete"` の要素（元の文書の場所） */
    deletedElements: NodeLocation[];
  };
  notes: string[];
}

/** 足す `reasonForUpdate` 1 つ分 */
export interface ReasonForUpdateInput {
  /** `simplePara` の文 */
  text: string;
  /** 更新の理由の種類（urt01 … urt99）。値は補わない */
  updateReasonType: string;
  /** "1" なら、ハイライトの DM に載せる理由 */
  updateHighlight?: '0' | '1';
  /** `reasonForUpdate/@id`。省略すると、文書に無い値（rfu-0001 の形）を作る */
  id?: string;
}

export interface AddReasonForUpdateOptions {
  engine?: XmlEngine;
}

export type AddReasonRefusalReason =
  | 'xml-not-well-formed'
  /** 元の文字列の中で、要素の範囲を求められなかった */
  | 'ranges-unavailable'
  /** 状態の要素（`dmStatus`）が無い */
  | 'no-status-element'
  /** 発行済みの版（`issueInfo/@inWork` が "00"）。先に `startRevision` で作業中の版を始める */
  | 'released-issue'
  /** `reason` の形が受け付けられない（文が空、`updateReasonType`・`updateHighlight`・`id` の値） */
  | 'reason-input-error'
  /** `reason.id` が、文書に既にある */
  | 'id-duplicate'
  /** 文字列を書き換えた結果が、DOM で同じ操作をした結果と合わない（適用しない） */
  | 'internal-mismatch';

export interface AddReasonRefusal {
  reason: AddReasonRefusalReason;
  message: string;
}

export interface AddReasonForUpdateResult {
  /** 足したか。false のとき、`xml` は渡された文字列のまま */
  added: boolean;
  xml: string;
  refusals: AddReasonRefusal[];
  /** 足した `reasonForUpdate` */
  reasonForUpdate?: { id: string; updateReasonType: string; updateHighlight?: '0' | '1' };
  notes: string[];
}
