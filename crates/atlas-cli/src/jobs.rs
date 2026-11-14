//! atlas serve の画面から動かす処理(ジョブ。packages/cli/src/jobs.ts の移植)。同時に 1 つだけ。
//! - refresh: 子プロセス `atlas all --out <out> --notes-dir <notes>`(集計し直す)
//! - judge:   子プロセス `atlas judge-flow --limit <n> --backend <b> --out <out> --notes-dir <notes>`(bundle → judge run → export)
//! - full:    サーバ内で 1 件だけ全文記録を書く(write_full_record。atlas.html・coverage.json・他のセッションは触らない)
//! - bundle:  子プロセス `atlas bundle --unjudged …`(チャットに添付する評価バンドルを未判定のセッションだけで作る。LLM は呼ばない)
//! - export:  子プロセス `atlas export …`(チャットの返答を取り込んだ後、判定をレポートに反映する)
//! - turn-bundle: 子プロセス `atlas turns bundle --unjudged …`(依頼ごとの判定でチャットに添付するファイルを作る。LLM は呼ばない)
//! - turn-judge:  子プロセス `atlas judge-flow --turns --limit <n> …`(依頼ごとの判定を GitHub Copilot CLI で回し、レポートを作り直す)
//! - m365 / turn-m365: 子プロセス `atlas judge m365 …` / `atlas turns m365 …`(M365 Copilot のアプリを操作して判定する)
//! 子プロセスの引数はここで固定の配列に組み立て、この実行ファイル自身(TS 版は process.execPath と main.ts)を shell なしで起動する
//! (画面からの文字列をコマンドラインに入れない)。起動の仕方(spawn)と全文の書き出し(run_full)は差し替えられる(単体テストを速く回すため)。
//!
//! out/ に書く処理の実行中だけ置く印({ pid, kind, by, startedAt })も持つ。serve のジョブも CLI の書き込むコマンド(all・judge・build など)も置き、
//! 他のプロセスの印があれば始めずに止まる(atlas.bat の再実行や npm run atlas:judge と画面の判定が、同じ out/ に並行して書かないように)。
//! ジョブの子プロセスには JOB_ENV を渡し、親(serve)の印では止まらないようにする。

use crate::sys;
use serde::Serialize;
use serde_json::{Map, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

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
    /// 外さずに持ち続ける(serve のジョブは、終わったときに drop_lock で外す)
    pub fn keep(mut self) {
        self.out_dir = None;
    }

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


// ---------- ジョブ ----------

pub const JOB_KINDS: [&str; 9] = ["refresh", "judge", "full", "bundle", "export", "turn-bundle", "turn-judge", "m365", "turn-m365"];
/// 画面から始める判定のバックエンド(従量課金の anthropic は CLI だけ)
pub const JOB_BACKENDS: [&str; 1] = ["copilot-cli"];
pub const JOB_LIMIT_MAX: i64 = 500;
/// 依頼ごとの判定の件数の上限(1 セッション 200 依頼 × 数十セッション)
pub const TURN_LIMIT_MAX: i64 = 5000;
/// 残すログの行数(子プロセスの stdout / stderr の末尾)
pub const JOB_LOG_LINES: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub enum JobRequest {
    Refresh,
    Judge { limit: i64, backend: String },
    Full { id: String },
    Bundle,
    Export,
    TurnBundle,
    TurnJudge { limit: i64 },
    M365,
    TurnM365,
}

impl JobRequest {
    pub fn kind(&self) -> &'static str {
        match self {
            JobRequest::Refresh => "refresh",
            JobRequest::Judge { .. } => "judge",
            JobRequest::Full { .. } => "full",
            JobRequest::Bundle => "bundle",
            JobRequest::Export => "export",
            JobRequest::TurnBundle => "turn-bundle",
            JobRequest::TurnJudge { .. } => "turn-judge",
            JobRequest::M365 => "m365",
            JobRequest::TurnM365 => "turn-m365",
        }
    }
}

