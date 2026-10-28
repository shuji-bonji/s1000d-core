/**
 * comment の入力の誤り。XSD 検証の代わりではなく、XML を組み立てる前に分かる誤り
 * （列挙外の値、混在した参照の種類、足りない必須項目など）を位置付きで知らせる。
 * write/ の `DraftInputError` と同じ形（`path` は XPath 風に入力の木をたどる。例: `/refs[2]/code`）。
 */
export class CommentInputError extends Error {
  /** 誤りの位置（入力の木。要素の番号は 1 から） */
  readonly path: string;
  /** 位置を除いた説明 */
  readonly detail: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'CommentInputError';
    this.path = path;
    this.detail = detail;
  }
}
