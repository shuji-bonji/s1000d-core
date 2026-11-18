/**
 * 既にあるデータモジュールの構造を変える編集（`editContent`）の型。
 * 設計: s1000d-stack の docs/design/core-structural-edit.md、DECISIONS D-31。
 */
import type { NodeLocation } from '../brex/types.js';
import type { XsdIndex } from '../fix/xsd-index.js';
import type { BuildContentContext } from '../write/content/index.js';
import type { DraftNode } from '../write/types.js';
import type { XmlEngine } from '../xml/engine.js';

/** 足す・移す先の位置。`before`・`after` は基準の節点の前後、`first-child`・`last-child` は基準の節点の中 */
export type EditPosition = 'before' | 'after' | 'first-child' | 'last-child';

/**
 * 編集 1 つ。場所（`at`・`to`）は、編集の前の文書の `location.path`（`readContent` が返すもの）で書く。
 * 複数の編集を渡すときも、すべて編集の前の文書の場所で書く。
 */
export type ContentEdit =
  /** 節点を足す。`to` が基準の節点、`node` が足す節点 */
  | { op: 'insert'; to: string; position: EditPosition; node: DraftNode }
  /** 節点を、子孫ごと取り除く */
  | { op: 'remove'; at: string }
  /** 節点を、中身を変えずに移す */
  | { op: 'move'; at: string; to: string; position: EditPosition };

/** 編集を断る理由 */
export type EditRefusalReason =
  | 'xml-not-well-formed'
  /** 元の文字列の中で、要素の範囲を求められなかった（実体参照が要素を展開している文書など） */
  | 'ranges-unavailable'
  /** 発行済みの版（`issueInfo/@inWork` が "00"）で、`allowReleasedIssue` が無い */
  | 'released-issue'
  | 'xpath-error'
  | 'location-not-found'
  | 'location-ambiguous'
  | 'not-an-element'
  /** 最初の版の対象でない種類の節点（対象は proceduralStep・para・warning・caution・note・listItem） */
  | 'unsupported-node'
  /** 基準の節点が、その位置に子を取れない形（空要素タグの中、足す節点の種類に対応していない親） */
  | 'unsupported-destination'
  /** 取り除く節点（子孫を含む）の id を、残る部分の属性が指している */
  | 'id-referenced'
  /** 足す節点の id が、文書に既にある */
  | 'id-duplicate'
  | 'move-into-self'
  /** XSD で、基準の親がその要素を子に取れない */
  | 'not-allowed-here'
  /** 足す節点（`DraftNode`）の形が受け付けられない */
  | 'draft-input-error'
  /** 同じ節点に 2 つの編集がある、取り除く節点の中や隣を別の編集が基準にしている、など */
  | 'conflicting-edits'
  /** 文字列を書き換えた結果が、DOM で同じ操作をした結果と合わない（適用しない） */
  | 'internal-mismatch'
  /** `marking` の形が受け付けられない（文が空、`updateReasonType`・`changeMark` の値など） */
  | 'marking-input-error'
  /** `marking` があり、`updateReasonType` が編集上の変更（urt01）。編集上の変更に変更の印は付けない（Chap 3.9.5.2.1.1 Para 2.2） */
  | 'editorial-reason'
  /** `marking` があり、`issueType` が変更の印を持てる値（changed・status・rinstate-changed・rinstate-status）でない（BREX-S1-00036） */
  | 'issue-type-not-markable'
  /** `marking` があり、取り除く節点が既に `changeType="delete"` を持つ */
  | 'already-marked-deleted'
  /** `marking` があり、移す先の親が元の親と違う（remove と insert で指定する。D-33 の R-3） */
  | 'move-across-parents'
  /** `marking` があり、移す節点の親が変更の印の属性を持てない（description・procedure など） */
  | 'parent-not-markable';

export interface EditRefusal {
  /** `edits` の何番目か。文書全体についての理由（`released-issue` など）では無い */
  index?: number;
  reason: EditRefusalReason;
  message: string;
  /** 編集の対象の場所 */
  location?: NodeLocation;
  /** `id-referenced` のとき、その id を指している属性を持つ要素 */
  referencedBy?: NodeLocation[];
}

/**
 * 変更の印を付ける指定（層 2。設計: s1000d-stack の docs/design/core-revision.md、DECISIONS D-33）。
 * 1 回の呼び出しの編集は、すべて同じ `reasonForUpdate` 1 つを指す。理由が違う編集は、呼び出しを分ける。
 */
