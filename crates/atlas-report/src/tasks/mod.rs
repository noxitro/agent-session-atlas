//! 管理ツールのタスクとの連携。管理ツールが書き出した XML を読み(xml.rs)、タスクの状態を atlas-notes/tasks.json に覚え(state.rs)、
//! セッションとタスクの紐づけを atlas-notes/task-links.json に持ち(links.rs)、タスクごとの工数を数える(metrics.rs・hours.rs)。
//! 送り先から集計したときは、送った人がセッションごとに添えたタスクの記録(atlas-session.json の task。sender.rs)から同じものを作る。
//! 画面に埋め込む形は view.rs。LLM で紐づける処理は atlas-judge の task_link.rs。

pub mod hours;
pub mod links;
pub mod metrics;
pub mod sender;
pub mod state;
pub mod view;
pub mod xml;

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub use hours::WorkHours;

/// タスクの状態(<notes-dir>/tasks.json)
pub const TASKS_FILE_NAME: &str = "tasks.json";
/// セッションとタスクの紐づけ(<notes-dir>/task-links.json)
pub const TASK_LINKS_FILE_NAME: &str = "task-links.json";

/// 設定の既定値(atlas.config.json の tasks の、file 以外の項目)
pub const DEFAULT_ITEM: &str = "Task";
pub const DEFAULT_ID_FIELD: &str = "Id";
pub const DEFAULT_NAME_FIELD: &str = "Name";
pub const DEFAULT_STATUS_FIELD: &str = "Status";
pub const DEFAULT_DONE_STATUS: [&str; 4] = ["Done", "Completed", "Closed", "完了"];

/// 管理ツールの書き出し(XML)の読み方と、稼働時間帯(atlas.config.json の tasks を読んだもの)
#[derive(Debug, Clone, PartialEq)]
pub struct TaskSource {
    /// 書き出した XML のファイル(設定の相対パスは、設定ファイルのフォルダから解決したもの)
    pub file: PathBuf,
    /// タスク 1 件の要素の名前(名前空間を除いた名前。大文字と小文字は区別しない)
    pub item: String,
    pub id: String,
    pub name: String,
    pub status: String,
    /// 完了とみなす状態(前後の空白を除き、大文字と小文字を区別せずに完全一致)
    pub done_status: Vec<String>,
    pub work_hours: WorkHours,
}

impl TaskSource {
    /// 既定の読み方で file を読む
    pub fn with_file(file: impl Into<PathBuf>) -> TaskSource {
        TaskSource {
            file: file.into(),
            item: DEFAULT_ITEM.into(),
            id: DEFAULT_ID_FIELD.into(),
            name: DEFAULT_NAME_FIELD.into(),
            status: DEFAULT_STATUS_FIELD.into(),
            done_status: DEFAULT_DONE_STATUS.iter().map(|s| s.to_string()).collect(),
            work_hours: WorkHours::default(),
        }
    }

    /// 状態が完了か
    pub fn is_done(&self, status: &str) -> bool {
        let s = atlas_core::js::trim(status).to_lowercase();
        self.done_status.iter().any(|d| atlas_core::js::trim(d).to_lowercase() == s)
    }

    /// 読み方の目印(同じ更新時刻の XML でも、読み方を変えたら読み直す)
    pub fn settings_key(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        for part in [self.file.to_string_lossy().as_ref(), &self.item, &self.id, &self.name, &self.status] {
            h.update(part.as_bytes());
            h.update([0u8]);
        }
        for d in &self.done_status {
            h.update(d.as_bytes());
            h.update([1u8]);
        }
        hex::encode(&h.finalize()[..8])
    }
}

/// <notes-dir>/tasks.json と <notes-dir>/task-links.json
pub fn tasks_path(notes: &Path) -> PathBuf {
    notes.join(TASKS_FILE_NAME)
}

pub fn task_links_path(notes: &Path) -> PathBuf {
    notes.join(TASK_LINKS_FILE_NAME)
}

static SEQ: AtomicU64 = AtomicU64::new(0);

fn tmp_path(path: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let mut s = path.as_os_str().to_owned();
    s.push(format!(".{}-{nanos:x}-{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    PathBuf::from(s)
}

/// 一時ファイルに書いてから置き換える(途中で止まってもファイルが欠けない。同時に読む側も書きかけを見ない)
pub(crate) fn write_atomic(path: &Path, text: &str) -> Result<()> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("{} を作れません", dir.display()))?;
    }
    let tmp = tmp_path(path);
    std::fs::write(&tmp, text).with_context(|| format!("{} に書けません", tmp.display()))?;
    if let Err(e) = atlas_core::fs_retry::rename_replacing(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("{} を置き換えられません", path.display()));
    }
    Ok(())
}

