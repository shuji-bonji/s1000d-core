import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAgainstBrexLayer, resolveBrexChain, findDefaultBrex } from '../brex/index.js';
import { CsdbIndex } from '../csdb-index.js';
import { classifyCsdbFileName, MemoryCsdbSource } from '../csdb-source.js';
import { createDirectoryBrexResolver } from '../csdb.js';
import { readDmRef } from '../data-module.js';
import { parseDmc } from '../dmc.js';
import type { DmCode } from '../types.js';
import { findSchemaDirs, locateXsd } from '../verify/schemas.js';
import { defaultXmlEngine } from '../xml/index.js';
import { Libxml2SchemaValidator } from '../xsd-libxml2.js';
import { buildComment, type BuildCommentOptions } from './build.js';
import {
  formatCommentCode,
  formatCommentFileName,
  parseCommentCode,
  parseCommentFileName,
} from './code.js';
import { CommentInputError } from './errors.js';
import type { CommentInput } from './types.js';

/**
 * 自作の最小スキーマ。必須要素と順序だけを持ち、S1000D の XSD の内容は含まない。
 * （列挙・桁数の検査は buildComment 側のテストで行う）
 */
const MINI_COMMENT_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="anyAttrs">
    <xs:sequence><xs:any minOccurs="0" maxOccurs="unbounded" processContents="lax"/></xs:sequence>
    <xs:anyAttribute processContents="lax"/>
  </xs:complexType>
  <xs:element name="comment">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="identAndStatusSection">
          <xs:complexType>
            <xs:sequence>
              <xs:element name="commentAddress">
                <xs:complexType>
                  <xs:sequence>
                    <xs:element name="commentIdent">
                      <xs:complexType>
                        <xs:sequence>
                          <xs:element name="commentCode">
                            <xs:complexType>
                              <xs:attribute name="modelIdentCode" use="required"/>
                              <xs:attribute name="senderIdent" use="required"/>
                              <xs:attribute name="yearOfDataIssue" use="required"/>
                              <xs:attribute name="seqNumber" use="required"/>
                              <xs:attribute name="commentType" use="required"/>
                            </xs:complexType>
                          </xs:element>
                          <xs:element name="language" type="anyAttrs"/>
                        </xs:sequence>
                      </xs:complexType>
                    </xs:element>
                    <xs:element name="commentAddressItems">
                      <xs:complexType>
                        <xs:sequence>
                          <xs:element name="commentTitle" type="xs:string" minOccurs="0"/>
                          <xs:element name="issueDate" type="anyAttrs"/>
                          <xs:element name="commentOriginator">
                            <xs:complexType>
                              <xs:sequence>
                                <xs:element name="dispatchAddress">
                                  <xs:complexType>
                                    <xs:sequence>
                                      <xs:element name="enterprise" type="anyAttrs"/>
                                      <xs:element name="dispatchPerson" type="anyAttrs" minOccurs="0"/>
                                      <xs:element name="address">
                                        <xs:complexType>
                                          <xs:sequence>
                                            <xs:any minOccurs="0" maxOccurs="unbounded" processContents="lax" namespace="##local"/>
                                          </xs:sequence>
                                        </xs:complexType>
                                      </xs:element>
                                    </xs:sequence>
                                  </xs:complexType>
                                </xs:element>
                              </xs:sequence>
                            </xs:complexType>
                          </xs:element>
                        </xs:sequence>
                      </xs:complexType>
                    </xs:element>
                  </xs:sequence>
                </xs:complexType>
              </xs:element>
              <xs:element name="commentStatus">
                <xs:complexType>
                  <xs:sequence>
                    <xs:element name="security" type="anyAttrs"/>
                    <xs:element name="commentPriority" type="anyAttrs"/>
                    <xs:element name="commentResponse" type="anyAttrs" minOccurs="0"/>
                    <xs:element name="commentRefs">
                      <xs:complexType>
                        <xs:choice>
                          <xs:element name="noReferences"/>
                          <xs:element name="dmRefGroup" type="anyAttrs"/>
                          <xs:element name="dmlRefGroup" type="anyAttrs"/>
                          <xs:element name="pmRefGroup" type="anyAttrs"/>
                          <xs:element name="ddnRefGroup" type="anyAttrs"/>
                        </xs:choice>
                      </xs:complexType>
                    </xs:element>
                    <xs:element name="brexDmRef" type="anyAttrs"/>
                    <xs:element name="remarks" type="anyAttrs" minOccurs="0"/>
                  </xs:sequence>
                  <xs:attribute name="issueType"/>
                </xs:complexType>
              </xs:element>
            </xs:sequence>
          </xs:complexType>
        </xs:element>
        <xs:element name="commentContent">
          <xs:complexType>
            <xs:sequence><xs:element name="simplePara" type="xs:string" maxOccurs="unbounded"/></xs:sequence>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const parsedBrex = parseDmc('S1000DBIKE-AAA-D00-00-00-00AA-022A-D');
