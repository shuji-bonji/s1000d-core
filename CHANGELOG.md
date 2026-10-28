# Changelog

## 0.8.0 (2026-10-28)

段階 3（writer）のための「書く側」の機能です（docs/design/writer-mcp.md、D-27）。既存の API は変えていません。

### 追加

- データモジュールの組み立て（`src/write/`）。`buildDataModule(draft, allocation, options)` が、構造化された入力 `DraftDataModule`（識別情報と、reader の `ContentNode` と同じ語彙の `DraftNode` の木）から識別・状態部と内容部の XML を組み立てます。種類は descript / proced / process / fault / pm の 5 つ（`buildContent`）。`DraftInputError` は XML を組み立てる前の入力の形の検査で、XSD 検証の代わりではありません。proced / fault で必須の前提・事後条件（`preliminaryRqmts` / `closeRqmts`）は、入力に無い項目を `noConds` などで埋め、`qualityAssurance` は `unverified` にします。
- 採番（`src/write/allocate.ts`）。`allocateDmc` / `allocateIcn` / `allocatePmc` が `Allocation`（モデル識別コード・SNS・種類ごとの情報コード `infoCodeByKind`・CAGE）と台帳 `ledger` から番号を決めます。同じ `sourceId` には同じ DMC を返し、台帳は入力で受け取って返します（状態を持たない）。情報コードの既定はありません（D-27）。
- 入力の JSON Schema `schema/draft.schema.json`（`@shuji-bonji/s1000d-core/schema/draft.schema.json`）。型と `required` が一致することをテストで固定しています。
- 修正候補の適用（`src/fix/apply.ts`）。`applyFix` / `applyFixes` が `suggestFixes` の候補（`replace` / `remove` / `add` / `retarget`）を DOM で適用します。`verify` か `offered` で候補を計算し直して照合し、候補に無い選択は `candidate-not-offered` で適用しません（D-19）。`range` / `pattern` の値は `matchesRange` / `matchesPattern` で確かめます。`add` の位置は `XsdIndex` の子要素の順序で決めます。XML 宣言と DOCTYPE（ICN の `ENTITY` / `NOTATION` 宣言）は保ちます（開始タグの中の空白は 1 つに揃います）。
- 書き込める置き場所 `WritableCsdbSource`（`writeText` / `writeBytes`、`isWritableCsdbSource`、`CsdbWriteConflictError`）。`DirectoryCsdbSource`（最初のフォルダーに書く）と `MemoryCsdbSource` に実装しました。同期のままです。
- comment データモジュールの組み立て（`src/comment/`）。`buildComment` が `comment.xsd` の構造（`commentCode` の必須属性 5 つ、`commentAddressItems`、`commentStatus`、`commentContent/simplePara`）に沿って組み立てます。`commentType` / `commentPriorityCode` / `responseType` / `issueType` は列挙のまま解釈しません。`seqNumber` 省略時は CSDB の同じモデル・送り手・年の次の番号です。ファイル名 `COM-<MIC>-<送り手>-<年>-<連番>-<種類>_<言語>-<国>.XML` は配布物の見本 1 件からの推定で、`classifyCsdbFileName` が `comment` として拾います（`CsdbObjectKind` に `comment`）。
- 翻訳向けの文の抜き出しと差し戻し（`src/segments/`）。`extractSegments` が人の読む文（題名・段落・手順・警告・表のセル・図の題名）だけを `Segment[]`（`id`・`xpath`・`context`・`text`・`placeholders`）として返し、インライン要素は `{n}` のプレースホルダーにします。`applySegments` は `skeletonHash` で骨組みが同じことを確かめてから訳文を差し戻し、`language` だけ違う DM を返します（`SkeletonMismatchError`）。Bike Samples 106 件で往復しても元と同じ（空白を除く）で、XSD に適合したままです。
- BREX の連鎖を PM と comment でもたどるようにしました。`readBrexDmRefOf` が `dmStatus` / `pmStatus` / `commentStatus` の `brexDmRef` を読み、`checkAgainstBrexChain` と `verifyDataModule` がそれを使います。`VerificationStatus.target` と `BrexCheckReport.target` に任意の `pmCode` / `commentCode` を足しました。
- `readNonDmIdent` / `readPmCodeElement` / `readCommentCodeElement`、`src/xml/serialize.ts`（宣言と DOCTYPE を保つ直列化）。
- 自作の券売機の入力データ `src/__fixtures__/kenbaiki-drafts.ts`（U-03 の出発点）。