/// 要求の中身(判定の件数とバックエンド、全文のセッション id)
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct JobTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub id: String,
    pub kind: String,
    /// running / done / failed / canceled
    pub state: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub exit_code: Option<i32>,
    /// 子プロセスの stdout / stderr(full はサーバ内の進み具合)の末尾 JOB_LOG_LINES 行
    pub log: Vec<String>,
    pub target: JobTarget,
}

/// 画面に返す失敗(HTTP の状態コードつき)
#[derive(Debug, Clone, PartialEq)]
pub struct JobError {
    pub status: u16,
    pub message: String,
}

impl JobError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        JobError { status, message: message.into() }
    }
}

impl std::fmt::Display for JobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for JobError {}

fn job_keys(kind: &str) -> &'static [&'static str] {
    match kind {
        "judge" => &["kind", "limit", "backend"],
        "full" => &["kind", "id"],
        "turn-judge" => &["kind", "limit"],
        _ => &["kind"],
    }
}

/// JS の Number.isInteger(数の値で、整数)
fn integer_of(v: Option<&Value>) -> Option<i64> {
    let n = v?.as_f64()?;
    (n.is_finite() && n.fract() == 0.0).then_some(n as i64)
}

/// POST /api/jobs の本文を検証する(純関数)。kind は列挙、limit は 0〜500 の整数(数値で必須。画面の確認で決めた件数だけ受ける)、
/// backend は省ける(画面から始める判定は copilot-cli だけなので、無ければそれ。書くなら copilot-cli)、id はファイル名に使える形で、
/// known_id(sessions.json にあるか)を満たすこと。知らないキーは 400
pub fn parse_job_request(body: &Map<String, Value>, known_id: &dyn Fn(&str) -> bool) -> Result<JobRequest, JobError> {
    let kind = match body.get("kind") {
        Some(Value::String(k)) if JOB_KINDS.contains(&k.as_str()) => k.as_str(),
        _ => return Err(JobError::new(400, format!("kind は {} のどれかです", JOB_KINDS.join(" / ")))),
    };
    let allowed = job_keys(kind);
    let extra: Vec<&str> = body.keys().map(String::as_str).filter(|k| !allowed.contains(k)).collect();
    if !extra.is_empty() {
        return Err(JobError::new(400, format!("{kind} では使えない項目です: {}", extra.join(", "))));
    }
    match kind {
        "refresh" => return Ok(JobRequest::Refresh),
        "bundle" => return Ok(JobRequest::Bundle),
        "export" => return Ok(JobRequest::Export),
        "turn-bundle" => return Ok(JobRequest::TurnBundle),
        "m365" => return Ok(JobRequest::M365),
        "turn-m365" => return Ok(JobRequest::TurnM365),
        _ => {}
    }
    if kind == "turn-judge" {
        return match integer_of(body.get("limit")) {
            Some(limit) if (0..=TURN_LIMIT_MAX).contains(&limit) => Ok(JobRequest::TurnJudge { limit }),
            _ => Err(JobError::new(400, format!("limit には 0〜{TURN_LIMIT_MAX} の整数を指定してください(判定する依頼の数の上限)"))),
        };
    }
    if kind == "judge" {
        let Some(limit) = integer_of(body.get("limit")).filter(|l| (0..=JOB_LIMIT_MAX).contains(l)) else {
            return Err(JobError::new(400, format!("limit には 0〜{JOB_LIMIT_MAX} の整数を指定してください(判定する件数の上限)")));
        };
        let backend = match body.get("backend") {
            None => JOB_BACKENDS[0].to_string(),
            Some(Value::String(b)) if JOB_BACKENDS.contains(&b.as_str()) => b.clone(),
            Some(_) => return Err(JobError::new(400, format!("backend は {} です(従量課金の anthropic は CLI からだけ使えます)", JOB_BACKENDS.join(" / ")))),
        };
        return Ok(JobRequest::Judge { limit, backend });
    }
    let id = match body.get("id") {
        Some(Value::String(id)) if atlas_report::memo::is_safe_memo_id(id) => id.clone(),
        _ => return Err(JobError::new(400, "セッション id の形が正しくありません")),
    };
    if !known_id(&id) {
        return Err(JobError::new(404, format!("セッション {id} は sessions.json にありません(集計し直すと出ることがあります)")));
    }
    Ok(JobRequest::Full { id })
}

