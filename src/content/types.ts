/**
 * 本文（内容部）の共通の形。
 *
 * データモジュールの種類（descript / proced / process / fault / pm）ごとに読み取り部分を 1 つ作り、出力をこの形に揃える
 * （design/reader-mcp.md「本文の構造の返し方」、background.md「change-request-locator から取り入れたい設計」）。
 * XML をそのまま返さず、LLM が要約・回答に使える構造（見出しの階層、手順の番号、警告の種類、参照先）を保つ。
 */
import type { NodeLocation } from '../brex/types.js';

import type { IssueInfo, Language } from '../types.js';

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
  /** preliminaryRqmts / closeRqmts。`text` が全体の要約、子が人員・文書・品目・安全の要件 */
  | 'requirements'
  /** requirements の子: 必要な人員（personnel / person）。`text` が役割（trade）、`count` が人数 */
  | 'person'
  /** requirements の子: 参照する文書（reqTechInfo）。`refs` に参照、外部の文書は `title`（題名）と `text`（番号） */
  | 'document'
  /** requirements の子: 試験器材・工具（supportEquipDescr）。`title` が名前 */
  | 'equipment'
  /** requirements の子: 材料・消耗品（supplyDescr） */
  | 'supply'
  /** requirements の子: 予備品（spareDescr） */
  | 'spare'
  /** process の dmSeq と dmLoop（繰り返し。条件の式は `attrs.expression`） */
  | 'sequence'
  /** process の dmIf（条件分岐）。条件の式は `attrs.expression`、人が書いた文（`humanReadableForm`）は `question` */
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
  /** dmRefAddressItems/dmTitle などから得た題名（dmRef は「techName - infoName」） */
  title?: string;
  /** dmRef の題名の内訳（`dmTitle/techName`・`infoName`） */
  techName?: string;
  infoName?: string;
  /** dmRef / pmRef が指す版（`dmRefIdent/issueInfo`）。無ければ版を指定していない参照 */
  issueInfo?: IssueInfo;
  /** dmRef / pmRef が指す言語（`dmRefIdent/language`） */
  language?: Language;
  /** dmRef が指す DM の中の場所（`@referredFragment`。行き先の DM の中の id） */
  fragment?: string;
  /** 参照自身の `@applicRefId` */
  applicRefId?: string;
  /** externalPubRef が指す文書の版（`externalPubRefIdent/externalPubIssueInfo/externalPubIssue` の文。値は解釈しない） */
  externalPubIssue?: string;
  /** externalPubRef が指す文書の発行日（`externalPubRefAddressItems/externalPubIssueDate` の文。値は解釈しない） */
  externalPubIssueDate?: string;
  /** internalRef の `@internalRefTargetType`、graphic の hotspot など */
  note?: string;
  /** graphic の改訂の理由（`graphic/reasonForAmendment` の文） */
  reasonForAmendment?: string;
}

/**
 * 品目の識別子のうち、`identNumber` と 1 つ目の `natoStockNumber` 以外のもの
 * （`toolRef`・`supplyRef`・`supplyRqmtRef`・`materialSetRef`・`catalogSeqNumberRef`・`partRef`・`functionalItemRef`、
 * 2 つ目からの `natoStockNumber`）。属性は書かれた値のまま返す（値は解釈しない）
 */
export interface ContentIdentifier {
  /** 要素名 */
  element: string;
  /** 要素の属性（書かれているものすべて） */
  attrs: Record<string, string>;
  /** `name` / `shortName` の文 */
  name?: string;
  shortName?: string;
  /** `natoStockNumber` の番号（`ContentNode.natoStockNumber` と同じつなぎ方） */
  text?: string;
  /** 識別子が持つ参照（`refs` の中、または直下の `dmRef`） */
  refs?: ContentRef[];
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
  /** fault の isolationStep: 問いと、答えごとの次の手順。process の dmIf では条件を人が読める文にしたもの（`expression/@humanReadableForm`） */
  question?: string;
  choices?: Array<{ text: string; nextActionRefId?: string }>;
  /** person の人数（`personnel/@numRequired`） */
  count?: number;
  /** person を区別する記号（`person/@man`） */
  man?: string;
  /** person の区分（`personCategory/@personCategoryCode`）と技能の水準（`personSkill/@skillLevelCode`）。値は解釈しない */
  personCategoryCode?: string;
  skillLevelCode?: string;
  /** person の見積もり時間（`estimatedTime`）と単位（`@unitOfMeasure`） */
  estimatedTime?: string;
  estimatedTimeUnit?: string;
  /** document の区分（`reqTechInfo/@reqTechInfoCategory`）。値は解釈しない */
  reqTechInfoCategory?: string;
  /** equipment / supply / spare の数量（`reqQuantity`）と単位（`@unitOfMeasure`）。値は解釈しない */
  quantity?: string;
  unit?: string;
  /** equipment / supply / spare の部品番号と製造者のコード（`identNumber`） */
  partNumber?: string;
  manufacturerCode?: string;
  /**
   * equipment / supply / spare の NATO 物品番号（`natoStockNumber`）。3 つの属性があれば、書かれた値を
   * "6850-00-181-7933" の形（7 桁の番号は 3-4 桁）につなぐ。属性が無ければ `fullNatoStockNumber`、それも無ければ要素の文。値は解釈しない
   */
  natoStockNumber?: string;
  /** equipment / supply / spare の、`identNumber` と 1 つ目の `natoStockNumber` 以外の識別子 */
  identifiers?: ContentIdentifier[];
  /** `@applicRefId`（適用性の判定は reader が ApplicEvaluator で行う） */
  applicRefId?: string;
  /** 要素自身の `@securityClassification`（機密区分。値は解釈しない。無ければ親または DM 全体の区分に従う） */
  securityClassification?: string;
  /** この節点自身が持つ参照 */
  refs?: ContentRef[];
  /** その他の属性（process の variableName、式を文にした expression、changeMark など） */
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
  /**
   * あることは分かっているが、中身を読んでいない要素・属性の名前とその数（`productionMaintData`、`hazards` など）。
   * 応答に含まれていない内容があることを知らせる。空なら、読み取り部分が知っている範囲では落としたものは無い
   */
  notReadElements: Record<string, number>;
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
