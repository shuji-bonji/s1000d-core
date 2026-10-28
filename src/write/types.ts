/**
 * データモジュールを「書く」側の入力の型。
 *
 * LLM や作成ツールは XML を書かず、この型の木（題名・段落・手順・参照先）だけを出す。XML は `buildDataModule` が組み立てる
 * （design/writer-mcp.md「入力の形: DraftDataModule」「採番と識別・状態部: allocation」）。
 * `DraftNode` は reader が返す `ContentNode`（content/types.ts）の書き込み用の部分集合で、
 * `location`・`attrs`・`unknown` は受け取らない。読んだ木をそのまま書き戻せ、reader が知らない構造は書けない。
 *
 * 同じ形の JSON Schema を `schema/draft.schema.json` に置く（MCP の inputSchema にそのまま使う）。
 * 型と Schema の `required` が食い違わないよう、下の `*_REQUIRED` を型と照合している（コンパイル時）。
 */
import type { DmCode, IssueInfo, Language, PmCode } from '../types.js';

/** データモジュールの種類。`xsi:noNamespaceSchemaLocation` のスキーマ名（descript.xsd など）を決める */
export type DraftKind = 'descript' | 'proced' | 'process' | 'fault' | 'pm';

/** `DraftKind` の一覧（JSON Schema の enum と照合する） */
export const DRAFT_KINDS = ['descript', 'proced', 'process', 'fault', 'pm'] as const;

export type DraftNodeKind =
  /** descript の levelledPara、process の dmNode、pm の pmEntry */
  | 'section'
  | 'para'
  /** randomList / sequentialList / definitionList */
  | 'list'
  | 'listItem'
  /** definitionListItem（title が用語、本文が定義） */
  | 'definition'
  | 'table'
  | 'figure'
  /** warning / caution / note（種類は `level`） */
  | 'admonition'
  /** proced・process の proceduralStep、fault の isolationStep / isolationProcedureEnd */
  | 'step'
  /** preliminaryRqmts / closeRqmts の条件（文だけ。位置で前後が決まる） */
  | 'requirements'
  /** process の dmSeq */
  | 'sequence'
  /** process の dmIf（条件分岐） */
  | 'if'
  /** process の dialog（利用者への問い） */
  | 'dialog'
  /** pm の dmRef / pmRef の 1 項目 */
  | 'entry';

/** `DraftNodeKind` の一覧（JSON Schema の enum と照合する） */
export const DRAFT_NODE_KINDS = [
  'section',
  'para',
  'list',
  'listItem',
  'definition',
  'table',
  'figure',
  'admonition',
  'step',
  'requirements',
  'sequence',
  'if',
  'dialog',
  'entry',
] as const satisfies readonly DraftNodeKind[];

/** 参照の種類 */
export type DraftRefKind = 'dmRef' | 'pmRef' | 'internalRef' | 'graphic' | 'multimedia';

/** `DraftRefKind` の一覧（JSON Schema の enum と照合する） */
export const DRAFT_REF_KINDS = [
  'dmRef',
  'pmRef',
  'internalRef',
  'graphic',
  'multimedia',
] as const satisfies readonly DraftRefKind[];

/**
 * 参照。`text` の中に埋め込まず、機械で解決できるよう分けて書く。
 * 文の中の参照は、`text` の後ろに `refs` の順に並べる（`figure` の graphic / multimedia は図の中身になる）。
 */
export interface DraftRef {
  kind: DraftRefKind;
  /** dmRef / pmRef は DMC・PMC、internalRef は同じ DM の id、graphic / multimedia は ICN か assetId */
  target: string;
  /** dmRef / pmRef では参照先の題名（dmRef は techName に入る）、internalRef では表示する文字 */
  title?: string;
  /**
   * multimedia の種類（`multimediaObject/@multimediaType`）。省略すると 'other'。
   * 形式の判断はしないので、動画・音声・3D と分かっているときは呼び出し側が書く
   */
  multimediaType?: '3D' | 'audio' | 'video' | 'other';
}

/** 内容部の節点。種類（`DraftDataModule.kind`）ごとに置ける `kind` が決まっている */
export interface DraftNode {
  kind: DraftNodeKind;
  /** 要素の `id`。fault の step、process の dialog・if では必須（手順の行き先と変数名に使う） */
  id?: string;
  /** 見出し。definition では用語、table・figure では表題、process の if では使わない */
  title?: string;
  /** この節点自身の文（子の段落や手順は含まない）。参照は text に埋め込まず refs に書く。`<` と `&` はそのまま書く */
  text?: string;
  /** admonition の種類（admonition では必須） */
  level?: 'warning' | 'caution' | 'note';
  /** list が順序付きか */
  ordered?: boolean;
  /** table の行。1 行目を見出し行（thead）にする。すべての行のセルの数が同じであること */
  rows?: string[][];
  /** fault の step（isolationStep）の問い。process の if では条件を人が読める文にしたもの */
  question?: string;
  /** fault の step の答えと次の手順（`next` は同じ DM の step の id）。process の dialog では選択肢（`next` は使わない） */
  choices?: Array<{ text: string; next?: string }>;
  applicRefId?: string;
  /** 要素自身の機密区分（値は解釈しない） */
  securityClassification?: string;
  refs?: DraftRef[];
  children?: DraftNode[];
}

/** 適用性の 1 つの条件（`assert`） */
export interface DraftAssert {
  /** ACT の productAttribute の id など */
  applicPropertyIdent: string;
  applicPropertyType: 'prodattr' | 'condition';
  /** 値（範囲や列挙は S1000D の書き方のまま渡す。例: `Mountain bicycle`、`A~C`、`1|2`） */
  applicPropertyValues: string;
}