if (!parsedBrex.ok) throw new Error('fixture: BREX DMC');
const BREX: DmCode = parsedBrex.value;

const base = (over: Partial<CommentInput> = {}): CommentInput => ({
  refs: [
    {
      kind: 'dmRef',
      code: 'S1000DBIKE-AAA-D00-00-00-00AA-041A-A',
      issueInfo: { issueNumber: '001', inWork: '00' },
    },
  ],
  commentType: 'q',
  commentPriorityCode: 'cp01',
  title: '手順 3 の文について',
  paragraphs: ['手順 3 の「締める」は <トルク値> & 工具を示してください。'],
  originator: {
    enterpriseCode: 'B6865',
    enterpriseName: 'Example Co.',
    address: { city: 'Tokyo', country: 'Japan' },
  },
  senderIdent: 'B6865',
  modelIdentCode: 'S1000DBIKE',
  securityClassification: '01',
  language: { languageIsoCode: 'ja', countryIsoCode: 'JP' },
  brexDmRef: BREX,
  ...over,
});

const FIXED_NOW = () => new Date(2026, 9, 28);
const opts = (o: BuildCommentOptions = {}): BuildCommentOptions => ({ now: FIXED_NOW, ...o });

let root: string;
let miniXsd: string;
const validator = new Libxml2SchemaValidator();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 's1000d-core-comment-'));
  miniXsd = join(root, 'comment.xsd');
  writeFileSync(miniXsd, MINI_COMMENT_XSD);
});
afterAll(() => {
  validator.dispose();
  rmSync(root, { recursive: true, force: true });
});

async function validate(xml: string, xsd = miniXsd) {
  const schema = await validator.load(xsd);
  return schema.validate(xml, { url: 'comment.xml' });
}

