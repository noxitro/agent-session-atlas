# Security Policy

## 脆弱性の報告

公開 Issue には書かないでください。GitHub の **Security → Report a vulnerability**
(Private vulnerability reporting) から報告をお願いします。

## リポジトリ側の対策

| 対策 | 仕組み |
| --- | --- |
| 秘密情報の混入防止 | `secret-scan.yml` (gitleaks と独自の検査、[noxitro/github-templates](https://github.com/noxitro/github-templates) の共通ワークフロー)。GitHub の Secret scanning / Push protection も有効 |
| 依存の脆弱性 | Dependabot alerts / security updates。`npm audit` を CI(dependencies)と毎週(`deny-schedule.yml`。devDependencies も)、PR では `dependency-review` で新しく入る・上がる dependencies を見る |
| ファイル形式 | `file-format.yml` (BOM / 改行コード) |
