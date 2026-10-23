/**
 * XML の読み取りと XPath の評価を 1 つのインターフェースに閉じ込める。
 *
 * 実装は `xmldom-fontoxpath.ts`（@xmldom/xmldom ＋ fontoxpath）。
 * ライブラリを差し替えるときは、このインターフェースの実装を 1 つ足せばよい（DECISIONS D-12、U-08）。
 *
 * 既定 BREX の objectPath には XPath 2.0 の構文（`for … return some … satisfies`）が 1 件含まれるため、
 * 実装は XPath 2.0 以上を評価できる必要がある。
 */
import type { Document, Node } from '@xmldom/xmldom';

export type { Document, Element, Node } from '@xmldom/xmldom';

/** XPath の評価結果。節点集合は配列、それ以外は文字列・数値・真偽値。 */
export type XPathValue = Node[] | string | number | boolean | null;

export interface XmlParseIssue {
  level: 'warning' | 'error' | 'fatalError';
  message: string;
}

export class XmlParseError extends Error {
  constructor(
    message: string,
    public readonly issues: XmlParseIssue[],
  ) {
    super(message);
    this.name = 'XmlParseError';
  }
}

export interface ParsedXml {
  document: Document;
  /** 致命的でない警告・エラー */
  issues: XmlParseIssue[];
  /** DOCTYPE の内部サブセットに ENTITY 宣言があるか */
  hasEntityDeclarations: boolean;
}

export interface XmlEngine {
  /** XML 文字列を読む。致命的なエラーがあれば XmlParseError を投げる。 */
  parse(xml: string): ParsedXml;
  /** XPath を評価する。節点集合なら配列、それ以外は値を返す。式の誤りは XPathError を投げる。 */
  evaluate(expression: string, context: Node): XPathValue;
  /** 節点集合だけを返す。節点集合以外の結果は空配列。 */
  selectNodes(expression: string, context: Node): Node[];
  /** 最初の節点の文字列値、または値の文字列表現。結果が無ければ undefined。 */
  selectString(expression: string, context: Node): string | undefined;
  /** 式が構文として正しいかを、文書を読まずに確かめる。 */
  validateExpression(expression: string): { ok: true } | { ok: false; error: string };
}

export class XPathError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
  ) {
    super(message);
    this.name = 'XPathError';
  }
}