/// 子プロセスの引数を決める場所
pub struct JobArgsInput<'a> {
    pub out_dir: &'a str,
    pub notes_dir: &'a str,
    /// 集計し直すときに読む場所(別のフォルダを開いたサーバ。省略時は CLI の既定)
    pub home: Option<&'a str>,
}

/// 子プロセスの引数(この実行ファイルの後ろ。TS 版の main.ts / judge-flow.ts の代わりにサブコマンドを置く)。サーバが固定の形で組み立てる。full はサーバ内なので None
pub fn job_args(req: &JobRequest, p: &JobArgsInput<'_>) -> Option<Vec<String>> {
    let mut v: Vec<String> = match req {
        // home: 別のフォルダを開いたサーバ(atlas open)は、集計し直すときも同じフォルダを読む
        JobRequest::Refresh => {
            let mut v = vec!["all".to_string()];
            if let Some(h) = p.home {
                v.extend(["--home".to_string(), h.to_string()]);
            }
            v
        }
        JobRequest::Judge { limit, backend } => vec!["judge-flow".into(), "--limit".into(), limit.to_string(), "--backend".into(), backend.clone()],
        JobRequest::Bundle => vec!["bundle".into(), "--unjudged".into()],
        JobRequest::Export => vec!["export".into()],
        JobRequest::TurnBundle => vec!["turns".into(), "bundle".into(), "--unjudged".into()],
        JobRequest::TurnJudge { limit } => vec!["judge-flow".into(), "--turns".into(), "--limit".into(), limit.to_string()],
        // M365 Copilot のアプリを操作して、未判定の添付ファイルを判定する(取り込めたらレポートにも反映する)
        JobRequest::M365 => vec!["judge".into(), "m365".into()],
        JobRequest::TurnM365 => vec!["turns".into(), "m365".into()],
        JobRequest::Full { .. } => return None,
    };
    v.extend(["--out".to_string(), p.out_dir.to_string(), "--notes-dir".to_string(), p.notes_dir.to_string()]);
    Some(v)
}

/// spawn の差し替え口。stdout / stderr を読み、終わりを待ち、止める
pub trait ChildLike: Send {
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>>;
    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>>;
    /// 終わるまで待つ(終了コード。止められたなどで無ければ None)
    fn wait(&mut self) -> std::io::Result<Option<i32>>;
    /// 止める口(wait を待っている間に別のスレッドから呼ぶ)
    fn killer(&self) -> Box<dyn Fn() + Send + Sync>;
}

/// 子プロセスを起動する(引数はこの実行ファイルの後ろ、env は親の環境変数に足すもの)
pub type SpawnFn = Arc<dyn Fn(&[String], &[(String, String)]) -> std::io::Result<Box<dyn ChildLike>> + Send + Sync>;

/// 本物の子プロセス
struct RealChild {
    child: std::process::Child,
    tree: Arc<ProcessTree>,
}

impl ChildLike for RealChild {
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>)
    }
    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        self.child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)
    }
    fn wait(&mut self) -> std::io::Result<Option<i32>> {
        self.child.wait().map(|s| s.code())
    }
    fn killer(&self) -> Box<dyn Fn() + Send + Sync> {
        let t = self.tree.clone();
        Box::new(move || t.kill())
    }
}

/// 子プロセスと、その子孫(judge-flow が起動した copilot など)。止めるときはまとめて止める。
/// Windows ではジョブオブジェクトに入れておき、すぐに子孫ごと止める(TS 版は taskkill /T /F。Rust 版の集計は速く、taskkill が動き出す前に終わることがある)
struct ProcessTree {
    pid: u32,
    #[cfg(windows)]
    job: usize,
}

