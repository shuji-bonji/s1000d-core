/**
 * データモジュールリスト（DML、`dml.xsd`）と納入票（DDN、`ddn.xsd`）の型。
 * 値の意味は解釈しない（`dmlType` / `dmlEntryType` / `issueType` は XSD の列挙をそのまま返す）。
 */
import type { NodeLocation } from '../brex/types.js';
import type { DmRef, IssueInfo, PmCode } from '../types.js';

/** DML のコード（`dmlCode` 要素の属性。ファイル名では `DML-<MIC>-<送り手>-<種類>-<年>-<連番>`） */
export interface DmlCode {
  modelIdentCode: string;
  /** 送り手の企業コード（5 文字） */
  senderIdent: string;
  /** DML の種類。XSD の列挙は c / p / s */
  dmlType: string;
  /** 年（4 桁） */
  yearOfDataIssue: string;
  /** 連番（5 桁） */
  seqNumber: string;
}

/** ファイル名に含まれる DML のコードと発行情報。例: `DML-S1000DBIKE-B6865-S-2026-00001_001-00.XML` */
export interface DmlFileName {
  dmlCode: DmlCode;
  issueInfo?: IssueInfo;
  extension?: string;
}

/** DDN のコード（`ddnCode` 要素の属性。ファイル名では `DDN-<MIC>-<送り手>-<受け手>-<年>-<連番>`） */
export interface DdnCode {
  modelIdentCode: string;
  senderIdent: string;
  receiverIdent: string;
  yearOfDataIssue: string;
  seqNumber: string;
}

export interface DdnFileName {
  ddnCode: DdnCode;
  extension?: string;
}

export type DmlEntryKind = 'dm' | 'pm' | 'icn' | 'comment' | 'dml';

/** DML の 1 行（`dmlEntry`）。参照の種類ごとに 1 つだけ入る */
export interface DmlEntry {
  kind: DmlEntryKind;
  /** 人が読む対象（DMC・PMC・実体名・DML のコード） */
  target: string;
  /** kind が dm のとき */
  dmRef?: DmRef;
  /** kind が pm のとき */
  pmRef?: { pmCode: PmCode; issueInfo?: IssueInfo };
  /** kind が icn のとき（`infoEntityRef/@infoEntityRefIdent`） */
  infoEntityIdent?: string;
  /** kind が dml のとき */
  dmlRef?: { dmlCode: DmlCode; issueInfo?: IssueInfo };
  /** 題名（`dmTitle` の techName と infoName、または `pmTitle`） */
  title?: string;
  /** `responsiblePartnerCompany/@enterpriseCode` と `enterpriseName` */
  responsiblePartnerCompany?: { enterpriseCode?: string; enterpriseName?: string };
  /** `@dmlEntryType`（XSD の列挙は c / d / n）。解釈しない */
  dmlEntryType?: string;
  /** `@issueType` */
  issueType?: string;
  /** `security/@securityClassification` */
  securityClassification?: string;
  remarks?: string;
  location: NodeLocation;
}

export interface DmlDocument {
  dmlCode: DmlCode;
  issueInfo?: IssueInfo;
  /** `issueDate` を YYYY-MM-DD にしたもの */
  issueDate?: string;
  /** `dmlStatus/@issueType` */
  issueType?: string;
  securityClassification?: string;
  brexDmRef?: DmRef;
  entries: DmlEntry[];
}

/** DDN の納入物 1 件（`deliveryListItem`） */
export interface DdnItem {
  /** `dispatchFileName`（ファイル名） */
  fileName: string;
  /** `entityControlNumber`（ICN） */
  entityControlNumber?: string;
  issueInfo?: IssueInfo;
  location: NodeLocation;
}

export interface DdnDocument {
  ddnCode: DdnCode;
  issueDate?: string;
  securityClassification?: string;
  /** `dispatchTo` / `dispatchFrom` の企業名 */
  dispatchTo?: string;
  dispatchFrom?: string;
  /** `mediaIdent/@label` */
  mediaIdent?: string;
  items: DdnItem[];
}
