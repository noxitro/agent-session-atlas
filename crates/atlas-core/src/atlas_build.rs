//! atlas 自身の版を、このチェックアウトの git から読む(TS 版の packages/core/src/atlas-build.ts の移植)。
//! 送るときに添え、送り先から集計するときに「この PC の版」として比べる。
//! コードの目印(code)は実行ファイルを作ったときに決まる(crates/atlas-cli/build.rs)ので、呼ぶ側が渡す。

use crate::atlas_version::{AtlasBuild, COMMIT_RE};
use crate::jsdate;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const GIT_TIMEOUT: Duration = Duration::from_secs(10);
/// npm が書き換えることのある、git が管理しているファイル
const LOCK_FILE: &str = "package-lock.json";

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

/// このプロセスが動かしている atlas の版(最初に呼んだときのもの)。repo はリポジトリの直下、code は実行ファイルの版の目印
pub fn current_atlas_build(repo: &Path, code: &str) -> AtlasBuild {
    static CACHED: OnceLock<AtlasBuild> = OnceLock::new();
    CACHED.get_or_init(|| read_atlas_build(repo, code)).clone()
}