impl ProcessTree {
    fn of(child: &std::process::Child) -> ProcessTree {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};
            // SAFETY: 名前の無いジョブを作り、子プロセスのハンドルを入れるだけ。入れられなければ閉じて taskkill に任せる
            let job = unsafe {
                let j = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if !j.is_null() && AssignProcessToJobObject(j, child.as_raw_handle()) == 0 {
                    CloseHandle(j);
                    std::ptr::null_mut()
                } else {
                    j
                }
            };
            ProcessTree { pid: child.id(), job: job as usize }
        }
        #[cfg(not(windows))]
        ProcessTree { pid: child.id() }
    }

    fn kill(&self) {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::JobObjects::TerminateJobObject;
            // SAFETY: 作ったジョブのハンドル(閉じるのは drop のときだけ)
            if self.job != 0 && unsafe { TerminateJobObject(self.job as windows_sys::Win32::Foundation::HANDLE, 1) } != 0 {
                return;
            }
        }
        kill_tree(self.pid);
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(windows)]
        if self.job != 0 {
            // SAFETY: 作ったジョブのハンドルを 1 度だけ閉じる(中のプロセスは止めない)
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.job as windows_sys::Win32::Foundation::HANDLE);
            }
        }
    }
}

/// 止める(ジョブオブジェクトが使えないとき)。Windows では子孫ごと(judge-flow が起動した copilot を残さない)
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let mut c = std::process::Command::new(Path::new(&root).join("System32").join("taskkill.exe"));
        c.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        crate::self_update::hide_window(&mut c);
        if c.spawn().is_err() {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
            // SAFETY: 開けなければ null。開けたハンドルは閉じる
            unsafe {
                let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
                if !h.is_null() {
                    TerminateProcess(h, 1);
                    CloseHandle(h);
                }
            }
        }
    }
    #[cfg(unix)]
    {
        // SAFETY: SIGTERM を送るだけ
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
}

/// 既定の起動: この実行ファイルを shell なしで(窓を出さない)。
/// TS 版は Node のファイル操作の並列数(UV_THREADPOOL_SIZE)も渡していたが、Rust 版には無いので渡さない
pub fn default_spawn() -> SpawnFn {
    Arc::new(|args: &[String], env: &[(String, String)]| {
        let exe = std::env::current_exe()?;
        let mut c = std::process::Command::new(exe);
        c.args(args).envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str()))).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        crate::self_update::hide_window(&mut c);
        let child = c.spawn()?;
        let tree = Arc::new(ProcessTree::of(&child));
        Ok(Box::new(RealChild { child, tree }) as Box<dyn ChildLike>)
    })
}

/// 全文の書き出し(サーバ内)に渡すもの。log は進み具合、canceled は止める操作があったか
pub struct FullCtx {
    pub log: Box<dyn Fn(&str) + Send + Sync>,
    pub canceled: Arc<AtomicBool>,
}

pub type RunFullFn = Arc<dyn Fn(&str, &FullCtx) -> anyhow::Result<()> + Send + Sync>;

pub struct JobRunnerOptions {
    pub out_dir: PathBuf,
    pub notes_dir: PathBuf,
    /// 集計し直すときに読む場所(別のフォルダを開いたサーバ。省略時は CLI の既定)
    pub home: Option<String>,
    pub spawn: Option<SpawnFn>,
    /// 子プロセスに足す環境変数
    pub env: Vec<(String, String)>,
    pub run_full: RunFullFn,
    /// serve の窓に流す(atlas.bat の窓にもジョブのログが出る)
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
    /// ジョブが終わったとき(serve が idle の判定を再開する)
    pub on_end: Option<Arc<dyn Fn(&JobSnapshot) + Send + Sync>>,
}

fn label(kind: &str) -> &'static str {
    match kind {
        "refresh" => "集計し直す",
        "judge" => "工数を判定する",
        "full" => "全文を作る",
        "bundle" => "添付ファイルを作る",
        "export" => "レポートに反映する",
        "turn-bundle" => "依頼の判定の添付ファイルを作る",
        "turn-judge" => "依頼を判定する",
        "m365" => "M365 Copilot で工数を判定する",
        _ => "M365 Copilot で依頼を判定する",
    }
}

