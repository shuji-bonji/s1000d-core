/**
 * comment データモジュール（`comment.xsd`）の型。
 *
 * 列挙（`commentType` / `commentPriorityCode` / `responseType` / `issueType` / `securityClassification`）は
 * 値の形だけを検査し、意味は付けない（意味は仕様書の該当章と BREX が決める）。
 */
import type { DmCode, DmRef, IssueInfo, Language } from '../types.js';

/** `commentCode/@commentType`。XSD の列挙は q / i / r（意味は解釈しない） */
export type CommentType = 'q' | 'i' | 'r';

/**
 * comment のコード（`commentCode` 要素の属性）。
 * ファイル名・文字列では `<modelIdentCode>-<senderIdent>-<yearOfDataIssue>-<seqNumber>-<commentType 大文字>`。
 */
export interface CommentCode {
  /** モデル識別コード（2〜14 文字） */
  modelIdentCode: string;
  /** 送り手の企業コード（5 文字） */
  senderIdent: string;
  /** 年（4 桁） */
  yearOfDataIssue: string;
  /** 連番（5 桁、00001 から） */
  seqNumber: string;
  commentType: CommentType;
}

/** ファイル名に含まれる comment のコードと言語。例: `COM-S1000DBIKE-B6865-2026-00001-Q_EN-US.XML` */
export interface CommentFileName {
  commentCode: CommentCode;
  language?: Language;
  extension?: string;
}

/** 参照の種類。`commentRefs` はこのうち 1 つの種類の群（または `noReferences`）しか持てない */
export type CommentRefKind = 'dmRef' | 'pmRef' | 'dmlRef' | 'ddnRef';

/** comment が指す対象 1 件 */
export interface CommentRef {
  kind: CommentRefKind;
  /**
   * 対象のコード。kind ごとに DMC（`parseDmc`）・PMC（`parsePmc`）・DML のコード（`parseDmlCode`）・
   * DDN のコード（`parseDdnCode`）の文字列。先頭の `DMC-` などは付いていてもよい
   */
  code: string;
  /** 版。dmRef・pmRef・dmlRef のみ（ddnRef の XSD には無い） */
  issueInfo?: IssueInfo;
  /** 言語。dmRef・pmRef のみ */
  language?: Language;
}

/** 発信者の住所（`address`）。`city` と `country` は XSD で必須 */
export interface CommentAddress {
  city: string;
  country: string;
  department?: string;
  street?: string;
  postOfficeBox?: string;
  postalZipCode?: string;
  state?: string;
  province?: string;
  building?: string;
  room?: string;
  phoneNumber?: string[];
  faxNumber?: string[];
  email?: string[];
  internet?: string[];
  SITA?: string;
}

/** 発信者（`commentOriginator/dispatchAddress`） */
export interface CommentOriginator {
  /**
   * 企業コード。comment.xsd の `enterprise` には属性が無いため XML には出さない（notes に書く）。
   * 送り手を表す値は `CommentInput.senderIdent` が持つ
   */
  enterpriseCode?: string;
  enterpriseName: string;
  division?: string;
  enterpriseUnit?: string;
  /** 担当者（`dispatchPerson`） */
  person?: { lastName: string; firstName?: string; jobTitle?: string; personPrefix?: string };
  /** XSD の `dispatchAddress` は `address`（`city` と `country` を含む）を必須とする */
  address: CommentAddress;
}

/** `buildComment` の入力（writer-mcp の `create_comment` の入力に対応） */
export interface CommentInput {
  /** 指す対象。空なら `noReferences`。種類の混在は XSD が許さないので入力の誤り */
  refs: CommentRef[];
  /** 列挙（q / i / r）。意味は解釈しない */
  commentType: CommentType;
  /** 列挙（cp01〜cp99）。意味は解釈しない */
  commentPriorityCode: string;
  title?: string;
  /** `commentContent/simplePara`（1 つ以上）。文はそのまま受け取る */
  paragraphs: string[];
  originator: CommentOriginator;
  senderIdent: string;
  modelIdentCode: string;
  /** 省略時は今年（`options.now` の年） */
  yearOfDataIssue?: string | number;
  /** 省略時は CSDB の同じモデル・送り手・年の次の番号 */
  seqNumber?: string | number;
  /** `security/@securityClassification`（01〜99）。省略を許さない */
  securityClassification: string;
  /** `commentResponse/@responseType`（rt01〜rt99）。省略すると commentResponse を出さない */
  responseType?: string;
  /** YYYY-MM-DD。省略時は今日 */
  issueDate?: string;
  language: Language;
  /** 従う BREX。省略時は `options.defaultBrex` → 既定 BREX の探索。見つからなければ入力の誤り（XSD が必須とする） */
  brexDmRef?: DmCode | DmRef;
  /** `commentStatus/@issueType`（XSD の列挙。既定値は new なので省略すると属性を出さない） */
  issueType?: string;
  /** `remarks/simplePara`。省略か空なら remarks を出さない */
  remarks?: string | string[];
}

export interface CommentBuildResult {
  /** 組み立てた XML（XML 宣言付き） */
  xml: string;
  commentCode: CommentCode;
  /** `COM-….XML`（仮の規則。`formatCommentFileName` の JSDoc を参照） */
  fileName: string;
  /** 補ったこと・出せなかったことの注記 */
  notes: string[];
}