/** 適用性（`applic`）。表示文と、あれば機械で判定できる条件 */
export interface DraftApplic {
  /** 人が読む適用性の表示文（`displayText/simplePara`） */
  displayText: string;
  /** 機械で判定できる条件。1 件ならそのまま、2 件以上なら `andOr` で束ねる */
  assert?: DraftAssert[];
  /** assert が 2 件以上のときに必須 */
  andOr?: 'and' | 'or';
}

/** 版の上げ方（`BuildOptions.issuePolicy`） */
export type IssuePolicy = 'increment-issue' | 'increment-inwork' | 'keep';

/**
 * データモジュール 1 件の入力。識別情報（採番の元）、題名、機密区分と内容部の木を持つ。
 * 識別・状態部の残り（issueInfo の既定、brexDmRef、qualityAssurance など）は `buildDataModule` が決める。
 */
export interface DraftDataModule {
  /** DMC を自分で指定するか、採番の規則（allocation）に任せるかのどちらか */
  dmCode?: DmCode;
  /** kind が pm のとき、PMC を自分で指定する。省略すると sourceId から採番する */
  pmCode?: PmCode;
  /** 採番に使う識別子。dmCode（pm は pmCode）を省いたときに要る。同じ sourceId には同じ DMC を返す */
  sourceId?: string;
  kind: DraftKind;
  language: Language;
  /** 省略時は 001-00（新規）か、`issuePolicy` に従う既存の版（上書き） */
  issueInfo?: IssueInfo;
  /** YYYY-MM-DD。省略時は実行環境の今日の日付（応答の notes に書く） */
  issueDate?: string;
  title: { techName: string; infoName?: string };
  /** 列挙のまま。省略を許さない（agent-platform.md「機密区分を必ず付ける」） */
  securityClassification: string;
  /** 責任企業の企業コード（`responsiblePartnerCompany/@enterpriseCode`）。省略時は allocation.icn.cageCode */
  responsiblePartnerCompany?: string;
  /** 作成者の企業コード（`originator/@enterpriseCode`）。省略時は allocation.icn.cageCode */
  originator?: string;
  /** 省略すると applic 要素を置かない（XSD は applic か applicRef を要求するので、XSD 検証で missing になる） */
  applic?: DraftApplic;
  /** 省略時は allocation.brexDmRef、無ければ既定 BREX */
  brexDmRef?: DmCode;
  body: DraftNode[];
}

/** 情報コード（kind ごとに与える。意味は付けない） */
export interface InfoCodeSpec {
  infoCode: string;
  infoCodeVariant: string;
}

/**
 * 採番の規則。DMC・ICN・brexDmRef は LLM ではなく writer が付ける。
 * writer は状態を持たない: `ledger` を入力で受け取り、応答で返す。
 */
export interface Allocation {
  modelIdentCode: string;
  systemDiffCode: string;
  /** sourceId（Topic.id など）→ SNS と情報コードの対応。無い sourceId は rules で決める */
  map?: Record<string, Partial<DmCode>>;
  rules: {
    sns: { systemCode: string; subSystemCode: string; subSubSystemCode: string; assyCode: string };
    /** 指定すると分解コードを連番にしない（衝突は DraftInputError）。省略時は同じ SNS・情報コードの既存 DM の次の番号 */
    disassyCode?: string;
    /** 省略時は 'A' */
    disassyCodeVariant?: string;
    /** kind ごとの情報コード。既定は無く、省略すると DraftInputError（情報コードの意味はプロジェクトが決める） */
    infoCodeByKind: Partial<Record<DraftKind, InfoCodeSpec>>;
    itemLocationCode: string;
  };
  icn: {
    cageCode: string;
    /** 次に使う連番。応答に次の値を返す */
    next: number;
  };
  brexDmRef?: DmCode;
  /** 既に使った DMC・ICN・PMC（sourceId → DMC / PMC、assetId → ICN）。CSDB から集めるか、前回の応答の ledger をそのまま渡す */
  ledger?: Record<string, string>;
}

// ---- 型と JSON Schema の `required` を揃えるための照合 ----

type RequiredKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];

type SameKeys<A extends PropertyKey, B extends PropertyKey> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/** 型の必須プロパティ。`schema/draft.schema.json` の `required` と同じであることをテストで確かめる */
export const DRAFT_REQUIRED = {
  DraftDataModule: ['kind', 'language', 'title', 'securityClassification', 'body'],
  DraftNode: ['kind'],
  DraftRef: ['kind', 'target'],
  DraftApplic: ['displayText'],
  DraftAssert: ['applicPropertyIdent', 'applicPropertyType', 'applicPropertyValues'],
  Allocation: ['modelIdentCode', 'systemDiffCode', 'rules', 'icn'],
} as const;

// 型を変えたのに DRAFT_REQUIRED を直し忘れると、ここでコンパイルエラーになる
export type DraftRequiredCheck = [
  SameKeys<RequiredKeys<DraftDataModule>, (typeof DRAFT_REQUIRED.DraftDataModule)[number]>,
  SameKeys<RequiredKeys<DraftNode>, (typeof DRAFT_REQUIRED.DraftNode)[number]>,
  SameKeys<RequiredKeys<DraftRef>, (typeof DRAFT_REQUIRED.DraftRef)[number]>,
  SameKeys<RequiredKeys<DraftApplic>, (typeof DRAFT_REQUIRED.DraftApplic)[number]>,
  SameKeys<RequiredKeys<DraftAssert>, (typeof DRAFT_REQUIRED.DraftAssert)[number]>,
  SameKeys<RequiredKeys<Allocation>, (typeof DRAFT_REQUIRED.Allocation)[number]>,
] extends [true, true, true, true, true, true]
  ? true
  : never;

const draftRequiredCheck: DraftRequiredCheck = true;
void draftRequiredCheck;
