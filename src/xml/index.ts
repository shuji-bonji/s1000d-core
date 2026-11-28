export {
  XPathError,
  XmlParseError,
  type Document,
  type Element,
  type Node,
  type ParsedXml,
  type XPathValue,
  type XmlEngine,
  type XmlParseIssue,
} from './engine.js';
export { XmldomFontoxpathEngine, defaultXmlEngine, stripBom } from './xmldom-fontoxpath.js';
export {
  attributeInsertPosition,
  escapeAttributeValue,
  rangeOfElement,
  rangesMatchDocument,
  removeAttributeSplice,
  scanAttributes,
  scanElementRanges,
  setAttributeSplice,
  type AttributeRange,
  type ElementRange,
  type TextSplice,
} from './ranges.js';
