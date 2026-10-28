/**
 * 本文（内容部）の共通の形。
 *
 * データモジュールの種類（descript / proced / process / fault / pm）ごとに読み取り部分を 1 つ作り、出力をこの形に揃える
 * （design/reader-mcp.md「本文の構造の返し方」、background.md「change-request-locator から取り入れたい設計」）。
 * XML をそのまま返さず、LLM が要約・回答に使える構造（見出しの階層、手順の番号、警告の種類、参照先）を保つ。
 */
import type { NodeLocation } from '../brex/types.js';

export type ContentNodeKind =
  /** levelledPara / pmEntry / dmNode など、題名を持つまとまり */
  | 'section'
  | 'para'
  /** randomList / sequentialList / definitionList / attention…List */
  | 'list'
  | 'listItem'
  /** definitionListItem（term と definition） */
  | 'definition'
  | 'table'
  | 'figure'
  /** warning / caution / note */
  | 'admonition'
  /** proceduralStep / isolationStep / isolationProcedureEnd */
  | 'step'
  /** preliminaryRqmts / closeRqmts の要約 */
  | 'requirements'
  /** process の dmSeq */
  | 'sequence'
  /** process の dmIf（条件分岐） */
  | 'if'
  /** process の dialog（利用者への問い） */
  | 'dialog'
  /** pm の dmRef / pmRef の 1 項目 */
  | 'entry'
  /** 読み取り部分が知らない要素（名前は `element` に残す） */
  | 'unknown';

export interface ContentRef {
  kind: 'dmRef' | 'pmRef' | 'internalRef' | 'externalPubRef' | 'graphic' | 'multimedia';
  /** DMC・PMC・id・実体名・外部文書の識別 */
  target: string;
  /** dmRefAddressItems/dmTitle などから得た題名 */
  title?: string;
  /** internalRef の `@internalRefTargetType`、graphic の hotspot など */
  note?: string;
}

export interface ContentNode {
  kind: ContentNodeKind;
  /** 要素名（unknown のときや、同じ kind で元の要素を区別したいとき） */
  element: string;
  id?: string;
  title?: string;
  /** この節点自身の文（子の段落や手順は含まない）。参照は `[→ …]` の形で埋め込む */
  text?: string;
  /** admonition の種類 */
  level?: 'warning' | 'caution' | 'note';
  /** step の番号（1、1.1、…）。読み取り時に組み立てる */
  number?: string;
  /** list が順序付きか */
  ordered?: boolean;
  /** table の行（thead を先頭に含む）。セルは文字列 */
  rows?: string[][];
  /** fault の isolationStep: 問いと、答えごとの次の手順 */
  question?: string;
  choices?: Array<{ text: string; nextActionRefId?: string }>;
  /** `@applicRefId`（適用性の判定は reader が ApplicEvaluator で行う） */
  applicRefId?: string;
  /** 要素自身の `@securityClassification`（機密区分。値は解釈しない。無ければ親または DM 全体の区分に従う） */
  securityClassification?: string;
  /** この節点自身が持つ参照 */
  refs?: ContentRef[];
  /** その他の属性（process の variableName、changeMark など） */
  attrs?: Record<string, string>;
  children: ContentNode[];
  location: NodeLocation;
}

export type ContentKind = 'descript' | 'proced' | 'process' | 'fault' | 'pm' | 'other';

export interface DataModuleContent {
  /** `xsi:noNamespaceSchemaLocation` のスキーマ名 */
  schemaName?: string;
  /** どの読み取り部分を使ったか */
  kind: ContentKind;
  /** 構造化できたか。other のときは false で、blocks は空 */
  structured: boolean;
  blocks: ContentNode[];
  /** 読み方の注意（構造化していない種類、知らない要素の数など） */
  notes: string[];
  /** 知らなかった要素名とその数（読み取り部分の改善の材料） */
  unknownElements: Record<string, number>;
}

/** 概要（outline）の節点。見出し・手順の番号・最初の 1 文と、部分木の大きさだけを持つ */
export interface OutlineNode {
  kind: ContentNodeKind;
  element: string;
  id?: string;
  title?: string;
  number?: string;
  level?: 'warning' | 'caution' | 'note';
  /** `text` の最初の 1 文（最大 `maxSentenceLength` 文字） */
  firstSentence?: string;
  applicRefId?: string;
  securityClassification?: string;
  /** この節点を含む部分木の大きさ。LLM が読む量の見当を付けるために使う */
  size: ContentSize;
  location: NodeLocation;
  children: OutlineNode[];
}

/** 部分木の大きさ */
export interface ContentSize {
  /** 節点の数（自身を含む） */
  nodes: number;
  /** `title` と `text`、表のセルの文字数の合計 */
  chars: number;
  /** 種類ごとの節点の数 */
  byKind: Partial<Record<ContentNodeKind, number>>;
  /** 警告・注意・注記の数 */
  admonitions: { warning: number; caution: number; note: number };
}