#[derive(Default)]
struct RunnerState {
    job: Option<JobSnapshot>,
    stop: Option<Arc<dyn Fn() + Send + Sync>>,
    canceling: bool,
    seq: u64,
}

/// `Date.now().toString(36)`
fn base36(mut n: u64) -> String {
    const D: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut v = Vec::new();
    loop {
        v.push(D[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    v.reverse();
    String::from_utf8(v).unwrap_or_default()
}

pub struct JobRunner {
    o: JobRunnerOptions,
    state: Mutex<RunnerState>,
}

impl JobRunner {
    pub fn new(o: JobRunnerOptions) -> Arc<Self> {
        Arc::new(JobRunner { o, state: Mutex::new(RunnerState::default()) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RunnerState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn current(&self) -> Option<JobSnapshot> {
        self.lock().job.clone()
    }

    pub fn running(&self) -> bool {
        self.lock().job.as_ref().is_some_and(|j| j.state == "running")
    }

    fn push(&self, line: &str) {
        let kind = {
            let mut st = self.lock();
            let Some(j) = st.job.as_mut() else { return };
            j.log.push(line.to_string());
            if j.log.len() > JOB_LOG_LINES {
                let n = j.log.len() - JOB_LOG_LINES;
                j.log.drain(0..n);
            }
            j.kind.clone()
        };
        (self.o.log)(&format!("[{}] {line}", label(&kind)));
    }

    fn finish(&self, state: &str, exit_code: Option<i32>) {
        let snap = {
            let mut st = self.lock();
            let canceling = st.canceling;
            let Some(j) = st.job.as_mut() else { return };
            if j.state != "running" {
                return;
            }
            // 止める操作の後でも、間に合って最後まで終わった(終了コード 0)ものは完了として扱う(結果は書かれている。「止めました」と出すと作り直しを促してしまう)
            j.state = if canceling && state != "done" { "canceled".into() } else { state.into() };
            j.exit_code = exit_code;
            j.ended_at = Some(atlas_core::jsdate::now_iso());
            let snap = j.clone();
            st.stop = None;
            snap
        };
        self.drop_lock();
        let how = match snap.state.as_str() {
            "done" => "完了".to_string(),
            "canceled" => "止めました".to_string(),
            _ => format!("失敗{}", exit_code.map(|c| format!("(終了コード {c})")).unwrap_or_default()),
        };
        (self.o.log)(&format!("[{}] {how}", label(&snap.kind)));
        if let Some(f) = &self.o.on_end {
            f(&snap);
        }
    }

    pub fn start(self: &Arc<Self>, req: &JobRequest) -> Result<JobSnapshot, JobError> {
        if let Some(j) = self.current().filter(|j| j.state == "running") {
            return Err(JobError::new(409, format!("ほかの処理({})が動いています。終わってから実行してください", label(&j.kind))));
        }
        // CLI(atlas.bat の再実行・npm run atlas:judge)が同じ out/ に書いている最中なら始めない。印はジョブの終わりに外す(drop_lock)
        match acquire_out_lock(&self.o.out_dir, req.kind(), "serve") {
            Ok(l) => l.keep(),
            Err(e) => return Err(JobError::new(409, e.0)),
        }
        let target = match req {
            JobRequest::Judge { limit, backend } => JobTarget { limit: Some(*limit), backend: Some(backend.clone()), id: None },
            JobRequest::TurnJudge { limit } => JobTarget { limit: Some(*limit), ..Default::default() },
            JobRequest::Full { id } => JobTarget { id: Some(id.clone()), ..Default::default() },
            _ => JobTarget::default(),
        };
        {
            let mut st = self.lock();
            st.canceling = false;
            st.seq += 1;
            let id = format!("{}-{}", base36(atlas_core::jsdate::now_ms().max(0) as u64), st.seq);
            st.job = Some(JobSnapshot { id, kind: req.kind().into(), state: "running".into(), started_at: atlas_core::jsdate::now_iso(), ended_at: None, exit_code: None, log: vec![], target });
        }
        let what = match req {
            JobRequest::Judge { limit, backend } => format!("(最大 {limit} 件、{backend})"),
            JobRequest::TurnJudge { limit } => format!("(最大 {limit} 依頼)"),
            JobRequest::Full { id } => format!("({id})"),
            _ => String::new(),
        };
        (self.o.log)(&format!("[{}] 開始{what}", label(req.kind())));
        let out = self.o.out_dir.to_string_lossy().into_owned();
        let notes = self.o.notes_dir.to_string_lossy().into_owned();
        match (job_args(req, &JobArgsInput { out_dir: &out, notes_dir: &notes, home: self.o.home.as_deref() }), req) {
            (Some(args), _) => self.start_child(&args),
            (None, JobRequest::Full { id }) => self.start_full(id.clone()),
            (None, _) => {}
        }
        Ok(self.current().expect("始めたジョブ"))
    }

    fn start_child(self: &Arc<Self>, args: &[String]) {
        let mut env = self.o.env.clone();
        env.push((JOB_ENV.into(), "1".into()));
        let spawn = self.o.spawn.clone().unwrap_or_else(default_spawn);
        let mut child = match spawn(args, &env) {
            Ok(c) => c,
            Err(e) => {
                self.push(&format!("起動できませんでした: {e}"));
                self.finish("failed", None);
                return;
            }
        };
        let killer: Arc<dyn Fn() + Send + Sync> = Arc::from(child.killer());
        self.lock().stop = Some(killer);
        let readers: Vec<std::thread::JoinHandle<()>> = [child.take_stdout(), child.take_stderr()]
            .into_iter()
            .flatten()
            .map(|stream| {
                let me = self.clone();
                std::thread::spawn(move || me.read_lines(stream))
            })
            .collect();
        let me = self.clone();
        std::thread::spawn(move || {
            // 出力を読み終えてから(TS 版の close)終わりにする
            for r in readers {
                let _ = r.join();
            }
            match child.wait() {
                Ok(code) => me.finish(if code == Some(0) { "done" } else { "failed" }, code),
                Err(e) => {
                    me.push(&format!("起動できませんでした: {e}"));
                    me.finish("failed", None);
                }
            }
        });
    }

    /// 行ごとにログへ(\r\n も \n も区切り。最後の改行の無い行も残す)
    fn read_lines(&self, mut stream: Box<dyn Read + Send>) {
        let mut rest: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            let n = match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            rest.extend_from_slice(&buf[..n]);
            while let Some(i) = rest.iter().position(|b| *b == b'\n') {
                let mut line: Vec<u8> = rest.drain(..=i).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                self.push(&String::from_utf8_lossy(&line));
            }
        }
        if !rest.is_empty() {
            self.push(&String::from_utf8_lossy(&rest));
        }
    }

    fn start_full(self: &Arc<Self>, id: String) {
        let canceled = Arc::new(AtomicBool::new(false));
        let flag = canceled.clone();
        self.lock().stop = Some(Arc::new(move || flag.store(true, Ordering::SeqCst)));
        let me = self.clone();
        std::thread::spawn(move || {
            let logger = me.clone();
            let ctx = FullCtx { log: Box::new(move |l: &str| logger.push(l)), canceled };
            match (me.o.run_full)(&id, &ctx) {
                Ok(()) => me.finish("done", Some(0)),
                Err(e) => {
                    me.push(&format!("失敗しました: {e:#}"));
                    me.finish("failed", Some(1));
                }
            }
        });
    }

    /// 実行中の印を消す(ジョブの終わりと serve の終了時。消せなくても serve は止めない)
    pub fn drop_lock(&self) {
        release_out_lock(&self.o.out_dir);
    }

    pub fn cancel(&self) -> Result<JobSnapshot, JobError> {
        let stop = {
            let mut st = self.lock();
            if !st.job.as_ref().is_some_and(|j| j.state == "running") {
                return Err(JobError::new(409, "動いている処理はありません"));
            }
            st.canceling = true;
            st.stop.clone()
        };
        self.push("止めています…");
        if let Some(s) = stop {
            s();
        }
        Ok(self.current().expect("動いているジョブ"))
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
