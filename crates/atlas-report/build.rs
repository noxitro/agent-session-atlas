//! report の画面のテンプレート(Vite で作った packages/report/dist/template.html)を、あれば実行ファイルに埋め込む。
//! 実行時はリポジトリの packages/report/dist/template.html を先に使う(TS 版と同じく、古ければ作り直す)。
//! リポジトリの外に置いた実行ファイル(段 8)は、ここで埋め込んだものを使う。無ければ埋め込まない(実行時に案内を出す)。

use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let template = dir.join("../../packages/report/dist/template.html");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("template.html");
    println!("cargo::rustc-check-cfg=cfg(atlas_embedded_template)");
    println!("cargo::rerun-if-changed={}", template.display());
    match std::fs::read(&template) {
        Ok(bytes) => {
            std::fs::write(&out, bytes).unwrap();
            println!("cargo::rustc-cfg=atlas_embedded_template");
        }
        Err(_) => std::fs::write(&out, b"").unwrap(),
    }
}
