//! atlas 自身の版を、このチェックアウトの git から読む(packages/core/src/atlas-build.ts と code-stamp.ts の移植)。
//! 送るときに添え、送り先から集計するときに「この PC の版」として比べる。
//! TODO(段 8): コードの目印は今は TS 版と同じく packages/ の下のソースから作る(TS 版と Rust 版で同じ目印になる)。
//! TS のサーバー側のコードを消すときに、Rust 版の目印の作り方を決め直す。

use crate::atlas_version::{AtlasBuild, COMMIT_RE};
use crate::jsdate;
use regex::Regex;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{LazyLock, OnceLock};
use std::time::{Duration, Instant};

const GIT_TIMEOUT: Duration = Duration::from_secs(10);
/// npm が書き換えることのある、git が管理しているファイル
const LOCK_FILE: &str = "package-lock.json";

/// 各パッケージの直下で目印に入れるファイル
const PACKAGE_FILES: &[&str] = &["template.html", "vite.config.ts", "svelte.config.js", "tsconfig.json", "package.json"];
/// リポジトリの直下で目印に入れるファイル
const ROOT_FILES: &[&str] = &["package.json", "package-lock.json", "tsconfig.json"];
/// エディタや OS が置く作業ファイル
static JUNK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\.|~$|\.(bak|orig|rej|swp|swo|tmp)$|^(thumbs\.db|desktop\.ini)$").unwrap());

fn normalize_eol(buf: Vec<u8>) -> Vec<u8> {
    if !buf.windows(2).any(|w| w == b"\r\n") {
        return buf;
    }
    let mut out = Vec::with_capacity(buf.len());
    let mut i = 0;
    while i < buf.len() {
        if buf[i] == b'\r' && buf.get(i + 1) == Some(&b'\n') {
            i += 1;
            continue;
        }
        out.push(buf[i]);
        i += 1;
    }
    out
}

/// root(packages/ にあたる場所)の下の各パッケージと、その 1 つ上から目印を作る(code-stamp.ts の computeCodeStamp)
pub fn compute_code_stamp(root: &Path) -> std::io::Result<String> {
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    let rel_key = |f: &Path| -> String {
        match f.strip_prefix(root) {
            Ok(r) => r.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"),
            Err(_) => format!("../{}", f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
        }
    };
    let mut pkgs: Vec<_> = std::fs::read_dir(root)?.collect::<Result<Vec<_>, _>>()?;
    pkgs.sort_by_key(|e| e.file_name());
    for e in pkgs {
        if !e.file_type()?.is_dir() {
            continue;
        }
        let pkg = e.path();
        let src = pkg.join("src");
        if src.exists() {
            for f in walkdir::WalkDir::new(&src).min_depth(1) {
                let f = f.map_err(std::io::Error::other)?;
                if !f.file_type().is_file() {
                    continue;
                }
                let rel = f.path().strip_prefix(&src).unwrap();
                if rel.components().any(|c| JUNK.is_match(&c.as_os_str().to_string_lossy())) {
                    continue;
                }
                files.push((f.path().to_path_buf(), String::new()));
            }
        }
        for name in PACKAGE_FILES {
            let p = pkg.join(name);
            if p.exists() {
                files.push((p, String::new()));
            }
        }
    }
    if let Some(top) = root.parent() {
        for name in ROOT_FILES {
            let p = top.join(name);
            if p.exists() {
                files.push((p, String::new()));
            }
        }
    }
    for f in files.iter_mut() {
        f.1 = rel_key(&f.0);
    }
    files.sort_by(|a, b| crate::js::cmp_utf16(&a.1, &b.1));
    let mut h = Sha256::new();
    for (f, key) in &files {
        h.update(key.as_bytes());
        h.update(b"\0");
        h.update(normalize_eol(std::fs::read(f)?));
        h.update(b"\0");
    }
    Ok(hex::encode(h.finalize())[..16].to_string())
}

/// git を動かして標準出力を返す(失敗・時間切れは None)
fn git(repo: &Path, args: &[&str]) -> Option<String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait().ok()? {
            Some(status) => {
                let out = child.wait_with_output().ok()?;
                return status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned());
            }
            None if start.elapsed() > GIT_TIMEOUT => {
                let _ = child.kill();
                return None;
            }
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

/// リポジトリで git を動かし、版を読む。例外は投げない
pub fn read_atlas_build(repo: &Path, code: &str) -> AtlasBuild {
    let none = AtlasBuild { commit: None, committed_at: None, dirty: None, code: code.to_string() };
    if !repo.join(".git").exists() {
        return none;
    }
    let Some(out) = git(repo, &["log", "-1", "--format=%H %cI", "HEAD"]) else { return none };
    let line = crate::js::trim(&out).to_string();
    let mut parts = line.split(' ');
    let sha = parts.next().unwrap_or("");
    let at = parts.next();
    if !COMMIT_RE.is_match(sha) {
        return none;
    }
    let t = at.and_then(jsdate::parse_ms);
    let status = git(repo, &["status", "--porcelain", "--untracked-files=no"]);
    let dirty = status.map(|s| s.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).filter(|l| !crate::js::trim(l).is_empty() && crate::js::trim(crate::js::utf16_slice(l, 3, usize::MAX).as_ref()) != LOCK_FILE).count() > 0);
    AtlasBuild { commit: Some(sha.to_string()), committed_at: t.map(jsdate::to_iso), dirty, code: code.to_string() }
}

/// このプロセスが動かしている atlas の版(最初に呼んだときのもの)。repo はリポジトリの直下
pub fn current_atlas_build(repo: &Path) -> AtlasBuild {
    static CACHED: OnceLock<AtlasBuild> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            let code = compute_code_stamp(&repo.join("packages")).unwrap_or_default();
            read_atlas_build(repo, &code)
        })
        .clone()
}
