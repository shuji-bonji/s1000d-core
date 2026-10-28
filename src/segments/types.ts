/**
 * 翻訳向けの文の抜き出しと差し戻しの型（design/writer-mcp.md「extract_segments / apply_segments」）。
 * 翻訳も訳の採点もしない。文を出し入れするだけ。
 */
import type { NodeLocation } from '../brex/types.js';
import type { DmCode, IssueInfo, Language } from '../types.js';

/** 文の種類。`ExtractOptions.include` で絞る */
export type SegmentCategory = 'title' | 'para' | 'step' | 'admonition' | 'table' | 'caption';

export const SEGMENT_CATEGORIES: readonly SegmentCategory[] = [
  'title',
  'para',
  'step',
  'admonition',
  'table',
  'caption',
];

/** 文の中のインライン要素（`emphasis`・`internalRef`・`dmRef` など）を置き換えた `{n}` の中身 */
export interface SegmentPlaceholder {
  /** `text` の中の `{index}`（1 から） */
  index: number;
  /** 元の要素名（コメントは `#comment`、処理命令は `#processing-instruction`） */
  element: string;
  /** 元のインライン要素の直列化。差し戻しのときに元の要素へ戻す */
  xml: string;
}

export interface Segment {
  /** XPath から作る安定した短い文字列（例: `d.lp2.p1`）。同じ DM の中で一意 */
  id: string;
  /** 文書要素からの XPath（番号は常に付く。例: `content/description/levelledPara[2]/para[1]`） */
  xpath: string;
  /** 文を持つ要素の名前 */
  element: string;
  category: SegmentCategory;
  /** 人が訳すときの手がかり（節の題名・手順の番号・警告の種類・表のセルの位置） */
  context: string;
  /**
   * 文。インライン要素は `{1}`・`{2}` に置き換えてある。空白は 1 つにまとめて前後を削ってある。
   * 文字としての `{` `}` は `{{` `}}` と書く。
   */
  text: string;
  placeholders: SegmentPlaceholder[];
  location: NodeLocation;
}

export interface ExtractOptions {
  /** 既定は全部 */
  include?: SegmentCategory[];
  /** 出す文の最大数（超えた分は出さず、`notes` に書く） */
  maxSegments?: number;
}

export interface SegmentCounts {
  total: number;
  title: number;
  para: number;
  step: number;
  admonition: number;
  table: number;
  caption: number;
}

export interface ExtractResult {
  dmCode: DmCode;
  language?: Language;
  /** すべての対象の文を空にした XML の SHA-256（16 進）。`include` や `maxSegments` に左右されない */
  skeletonHash: string;
  segments: Segment[];
  /** 出した文の数（`include` と `maxSegments` を適用した後） */
  counts: SegmentCounts;
  notes: string[];
}

export interface ApplyOptions {
  /** 訳先の言語。`dmIdent/language` に書く */
  language: Language;
  /** 指定があれば `dmIdent/issueInfo` を変える。無ければ元のまま */
  issueInfo?: IssueInfo;
  /** `extractSegments` が返した値 */
  skeletonHash: string;
}

export type UnappliedReason = 'unknown-id' | 'placeholder-mismatch' | 'duplicate-id';

export interface UnappliedSegment {
  id: string;
  reason: UnappliedReason;
}

export interface ApplyResult {
  xml: string;
  /** 言語だけ違う `DMC-….XML` */
  fileName: string;
  /** 訳文を適用した（元の文と同じで変えなかったものを含む）文の数 */
  applied: number;
  /** 適用しなかった文。元の文は残る */
  unapplied: UnappliedSegment[];
  notes: string[];
}
