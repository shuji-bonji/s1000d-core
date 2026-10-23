/**
 * XmlEngine の実装: @xmldom/xmldom（DOM）＋ fontoxpath（XPath 3.1）。
 *
 * 2026-10-23 の実測（Issue 7 既定 BREX の objectPath 274 件 × Bike Samples 106 件）:
 * fontoxpath は 274 件すべてを構文解析・評価でき、xmldom の Document をそのまま文脈に取れる。
 * 純 XPath 1.0 の `xpath` パッケージは 2 件（XPath 2.0 構文 1 件、`not (` の空白 1 件）で失敗した。
 */
import { DOMParser } from '@xmldom/xmldom';
import type { Document, Node } from '@xmldom/xmldom';
import fontoxpath from 'fontoxpath';
import { XPathError, XmlParseError } from './engine.js';
import type { ParsedXml, XPathValue, XmlEngine, XmlParseIssue } from './engine.js';

const { evaluateXPath } = fontoxpath;

export class XmldomFontoxpathEngine implements XmlEngine {
  parse(xml: string): ParsedXml {
    const issues: XmlParseIssue[] = [];
    const parser = new DOMParser({
      onError: (level, message) => {
        issues.push({ level, message });
      },
    });
    let document: Document;
    try {
      // xmldom 0.9 は致命的なエラーを onError に渡さず ParseError を投げる
      document = parser.parseFromString(xml, 'text/xml') as Document;
    } catch (e) {
      const message = (e as Error).message;
      issues.push({ level: 'fatalError', message });
      throw new XmlParseError(message, issues);
    }
    const fatal = issues.filter((i) => i.level === 'fatalError');
    if (fatal.length > 0 || !document.documentElement) {
      throw new XmlParseError(fatal[0]?.message ?? 'XML has no document element', issues);
    }
    const internalSubset = document.doctype?.internalSubset ?? '';
    return {
      document,
      issues,
      hasEntityDeclarations: /<!ENTITY\s/.test(internalSubset),
    };
  }

  evaluate(expression: string, context: Node): XPathValue {
    // 1. まず節点集合として評価する。ANY_TYPE は属性を文字列に原子化してしまい、
    //    違反箇所（行番号・パス）を失うため、節点が得られるならそれを優先する。
    try {
      return evaluateXPath(expression, context, null, null, evaluateXPath.NODES_TYPE) as Node[];
    } catch {
      // 節点集合でない結果（真偽値・数値・文字列）か、構文エラー。次で判別する
    }
    try {
      // 2. ANY_TYPE: 原子値はそのまま返る。節点 1 つの結果は配列に包まれないので揃える
      const r: unknown = evaluateXPath(expression, context, null, null, evaluateXPath.ANY_TYPE);
      if (r !== null && typeof r === 'object' && !Array.isArray(r) && 'nodeType' in (r as object)) {
        return [r as Node];
      }
      return r as XPathValue;
    } catch (e) {
      throw new XPathError((e as Error).message, expression);
    }
  }

  selectNodes(expression: string, context: Node): Node[] {
    const r = this.evaluate(expression, context);
    return Array.isArray(r) ? r : [];
  }

  selectString(expression: string, context: Node): string | undefined {
    const r = this.evaluate(expression, context);
    if (r === null || r === undefined) return undefined;
    if (Array.isArray(r)) {
      const first = r[0];
      if (!first) return undefined;
      return first.textContent ?? undefined;
    }
    return String(r);
  }

  validateExpression(expression: string): { ok: true } | { ok: false; error: string } {
    try {
      // 文脈無しで評価すると、構文エラーは例外、文脈依存のエラー（XPDY0002）は構文が正しい証拠
      evaluateXPath(expression, null, null, null, evaluateXPath.ANY_TYPE);
      return { ok: true };
    } catch (e) {
      const message = (e as Error).message;
      if (/XPDY0002|XPST0008/.test(message)) return { ok: true };
      return { ok: false, error: message.split('\n')[0] };
    }
  }
}

/** 既定のエンジン。アプリケーション全体で 1 つ使い回せる（状態を持たない）。 */
export const defaultXmlEngine: XmlEngine = new XmldomFontoxpathEngine();