## 0.7.0 (2026-10-28)

### 追加

- 本文の概要と大きさ（`src/content/outline.ts`、段階 2.5 の作業 7、D-19）。`outlineContent` は本文の木から見出し・手順の番号・最初の 1 文（`firstSentence`）・警告の数だけを残した `OutlineNode[]` を返し、`measureContent` は部分木の大きさ `ContentSize`（節点数・文字数・種類ごとの数・警告の数）を返します。LLM が全文を読む前に当たりを付け、読む量の予算を立てるためのものです。残す種類は既定で section / step / requirements / sequence / if / dialog / entry で、`keep`・`maxDepth`・`maxSentenceLength` で変えられます。
- `ContentNode` に `securityClassification`（要素自身の `@securityClassification`。値は解釈しない）を足しました。概要の節点にも付きます。

## 0.6.0 (2026-10-28)

### 追加

- DML（データモジュールリスト）と DDN（納入票）の読み取りと、CSDB との照合（`src/dml/`、段階 2.5 の作業 5、D-19）。`readDml` / `readDdn` が識別・状態部と行（`dmlEntry` の `dmRef` / `pmRef` / `infoEntityRef` / `dmlRef` / `commentRef`、`deliveryListItem` の `dispatchFileName`）を読み、`reconcileDml` / `reconcileDdn` が `found` / `issue-mismatch` / `not-found` / `not-checked` と、CSDB にあるのに DML に載っていない DM・PM（`notListed`）を返します。`dmlType`・`dmlEntryType`・`issueType` は解釈しません。コードとファイル名の分解・組み立ては `parseDmlCode` / `parseDmlFileName` / `formatDmlCode` / `parseDdnCode` / `parseDdnFileName` / `formatDdnCode`。
- `CsdbObject` に `dml` / `ddn`（ファイル名から読めた DML・DDN のコードと発行情報）を足しました。
- `CsdbObjectKind` に `dme`（拡張 DMC のデータモジュール。ファイル名が `DME-` で始まる。Bike Samples に 2 件）を足しました。これまでは索引に入らず、DDN の照合で「無い」と出ていました。`dm` は付かないので `findDataModules` では見つかりません（`findByFileName` では見つかります）。
- `readIssueInfo` を `data-module.ts` から export しました（内部用）。

## 0.5.0 (2026-10-27)

### 追加

- `CsdbSource` インターフェース（`src/csdb-source.ts`、段階 2.5 の作業 3、D-19）。CSDB オブジェクトの「一覧」（`list()`）と「中身の取得」（`readText()`）をここに集め、フォルダー実装 `DirectoryCsdbSource` を既定にしたまま、データベースや API を持つ製品側が自分の実装を差し込めるようにしました。`CsdbIndex.fromSource(source)` で索引を作り、`index.read(object)` で中身を読みます。`CsdbIndex.fromDirs` は `DirectoryCsdbSource` の上に索引を作るようになり、結果は変わりません。
- `MemoryCsdbSource`（ファイル名と XML の組をメモリーに持つ実装）。テストと、先に読み込んだ内容を渡すのに使います。
- `classifyCsdbFileName`（ファイル名から種類と DMC・PMC を決める。`listCsdbObjects` と `MemoryCsdbSource` が共有）。
- `createBrexResolver(index)`（`CsdbIndex` から BREX を探す）。`createDirectoryBrexResolver(dirs)` は `createBrexResolver(CsdbIndex.fromDirs(dirs))` と同じになりました。
- `verifyDataModule` の `references.csdb` に `CsdbSource` を渡せるようにしました（これまでの `CsdbIndex` とフォルダーの一覧も引き続き受け取ります）。

### 変更

- `findApplicTables` と BREX の解決器が、ACT・CCT・PCT・BREX の中身を `readFileSync` ではなく索引の `read()` から読むようになりました。`new CsdbIndex(objects)` で `source` を与えずに作った索引は、これまでどおり `path` をファイルとして読みます。
- `CsdbSource` は同期です。`resolveReferences`・`suggestFixes`・`findApplicTables` が同期関数で、非同期にするとそれらの API を変えることになるためです。非同期にしか読めない置き場所は、先に読み込んで `MemoryCsdbSource` に渡してください。

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
