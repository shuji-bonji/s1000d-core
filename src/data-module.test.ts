import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readDataModuleInfo } from './data-module.js';
import { formatDmc } from './dmc.js';
import { XmlParseError, defaultXmlEngine } from './xml/index.js';

const fixture = readFileSync(
  fileURLToPath(new URL('./__fixtures__/kenbaiki-descript.xml', import.meta.url)),
  'utf8',
);

describe('readDataModuleInfo', () => {
  it('種類・版・ENTITY 宣言の有無を読む', () => {
    const info = readDataModuleInfo(fixture);
    expect(info.rootElement).toBe('dmodule');
    expect(info.schemaName).toBe('descript');
    expect(info.issue).toBe('7');
    expect(info.hasEntityDeclarations).toBe(true);
  });

  it('識別・状態部を読む', () => {
    const ident = readDataModuleInfo(fixture).identAndStatus;
    expect(ident).toBeDefined();
    if (!ident) return;
    expect(formatDmc(ident.dmCode)).toBe('KENBAIKI-A-10-20-00-00A-040A-D');
    expect(ident.language).toEqual({ languageIsoCode: 'ja', countryIsoCode: 'JP' });
    expect(ident.issueInfo).toEqual({ issueNumber: '002', inWork: '01' });
    expect(ident.issueDate).toBe('2026-10-23');
    expect(ident.techName).toBe('指定席券売機');
    expect(ident.infoName).toBe('説明');
    expect(ident.issueType).toBe('changed');
    expect(ident.securityClassification).toBe('01');
    expect(ident.responsiblePartnerCompany).toEqual({
      enterpriseCode: 'K0001',
      enterpriseName: 'Kenbaiki Works',
    });
    expect(ident.applicDisplayText).toBe('タッチパネル式、2 号機以降');
    expect(ident.qualityAssurance).toBe('firstVerification');
    expect(ident.brexDmRef).toBeDefined();
    expect(formatDmc(ident.brexDmRef!.dmCode)).toBe('KENBAIKI-A-00-00-00-00A-022A-D');
    expect(ident.brexDmRef!.issueInfo).toEqual({ issueNumber: '001', inWork: '00' });
  });

  it('dmodule 以外のルートでは識別・状態部を持たない', () => {
    const info = readDataModuleInfo(
      '<pm xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/pm.xsd"/>',
    );
    expect(info.rootElement).toBe('pm');
    expect(info.schemaName).toBe('pm');
    expect(info.issue).toBe('4.2');
    expect(info.identAndStatus).toBeUndefined();
  });

  it('壊れた XML は XmlParseError', () => {
    expect(() => readDataModuleInfo('<dmodule><identAndStatusSection></dmodule>')).toThrow(
      XmlParseError,
    );
  });
});

describe('XmlEngine', () => {
  it('XPath 2.0 以降の構文を評価できる（既定 BREX に含まれるため）', () => {
    const { document } = defaultXmlEngine.parse('<a><b n="1"/><b n="2"/></a>');
    const r = defaultXmlEngine.evaluate('for $x in //b return number($x/@n)', document);
    expect(r).toEqual([1, 2]);
    expect(defaultXmlEngine.evaluate('count(//b) = 2', document)).toBe(true);
  });

  it('not ( の空白を受け付ける', () => {
    const v = defaultXmlEngine.validateExpression('//a[not (@x)]');
    expect(v.ok).toBe(true);
  });

  it('構文の誤りを検出する', () => {
    const v = defaultXmlEngine.validateExpression('//a[');
    expect(v.ok).toBe(false);
  });
});
