//! 管理ツールのタスクとの連携。管理ツールが書き出した XML を読み(xml.rs)、タスクの状態を atlas-notes/tasks.json に覚え(state.rs)、
//! セッションとタスクの紐づけを atlas-notes/task-links.json に持ち(links.rs)、タスクごとの工数を数える(metrics.rs・hours.rs)。
//! 送り先から集計したときは、送った人がセッションごとに添えたタスクの記録(atlas-session.json の task。sender.rs)から同じものを作る。
//! 画面に埋め込む形は view.rs。LLM に紐づけを頼む束と返答の検証は atlas-judge の task_link.rs。

pub mod extras;
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
    /// 完了日時の項目(任意。id などと同じ書き方で、@ を付けると属性だけ)。読めれば、それを完了の時刻(記録)にする
    pub done_at: Option<String>,
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
            done_at: None,
            work_hours: WorkHours::default(),
        }
    }

    /// 状態が完了か
    pub fn is_done(&self, status: &str) -> bool {
        let s = atlas_core::js::trim(status).to_lowercase();
        self.done_status.iter().any(|d| atlas_core::js::trim(d).to_lowercase() == s)
    }

    /// 読み方の目印(同じ更新時刻の XML でも、読み方を変えたら読み直す)。ファイルの場所は入れない(stamp の path に別に持つ)。
    /// 完了日時の項目を指したときは、稼働時間帯も入れる(時刻の無い完了日の時刻が変わるので、読み直す)
    pub fn settings_key(&self) -> String {
        self.key(true)
    }

    /// 稼働時間帯を除いた読み方の目印(完了かどうかの読み方。state.rs が「同じ読み方」かを比べるのに使う)。
    /// 完了日時の項目を指さなければ settings_key と同じ
    pub fn reading_key(&self) -> String {
        self.key(false)
    }

    fn key(&self, with_work_hours: bool) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        for part in [self.item.as_str(), &self.id, &self.name, &self.status] {
            h.update(part.as_bytes());
            h.update([0u8]);
        }
        for d in &self.done_status {
            h.update(d.as_bytes());
            h.update([1u8]);
        }
        // 完了日時の項目は、指したときだけ入れる(指さない設定の目印は前の版と同じ。読み直しで完了の変化を見落とさないように)。
        // 稼働時間帯も、時刻の無い完了日時の読み方を変えるので、そのときだけ入れる(with_work_hours のとき)
        if let Some(d) = &self.done_at {
            h.update([2u8]);
            h.update(d.as_bytes());
            if with_work_hours {
                h.update([2u8]);
                h.update(format!("{:?}/{}/{}", self.work_hours.days, self.work_hours.start_min, self.work_hours.end_min).as_bytes());
            }
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

/// 書き込みの一時ファイル(`<path>.<pid>-<時刻>-<連番>.tmp`)。同じプロセスの別のスレッドや、同じ pid を使い回した別の PC のプロセスと重ならないように
pub fn tmp_path(path: &Path) -> PathBuf {
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

/// ロックを取れるまで待つ長さ(ms)。ロックを持つのは読んで・直して・書くまでの短い間だけ(LLM の問い合わせの間は持たない)
const LOCK_WAIT_MS: u128 = 15_000;

/// 別の書き手がロックを持ったまま、待つ長さを過ぎた(serve は 409 で返す)
#[derive(Debug, Clone, PartialEq)]
pub struct LockBusy(pub String);

impl std::fmt::Display for LockBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LockBusy {}

/// 読めない・形が違うので書き換えないファイル(serve は 409 で返す)
#[derive(Debug, Clone, PartialEq)]
pub struct BrokenFile(pub String);

impl std::fmt::Display for BrokenFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BrokenFile {}

/// <file>.lock
pub fn lock_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".lock");
    PathBuf::from(s)
}

/// 持っているロック。落とすと(f が失敗しても、panic しても)外れる
struct LockGuard(std::fs::File);

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

/// <file>.lock の中身の印(どちらも 7 バイト)。最後にロックの中で書き終えたとき(f が Ok を返したとき)に、<file> があったかを書く。
/// 前の版が作った空の .lock や、ほかの中身のものは「分からない」として扱い、待たない(前の版と同じ)
const MARK_EXISTS: &[u8] = b"exists\n";
const MARK_ABSENT: &[u8] = b"absent\n";

