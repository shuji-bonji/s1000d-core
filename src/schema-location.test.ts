import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUILD_ISSUE,
  buildSchemaLocation,
  isIssueString,
  parseSchemaLocation,
} from './schema-location.js';

describe('buildSchemaLocation', () => {
  it('版を省くと Issue 7 の URL になる', () => {
    expect(DEFAULT_BUILD_ISSUE).toBe('7');
    expect(buildSchemaLocation('descript')).toBe(
      'http://www.s1000d.org/S1000D_7/xml_schema_flat/descript.xsd',
    );
  });
  it('ピリオドをハイフンに替える（4.2 → S1000D_4-2）', () => {
    expect(buildSchemaLocation('proced', '4.2')).toBe(
      'http://www.s1000d.org/S1000D_4-2/xml_schema_flat/proced.xsd',
    );
    expect(buildSchemaLocation('pm', '4.0.1')).toBe(
      'http://www.s1000d.org/S1000D_4-0-1/xml_schema_flat/pm.xsd',
    );
  });
  it('作った URL を parseSchemaLocation で読むと、元の版とスキーマ名に戻る', () => {
    for (const issue of ['7', '6', '5.0', '4.2', '4.1', '4.0']) {
      expect(parseSchemaLocation(buildSchemaLocation('fault', issue))).toEqual({
        schemaName: 'fault',
        issue,
      });
    }
  });
  it('版の書き方として読めないものは RangeError', () => {
    for (const bad of ['', '4-2', 'Issue 7', '4.', '.2', '7/../x'])
      expect(() => buildSchemaLocation('descript', bad)).toThrowError(RangeError);
  });
});

describe('isIssueString', () => {
  it('数字をピリオドで区切ったものだけを通す', () => {
    expect(isIssueString('7')).toBe(true);
    expect(isIssueString('4.2')).toBe(true);
    expect(isIssueString('4-2')).toBe(false);
    expect(isIssueString(7)).toBe(false);
    expect(isIssueString(undefined)).toBe(false);
  });
});