describe('buildComment: 自作の最小 XSD', () => {
  it('必須要素と順序を満たし valid になる', async () => {
    const r = buildComment(base(), opts());
    const v = await validate(r.xml);
    expect(v.errors).toEqual([]);
    expect(v.valid).toBe(true);
    expect(r.xml).toContain(
      'xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_7/xml_schema_flat/comment.xsd"',
    );
    expect(r.commentCode).toEqual({
      modelIdentCode: 'S1000DBIKE',
      senderIdent: 'B6865',
      yearOfDataIssue: '2026',
      seqNumber: '00001',
      commentType: 'q',
    });
    expect(r.fileName).toBe('COM-S1000DBIKE-B6865-2026-00001-Q_JA-JP.XML');
  });

  it('要素の並びが XSD どおり（identAndStatusSection の子、commentStatus の子）', () => {
    const { xml } = buildComment(
      base({ responseType: 'rt01', remarks: ['備考'], issueType: 'new' }),
      opts(),
    );
    const doc = defaultXmlEngine.parse(xml).document;
    const names = (xpath: string) =>
      defaultXmlEngine
        .selectNodes(xpath, doc)
        .map((n) => (n as unknown as { nodeName: string }).nodeName);
    expect(names('/comment/*')).toEqual(['identAndStatusSection', 'commentContent']);
    expect(names('/comment/identAndStatusSection/commentAddress/*')).toEqual([
      'commentIdent',
      'commentAddressItems',
    ]);
    expect(names('//commentAddressItems/*')).toEqual([
      'commentTitle',
      'issueDate',
      'commentOriginator',
    ]);
    expect(names('//dispatchAddress/*')).toEqual(['enterprise', 'address']);
    expect(names('//commentStatus/*')).toEqual([
      'security',
      'commentPriority',
      'commentResponse',
      'commentRefs',
      'brexDmRef',
      'remarks',
    ]);
  });

  it('refs が空なら noReferences になり、valid', async () => {
    const r = buildComment(base({ refs: [] }), opts());
    expect(r.xml).toContain('<noReferences/>');
    expect(r.xml).not.toContain('dmRefGroup');
    expect((await validate(r.xml)).valid).toBe(true);
  });

  it('参照の 4 種（dmRef / pmRef / dmlRef / ddnRef）を組み立てる', async () => {
    const cases: [CommentInput['refs'], string][] = [
      [
        [
          {
            kind: 'dmRef',
            code: 'DMC-S1000DBIKE-AAA-D00-00-00-00AA-041A-A',
            language: { languageIsoCode: 'EN', countryIsoCode: 'us' },
          },
        ],
        '<dmRefGroup>',
      ],
      [
        [
          {
            kind: 'pmRef',
            code: 'S1000DBIKE-B6865-EPWG1-00',
            issueInfo: { issueNumber: '006', inWork: '00' },
          },
        ],
        '<pmRefGroup>',
      ],
      [[{ kind: 'dmlRef', code: 'S1000DBIKE-B6865-S-2026-00001' }], '<dmlRefGroup>'],
      [[{ kind: 'ddnRef', code: 'S1000DBIKE-B6865-B6865-2026-00001' }], '<ddnRefGroup>'],
    ];
    for (const [refs, tag] of cases) {
      const r = buildComment(base({ refs }), opts());
      expect(r.xml).toContain(tag);
      expect((await validate(r.xml)).valid).toBe(true);
    }
    const dml = buildComment(base({ refs: cases[2]![0] }), opts()).xml;
    expect(dml).toContain(
      '<dmlCode modelIdentCode="S1000DBIKE" senderIdent="B6865" dmlType="s" yearOfDataIssue="2026" seqNumber="00001"/>',
    );
    const dm = buildComment(base({ refs: cases[0]![0] }), opts()).xml;
    expect(dm).toContain('<language languageIsoCode="en" countryIsoCode="US"/>');
  });

  it('同じ種類の参照は 1 つの群に複数入る。種類の混在は入力の誤り', () => {
    const two = buildComment(
      base({
        refs: [
          { kind: 'dmRef', code: 'S1000DBIKE-AAA-D00-00-00-00AA-041A-A' },
          { kind: 'dmRef', code: 'S1000DBIKE-AAA-D00-00-00-00AA-042A-A' },
        ],
      }),
      opts(),
    );
    expect(two.xml.match(/<dmRefGroup>/g)).toHaveLength(1);
    expect(two.xml.match(/<dmRef>/g)).toHaveLength(3); // 参照 2 件 + brexDmRef
    expect(() =>
      buildComment(
        base({
          refs: [
            { kind: 'dmRef', code: 'S1000DBIKE-AAA-D00-00-00-00AA-041A-A' },
            { kind: 'pmRef', code: 'S1000DBIKE-B6865-EPWG1-00' },
          ],
        }),
        opts(),
      ),
    ).toThrow(/\/refs\[2\]\/kind.*only one kind/);
  });

  it('参照の誤り: コードの形、ddnRef の版、dmlRef の言語', () => {
    const err = (refs: CommentInput['refs']) => {
      try {
        buildComment(base({ refs }), opts());
      } catch (e) {
        return e as CommentInputError;
      }
      throw new Error('no error');
    };
    expect(err([{ kind: 'dmRef', code: 'nope' }]).path).toBe('/refs[1]/code');
    expect(
      err([
        {
          kind: 'ddnRef',
          code: 'S1000DBIKE-B6865-B6865-2026-00001',
          issueInfo: { issueNumber: '001', inWork: '00' },
        },
      ]).path,
    ).toBe('/refs[1]/issueInfo');
    expect(
      err([
        {
          kind: 'dmlRef',
          code: 'S1000DBIKE-B6865-S-2026-00001',
          language: { languageIsoCode: 'ja', countryIsoCode: 'JP' },
        },
      ]).path,
    ).toBe('/refs[1]/language');
    expect(err([{ kind: 'xxRef' as never, code: 'a' }]).path).toBe('/refs[1]/kind');
  });

  it('本文の < & はエスケープされ、読み戻すと元の文になる', () => {
    const r = buildComment(base(), opts());
    expect(r.xml).toContain('&lt;トルク値&gt;');
    expect(r.xml).toContain('&amp;');
    const doc = defaultXmlEngine.parse(r.xml).document;
    const text = defaultXmlEngine.selectNodes('//commentContent/simplePara', doc)[0]!.textContent;
    expect(text).toBe('手順 3 の「締める」は <トルク値> & 工具を示してください。');
  });

  it('title・responseType・remarks・issueType は省略すると出さない', () => {
    const r = buildComment(base({ title: undefined }), opts());
    expect(r.xml).not.toContain('commentTitle');
    expect(r.xml).not.toContain('commentResponse');
    expect(r.xml).not.toContain('remarks');
    expect(r.xml).not.toContain('issueType');
    const full = buildComment(
      base({ responseType: 'rt05', issueType: 'changed', remarks: '備考' }),
      opts(),
    );
    expect(full.xml).toContain('<commentResponse responseType="rt05"/>');
    expect(full.xml).toContain('issueType="changed"');
    expect(full.xml).toContain('<remarks>');
  });

  it('年と日付の既定は今年・今日。issueDate は実在する日付だけ', () => {
    const r = buildComment(base(), opts());
    expect(r.xml).toContain('<issueDate year="2026" month="10" day="28"/>');
    expect(r.notes.join('\n')).toMatch(/issueDate: not given/);
    expect(() => buildComment(base({ issueDate: '2026-02-30' }), opts())).toThrow(/real date/);
    expect(buildComment(base({ yearOfDataIssue: 2025 }), opts()).commentCode.yearOfDataIssue).toBe(
      '2025',
    );
  });

  it('enterpriseCode は XML に出さず、notes に書く。address は必須', () => {
    const r = buildComment(base(), opts());
    expect(r.xml).not.toContain('enterpriseCode');
    expect(r.notes.join('\n')).toMatch(/enterpriseCode/);
    expect(() =>
      buildComment(base({ originator: { enterpriseName: 'X' } as never }), opts()),
    ).toThrow(/\/originator\/address/);
    expect(() =>
      buildComment(
        base({ originator: { enterpriseName: 'X', address: { city: 'T' } as never } }),
        opts(),
      ),
    ).toThrow(/\/originator\/address\/country/);
  });

  it('住所と担当者は XSD の順序で出る', () => {
    const r = buildComment(
      base({
        originator: {
          enterpriseName: 'Example Co.',
          division: 'Docs',
          person: { lastName: 'Bonji', firstName: 'Shuji', personPrefix: 'Mr' },
          address: {
            country: 'Japan',
            city: 'Tokyo',
            street: '1-1',
            email: ['a@example.test', 'b@example.test'],
            phoneNumber: ['000'],
          },
        },
      }),
      opts(),
    );
    const order = [
      '<enterprise>',
      '<division>',
      '<dispatchPerson',
      '<street>',
      '<city>',
      '<country>',
      '<phoneNumber>',
      '<email>',
    ];
    const pos = order.map((s) => r.xml.indexOf(s));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });
});

