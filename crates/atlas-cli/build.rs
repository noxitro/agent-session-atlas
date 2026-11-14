//! 実行ファイルに入れる版の情報を、ビルドのときに決める。
//!  - ATLAS_BUILD_COMMIT: 作ったときの git のコミット(全桁。git で取得したフォルダでなければ空)。atlas --version が出す。
//!    環境変数 ATLAS_BUILD_COMMIT があればそれを使う(git の無いところで作るとき用)
//!  - ATLAS_CODE_STAMP: 版の目印(16 桁)。画面とサーバの版のずれを見つけるのに使う(ページの <meta name="atlas-code"> と応答の x-atlas-code)。
//!    材料は、実行ファイルの動きを決めるものの中身: 各クレートの Cargo.toml・build.rs・src/・assets/、ワークスペースの Cargo.toml・Cargo.lock、
//!    埋め込む画面のテンプレート(packages/report/dist/template.html)と共通スタイル(packages/report/src/styles/base.css)。
//!    テスト(tests/)・例(examples/)・説明書は入れない。改行は LF にそろえ、エディタや OS が置く作業ファイルは数えない。
//!    同じ中身から作った実行ファイルは同じ目印になり、ページを書いた実行ファイルとサーバの実行ファイルが違えば目印も違う。

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;

/// 各クレートの中で目印に入れるもの
const CRATE_PARTS: &[&str] = &["Cargo.toml", "build.rs", "src", "assets"];
/// ワークスペースの直下で目印に入れるもの
const ROOT_FILES: &[&str] = &["Cargo.toml", "Cargo.lock", "packages/report/dist/template.html", "packages/report/src/styles/base.css"];

/// エディタや OS が置く作業ファイル(名前が . で始まるもの、バックアップ、パッチの残り、スワップ)
fn junk(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name.starts_with('.')
        || name.ends_with('~')
        || [".bak", ".orig", ".rej", ".swp", ".swo", ".tmp"].iter().any(|e| lower.ends_with(e))
        || lower == "thumbs.db"
        || lower == "desktop.ini"
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if junk(&name) {
            continue;
        }
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => walk(&p, out),
            Ok(t) if t.is_file() => out.push(p),
            _ => {}
        }
    }
}

fn normalize_eol(buf: Vec<u8>) -> Vec<u8> {
    if !buf.windows(2).any(|w| w == b"\r\n") {
        return buf;
    }
    let mut out = Vec::with_capacity(buf.len());
    for (i, b) in buf.iter().enumerate() {
        if *b == b'\r' && buf.get(i + 1) == Some(&b'\n') {
            continue;
        }
        out.push(*b);
    }
    out
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let o = Command::new("git").args(args).current_dir(dir).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn rerun_if_exists(p: &Path) {
    // 無いものを指すと毎回動き直すので、あるものだけ
    if p.exists() {
        println!("cargo::rerun-if-changed={}", p.display());
    }
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let crates = manifest.parent().unwrap().to_path_buf();
    let root = crates.parent().unwrap().to_path_buf();

    // 版の目印
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    let mut members: Vec<_> = std::fs::read_dir(&crates).unwrap().flatten().filter(|e| e.path().join("Cargo.toml").is_file()).map(|e| e.path()).collect();
    members.sort();
    for c in &members {
        for part in CRATE_PARTS {
            let p = c.join(part);
            rerun_if_exists(&p);
            if p.is_dir() {
                let mut v = Vec::new();
                walk(&p, &mut v);
                files.extend(v.into_iter().map(|f| (String::new(), f)));
            } else if p.is_file() {
                files.push((String::new(), p));
            }
        }
    }
    for name in ROOT_FILES {
        let p = root.join(name);
        // テンプレートはまだ無くても、できたときに作り直す(atlas-report の build.rs と同じ)
        println!("cargo::rerun-if-changed={}", p.display());
        if p.is_file() {
            files.push((String::new(), p));
        }
    }
    for f in files.iter_mut() {
        f.0 = f.1.strip_prefix(&root).unwrap().components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
    }
    files.sort();
    let mut h = Sha256::new();
    for (key, path) in &files {
        h.update(key.as_bytes());
        h.update(b"\0");
        h.update(normalize_eol(std::fs::read(path).unwrap()));
        h.update(b"\0");
    }
    let stamp = hex::encode(h.finalize())[..16].to_string();
    println!("cargo::rustc-env=ATLAS_CODE_STAMP={stamp}");

    // 作ったときのコミット
    println!("cargo::rerun-if-env-changed=ATLAS_BUILD_COMMIT");
    let commit = match std::env::var("ATLAS_BUILD_COMMIT") {
        Ok(c) => c.trim().to_string(),
        Err(_) => {
            // HEAD が動いたら(コミット・切り替え)作り直す
            if let (Some(git_dir), Some(common)) = (git(&root, &["rev-parse", "--absolute-git-dir"]), git(&root, &["rev-parse", "--path-format=absolute", "--git-common-dir"])) {
                rerun_if_exists(&Path::new(&git_dir).join("HEAD"));
                if let Some(r) = git(&root, &["symbolic-ref", "-q", "HEAD"]) {
                    rerun_if_exists(&Path::new(&common).join(r));
                }
                rerun_if_exists(&Path::new(&common).join("packed-refs"));
            }
            git(&root, &["rev-parse", "HEAD"]).filter(|s| s.len() >= 40 && s.bytes().all(|b| b.is_ascii_hexdigit())).unwrap_or_default()
        }
    };
    println!("cargo::rustc-env=ATLAS_BUILD_COMMIT={commit}");
}
