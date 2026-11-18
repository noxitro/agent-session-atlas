# Security Policy

## 脆弱性の報告

公開 Issue には書かないでください。GitHub の **Security → Report a vulnerability**
(Private vulnerability reporting) から報告をお願いします。

## リポジトリ側の対策

| 対策 | 仕組み |
| --- | --- |
| 秘密情報の混入防止 | `secret-scan.yml` (gitleaks と独自の検査、[noxitro/github-templates](https://github.com/noxitro/github-templates) の共通ワークフロー)。GitHub の Secret scanning / Push protection も有効 |
| 依存の脆弱性 | Dependabot alerts / security updates。`npm audit`(`scripts/npm-audit.mjs`。devDependencies も含む)を CI と毎週(`deny-schedule.yml`)、入れたものの署名は `npm audit signatures` を CI、`package-lock.json` の取得元・整合性ハッシュ・インストール時のスクリプトは `scripts/lockfile.test.ts` を CI、PR では `dependency-review` で新しく入る・上がる dependencies を見る |
| ファイル形式 | `file-format.yml` (BOM / 改行コード) |
