# Changelog

## 0.4.0 (2026-10-27)

### 追加

- 配布物の場所と CSDB の場所を決める `resolveStackConfig`（`src/stack-config.ts`）。環境変数 `S1000D_SPEC_DIR` / `S1000D_CSDB_DIR` を先に読み、無ければ設定ファイル（既定 `~/.config/s1000d-stack/config.json`、`XDG_CONFIG_HOME` に従う、`S1000D_CONFIG` で変更可）の `specDir` / `csdbDirs` を読みます。Claude Desktop が plugin のサーバーに環境変数を渡さず、plugin の `env` の `${VAR}` も置き換えないため、MCP 3 本が共通に使う入口として足しました。置き換えられずに渡った `${VAR}` は使わず、`warnings` に理由を書きます。

## 0.3.0 (2026-10-27)

段階 2.5 の修正提案（`suggestFixes`）と、BREX の NOTATION の照合の修正。利用側の `^0.2.0` は 0.3.0 を含まないため、依存範囲を `^0.3.0` に上げてください。NOTATION の照合の修正により、除外だけの `notationRuleList` を持つ BREX に照合したときの違反の件数が変わります。

### 追加

- 修正提案（`src/fix/`、段階 2.5 の作業 1、D-19）。`suggestFixes` が `verifyDataModule` の結果から、違反ごとに直し方の候補 `Fix`（`kind` / `location` / `problem` / `candidates[]` / `confidence` / `source`、必要なら `note` と `brSeverityLevel`）を返します。候補は決定論的に決め、点数は付けず、確からしさは `exact` / `several` / `none` の 3 段階です。
  - BREX: 値の違反はルールの `objectValue`（許可値と説明文、`range` / `pattern` は `valueForm` 付き）、禁止は「取り除く」、欠落は「足す」、NOTATION は許可された一覧（`suggestBrexFixes`）。
  - XSD: libxml2 の文章にある値・要素を候補にし、文章に無いもの（型の不一致、`This element is not expected.` だけのもの、許されない属性）は XSD の定義を読んで作ります（`suggestSchemaFixes`）。定義の読み取りは `XsdIndex` / `loadXsdIndex`（`xs:include` / `xs:import` の相対パスをたどる）。
  - 参照: 情報コード・システム差異コードだけ違う DMC、CSDB にある版（`issueMismatch`）、巻だけ違う PMC、拡張子だけ違う ICN、近い id（`suggestReferenceFixes`、`nearMatches` / `editDistance`）。仕様書の章への `dmRef` は候補を作らず説明だけを返します。
  - 適用性: 製品の値が足りず判定不能になった適用性を集め（`findUndeterminedApplicability`）、ACT・CCT・PCT の値を `provide` の候補にします（`suggestApplicabilityFixes`）。
- `findApplicTables`（対象 DM の ACT・CCT・PCT を CSDB から探す）。s1000d-reader-mcp の `services/context.ts` にあった処理を、s1000d-verify-mcp と共有するために移しました。

### 修正

- NOTATION の照合で、許可（`allowedNotationFlag="1"`）が 1 つも無く除外（`"0"`）だけの BREX の層を「使ってよい NOTATION が 0 件」と読み、使われているすべての NOTATION を違反にしていた誤りを直しました。Issue 7 Chap 4.10.2.2 Para 2.2.2 のとおり `allowedNotationFlag` は基本セットに対する相対的な宣言で、基本セットを BREX で決めないときは BREX 以外の手段で範囲を決めるとされているため、この層は「挙げたものだけを違反にし、それ以外は制限しない」と読みます。判定は新しい `notationPolicy`（`closed` / `open`）で行い、`allowedNotations` は集合が決まらないとき `undefined` を返します（以前は空の集合）。Bike Samples では、Flash を除外するルール 1 件だけを持つ BREX のために出ていた NOTATION の違反 36 件が 0 件になりました。除外だけの層での NOTATION の違反には `allowedValues` が付きません。
- `findSchemaDirs` が配布物のデータ辞書（`data_dictionary_*/Files/xml_schema_flat/`）の XSD を候補に入れないようにしました。この写しは `xml.xsd` などを `http://www.w3.org/2001/xml.xsd` の絶対 URL で import しており、libxml2 がネットワークに出ようとして失敗します。「XML Schema Package」側（相対パスで import）だけを使います。

## 0.2.0 (2026-10-25)

段階 2（reader / verify）の土台。XSD 検証・参照の解決・適用性の評価・本文の読み取りを追加しました。利用側の `^0.1.0` は 0.2.0 を含まないため、依存範囲を `^0.2.0` に上げてください。

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

- `package.json` の `exports` にサブパス `./xsd-libxml2` を追加。`libxml2-wasm` を任意の `peerDependencies` に追加（XSD 検証を使うときだけ入れる）。
- 既存の API は変えていません。

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
