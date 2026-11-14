//! report の画面のテンプレート(Vite で作った packages/report/dist/template.html)を実行ファイルに埋め込む。
//! 実行するときは埋め込んだものだけを使う(リポジトリの dist/ は読まない)。
//! 無ければ埋め込まない(テンプレートを使わない cargo test のため。atlas build は案内を出して止まる)。
//! 環境変数 ATLAS_REQUIRE_TEMPLATE=1 のときは、無ければビルドを止める(配る実行ファイルを作るとき。scripts/ensure-atlas.ps1 とリリースのワークフロー)。

use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let template = dir.join("../../packages/report/dist/template.html");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("template.html");
    println!("cargo::rustc-check-cfg=cfg(atlas_embedded_template)");
    println!("cargo::rerun-if-changed={}", template.display());
    println!("cargo::rerun-if-env-changed=ATLAS_REQUIRE_TEMPLATE");
    match std::fs::read(&template) {
        Ok(bytes) => {
            std::fs::write(&out, bytes).unwrap();
            println!("cargo::rustc-cfg=atlas_embedded_template");
        }
        Err(e) => {
            if std::env::var("ATLAS_REQUIRE_TEMPLATE").is_ok_and(|v| v == "1") {
                panic!("画面のテンプレート {} がありません({e})。先に npm run build:report を実行してください", template.display());
            }
            std::fs::write(&out, b"").unwrap();
        }
    }
}
