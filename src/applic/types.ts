/**
 * 適用性（applicability）の型。
 *
 * 根拠: S1000D Issue 7 Chap 3.9.5（適用性）。要素名・属性名は仕様書の名前に合わせる。
 * Bike Samples の実測（2026-10-25）: `assert` 627 件、`evaluate` 406 件（and 320 / or 86、入れ子 82）、
 * `applicPropertyValues` の書き方は単一値・`|` 区切り・`a~b` の範囲（`1~3`、`POST-001~POST-999`、`0010|0023|0056~0062`）。
 */
import type { NodeLocation } from '../brex/types.js';
import type { DmRef } from '../types.js';

/** `assert` 1 件、または `evaluate`（and / or で子を結ぶ） */
export type ApplicExpr =
  | {
      kind: 'assert';
      /** `@applicPropertyIdent`（ACT の productAttribute/@id か CCT の cond/@id） */
      propertyIdent: string;
      /** `@applicPropertyType`: prodattr / condition */
      propertyType: 'prodattr' | 'condition' | string;
      /** `@applicPropertyValues`（単一値・`|` 区切り・`a~b` の範囲） */
      values: string;
    }
  | {
      kind: 'evaluate';
      andOr: 'and' | 'or';
      children: ApplicExpr[];
    };

/** `applic` 要素 1 つ（識別・状態部のもの、referencedApplicGroup のもの、適用性リポジトリのもの） */
export interface ApplicStatement {
  /** `@id`（referencedApplicGroup の中では必須） */
  id?: string;
  /** `@applicIdentValue`（適用性リポジトリで、別の DM から参照されるときの識別子） */
  applicIdentValue?: string;
  /** `displayText` の文字列。人が読む適用範囲 */
  displayText?: string;
  /** 式。無ければ「すべてに当てはまる」と読む（displayText だけの applic） */
  expr?: ApplicExpr;
  /** 識別・状態部の applic（DM 全体の適用性）なら true */
  isDmLevel: boolean;
  location: NodeLocation;
}

/** ACT の `productAttribute` */
export interface ProductAttribute {
  id: string;
  name?: string;
  displayName?: string;
  descr?: string;
  /** `@valueDataType`（string / integer / real / boolean / date など） */
  valueDataType?: string;
  /** `@valuePattern`（正規表現） */
  valuePattern?: string;
  /** `enumeration/@applicPropertyValues` の一覧 */
  enumerations: string[];
  /** `@productIdentifier="primary"` なら製品を識別する属性 */
  productIdentifier?: string;
}

/** ACT（applicCrossRefTable、情報コード 00W） */
export interface Act {
  productAttributes: ProductAttribute[];
  condCrossRefTableRef?: DmRef;
  productCrossRefTableRef?: DmRef;
}

/** CCT の `condType` */
export interface CondType {
  id: string;
  name?: string;
  descr?: string;
  valueDataType?: string;
  enumerations: string[];
}

/** CCT の `cond` */
export interface Cond {
  id: string;
  condTypeRefId: string;
  name?: string;
  descr?: string;
}

/** CCT（condCrossRefTable、情報コード 00Q） */
export interface Cct {
  condTypes: CondType[];
  conds: Cond[];
}

/** PCT（productCrossRefTable、情報コード 00P）の `product` 1 件 */
export interface PctProduct {
  id?: string;
  assigns: Array<{ propertyIdent: string; propertyType: string; value: string }>;
}

export interface Pct {
  products: PctProduct[];
}

/** 判定に使う製品。reader の `product` 引数、または PCT の 1 行から作る */
export interface Product {
  /** ACT の productAttribute/@id → 値 */
  attributes: Record<string, string>;
  /** CCT の cond/@id → 値 */
  conditions: Record<string, string>;
}

export type ApplicState = 'applicable' | 'notApplicable' | 'undetermined';

export interface ApplicResult {
  state: ApplicState;
  /** 判定に使った applic の displayText */
  displayText?: string;
  /** 判定に使った applic の id */
  applicId?: string;
  /** undetermined の理由 */
  reason?: string;
  /** 式に出てきたが product に無かった属性・条件 */
  missingProperties?: string[];
}
