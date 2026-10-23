# リリース手順

`@shuji-bonji/s1000d-core` の公開手順です。認証は Trusted Publisher（GitHub Actions の OIDC）で行い、`NPM_TOKEN` は使いません。

> [!IMPORTANT]
> Trusted Publisher は **既に npm に存在するパッケージ**にしか設定できません。そのため 0.1.0 だけは手動で `npm publish --access public` を行いました（2026-10-24）。0.1.1 以降は tag の push で `.github/workflows/publish.yml` が公開します。

## 一度だけ行う設定（npm 側）

1. https://www.npmjs.com/package/@shuji-bonji/s1000d-core/access を開く
2. 「Trusted Publishers」→「Add」
3. Publisher: **GitHub Actions**、Repository: `shuji-bonji/s1000d-core`、Workflow filename: `publish.yml`、Environment: 空欄

## 通常のリリース

```sh
# 1. main を最新にし、テストが通ることを確認する
git checkout main && git pull
npm test && npm run lint && npm run format:check && npm run build

# 2. CHANGELOG.md に版の節を書く

# 3. 版を上げる（package.json と git tag を同時に更新）
npm version patch -m "release: v%s"   # 0.1.0 → 0.1.1
# npm version minor -m "release: v%s" # 0.1.0 → 0.2.0

# 4. tag を push する（publish.yml が動く）
git push origin main --tags

# 5. Actions の結果を確認する
gh run watch
```

## 版の上げ方の目安

| 変更 | 版 |
|---|---|
| 不具合の修正、既存 API の振る舞いを変えない追加 | patch |
| 新しい関数・型の追加、判定規則の追加（既存の結果が変わり得る） | minor |
| 公開 API の削除・改名、`XmlEngine` の差し替え | major（1.0.0 以降） |

> [!NOTE]
> 0.x の間、利用側（`s1000d-brex-mcp` など）の `^0.1.0` は minor をまたぎません。minor を上げたときは利用側の依存範囲も上げて公開し直してください。

## うまくいかないとき

| 症状 | 原因と対処 |
|---|---|
| `npm publish` が 404 | Trusted Publisher の設定が無い。上の「一度だけ行う設定」を確認する |
| `package.json version does not match tag` | `npm version` を使わず tag だけ打った。版を揃えて tag を付け直す |
| `npx publish` を実行してしまった | 別物の古いパッケージ（`publish@0.6.0`）が起動する。`npm publish` を使う |
