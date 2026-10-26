/**
 * 修正提案（`Fix`）の型。
 *
 * 設計: s1000d-stack の docs/design/agent-platform.md「修正提案の設計」（段階 2.5、D-19）。
 * 候補を決めるのは core（決定論的）で、LLM は候補の中から選んで説明するだけにする（D-18 と同じ境界）。
 * 点数は出さず、確からしさは `confidence` の 3 段階で表す。
 */
import type { NodeLocation, ValueForm } from '../brex/types.js';

export type FixKind =
  | 'brex-value'
  | 'brex-forbidden'
  | 'brex-missing'
  | 'brex-notation'
  | 'schema'
  | 'reference'
  | 'applicability';

/**
 * 直し方の種類。
 * - replace: 値（または要素名・属性名）を置き換える
 * - remove: 要素・属性・文字を取り除く
 * - add: 要素・属性・宣言を足す
 * - retarget: 参照先を別の対象に向け直す
 * - provide: 文書ではなく、判定に使う入力（製品の属性など）に値を与える
 */
export type FixAction = 'replace' | 'remove' | 'add' | 'retarget' | 'provide';

export interface FixCandidate {
  action: FixAction;
  /** 置き換える値・足す値・向け直す先。値の決まらない候補（取り除くなど）では undefined */
  value?: string;
  /**
   * `value` の書き方。single = その値そのもの、range = `a~b` や `|` 区切りの範囲、pattern = XSD の正規表現。
   * 省略時は single。range / pattern のときは、その範囲・正規表現に合う値を利用者が決める
   */
  valueForm?: ValueForm;
  /** 直す対象（属性名 `@name`、要素名、`issueInfo`、製品の属性 id など）。場所だけで分かるときは省略 */
  target?: string;
  /** 人が読む説明（BREX の objectValue の文章、XSD の定義の名前など） */
  description: string;
}

export type FixConfidence =
  /** 候補が 1 つで、値も決まっている */
  | 'exact'
  /** 候補が複数ある、または値を範囲・正規表現の中から選ぶ */
  | 'several'
  /** 候補を決められない（利用者に聞く） */
  | 'none';

export interface Fix {
  /** 何に対する提案か */
  kind: FixKind;
  /** 違反の場所（XPath と行） */
  location?: NodeLocation;
  /** 何が問題か（元の結果の文章） */
  problem: string;
  /** 直し方の候補。空なら「候補を決められない」 */
  candidates: FixCandidate[];
  /** 候補の確からしさ */
  confidence: FixConfidence;
  /** 候補の出どころ（BREX のルール ID、XSD の定義、CsdbIndex など）。LLM が「なぜその候補か」を説明するのに使う */
  source: string;
  /** 候補を決められない理由や、候補を選ぶときの注意（仕様書への参照である、など） */
  note?: string;
  /** BREX 違反のとき、ルールの重大度（brSeverityLevel。解釈しない） */
  brSeverityLevel?: string;
}

/** 候補の並びから確からしさを決める */
export function confidenceOf(candidates: FixCandidate[]): FixConfidence {
  if (candidates.length === 0) return 'none';
  if (candidates.length > 1) return 'several';
  const c = candidates[0];
  if (c.valueForm === 'range' || c.valueForm === 'pattern') return 'several';
  if (c.action === 'remove') return 'exact';
  return c.value !== undefined ? 'exact' : 'several';
}
