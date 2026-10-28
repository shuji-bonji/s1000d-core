/**
 * BREX（Business Rules Exchange）データモジュールの読み取り結果と、照合結果の型。
 *
 * 根拠: S1000D Issue 7 Chap 4.10.2（BREX data module）、4.10.2.1〜4.10.2.4、4.10.3、7.9。
 * 要素名・属性名は仕様書の名前に合わせる。
 */
import type { CommentCode } from '../comment/types.js';
import type { DmCode, DmRef, IssueInfo, PmCode } from '../types.js';

/** `objectPath/@allowedObjectFlag`: 0 = 使ってはならない、1 = 必ず含める、2 = 任意 */
export type AllowedObjectFlag = '0' | '1' | '2';

/** `objectValue/@valueForm` */
export type ValueForm = 'single' | 'range' | 'pattern';

/** `objectValue/@valueTailoring`（既定は closed） */
export type ValueTailoring = 'restrictable' | 'lexical' | 'closed';

export interface BrexObjectValue {
  valueForm: ValueForm;
  /** `@valueAllowed`。無いときは undefined（説明だけの objectValue） */
  valueAllowed?: string;
  valueTailoring: ValueTailoring;
  /** 要素の本文（値の意味の説明） */
  description: string;
}

/** `structureObjectRule` 1 件 */
export interface BrexStructureRule {
  kind: 'structure';
  /** `brDecisionRef/@brDecisionIdentNumber`（既定 BREX では BREX-S1-NNNNN） */
  ruleId?: string;
  /** `@id` */
  id?: string;
  objectPath: string;
  allowedObjectFlag: AllowedObjectFlag;
  /** 人が読む説明（`objectUse` の文字列） */
  objectUse: string;
  objectValues: BrexObjectValue[];
  /** `@brSeverityLevel`（無ければ brex/@defaultBrSeverityLevel を使う） */
  brSeverityLevel?: string;
  /** 所属する `contextRules/@rulesContext`。共通ルールなら undefined */
  rulesContext?: string;
}

/** `notationRule` 1 件 */
export interface BrexNotationRule {
  kind: 'notation';
  ruleId?: string;
  id?: string;
  notationName: string;
  /** 0 = その文脈では禁止、1 = 許可。無いときは undefined */
  allowedNotationFlag?: '0' | '1';
  objectUse: string;
  brSeverityLevel?: string;
  rulesContext?: string;
}

/** `nonContextRule` 1 件（機械では判定できない。手動確認の項目） */
export interface BrexNonContextRule {
  kind: 'nonContext';
  ruleId?: string;
  id?: string;
  text: string;
  brSeverityLevel?: string;
}

/** `contextRules` 1 ブロック */
export interface BrexContextRules {
  /** `@rulesContext`（対象スキーマの URL）。省略時はすべてのスキーマに共通 */
  rulesContext?: string;
  structureRules: BrexStructureRule[];
  notationRules: BrexNotationRule[];
}

export interface SnsNode {
  snsCode: string;
  snsTitle: string;
  children: SnsNode[];
}

/** `snsRules/snsDescr` 1 件 */
export interface SnsDescription {
  systems: SnsNode[];
}

/** BREX データモジュール全体 */
export interface BrexDocument {
  dmCode: DmCode;
  issueInfo?: IssueInfo;
  /** 題名（techName / infoName） */
  title?: string;
  /** この BREX が従う上位の BREX。既定 BREX は自分自身を指す */
  brexDmRef?: DmRef;
  /** `brex/@defaultBrSeverityLevel` */
  defaultBrSeverityLevel?: string;
  /** `brex/commonInfo` の文字列 */
  commonInfo?: string;
  snsRules: SnsDescription[];
  contextRules: BrexContextRules[];
  nonContextRules: BrexNonContextRule[];
}

/** 違反の種類 */
export type ViolationKind =
  /** allowedObjectFlag=0 の対象が存在した */
  | 'forbidden'
  /** allowedObjectFlag=1 の対象が存在しなかった */
  | 'missing'
  /** 対象の値が objectValue のどれにも合わなかった */
  | 'value'
  /** 対象の DM が使う NOTATION が許可されていない */
  | 'notation';

export interface NodeLocation {
  /** ルートからの簡易なパス（例: /dmodule/content/description/levelledPara[2]/para） */
  path: string;
  line?: number;
  column?: number;
}

export interface BrexViolation {
  kind: ViolationKind;
  ruleId?: string;
  objectPath?: string;
  objectUse: string;
  brSeverityLevel?: string;
  rulesContext?: string;
  location?: NodeLocation;
  actualValue?: string;
  /**
   * value 違反のとき、許可されている値の一覧（valueAllowed）。
   * notation 違反のとき、使ってよい NOTATION の集合（集合が決まっている層だけ。除外だけの層では undefined）
   */
  allowedValues?: string[];
}

/** XPath を評価できなかったルール */
export interface SkippedRule {
  ruleId?: string;
  objectPath: string;
  error: string;
}

/** BREX 1 層に対する照合結果 */
export interface BrexLayerReport {
  brex: { dmCode: DmCode; issueInfo?: IssueInfo; title?: string };
  /** 対象 DM のスキーマに当てはまり、評価したルールの数 */
  evaluatedRules: number;
  violations: BrexViolation[];
  skipped: SkippedRule[];
  /** 手動で確認する項目（nonContextRules） */
  manualChecks: BrexNonContextRule[];
}

/** 連鎖全体に対する照合結果 */
export interface BrexCheckReport {
  target: {
    dmCode?: DmCode;
    /** ルートが pm のとき */
    pmCode?: PmCode;
    /** ルートが comment のとき */
    commentCode?: CommentCode;
    schemaLocation?: string;
    schemaName?: string;
  };
  layers: BrexLayerReport[];
  /** 連鎖の中で見つからなかった BREX */
  unresolved: DmRef[];
  /** どの層にも違反が無く、評価できなかったルールも無いとき true */
  passed: boolean;
}
