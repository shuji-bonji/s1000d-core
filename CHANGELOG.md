# Changelog

## 未リリース（0.2.0 に向けて）

### 追加

- BREX の所在の解決（`locateBrex` / `findDefaultBrex` / `isDefaultBrexDmc` / `BrexLocateError`）。s1000d-brex-mcp にあった「ファイルのパス・DMC・省略（配布物の既定 BREX）のどれで指定されても BREX を 1 つ決める」処理を、s1000d-verify-mcp と共有するために移しました。既定 BREX は `DMC-S1000D-*-04-10-0301-00A-022A-D` をシステム差異コードを見ずに探し、中身の DMC がファイル名と一致して自分自身を参照するものを優先します。見つからない理由は `BrexLocateError.reason`（`default-not-found` / `file-not-found` / `not-brex` / `invalid-spec` / `dmc-not-found`）で返します。

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
