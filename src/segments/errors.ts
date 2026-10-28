/**
 * 文の抜き出し・差し戻しの誤り。
 */

/** 抜き出しのときの骨組みと、差し戻す DM の骨組みが違う（DM が変わっている）。訳文は適用しない */
export class SkeletonMismatchError extends Error {
  readonly code = 'skeleton-mismatch' as const;
  /** 呼び出し側が持っていた `skeletonHash`（抜き出しのときの値） */
  readonly expected: string;
  /** いま渡された DM から計算した値 */
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(
      `The data module changed since the segments were extracted (skeletonHash ${expected} != ${actual}). Extract the segments again.`,
    );
    this.name = 'SkeletonMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

export type SegmentsErrorCode = 'not-a-data-module' | 'invalid-data-module' | 'no-language';

/** 文を出し入れできない DM（`dmodule` でない、DMC を読めない、`language` が無い） */
export class SegmentsError extends Error {
  readonly code: SegmentsErrorCode;

  constructor(code: SegmentsErrorCode, message: string) {
    super(message);
    this.name = 'SegmentsError';
    this.code = code;
  }
}
