# Changelog

## 未リリース（0.2.0 に向けて）

### 追加

- BREX の所在の解決（`locateBrex` / `findDefaultBrex` / `isDefaultBrexDmc` / `BrexLocateError`）。s1000d-brex-mcp にあった「ファイルのパス・DMC・省略（配布物の既定 BREX）のどれで指定されても BREX を 1 つ決める」処理を、s1000d-verify-mcp と共有するために移しました。既定 BREX は `DMC-S1000D-*-04-10-0301-00A-022A-D` をシステム差異コードを見ずに探し、中身の DMC がファイル名と一致して自分自身を参照するものを優先します。見つからない理由は `BrexLocateError.reason`（`default-not-found` / `file-not-found` / `not-brex` / `invalid-spec` / `dmc-not-found`）で返します。
- XML スキーマ（XSD）による検証（D-15、D-17）。インターフェース `SchemaValidator` と、`libxml2-wasm` による実装 `Libxml2SchemaValidator`（サブパス `@shuji-bonji/s1000d-core/xsd-libxml2`。`libxml2-wasm` は任意の peerDependency）。XSD ごとに 1 つコンパイルして使い回し、Issue 7 の Bike Samples 106 件を 0.5 秒以内で検証します。
- 配布物の中の `xml_schema_flat/` の探索（`findSchemaDirs`。版は `brex.xsd` 冒頭の `Issue number:` から読む）と、`xsi:noNamespaceSchemaLocation` から使う XSD を決める `locateXsd`。
- 検証状態 `VerificationStatus` と、整形式・XSD・BREX をまとめて行う `verifyDataModule`。s1000d-verify-mcp と s1000d-reader-mcp が同じ形で検証状態を返すための土台です。
- 参照の解決（`collectReferences` / `resolveReferences`、`verifyDataModule` の `references`）。`dmRef`（brexDmRef・applicCrossRefTableRef・pmEntry などすべての文脈）、`pmRef`、ICN（`@infoEntityIdent` → DOCTYPE の `ENTITY` 宣言 → ファイル）、`internalRef`、`applicRefId`（`applic/@id` と `referencedApplicGroupRef/applicRef/@id` の両方）を集め、参照先の有無を理由付きで返します。`issueInfo` 付きの参照は版の一致も見て、違えば `issueMismatch` を付けます。
- 本文の読み取り（`src/content/`。`readContent` / `readContentFromXml` / `countNodes`）。`descript` / `proced` / `process` / `fault` / `pm` の 5 種の内容部を、共通の形 `ContentNode` の木（section / para / list / table / figure / admonition / step / requirements / sequence / if / dialog / entry）に揃えます。手順の番号（1、1.1）を組み立て、段落の中の参照は `[→ DMC 題名]` の形で文に埋め込みつつ `refs` にも集めます。知らない要素は捨てず `unknown` として残し、名前と数を `unknownElements` に返します。他の種類は `kind: 'other'` で識別・状態部だけを対象にします。
- 適用性の評価（`src/applic/`）。ACT・CCT・PCT の読み取り（`readAct` / `readCct` / `readPct` / `productFromPct`）、`applic` の読み取り（`readApplicStatements`）、`assert` / `evaluate` の 3 値評価（`evaluateApplic` / `evaluateExpr`。applicable / notApplicable / undetermined）、データモジュール 1 件分の評価器 `ApplicEvaluator`（DM 全体の applic と要素の `@applicRefId` を and で結ぶ。`referencedApplicGroupRef/applicRef/@applicIdentValue` で別 DM の適用性リポジトリを指す形も `buildApplicRepository` で扱う）。値の照合は BREX と同じ `matchesRange`（単一値・`|`・`a~b`）。
- PMC の分解・組み立て（`parsePmc` / `formatPmc` / `parsePmcFileName` / `samePmc`）と、DMC 以外（PMC・DML・DDN・IMF・UPF・ICN）も拾う CSDB の索引（`listCsdbObjects` / `CsdbIndex`）。

### 変更

- `package.json` の `exports` にサブパス `./xsd-libxml2` を追加。

## 0.1.0 (2026-10-24)

最初の公開。S1000D® の CSDB オブジェクトを読み、BREX に照合するための土台です。

### 追加

- DMC の分解・組み立て（`parseDmc` / `formatDmc` / `parseDmcFileName` / `formatDmcFileName` / `sameDmc` / `isBrexDmc`）
- ICN（MIC 基準・CAGE 基準）の分解・組み立て（`parseIcn` / `formatIcn` / `parseIcnFileName`）
- `xsi:noNamespaceSchemaLocation` からのスキーマ名と版の推定（`parseSchemaLocation`）
- データモジュールの識別・状態部の読み取り（`readDataModuleInfo` / `readIdentAndStatus` / `readDmRef`）
- BREX データモジュールの読み取り（`readBrex`）と SNS 検索（`lookupSns`）
- BREX への照合: 1 層・複数層・`brexDmRef` の連鎖（`checkAgainstBrexLayer` / `checkAgainstBrexLayers` / `checkAgainstBrexChain` / `resolveBrexChain`）。Issue 7 Chap 4.10.2 と Chap 7.9 の規則に沿い、各層を個別に照合する
- フォルダーを CSDB と見なす解決器（`listDataModules` / `findDataModule` / `createDirectoryBrexResolver`）
- XML の読み取りと XPath 3.1 の評価（`XmlEngine` / `defaultXmlEngine`。実装は `@xmldom/xmldom` ＋ `fontoxpath`）

### 注記

- S1000D の仕様書・スキーマ・公式サンプルは含みません。配布物を使うテスト（`npm run test:spec`）は利用者が入手したものを `S1000D_SPEC_DIR` から読みます。
- XML スキーマ（XSD）による検証は含みません。
