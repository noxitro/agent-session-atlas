//! 出力先 out/ の作業中の印(packages/cli/src/jobs.ts のうち、out/.job.json のロックの部分の移植)。
//! out/ に書く処理の実行中だけ置く印({ pid, kind, by, startedAt })。serve のジョブも CLI の書き込むコマンド(all・judge・build など)も置き、
//! 他のプロセスの印があれば始めずに止まる(atlas.bat の再実行や npm run atlas:judge と画面の判定が、同じ out/ に並行して書かないように)。
//! ジョブの子プロセスには JOB_ENV を渡し、親(serve)の印では止まらないようにする。
//! TODO(段 5): ジョブの実行(JobRunner・parseJobRequest・jobArgs など)は serve の移植でここに足す。

use crate::sys;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const JOB_LOCK_FILE: &str = ".job.json";
pub const JOB_ENV: &str = "ATLAS_SERVE_JOB";
/// 中身を読めない印を、まだ書きかけとみなす時間(作った直後に別のプロセスが読むと空のことがある)
const LOCK_WRITE_GRACE_MS: f64 = 10_000.0;

/// プロセスがあるか(EPERM はプロセスがあるが触れない)
pub fn alive(pid: u32) -> bool {
    sys::alive(pid)
}

#[derive(Debug, Default, Clone)]
struct LockInfo {
    pid: Option<u32>,
    kind: Option<String>,
    /// 印を置いたのは serve(画面のジョブ)か CLI か
    by: Option<String>,
}

fn read_lock(p: &Path) -> Option<LockInfo> {
    let text = std::fs::read(p).ok()?;
    let v = atlas_core::js::parse_json(&String::from_utf8_lossy(&text)).ok()?;
    // JSON.parse の結果をそのまま使う(pid が数でなければ「印が無い」と同じ扱い)
    let pid = v.get("pid").and_then(Value::as_f64).filter(|n| *n > 0.0 && n.fract() == 0.0).map(|n| n as u32);
    Some(LockInfo { pid, kind: v.get("kind").and_then(Value::as_str).map(str::to_string), by: v.get("by").and_then(Value::as_str).map(str::to_string) })
}

fn written_within(p: &Path, ms: f64) -> bool {
    std::fs::metadata(p).is_ok_and(|m| (atlas_core::jsdate::now_ms() as f64 - atlas_core::jsfs::mtime_ms(&m)) < ms)
}

fn in_job() -> bool {
    std::env::var_os(JOB_ENV).is_some_and(|v| !v.is_empty())
}

/// 他のプロセスの処理が out/ で動いていれば、その種類を返す。印が古い(プロセスが無い)・自分の印・ジョブの子プロセスなら None
pub fn running_job_in(out_dir: &Path) -> Option<String> {
    if in_job() {
        return None;
    }
    let j = read_lock(&out_dir.join(JOB_LOCK_FILE))?;
    let pid = j.pid?;
    if pid == std::process::id() || !alive(pid) {
        return None;
    }
    Some(j.kind.unwrap_or_else(|| "job".into()))
}

/// 別の処理が out/ で動いている
#[derive(Debug, Clone)]
pub struct OutBusyError(pub String);

impl std::fmt::Display for OutBusyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for OutBusyError {}

impl OutBusyError {
    fn new(out_dir: &Path, j: &LockInfo) -> Self {
        let kind = j.kind.as_deref().unwrap_or("不明");
        let cli = j.by.as_deref() == Some("cli");
        let what = if cli { format!("別の atlas の処理({kind})") } else { format!("画面から実行した処理({kind})") };
        let hint = if cli { "" } else { "画面の帯で進み具合を見られます。" };
        OutBusyError(format!(
            "{what}が {} で動いています。終わってから実行してください({hint}処理がもう動いていないのにこの表示が続くときは {} を消してください)",
            out_dir.display(),
            out_dir.join(JOB_LOCK_FILE).display()
        ))
    }
}

/// 取った印。release(か drop)で外す。取らなかった(同じプロセスが持っている・ジョブの子・書けない)ときは何もしない
#[derive(Debug)]
pub struct OutLock {
    out_dir: Option<PathBuf>,
}

impl OutLock {
    pub fn release(mut self) {
        if let Some(d) = self.out_dir.take() {
            release_out_lock(&d);
        }
    }
}

impl Drop for OutLock {
    fn drop(&mut self) {
        if let Some(d) = self.out_dir.take() {
            release_out_lock(&d);
        }
    }
}