describe('buildComment: 列挙と必須項目の誤りは入力の誤り', () => {
  const bad = (over: Partial<CommentInput>, path: string) => {
    let e: unknown;
    try {
      buildComment(base(over), opts());
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(CommentInputError);
    expect((e as CommentInputError).path).toBe(path);
  };
  it('commentType', () => bad({ commentType: 'x' as never }, '/commentType'));
  it('commentPriorityCode', () => {
    bad({ commentPriorityCode: 'cp00' }, '/commentPriorityCode');
    bad({ commentPriorityCode: 'cp100' }, '/commentPriorityCode');
    bad({ commentPriorityCode: 'high' }, '/commentPriorityCode');
    expect(buildComment(base({ commentPriorityCode: 'cp99' }), opts()).xml).toContain(
      'commentPriorityCode="cp99"',
    );
  });
  it('responseType', () => {
    bad({ responseType: 'rt00' }, '/responseType');
    bad({ responseType: 'x' }, '/responseType');
  });
  it('securityClassification', () => {
    bad({ securityClassification: '00' }, '/securityClassification');
    bad({ securityClassification: undefined as never }, '/securityClassification');
  });
  it('issueType', () => bad({ issueType: 'old' }, '/issueType'));
  it('modelIdentCode・senderIdent・年・連番の形', () => {
    bad({ modelIdentCode: 'a' }, '/modelIdentCode');
    bad({ senderIdent: 'B685' }, '/senderIdent');
    bad({ yearOfDataIssue: '26' }, '/yearOfDataIssue');
    bad({ seqNumber: '1' }, '/seqNumber');
    bad({ seqNumber: '00000' }, '/seqNumber');
  });
  it('paragraphs は 1 つ以上', () => {
    bad({ paragraphs: [] }, '/paragraphs');
    bad({ paragraphs: [1 as never] }, '/paragraphs[1]');
  });
  it('language', () =>
    bad({ language: { languageIsoCode: 'j', countryIsoCode: 'JP' } }, '/language/languageIsoCode'));
});

describe('buildComment: seqNumber の採番', () => {
  const com = (name: string) => ({ fileName: name });
  it('CSDB に同じモデル・送り手・年の comment があれば、その次の番号', () => {
    const index = CsdbIndex.fromSource(
      new MemoryCsdbSource([
        com('COM-S1000DBIKE-B6865-2026-00001-Q_JA-JP.XML'),
        com('COM-S1000DBIKE-B6865-2026-00007-R_JA-JP.XML'), // 種類が違っても通しで数える
        com('COM-S1000DBIKE-B6865-2025-00099-Q_JA-JP.XML'), // 年が違う
        com('COM-S1000DBIKE-C1234-2026-00050-Q_JA-JP.XML'), // 送り手が違う
        com('COM-OTHER-B6865-2026-00060-Q_JA-JP.XML'), // モデルが違う
      ]),
    );
    const r = buildComment(base(), opts({ index }));
    expect(r.commentCode.seqNumber).toBe('00008');
    expect(r.fileName).toBe('COM-S1000DBIKE-B6865-2026-00008-Q_JA-JP.XML');
    expect(r.notes.join('\n')).toMatch(/seqNumber: not given; used 00008/);
    // 年を変えれば、その年の次
    expect(
      buildComment(base({ yearOfDataIssue: '2025' }), opts({ index })).commentCode.seqNumber,
    ).toBe('00100');
    expect(
      buildComment(base({ senderIdent: 'D9999' }), opts({ index })).commentCode.seqNumber,
    ).toBe('00001');
  });
  it('index が無い・comment が無ければ 00001', () => {
    expect(buildComment(base(), opts()).commentCode.seqNumber).toBe('00001');
    expect(
      buildComment(base(), opts({ index: CsdbIndex.fromSource(new MemoryCsdbSource([])) }))
        .commentCode.seqNumber,
    ).toBe('00001');
  });
  it('99999 まで使っていれば入力の誤り', () => {
    const index = CsdbIndex.fromSource(
      new MemoryCsdbSource([com('COM-S1000DBIKE-B6865-2026-99999-Q_JA-JP.XML')]),
    );
    expect(() => buildComment(base(), opts({ index }))).toThrow(/\/seqNumber/);
  });
  it('seqNumber を指定すれば数値でも文字列でも使い、既にあれば notes に書く', () => {
    const index = CsdbIndex.fromSource(
      new MemoryCsdbSource([com('COM-S1000DBIKE-B6865-2026-00003-I_JA-JP.XML')]),
    );
    expect(buildComment(base({ seqNumber: 12 }), opts({ index })).commentCode.seqNumber).toBe(
      '00012',
    );
    const dup = buildComment(base({ seqNumber: '00003' }), opts({ index }));
    expect(dup.notes.join('\n')).toMatch(/may collide/);
  });
  it('書いた comment を CSDB に入れると、次の採番に効く', () => {
    const source = new MemoryCsdbSource([]);
    const first = buildComment(base(), opts({ index: CsdbIndex.fromSource(source) }));
    source.writeText(first.fileName, first.xml);
    const second = buildComment(base(), opts({ index: CsdbIndex.fromSource(source) }));
    expect(second.commentCode.seqNumber).toBe('00002');
  });
});

describe('buildComment: brexDmRef の決め方', () => {
  it('入力 → options.defaultBrex の順。どちらも無ければ入力の誤り', () => {
    const viaOption = buildComment(base({ brexDmRef: undefined }), opts({ defaultBrex: BREX }));
    expect(viaOption.xml).toContain('infoCode="022"');
    expect(viaOption.notes.join('\n')).toMatch(/options\.defaultBrex/);
    const other = parseDmc('S1000DBIKE-AAA-D00-00-00-00AA-022A-A');
    if (!other.ok) throw new Error('fixture');
    const viaInput = buildComment(base({ brexDmRef: other.value }), opts({ defaultBrex: BREX }));
    expect(viaInput.xml).toContain('infoCodeVariant="A"');
    expect(viaInput.notes.join('\n')).toMatch(/brexDmRef: taken from the input/);
    expect(() => buildComment(base({ brexDmRef: undefined }), opts())).toThrow(/\/brexDmRef/);
  });
  it('版つきの参照（DmRef）は issueInfo を出す', () => {
    const r = buildComment(
      base({ brexDmRef: { dmCode: BREX, issueInfo: { issueNumber: '001', inWork: '00' } } }),
      opts(),
    );
    expect(r.xml).toMatch(/<dmCode [^>]*\/>\s*<issueInfo issueNumber="001" inWork="00"\/>/);
  });
});

describe('comment のコードとファイル名', () => {
  it('formatCommentCode / parseCommentCode', () => {
    const code = {
      modelIdentCode: 'AJ',
      senderIdent: 'I9034',
      yearOfDataIssue: '2006',
      seqNumber: '00365',
      commentType: 'r' as const,
    };
    expect(formatCommentCode(code)).toBe('AJ-I9034-2006-00365-R');
    expect(parseCommentCode('COM-AJ-I9034-2006-00365-R')).toEqual({ ok: true, value: code });
    expect(parseCommentCode('AJ-I9034-2006-00365-r')).toEqual({ ok: true, value: code });
    expect(parseCommentCode('AJ-I9034-2006-00365-X').ok).toBe(false);
    expect(parseCommentCode('AJ-I9034-2006-365-R').ok).toBe(false);
  });
  it('formatCommentFileName / parseCommentFileName（配布物の見本と同じ形）', () => {
    const code = {
      modelIdentCode: 'AJ',
      senderIdent: 'I9034',
      yearOfDataIssue: '2006',
      seqNumber: '00365',
      commentType: 'r' as const,
    };
    const name = formatCommentFileName(code, { languageIsoCode: 'sx', countryIsoCode: 'US' });
    expect(name).toBe('COM-AJ-I9034-2006-00365-R_SX-US.XML');
    expect(parseCommentFileName(name)).toEqual({
      ok: true,
      value: {
        commentCode: code,
        language: { languageIsoCode: 'sx', countryIsoCode: 'US' },
        extension: 'XML',
      },
    });
    expect(formatCommentFileName(code, undefined, '')).toBe('COM-AJ-I9034-2006-00365-R');
    expect(parseCommentFileName('COM-AJ-I9034-2006-00365-R.XML')).toMatchObject({
      ok: true,
      value: { extension: 'XML' },
    });
    expect(parseCommentFileName('DMC-AJ-I9034-2006-00365-R.XML').ok).toBe(false);
  });
  it('classifyCsdbFileName が COM- を comment として分類する', () => {
    const o = classifyCsdbFileName('COM-S1000DBIKE-B6865-2026-00001-Q_JA-JP.XML');
    expect(o?.kind).toBe('comment');
    expect(o?.comment?.commentCode.seqNumber).toBe('00001');
    expect(o?.comment?.language).toEqual({ languageIsoCode: 'ja', countryIsoCode: 'JP' });
    // 読めない名前でも種類は comment（DML・DDN と同じ）
    expect(classifyCsdbFileName('COM-x.XML')).toMatchObject({ kind: 'comment' });
    expect(classifyCsdbFileName('COM-x.txt')).toBeUndefined();
  });
});

// ---- 配布物（利用者が入手したもの）。S1000D_SPEC_TESTS=1 のときだけ ----

const enabled = process.env.S1000D_SPEC_TESTS === '1';
const specDir = resolve(process.env.S1000D_SPEC_DIR ?? '../../specs/s1000d/issue-7');

describe.skipIf(!enabled || !existsSync(specDir))('comment: S1000D 配布物', () => {
  it('本物の comment.xsd で valid（参照 5 通り・全項目あり）', async () => {
    const schemaDirs = findSchemaDirs([specDir]);
    const located = locateXsd(
      'http://www.s1000d.org/S1000D_7/xml_schema_flat/comment.xsd',
      schemaDirs,
      { issue: '7' },
    );
    expect(located.ok).toBe(true);
    if (!located.ok) return;
    const found = findDefaultBrex([specDir]);
    expect(found).toBeDefined();
    const brexDmRef = { dmCode: found!.brex.dmCode, issueInfo: found!.brex.issueInfo };
    const variants: CommentInput[] = [
      base({ brexDmRef, refs: [] }),
      base({ brexDmRef }),
      base({
        brexDmRef,
        refs: [
          {
            kind: 'pmRef',
            code: 'S1000DBIKE-B6865-EPWG1-00',
            issueInfo: { issueNumber: '006', inWork: '00' },
            language: { languageIsoCode: 'en', countryIsoCode: 'US' },
          },
        ],
      }),
      base({
        brexDmRef,
        refs: [
          {
            kind: 'dmlRef',
            code: 'S1000DBIKE-B6865-S-2026-00001',
            issueInfo: { issueNumber: '001', inWork: '00' },
          },
        ],
      }),
      base({ brexDmRef, refs: [{ kind: 'ddnRef', code: 'S1000DBIKE-B6865-B6865-2026-00001' }] }),
      base({
        brexDmRef,
        responseType: 'rt01',
        issueType: 'new',
        remarks: ['備考 1', '備考 2'],
        commentType: 'r',
        originator: {
          enterpriseName: 'Example Co.',
          division: 'Docs',
          enterpriseUnit: 'Unit 1',
          person: { lastName: 'Bonji', firstName: 'Shuji', jobTitle: 'Writer', personPrefix: 'Mr' },
          address: {
            department: 'D',
            street: 'S',
            postOfficeBox: 'P',
            postalZipCode: '100-0001',
            city: 'Tokyo',
            country: 'Japan',
            state: 'ST',
            province: 'PR',
            building: 'B',
            room: 'R',
            phoneNumber: ['000'],
            faxNumber: ['111'],
            email: ['a@example.test'],
            internet: ['https://example.test'],
            SITA: 'TYOXXXX',
          },
        },
      }),
    ];
    for (const v of variants) {
      const r = buildComment(v, opts());
      const res = await validate(r.xml, located.xsdPath);
      expect(res.errors, r.xml).toEqual([]);
      expect(res.valid).toBe(true);
    }
  });

  it('既定 BREX（comment の層を含む）への違反が 0 件', async () => {
    const found = findDefaultBrex([specDir]);
    expect(found).toBeDefined();
    const r = buildComment(base({ brexDmRef: undefined }), opts({ specDirs: [specDir] }));
    const { document } = defaultXmlEngine.parse(r.xml);
    const refEl = defaultXmlEngine.selectNodes('//commentStatus/brexDmRef/dmRef', document)[0]!;
    const ref = readDmRef(refEl as never);
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    const chain = await resolveBrexChain(ref.value, createDirectoryBrexResolver([specDir]));
    expect(chain.unresolved).toEqual([]);
    expect(chain.layers.length).toBeGreaterThan(0);
    const schemaLocation = 'http://www.s1000d.org/S1000D_7/xml_schema_flat/comment.xsd';
    // comment 用の contextRules が実際に評価されたことを確かめる
    expect(
      chain.layers.some((b) => b.contextRules.some((c) => c.rulesContext === schemaLocation)),
    ).toBe(true);
    for (const layer of chain.layers) {
      const rep = checkAgainstBrexLayer(document, layer, schemaLocation);
      expect(rep.skipped).toEqual([]);
      expect(rep.violations).toEqual([]);
      expect(rep.evaluatedRules).toBeGreaterThan(0);
    }
  });
});