/// 印が「ある」なのに <file> が見つからないときに、現れるのを待つ長さ(ms)。
/// Windows の SMB のクライアントは「ファイルが無い」を数秒覚えている(FileNotFoundCacheLifetime の既定は 5 秒。ファイルの情報やフォルダの中身は 10 秒ほど)ので、
/// 別の PC が作った直後のファイルを無いと見て、空から書き直してしまわないように、それより長く待つ。
/// 待っても無ければ、消されたものとして続ける(止まらない・エラーにしない)
const MISSING_WAIT_MS: u64 = 12_000;
/// 見つからないときに見直す間(ms)
const MISSING_POLL_MS: u64 = 250;

/// <file>.lock を開いて OS のファイルのロック(Windows は LockFileEx、ほかは flock)を排他で取り、f の間だけ持つ
/// (serve の画面・返答を取り込むジョブの子プロセス・集計が、同じファイルを同時に読んで書かないように)。
/// 書き手は、このロックの中で読み直してから自分の変更だけを足して書く。
/// ロックは開いているハンドルに付くので、落ちたプロセスのロックは OS が外す(古いロックを消して取り直す仕組みは要らず、取り合いも起きない)。
/// <file>.lock のファイルそのものは消さずに残す(消すと、開いたままの別の書き手と別のファイルを取り合うことになるため)。
/// 待つのは、別の書き手が持っているときだけ。ほかの失敗(開けない・ロックできない)はそのまま返す。
///
/// <file>.lock の中身には、最後に書き終えたときに <file> があったか(MARK_EXISTS / MARK_ABSENT)を置く。
/// 読み書きは、ロックを取ったハンドルのまま行う(名前で開き直さない。Windows のロックは範囲の全体にかかり、取ったハンドルからは読み書きできる)。
/// 印が「ある」なのに <file> が見つからなければ、共有のフォルダで別の PC が作った直後のファイルが、まだ見えていないだけかもしれないので、
/// MISSING_WAIT_MS まで待ってから f を呼ぶ。f が Ok を返したら、そのときに <file> があるかを印に書く(Err なら印は変えない)
pub fn with_file_lock<T>(path: &Path, f: impl FnOnce() -> Result<T>) -> Result<T> {
    lock_waiting(path, LOCK_WAIT_MS, MISSING_WAIT_MS, f)
}

/// 名前で見て、ファイルがあるか(見つからないときだけ false。ほかの理由で見られないときは、ある側に倒して待たない。理由は f が読むときに出る)
fn data_file_seen(path: &Path) -> bool {
    !matches!(std::fs::metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
}

/// ロックを取ったハンドルから印を読む(頭の数バイトだけ)
fn read_mark(file: &mut std::fs::File) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))?;
    let mut buf = Vec::with_capacity(16);
    file.by_ref().take(16).read_to_end(&mut buf)?;
    Ok(buf)
}

/// ロックを取ったハンドルに印を書く(同じ中身なら書かない)。長さは印どうしで同じなので、前の印より長いもの(前の版の中身など)だけを切り詰める
fn write_mark(file: &mut std::fs::File, before: &[u8], mark: &[u8]) -> std::io::Result<()> {
    use std::io::{Seek, SeekFrom, Write};
    if before == mark {
        return Ok(());
    }
    file.seek(SeekFrom::Start(0))?;
    file.write_all(mark)?;
    if file.metadata()?.len() != mark.len() as u64 {
        file.set_len(mark.len() as u64)?;
    }
    file.flush()
}

