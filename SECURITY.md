# Security Policy

## 脆弱性の報告

公開 Issue には書かないでください。GitHub の **Security → Report a vulnerability**
(Private vulnerability reporting) から報告をお願いします。

## リポジトリ側の対策

| 対策 | 仕組み |
| --- | --- |
| 秘密情報の混入防止 | `secret-scan.yml` (gitleaks と独自の検査、[noxitro/github-templates](https://github.com/noxitro/github-templates) の共通ワークフロー)。GitHub の Secret scanning / Push protection も有効 |
| 依存の脆弱性 | Dependabot alerts / security updates。Rust は `cargo deny check`(`deny.toml`。RustSec の脆弱性・保守終了・取り下げ、ライセンス、取得元)を CI と毎週(`deny-schedule.yml`)、npm は `npm audit`(`scripts/npm-audit.mjs`。devDependencies も含む)を CI・毎週・リリースの前、入れたものの署名は `npm audit signatures` を CI・リリースの前、`package-lock.json` の取得元・整合性ハッシュ・インストール時のスクリプトは `scripts/lockfile.test.ts` を CI |
| 配る実行ファイル | リリースの `atlas.exe` に sha256 とビルドの来歴(GitHub の artifact attestation)を付ける。起動用の `.bat` は sha256 と、`gh` があれば来歴も確かめてから使う(README の「リリースの atlas.exe を自分で確かめる」) |
| ファイル形式 | `file-format.yml` (BOM / 改行コード) |