/// out/ の印を取る。他のプロセスが持っていれば OutBusyError。
/// 印は排他的に作るので、2 つが同時に取りに来ても片方だけが取れる。次のときは何もしない印を返す:
/// 同じプロセスが持っている(atlas:judge の bundle → judge → export の入れ子)・ジョブの子プロセス・印が書けない(並行実行を止められないだけで、処理は動かす)
pub fn acquire_out_lock(out_dir: &Path, kind: &str, by: &str) -> Result<OutLock, OutBusyError> {
    let none = || OutLock { out_dir: None };
    if in_job() {
        return Ok(none());
    }
    let p = out_dir.join(JOB_LOCK_FILE);
    let body = format!(
        "{}\n",
        atlas_core::json::to_js_string(&serde_json::json!({ "pid": std::process::id(), "kind": kind, "by": by, "startedAt": atlas_core::jsdate::now_iso() })).unwrap_or_default()
    );
    if std::fs::create_dir_all(out_dir).is_err() {
        return Ok(none());
    }
    for _ in 0..2 {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(mut f) => {
                use std::io::Write;
                let _ = f.write_all(body.as_bytes());
                return Ok(OutLock { out_dir: Some(out_dir.to_path_buf()) });
            }
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Ok(none()),
            Err(_) => {}
        }
        let cur = read_lock(&p);
        if cur.as_ref().and_then(|c| c.pid) == Some(std::process::id()) {
            return Ok(none());
        }
        let busy = match cur.as_ref().and_then(|c| c.pid) {
            Some(pid) => alive(pid),
            None => written_within(&p, LOCK_WRITE_GRACE_MS),
        };
        if busy {
            return Err(OutBusyError::new(out_dir, &cur.unwrap_or_default()));
        }
        // 古い印(プロセスが無い・壊れたまま時間が経った)は消して取り直す
        let _ = atlas_core::jsfs::rm_force(&p);
    }
    Err(OutBusyError::new(out_dir, &read_lock(&p).unwrap_or_default()))
}

/// 自分の印だけを消す(消せなくても止めない。次に取りに来た側はプロセスの有無で古い印を無視する)
pub fn release_out_lock(out_dir: &Path) {
    let p = out_dir.join(JOB_LOCK_FILE);
    if !p.exists() {
        return;
    }
    if read_lock(&p).and_then(|l| l.pid) == Some(std::process::id()) {
        let _ = atlas_core::jsfs::rm_force(&p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_is_exclusive_and_stale_locks_are_taken_over() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("out");
        let l = acquire_out_lock(&out, "project upload", "cli").unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(out.join(JOB_LOCK_FILE)).unwrap()).unwrap();
        assert_eq!(v["kind"], "project upload");
        assert_eq!(v["by"], "cli");
        // 同じプロセスがもう一度取りに来たら、何もしない印
        let inner = acquire_out_lock(&out, "x", "cli").unwrap();
        inner.release();
        assert!(out.join(JOB_LOCK_FILE).exists());
        assert_eq!(running_job_in(&out), None);
        l.release();
        assert!(!out.join(JOB_LOCK_FILE).exists());
        // 生きている別のプロセスの印があれば止まる。プロセスが無い印は取り直す
        let parent = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" }).args(if cfg!(windows) { ["/c", "exit 0"] } else { ["-c", "exit 0"] }).spawn().unwrap();
        let dead = parent.id();
        let mut parent = parent;
        parent.wait().unwrap();
        std::fs::write(out.join(JOB_LOCK_FILE), format!("{{\"pid\":{dead},\"kind\":\"refresh\",\"by\":\"serve\"}}")).unwrap();
        assert_eq!(running_job_in(&out), None);
        acquire_out_lock(&out, "y", "cli").unwrap().release();
        let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" }).args(if cfg!(windows) { ["/c", "ping -n 5 127.0.0.1 >nul"] } else { ["-c", "sleep 5"] }).spawn().unwrap();
        std::fs::write(out.join(JOB_LOCK_FILE), format!("{{\"pid\":{},\"kind\":\"refresh\",\"by\":\"serve\"}}", child.id())).unwrap();
        assert_eq!(running_job_in(&out).as_deref(), Some("refresh"));
        let e = acquire_out_lock(&out, "z", "cli").unwrap_err();
        assert!(e.0.starts_with("画面から実行した処理(refresh)が "), "{e}");
        assert!(e.0.contains("画面の帯で進み具合を見られます。"));
        let _ = child.kill();
        let _ = child.wait();
    }
}
