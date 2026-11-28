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
  /**
   * preliminaryRqmts / closeRqmts の条件（文。位置で前後が決まる）。前の requirements は、子の admonition を安全の要件として、
   * person・document・equipment・supply・spare を人員・文書・品目として受け取る
   */
  | 'requirements'
  /**
   * requirements の子: 必要な人員。`man` があれば `person`（人を区別する）、無ければ `personnel`（人数で書く）。
   * `text` が職種（trade）、`count` が人数（`personnel/@numRequired`）
   */
  | 'person'
  /**
   * requirements の子: 参照する文書（reqTechInfo）。`refs` に dmRef / pmRef が 1 つ、または `title`（題名）と `text`（番号）。
   * `reqTechInfoCategory` は区分（値は解釈しない）
   */
  | 'document'
  /**
   * requirements の子: 試験器材・工具（supportEquipDescr）。`title` が名前。
   * 識別子（`natoStockNumber` か `manufacturerCode` のどちらか 1 つ以上）と `quantity` が要る
   */
  | 'equipment'
  /** requirements の子: 材料・消耗品（supplyDescr）。項目は equipment と同じ */
  | 'supply'
  /** requirements の子: 予備品（spareDescr）。項目は equipment と同じ */
  | 'spare'
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
  'person',
  'document',
  'equipment',
  'supply',
  'spare',
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
  /** dmRef の題名の infoName（`dmTitle/infoName`）。`title` が要る */
  infoName?: string;
  /** dmRef / pmRef が指す版（`dmRefIdent/issueInfo`）。省略すると版を指定しない参照 */
  issueInfo?: IssueInfo;
  /** dmRef / pmRef が指す言語（`dmRefIdent/language`） */
  language?: Language;
  /** dmRef が指す DM の中の場所（`@referredFragment`。行き先の DM の中の id。あるかどうかは確かめない） */
  fragment?: string;
  /** dmRef / pmRef 自身の `@applicRefId` */
  applicRefId?: string;
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
  /**
   * 管理された内容の印（S1000D Issue 4.0〜4.2 の `authorityName`・`authorityDocument`）。この節点とその子の内容を、
   * 書いた組織とは別の組織（データを受け取る側など）が管理していることを示す。`name` は管理する組織の名前（必須）、
   * `document` は管理を求める根拠の文書（任意）。値は解釈しない。
   * 対象の版が Issue 4.2 より後のとき（既定の Issue 7 を含む）と、その版でこの印を付けられない要素になる節点では、
   * DraftInputError（黙って落とさない）
   */
  authority?: { name: string; document?: string };
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
  /** person の人数（1 以上の整数。`personnel/@numRequired`）。`man` と一緒には使えない */
  count?: number;
  /** person を区別する記号（`person/@man`。A、B など）。あれば personnel ではなく person として書く */
  man?: string;
  /** person の区分（`personCategory/@personCategoryCode`。値はプロジェクトが決める。解釈しない） */
  personCategoryCode?: string;
  /** person の技能の水準（`personSkill/@skillLevelCode`。sk01 など。列挙のまま渡す） */
  skillLevelCode?: string;
  /** person の見積もり時間（`estimatedTime`）。`estimatedTimeUnit` が要る */
  estimatedTime?: string;
  /** 見積もり時間の単位（`estimatedTime/@unitOfMeasure`。値は解釈しない） */
  estimatedTimeUnit?: string;
  /** document の区分（`reqTechInfo/@reqTechInfoCategory`。ti01 など。列挙のまま渡す） */
  reqTechInfoCategory?: string;
  /** equipment / supply / spare の数量（`reqQuantity`。必須） */
  quantity?: string;
  /** 数量の単位（`reqQuantity/@unitOfMeasure`。値は解釈しない） */
  unit?: string;
  /** equipment / supply / spare の部品番号（`identNumber/partAndSerialNumber/partNumber`） */
  partNumber?: string;
  /**
   * equipment / supply / spare の製造者のコード（`identNumber/manufacturerCode`）。
   * 品目には識別子が要るので、`natoStockNumber` が無いときは必須。`partNumber` を書くときも必須
   */
  manufacturerCode?: string;
  /**
   * equipment / supply / spare の NATO 物品番号（NSN）。数字 13 桁で、"6850-00-181-7933" のように
   * 4-2-3-4 桁をハイフンで区切って書ける。`natoStockNumber` の 3 つの属性
   * （`@natoSupplyClass` 4 桁・`@natoCodificationBureau` 2 桁・`@natoItemIdentNumberCore` 7 桁）に、書かれた桁のまま分けて書く
   */
  natoStockNumber?: string;
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
