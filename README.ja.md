# @shuji-bonji/s1000d-core

[English](./README.md) | **日本語**

S1000D® の CSDB オブジェクト（データモジュールなど）を読み、BREX（Business Rules Exchange）に照合するための共通ライブラリです。データモジュールコード（DMC）と ICN の分解・組み立て、識別・状態部の読み取り、BREX の読み取りと照合、XML の読み取りと XPath の評価を提供し、`s1000d-brex-mcp` / `s1000d-reader-mcp` / `s1000d-verify-mcp` / `s1000d-writer-mcp` が共有します。

> [!IMPORTANT]
> このライブラリは ASD（Aerospace, Security and Defence Industries Association of Europe）とは無関係の個人プロジェクトです。S1000D® は ASD の登録商標です。
> S1000D の仕様書・XML スキーマ・公式サンプルは、利用条件により再配布できないため、このパッケージには含まれていません。必要な場合は利用者ご自身で [s1000d.org](https://s1000d.org/) から入手してください。

## できること

| 機能 | 関数 |
|---|---|
| DMC の分解・組み立て（学習コード付きも可） | `parseDmc` / `formatDmc` / `sameDmc` / `isBrexDmc` |
| DMC のファイル名（発行情報・言語・拡張子）の分解・組み立て | `parseDmcFileName` / `formatDmcFileName` |
| ICN（MIC 基準・CAGE 基準）の分解・組み立て | `parseIcn` / `formatIcn` / `parseIcnFileName` |
| `xsi:noNamespaceSchemaLocation` からスキーマ名と S1000D の版を推定 | `parseSchemaLocation` |
| データモジュールの識別・状態部（DMC・言語・発行・題名・BREX 参照・適用性の表示文など）の読み取り | `readDataModuleInfo` / `readIdentAndStatus` / `readDmRef` |
| BREX データモジュールの読み取り（contextRules / nonContextRules / snsRules / notationRuleList） | `readBrex` / `allRules` / `lookupSns` |
| データモジュールの BREX への照合（1 層、複数層、`brexDmRef` の連鎖をたどる） | `checkAgainstBrexLayer` / `checkAgainstBrexLayers` / `checkAgainstBrexChain` / `resolveBrexChain` |
| フォルダーを CSDB と見なして DMC からファイルを探す | `listDataModules` / `findDataModule` / `createDirectoryBrexResolver` |
| BREX の指定（ファイルのパス・DMC・省略＝配布物の既定 BREX）から BREX を 1 つ決める | `locateBrex` / `findDefaultBrex` / `isDefaultBrexDmc` |
| XML の読み取りと XPath 3.1 の評価（差し替え可能なインターフェース） | `XmlEngine` / `defaultXmlEngine` |
| XML スキーマ（XSD）による検証（差し替え可能なインターフェース。実装はサブパス `xsd-libxml2`） | `SchemaValidator` / `Libxml2SchemaValidator` |
| 配布物の中の `xml_schema_flat/` を探し、`xsi:noNamespaceSchemaLocation` から使う XSD を決める | `findSchemaDirs` / `locateXsd` |
| PMC の分解・組み立てと、DMC 以外（PMC・DML・DDN・IMF・UPF・ICN）も拾う CSDB の索引 | `parsePmc` / `parsePmcFileName` / `listCsdbObjects` / `CsdbIndex` |
| 参照（`dmRef` / `pmRef` / ICN / `internalRef` / `applicRefId`）を集め、参照先の有無を理由付きで返す | `collectReferences` / `resolveReferences` |
| 本文（descript / proced / process / fault / pm）を共通の形（見出し・段落・手順・警告・図・表・参照）に読み取る | `readContent` / `readContentFromXml` |
| 適用性: ACT・CCT・PCT の読み取りと、`assert` / `evaluate` の 3 値評価（applicable / notApplicable / undetermined） | `readAct` / `readCct` / `readPct` / `ApplicEvaluator` / `evaluateApplic` |
| 1 件のデータモジュールの検証（整形式・XSD・BREX・参照）をまとめ、検証状態 `VerificationStatus` を返す | `verifyDataModule` |
| 配布物の場所（`specDir`）と CSDB の場所（`csdbDirs`）を、環境変数か設定ファイルから決める | `resolveStackConfig` / `stackConfigPath` / `specDirHowTo` |
| 検証結果（XSD・BREX・参照）と適用性の判定不能から、修正の候補を決定論的に決める | `suggestFixes` / `findUndeterminedApplicability` / `findApplicTables` |

```ts
import { readFileSync } from 'node:fs';
import { checkAgainstBrexChain, createDirectoryBrexResolver } from '@shuji-bonji/s1000d-core';

// 利用者が入手した S1000D の配布物（既定 BREX を含む）と、プロジェクトの CSDB から BREX を探す
const resolve = createDirectoryBrexResolver([process.env.S1000D_SPEC_DIR!, './csdb']);

const report = await checkAgainstBrexChain(readFileSync('./csdb/DMC-….XML', 'utf8'), resolve);
console.log(report.passed);
for (const layer of report.layers) {
  for (const v of layer.violations) {
    console.log(layer.brex.title, v.kind, v.ruleId, v.location?.path, v.actualValue, v.objectUse);
  }
  // nonContextRules は機械で判定できないため、手動で確認する項目として返る
  console.log(layer.manualChecks.map((m) => m.text));
}
```

## 照合の規則

S1000D Issue 7 の Chap 4.10.2（BREX data module）と Chap 7.9（Business rules processing）に沿っています。

| 項目 | 扱い |
|---|---|
| `allowedObjectFlag="0"` | `objectPath` の結果が空でなければ違反（`forbidden`） |
| `allowedObjectFlag="1"` | 結果が空なら違反（`missing`） |
| `allowedObjectFlag="2"` | 結果の各節点の値を `objectValue` と照合し、どれにも合わなければ違反（`value`）。`single` は一致、`range` は `brsl51~brsl99` のような接頭辞付きの範囲、`pattern` は正規表現の全体一致 |
| 真偽値を返す `objectPath`（`not(…)` など） | true を「対象あり」、false を「対象なし」として同じ規則で判定 |
| `contextRules/@rulesContext` | 対象データモジュールの `xsi:noNamespaceSchemaLocation` とスキーマ名が一致するブロックと、`rulesContext` の無い共通ブロックを適用 |
| `notationRuleList` | DOCTYPE の `ENTITY … NDATA` で使われている NOTATION が、許可された集合（基本セット＋スキーマ固有の再定義・除外）に無ければ違反（`notation`）。許可（`allowedNotationFlag="1"`）が 1 つも無く除外（`"0"`）だけの層は、挙げたものだけを違反にし、それ以外はその層では制限しない（`notationPolicy`） |
| `nonContextRules` | 判定せず、手動確認の項目（`manualChecks`）として返す |
| 階層 | `brexDmRef` の連鎖を既定 BREX（自分自身を参照）までたどり、各層に個別に照合する。層の統合はしない。どの層にも違反が無く、未解決の参照も無いときだけ `passed` |
| `brSeverityLevel` | ルールの属性、無ければ `brex/@defaultBrSeverityLevel` をそのまま報告に載せる。意味の解釈はしない |

## XML スキーマ（XSD）による検証

XSD は配布物に含まれ再配布できないため、利用者が展開したフォルダーから探します。検証の実装は `libxml2-wasm` で、サブパス `@shuji-bonji/s1000d-core/xsd-libxml2` から読み込みます。`libxml2-wasm` は任意の peerDependency なので、使うパッケージ側で `npm install libxml2-wasm` が要ります。

```ts
import { findSchemaDirs, createDirectoryBrexResolver, verifyDataModule } from '@shuji-bonji/s1000d-core';
import { Libxml2SchemaValidator } from '@shuji-bonji/s1000d-core/xsd-libxml2';

const specDir = process.env.S1000D_SPEC_DIR!;
const schemaDirs = findSchemaDirs([specDir]);          // brex.xsd を含む xml_schema_flat/ を探す（版は brex.xsd から読む）
const validator = new Libxml2SchemaValidator();        // XSD ごとに 1 つコンパイルして使い回す
try {
  const result = await verifyDataModule(xml, {
    path: 'DMC-….XML',
    schema: { validator, schemaDirs },
    brex: { resolver: createDirectoryBrexResolver([specDir, './csdb']) },
    references: { csdb: ['./csdb'] },
  });
  console.log(result.status.schema.state);   // valid / invalid / schema-not-found / not-run
  console.log(result.status.brex.state);     // passed / violations / incomplete / not-run
  console.log(result.status.references.state); // resolved / unresolved / not-run
  console.log(result.schema.errors);         // libxml2 の文章と行番号
  console.log(result.references?.unresolved); // 見つからなかった参照と理由
} finally {
  validator.dispose();
}
```

`VerificationStatus` には S1000D 準拠を表す 1 つの真偽値を置いていません。XSD と BREX の機械判定に通っても、nonContextRules（`brex.manualChecks`）と人が読むビジネスルール文書が残るためです。

## 配布物と CSDB の場所

`resolveStackConfig` は、利用者が入手した S1000D の配布物の場所と、プロジェクトの CSDB の場所を決めます。読む順番は、環境変数 `S1000D_SPEC_DIR` / `S1000D_CSDB_DIR`、次に設定ファイルです。設定ファイルの既定の場所は `~/.config/s1000d-stack/config.json`（`XDG_CONFIG_HOME` があればその下）で、`S1000D_CONFIG` で変えられます。

```json
{
  "specDir": "~/s1000d/issue-7",
  "csdbDirs": ["~/projects/kenbaiki/csdb"]
}
```

`~/` で始まるパスと、設定ファイルのあるフォルダーからの相対パスも使えます。設定ファイルを用意したのは、Claude Desktop などの MCP ホストが plugin で入れたサーバーに環境変数を渡さないためです。ホストが `${S1000D_SPEC_DIR}` を置き換えずに文字のまま渡したときは、その値を使わずに設定ファイルを読み、`warnings` に理由を書きます。

## 修正提案

`suggestFixes` は `verifyDataModule` の結果から、違反ごとに「何を」「どこで」「どの値に」直せばよいかの候補（`Fix`）を返します。候補はすべてこのライブラリが決め、LLM には候補の中から選んで説明させる使い方を想定しています。LLM が許可値や参照先を自分で考え出さないようにするためです。

| 元になる結果 | 候補 | 出どころ（`source`） |
|---|---|---|
| BREX の値の違反 | そのルールの `objectValue`（許可値と説明文。`range` と `pattern` は書き方を付けて渡す） | BREX のルール ID |
| BREX の禁止・欠落 | 取り除く・足す（`objectValue` があれば初期値の候補にする） | BREX のルール ID |
| BREX の NOTATION の違反 | 許可された NOTATION の一覧 | BREX |
| XSD の違反 | libxml2 の文章にある値・要素。文章に無ければ XSD の定義（`xs:enumeration`・`xs:pattern`・子要素と属性の一覧）を読んで作る | XSD のファイル名と定義の名前 |
| 未解決の参照 | 情報コードだけ違う DMC、システム差異コードだけ違う DMC、CSDB にある版、拡張子だけ違う ICN、近い id。仕様書の章への参照（モデル識別コード `S1000D`）は説明だけを返す | CsdbIndex、文書内の id |
| 適用性の判定不能 | 製品に与える値（ACT の列挙・`valuePattern`、CCT の列挙、PCT の製品の値） | ACT・CCT・PCT |

確からしさは `confidence` の 3 段階（`exact` = 候補が 1 つで値も決まる、`several` = 複数から選ぶか範囲・正規表現の中から選ぶ、`none` = 候補なし）で表し、点数は付けません。

```ts
import { findApplicTables, findUndeterminedApplicability, resolveBrexChain, suggestFixes, CsdbIndex } from '@shuji-bonji/s1000d-core';

const csdb = CsdbIndex.fromDirs(['./csdb']);
const result = await verifyDataModule(xml, { schema: { validator, schemaDirs }, brex: { resolver }, references: { csdb } });
const chain = await resolveBrexChain(result.info?.identAndStatus?.brexDmRef, resolver);

// 適用性は、判定に使う製品を決めたときだけ見る
const tables = findApplicTables(xml, csdb);
const findings = findUndeterminedApplicability(xml, { attributes: { model: 'MV-50' }, conditions: {} });

const fixes = suggestFixes(result, {
  xml,                       // 文書内の id から internalRef / applicRefId の候補を探す
  csdb,                      // 参照の候補を探す
  brexLayers: chain.layers,  // objectValue の説明文を候補に添える
  applicability: { findings, act: tables.act?.act, cct: tables.cct?.cct, pct: tables.pct?.pct },
});
for (const f of fixes) console.log(f.kind, f.location?.path, f.confidence, f.candidates.map((c) => c.value));
```

XSD の定義は `result.schema.xsdPath` から読みます（`xsd: false` で読まずに済ませられます）。修正を文書に当てる処理（`apply_fix`）は持っていません。段階 3 の s1000d-writer-mcp が受け持ちます。

## XML と XPath のライブラリ

XML は `@xmldom/xmldom`、XPath は `fontoxpath`（XPath 3.1）で評価します。S1000D Issue 7 の既定 BREX には XPath 2.0 の構文（`for … return some … satisfies`）を使うルールが含まれるため、XPath 1.0 だけのエンジンでは既定 BREX のすべてのルールを評価できません。ライブラリの差し替えに備え、両方を `XmlEngine` インターフェースの後ろに置いています。

> [!TIP]
> 配布物の中には、ファイル名の DMC と中身の DMC が一致しない見本（データ辞書の `samples/`）があります。`createDirectoryBrexResolver` は中身の DMC が参照と一致するファイルを優先し、見つからなければ最初に読めたものを返します。

## テスト

```sh
npm test            # 自作のテストデータだけで動く
npm run test:spec   # 利用者が入手した S1000D の配布物を使う（S1000D_SPEC_DIR で場所を指定）
```

`test:spec` は、配布物を `../../specs/s1000d/issue-7`（s1000d-stack の配置）または環境変数 `S1000D_SPEC_DIR` の場所から読みます。配布物は再配布できないため、リポジトリには含みません。

## ライセンス

MIT
