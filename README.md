# @shuji-bonji/s1000d-core

S1000D® の CSDB オブジェクト（データモジュールなど）を読むための共通ライブラリです。データモジュールコード（DMC）と ICN の分解・組み立て、識別・状態部の読み取り、XML の読み取りと XPath の評価を提供し、`s1000d-brex-mcp` / `s1000d-reader-mcp` / `s1000d-verify-mcp` / `s1000d-writer-mcp` が共有します。

> **注記**
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
| XML の読み取りと XPath 3.1 の評価（差し替え可能なインターフェース） | `XmlEngine` / `defaultXmlEngine` |

```ts
import { parseDmc, readDataModuleInfo } from '@shuji-bonji/s1000d-core';
import { readFileSync } from 'node:fs';

const dmc = parseDmc('S1000D-J-04-10-0301-00A-022A-D');
if (dmc.ok) console.log(dmc.value.infoCode); // "022"

const info = readDataModuleInfo(readFileSync('DMC-….XML', 'utf8'));
console.log(info.schemaName, info.issue, info.identAndStatus?.brexDmRef);
```

## できないこと

- XML スキーマ（XSD）による検証は行いません（段階 2 の `s1000d-verify-mcp` で扱います）。
- BREX の照合処理は、このライブラリに追加予定です（まだ入っていません）。
- 仕様書の本文は持っていません。ここにある桁数・要素名は実装者が仕様書を読んで書いたものです。

## XML と XPath のライブラリ

XML は `@xmldom/xmldom`、XPath は `fontoxpath`（XPath 3.1）で評価します。S1000D Issue 7 の既定 BREX には XPath 2.0 の構文（`for … return some … satisfies`）を使うルールが含まれるため、XPath 1.0 だけのエンジンでは既定 BREX のすべてのルールを評価できません。ライブラリの差し替えに備え、両方を `XmlEngine` インターフェースの後ろに置いています。

## テスト

```sh
npm test            # 自作のテストデータだけで動く
npm run test:spec   # 利用者が入手した S1000D の配布物を使う（S1000D_SPEC_DIR で場所を指定）
```

`test:spec` は、配布物を `../../specs/s1000d/issue-7`（s1000d-stack の配置）または環境変数 `S1000D_SPEC_DIR` の場所から読みます。配布物は再配布できないため、リポジトリには含みません。

## ライセンス

MIT
