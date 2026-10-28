/**
 * 入力の形の誤り。XSD 検証の代わりではなく、XML を組み立てる前に分かる誤り
 * （置けない `kind`、足りない採番の規則、存在しない参照先 id など）を、位置付きで知らせる。
 */
export class DraftInputError extends Error {
  /**
   * 誤りの位置。XPath 風に、入力の木をたどる。要素の番号は 1 から数える
   * （例: `/body[2]/children[1]`、`/allocation/rules/infoCodeByKind/proced`、`/draft/title`）。
   */
  readonly path: string;
  /** 位置を除いた説明 */
  readonly detail: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'DraftInputError';
    this.path = path;
    this.detail = detail;
  }
}