fn lock_waiting<T>(path: &Path, wait_ms: u128, missing_wait_ms: u64, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let lock = lock_path(path);
    if let Some(dir) = lock.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("{} を作れません", dir.display()))?;
    }
    let file = std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(&lock).with_context(|| format!("ロックのファイル {} を開けません", lock.display()))?;
    let started = std::time::Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) => {}
            Err(std::fs::TryLockError::Error(e)) => return Err(e).with_context(|| format!("{} をロックできません", lock.display())),
        }
        if started.elapsed().as_millis() > wait_ms {
            return Err(LockBusy(format!("{} を別の処理が書き換えています({})。少し待ってからやり直してください", path.display(), lock.display())).into());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let mut guard = LockGuard(file);
    let before = read_mark(&mut guard.0).with_context(|| format!("ロックのファイル {} を読めません", lock.display()))?;
    if before == MARK_EXISTS && !data_file_seen(path) {
        // 前に書き終えたときにはあったのに、見つからない。共有のフォルダで、別の PC が作った直後のファイルが見えていないだけかもしれない
        let waited = std::time::Instant::now();
        let bound = std::time::Duration::from_millis(missing_wait_ms);
        let mut seen = false;
        while waited.elapsed() < bound {
            std::thread::sleep(std::time::Duration::from_millis(MISSING_POLL_MS).min(bound.saturating_sub(waited.elapsed())));
            if data_file_seen(path) {
                seen = true;
                break;
            }
        }
        let secs = waited.elapsed().as_secs_f64();
        if seen {
            eprintln!("{} が見えるまで {secs:.1} 秒待ちました(前に書いたときにはあったファイル)", path.display());
        } else {
            eprintln!("{} が {secs:.1} 秒待っても見つからないので、消されたものとして続けます", path.display());
        }
    }
    let out = f()?;
    let mark = if data_file_seen(path) { MARK_EXISTS } else { MARK_ABSENT };
    if let Err(e) = write_mark(&mut guard.0, &before, mark) {
        // 書き込みそのものは済んでいるので、失敗にはしない(次に書くときに、前の版と同じく待たないか、1 回だけ余分に待つだけ)
        eprintln!("ロックのファイル {} に、{} があるかの印を書けませんでした({e})", lock.display(), path.display());
    }
    Ok(out)
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

    /// 1 つの読み・直し・書きを数える(重なれば数が減る)
    fn bump(p: &Path) -> Result<()> {
        let n: u32 = std::fs::read_to_string(p)?.parse()?;
        std::thread::sleep(std::time::Duration::from_millis(1));
        std::fs::write(p, (n + 1).to_string())?;
        Ok(())
    }

    /// ロックの中の読み・直し・書きは重ならない(別の書き手の変更を消さない)。
    /// 前の処理が残した <file>.lock があっても(中身や更新時刻に関わらず)、何人もの書き手が同時に待っても、1 人ずつ取る
    #[test]
    fn file_lock_serializes_writers_even_with_a_leftover_lock_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("n.txt");
        std::fs::write(&p, "0").unwrap();
        // 落ちた処理が残した、古いロックのファイル
        std::fs::write(lock_path(&p), "前の処理").unwrap();
        let old = atlas_core::jsdate::now_ms() - 120_000;
        atlas_core::jsfs::utimes(&lock_path(&p), old, old).unwrap();
        let inside = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    for _ in 0..5 {
                        with_file_lock(&p, || {
                            assert_eq!(inside.fetch_add(1, std::sync::atomic::Ordering::SeqCst), 0, "2 人が同時にロックを持った");
                            let r = bump(&p);
                            inside.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                            r
                        })
                        .unwrap();
                    }
                });
            }
        });
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "40");
        // f が失敗しても、panic しても、ロックは外れる
        assert!(with_file_lock(&p, || -> Result<()> { anyhow::bail!("x") }).is_err());
        let r = std::panic::catch_unwind(|| with_file_lock(&p, || -> Result<()> { panic!("途中で止まった") }));
        assert!(r.is_err());
        assert_eq!(with_file_lock(&p, || Ok(7)).unwrap(), 7);
    }

    /// 持っている間は、ほかの書き手は待つ(待ちきれなければ LockBusy)
    #[test]
    fn busy_lock_waits_then_reports_busy() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("x.json");
        let lock = lock_path(&p);
        let holder = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&lock).unwrap();
        holder.lock().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|s| {
            s.spawn(|| {
                let t = std::time::Instant::now();
                with_file_lock(&p, || Ok(())).unwrap();
                tx.send(t.elapsed()).unwrap();
            });
            std::thread::sleep(std::time::Duration::from_millis(150));
            holder.unlock().unwrap();
        });
        assert!(rx.recv().unwrap() >= std::time::Duration::from_millis(100));
        // 待ちきれなければ LockBusy
        holder.lock().unwrap();
        let e = lock_waiting(&p, 100, MISSING_WAIT_MS, || Ok(())).unwrap_err();
        assert!(e.downcast_ref::<LockBusy>().is_some(), "{e}");
        holder.unlock().unwrap();
        // ロックのファイルの代わりにフォルダがあるなど、ロックそのものを作れないときは、待たずに本当の理由を返す
        let q = d.path().join("y.json");
        std::fs::create_dir_all(lock_path(&q)).unwrap();
        let t = std::time::Instant::now();
        let e = with_file_lock(&q, || Ok(())).unwrap_err();
        assert!(t.elapsed() < std::time::Duration::from_secs(5));
        assert!(e.to_string().contains("ロックのファイル"), "{e}");
        assert!(e.downcast_ref::<LockBusy>().is_none());
    }

    /// ロックの中で、ファイルがあれば中身を、無ければ「空」を返す(書き手が読み直すのと同じ)
    fn read_or_empty(p: &Path) -> Result<String> {
        match std::fs::read_to_string(p) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(e.into()),
        }
    }

    /// 印が「ある」のに見つからないときは、現れるまで待ってから f を呼ぶ(空から書き直して、別の PC の分を消さない)
    #[test]
    fn waits_for_a_file_the_mark_says_exists() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("j.json");
        std::fs::write(lock_path(&p), MARK_EXISTS).unwrap();
        let t = std::time::Instant::now();
        let seen = std::thread::scope(|s| {
            s.spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(200));
                write_atomic(&p, "別の PC の分").unwrap();
            });
            lock_waiting(&p, LOCK_WAIT_MS, 5_000, || {
                let cur = read_or_empty(&p)?;
                std::fs::write(&p, format!("{cur}+自分の分"))?;
                Ok(cur)
            })
            .unwrap()
        });
        assert_eq!(seen, "別の PC の分");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "別の PC の分+自分の分");
        assert!(t.elapsed() >= std::time::Duration::from_millis(200));
        assert!(t.elapsed() < std::time::Duration::from_millis(4_000), "{:?}", t.elapsed());
        assert_eq!(std::fs::read(lock_path(&p)).unwrap(), MARK_EXISTS);
    }

    /// 待っても現れなければ、消されたものとして続ける(止まらない・エラーにしない)。書かなければ印は「無い」になり、次は待たない
    #[test]
    fn gives_up_waiting_after_the_bound() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("j.json");
        std::fs::write(lock_path(&p), MARK_EXISTS).unwrap();
        let t = std::time::Instant::now();
        let seen = lock_waiting(&p, LOCK_WAIT_MS, 600, || read_or_empty(&p)).unwrap();
        assert_eq!(seen, "");
        assert!(t.elapsed() >= std::time::Duration::from_millis(600), "{:?}", t.elapsed());
        assert!(t.elapsed() < std::time::Duration::from_millis(5_000), "{:?}", t.elapsed());
        assert_eq!(std::fs::read(lock_path(&p)).unwrap(), MARK_ABSENT);
        let t = std::time::Instant::now();
        lock_waiting(&p, LOCK_WAIT_MS, 5_000, || Ok(())).unwrap();
        assert!(t.elapsed() < std::time::Duration::from_millis(500), "{:?}", t.elapsed());
    }

    /// 前の版が作った .lock(空・ほかの中身)と「無い」の印では待たない
    #[test]
    fn legacy_or_absent_mark_does_not_wait() {
        let d = tempfile::tempdir().unwrap();
        for (i, before) in [&b""[..], "前の処理".as_bytes(), MARK_ABSENT].into_iter().enumerate() {
            let p = d.path().join(format!("j{i}.json"));
            std::fs::write(lock_path(&p), before).unwrap();
            let t = std::time::Instant::now();
            lock_waiting(&p, LOCK_WAIT_MS, 5_000, || Ok(())).unwrap();
            assert!(t.elapsed() < std::time::Duration::from_millis(500), "{i}: {:?}", t.elapsed());
            assert_eq!(std::fs::read(lock_path(&p)).unwrap(), MARK_ABSENT, "{i}");
        }
    }

    /// 書き終えたら、そのときにファイルがあるかを印に書く(前の中身が長くても切り詰める)。f が失敗したら印は変えない
    #[test]
    fn mark_follows_successful_writes_only() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("j.json");
        // 前の版が残した、印より長い中身
        std::fs::write(lock_path(&p), "前の処理が残した中身").unwrap();
        with_file_lock(&p, || Ok(std::fs::write(&p, "1")?)).unwrap();
        assert_eq!(std::fs::read(lock_path(&p)).unwrap(), MARK_EXISTS);
        // f が失敗したら(消してから失敗しても)、印は変えない
        assert!(with_file_lock(&p, || -> Result<()> {
            std::fs::remove_file(&p)?;
            anyhow::bail!("途中で失敗した")
        })
        .is_err());
        assert_eq!(std::fs::read(lock_path(&p)).unwrap(), MARK_EXISTS);
        std::fs::write(&p, "1").unwrap();
        // 書き手が消せば「無い」、また作れば「ある」
        with_file_lock(&p, || Ok(std::fs::remove_file(&p)?)).unwrap();
        assert_eq!(std::fs::read(lock_path(&p)).unwrap(), MARK_ABSENT);
        with_file_lock(&p, || write_atomic(&p, "2")).unwrap();
        assert_eq!(std::fs::read(lock_path(&p)).unwrap(), MARK_EXISTS);
        // 印を書いている間も、ほかの書き手はロックを取れない(印はロックを取ったハンドルで書く)
        let other = std::fs::OpenOptions::new().read(true).write(true).open(lock_path(&p)).unwrap();
        with_file_lock(&p, || {
            assert!(matches!(other.try_lock(), Err(std::fs::TryLockError::WouldBlock)));
            Ok(())
        })
        .unwrap();
        other.lock().unwrap();
        other.unlock().unwrap();
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