export interface EditMarking {
  /**
   * 識別・状態部に新しく足す `reasonForUpdate` 1 つ分。`reasonRefId` とどちらか一方だけを渡す。
   * この改版で、その理由による最初の編集のときに使う。
   */
  reason?: {
    /** `simplePara` の文 */
    text: string;
    /** 更新の理由の種類（urt02 など）。値は補わない。urt01（編集上の変更）は断る */
    updateReasonType: string;
    /** "1" なら、ハイライトの DM に載せる理由 */
    updateHighlight?: '0' | '1';
    /** `reasonForUpdate/@id`。省略すると、文書に無い値（rfu-0001 の形）を作る */
    id?: string;
  };
  /**
   * 文書の識別・状態部に既にある `reasonForUpdate` の `id`。`reason` とどちらか一方だけを渡す。
   * 同じ理由による 2 回目からの編集のときに使う（同じ理由の変更は、同じ `reasonForUpdate` を指す。
   * Chap 3.9.5.2.1.1 Para 2.1.3）。識別・状態部は変えない。その `reasonForUpdate` が urt01 なら断る。
   */
  reasonRefId?: string;
  /** 変更を示す表示（変更線など）を出すか。"1" が出す */
  changeMark: '0' | '1';
}

export interface EditContentOptions {
  /**
   * 変更の印を付ける。渡さなければ、版も変更の印も変えない（層 1 の動き）。
   * 渡したときは、`allowReleasedIssue` があっても発行済みの版を断る（先に `startRevision` で作業中の版を始める）。
   * - insert: 足した要素に `changeType="add"`
   * - remove: 要素を残して `changeType="delete"`。この作業中の版で足した要素（`changeType="add"`）は、印を付けずに取り除く
   * - move: 同じ親の中だけ。親に `changeType="modify"`
   * - `add`・`delete` の印を持つ要素の中への編集には、印を付けない
   */
  marking?: EditMarking;
  /**
   * 発行済みの版（`issueInfo/@inWork` が "00"）でも編集する。既定は false。
   * `editContent` は版も変更の印（`changeType` など）も変えないので、発行済みの版を書き換えると、
   * S1000D の版の決まり（Chap 3.5、Chap 3.9.5.2.1.1）に合わない文書になる。試作や練習で、承知の上で使う。
   */
  allowReleasedIssue?: boolean;
  /** 基準の親がその要素を子に取れるかを確かめる XSD の定義。省略・false なら確かめない（`notes` に書く） */
  xsd?: XsdIndex | false;
  /** insert の節点を組み立てるときの文脈（図の ICN の解決など）。`document`・`notes` は使わない */
  build?: Pick<BuildContentContext, 'resolveIcn' | 'onAsset'>;
  engine?: XmlEngine;
}

/** 適用した編集 1 つ */
export interface AppliedEdit {
  index: number;
  op: ContentEdit['op'];
  /** remove・move の対象の、編集の前の場所 */
  at?: NodeLocation;
  /** insert・move の基準の節点の、編集の前の場所 */
  to?: NodeLocation;
  position?: EditPosition;
  /** 対象（足した・取り除いた・移した）要素の名前 */
  element: string;
  /** `marking` で付けた変更の印。印を付けなかった編集（`add`・`delete` の要素の中、足した要素の取り消し）では無い */
  mark?: AppliedMark;
  /** `marking` があり、要素を取り除かずに `changeType="delete"` を付けて残したとき true */
  kept?: boolean;
}

/** 付けた変更の印 1 つ */
export interface AppliedMark {
  /** 印を付けた要素の名前（move では親） */
  element: string;
  /** 印を付けた要素の、編集の前の場所。足した要素に付けた印では無い */
  at?: NodeLocation;
  changeType: 'add' | 'delete' | 'modify';
  changeMark: '0' | '1';
  /** 指した `reasonForUpdate` の id */
  reasonForUpdateRefId: string;
}

export interface EditContentResult {
  /** すべての編集を適用したか。1 つでも断ったら false で、`xml` は渡された文字列のまま */
  applied: boolean;
  xml: string;
  refusals: EditRefusal[];
  changes: AppliedEdit[];
  /**
   * `marking` で付けた印が指す `reasonForUpdate`。印を 1 つも付けなかったときは無い。
   * `added` が true なら、この呼び出しで識別・状態部に足したもの（`marking.reason`）。
   * false なら、文書に既にあったもの（`marking.reasonRefId`）で、`updateReasonType` は書かれているときだけ返す。
   */
  reasonForUpdate?: {
    id: string;
    added: boolean;
    updateReasonType?: string;
    updateHighlight?: '0' | '1';
  };
  notes: string[];
}