/// ロックを取れるまで待つ長さ(ms)と、落ちた処理が残したロックとみなす古さ(ms)。
/// ロックを持つのは読んで・直して・書くまでの短い間だけ(LLM の問い合わせの間は持たない)
const LOCK_WAIT_MS: u128 = 15_000;
const LOCK_STALE_MS: f64 = 30_000.0;

/// <file>.lock
pub fn lock_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".lock");
    PathBuf::from(s)
}

/// <file>.lock を排他で作り、f の間だけ持つ(serve の画面・LLM で紐づけるジョブの子プロセス・集計が、同じファイルを同時に読んで書かないように)。
/// 書き手は、このロックの中で読み直してから自分の変更だけを足して書く。落ちた処理が残した古いロックは消して取り直す
pub fn with_file_lock<T>(path: &Path, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let lock = lock_path(path);
    if let Some(dir) = lock.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("{} を作れません", dir.display()))?;
    }
    let started = std::time::Instant::now();
    loop {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
            Ok(_) => break,
            // Windows では、消したばかりのロックを同じ名前で作ると一時的に拒否されることがある(少し待ってやり直す)
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && cfg!(windows) => {}
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e).with_context(|| format!("{} を作れません", lock.display())),
            Err(_) => {
                if let Ok(m) = std::fs::metadata(&lock)
                    && atlas_core::jsdate::now_ms() as f64 - atlas_core::jsfs::mtime_ms(&m) > LOCK_STALE_MS
                {
                    let _ = std::fs::remove_file(&lock);
                    continue;
                }
            }
        }
        if started.elapsed().as_millis() > LOCK_WAIT_MS {
            anyhow::bail!("{} を別の処理が書き換えています({})。少し待ってからやり直してください", path.display(), lock.display());
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
    let r = f();
    // 消せなくても書いたことは失敗にしない(残ったロックは古くなれば次の書き手が消す)
    let _ = std::fs::remove_file(&lock);
    r
}

/// JSON のファイルを読む(無ければ None。BOM は取り除く)。読めなければ理由
pub(crate) fn read_json_file(path: &Path) -> std::result::Result<Option<serde_json::Value>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{} を読めません({e})", path.display())),
    };
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    atlas_core::js::parse_json(text).map(Some).map_err(|e| format!("{} を読めません({e})", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn done_status_is_trimmed_and_case_insensitive() {
        let s = TaskSource::with_file("x.xml");
        assert!(s.is_done(" done "));
        assert!(s.is_done("COMPLETED"));
        assert!(s.is_done("完了"));
        assert!(!s.is_done("Done!"));
        assert!(!s.is_done("未完了"));
        assert!(!s.is_done(""));
    }

    /// ロックの中の読み・直し・書きは重ならない(別の書き手の変更を消さない)。落ちた処理が残した古いロックは取り直す
    #[test]
    fn file_lock_serializes_writers_and_takes_over_stale_locks() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("n.txt");
        std::fs::write(&p, "0").unwrap();
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    for _ in 0..5 {
                        with_file_lock(&p, || {
                            let n: u32 = std::fs::read_to_string(&p)?.parse()?;
                            std::thread::sleep(std::time::Duration::from_millis(1));
                            std::fs::write(&p, (n + 1).to_string())?;
                            Ok(())
                        })
                        .unwrap();
                    }
                });
            }
        });
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "40");
        assert!(!lock_path(&p).exists());
        std::fs::write(lock_path(&p), "").unwrap();
        let old = atlas_core::jsdate::now_ms() - 120_000;
        atlas_core::jsfs::utimes(&lock_path(&p), old, old).unwrap();
        assert_eq!(with_file_lock(&p, || Ok(7)).unwrap(), 7);
        assert!(!lock_path(&p).exists());
        // f が失敗してもロックは外す
        assert!(with_file_lock(&p, || -> Result<()> { anyhow::bail!("x") }).is_err());
        assert!(!lock_path(&p).exists());
    }

    #[test]
    fn settings_key_changes_with_the_reading_rules() {
        let a = TaskSource::with_file("x.xml");
        let mut b = a.clone();
        assert_eq!(a.settings_key(), b.settings_key());
        b.done_status.push("Resolved".into());
        assert_ne!(a.settings_key(), b.settings_key());
        let mut c = a.clone();
        c.work_hours.start_min = 0;
        // 稼働時間帯は読み方ではない(数え方だけが変わる)
        assert_eq!(a.settings_key(), c.settings_key());
    }
}
