/**
 * 共有型。S1000D の識別子（DMC・ICN）と、データモジュールの識別・状態部の読み取り結果。
 *
 * 用語は S1000D の要素名・属性名に合わせる（modelIdentCode など）。
 * 日本語の説明は JSDoc に置き、プロパティ名は英語のまま使う。
 */

/** 解析の結果。失敗したときは `ok: false` と理由を返し、例外は投げない。 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * データモジュールコード（DMC）の構成要素。
 * 例: `S1000DBIKE-AAA-D00-00-00-00AA-041A-A`
 */
export interface DmCode {
  /** モデル識別コード（2〜14 文字） */
  modelIdentCode: string;
  /** システム差異コード（1〜4 文字） */
  systemDiffCode: string;
  /** システムコード（2〜3 文字） */
  systemCode: string;
  /** サブシステムコード（1 文字） */
  subSystemCode: string;
  /** サブサブシステムコード（1 文字） */
  subSubSystemCode: string;
  /** 組立コード（2 または 4 文字） */
  assyCode: string;
  /** 分解コード（2 文字） */
  disassyCode: string;
  /** 分解コードバリアント（1〜3 文字） */
  disassyCodeVariant: string;
  /** 情報コード（3 文字） */
  infoCode: string;
  /** 情報コードバリアント（1 文字） */
  infoCodeVariant: string;
  /** アイテムロケーションコード（1 文字） */
  itemLocationCode: string;
  /** 学習コード（3 文字、学習用データモジュールのみ） */
  learnCode?: string;
  /** 学習イベントコード（1 文字、学習用データモジュールのみ） */
  learnEventCode?: string;
}

/** 発行情報。`issueInfo` 要素に対応する。 */
export interface IssueInfo {
  issueNumber: string;
  inWork: string;
}

/** 言語。`language` 要素に対応する。 */
export interface Language {
  languageIsoCode: string;
  countryIsoCode: string;
}

/**
 * ファイル名に含まれる DMC の付加情報。
 * 例: `DMC-S1000DBIKE-AAA-D00-00-00-00AA-041A-A_013-00_EN-US.XML`
 */
export interface DmcFileName {
  dmCode: DmCode;
  issueInfo?: IssueInfo;
  language?: Language;
  extension?: string;
}

/**
 * ICN（Information Control Number）。2 つの書式がある。
 * - MIC 基準: `ICN-<MIC>-<SDC>-<SNS>-<責任企業>-<CAGE>-<固有番号>-<バリアント>-<版>-<機密区分>`
 * - CAGE 基準: `ICN-<CAGE>-<固有番号>-<版>-<機密区分>`
 */
export type Icn =
  | {
      form: 'mic';
      modelIdentCode: string;
      systemDiffCode: string;
      /** システム・サブシステム・サブサブシステム・組立を連結した部分 */
      sns: string;
      responsiblePartnerCompanyCode: string;
      originatorCode: string;
      uniqueIdentifier: string;
      variantCode: string;
      issueNumber: string;
      securityClassification: string;
    }
  | {
      form: 'cage';
      originatorCode: string;
      uniqueIdentifier: string;
      issueNumber: string;
      securityClassification: string;
    };

/** データモジュールへの参照（`dmRef` 要素の中の `dmRefIdent`）。 */
export interface DmRef {
  dmCode: DmCode;
  issueInfo?: IssueInfo;
  language?: Language;
}

/**
 * 識別・状態部（`identAndStatusSection`）から読み取れる主な情報。
 * 要素が無いものは undefined。
 */
export interface IdentAndStatus {
  dmCode: DmCode;
  language?: Language;
  issueInfo?: IssueInfo;
  /** `issueDate` を YYYY-MM-DD に組み立てたもの */
  issueDate?: string;
  techName?: string;
  infoName?: string;
  infoNameVariant?: string;
  securityClassification?: string;
  responsiblePartnerCompany?: { enterpriseCode?: string; enterpriseName?: string };
  originator?: { enterpriseCode?: string; enterpriseName?: string };
  /** 適用性の表示文（`applic/displayText` の文字列。無ければ undefined） */
  applicDisplayText?: string;
  /** このデータモジュールが従う BREX の参照 */
  brexDmRef?: DmRef;
  /** `dmStatus/@issueType` */
  issueType?: string;
  /** `qualityAssurance` の子要素名（unverified / firstVerification / secondVerification） */
  qualityAssurance?: string;
}

/**
 * データモジュール全体の要約。XML を読んだ直後に得られる、識別・状態部より外側の情報を含む。
 */
export interface DataModuleInfo {
  /** ルート要素名（dmodule / pm / dml / ddn / comment / icnMetadataFile など） */
  rootElement: string;
  /** `xsi:noNamespaceSchemaLocation` の値 */
  schemaLocation?: string;
  /** スキーマのファイル名から得たデータモジュールの種類（brex / descript / proced など） */
  schemaName?: string;
  /** スキーマの URL から推定した S1000D の版（例: "7", "5.0", "4.2"）。推定できなければ undefined */
  issue?: string;
  /** DOCTYPE の内部サブセットに ENTITY 宣言があるか */
  hasEntityDeclarations: boolean;
  identAndStatus?: IdentAndStatus;
}
