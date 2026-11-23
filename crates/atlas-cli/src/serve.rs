//! atlas serve(packages/cli/src/serve.ts の移植): out/ を 127.0.0.1 だけに配信し、画面からメモ(atlas-notes/memos/)を書く小さな API を持つ。
//! 画面からの操作(集計し直す・判定の添付ファイルを作る・全文を作る。jobs.rs)と、記録・全文記録の表示(/view/<id>)も持つ。
//! 外部の LLM での判定(チャットに貼る・ZIP をエージェントに渡す): 添付ファイル(bundle/parts/ など)の一覧と進み具合(/api/judge/parts)、
//! 返答の取り込み(/api/judge/import)。工数・依頼ごとの採用・管理ツールのタスクへの紐づけ(?target=)で同じ形。このツールは LLM を呼ばない。
//! 管理ツールのタスク: 今の状態・紐づけ・工数(GET /api/tasks。集計し直さずに今のファイルから数える)と、手動の紐づけ(PUT /api/tasks/links/<id>)。
//! 画面(3 画面)は 3 秒ごとに heartbeat を送り、ページを閉じるときは bye を送る。開いている画面がすべて bye を送ったら BYE_GRACE_MS 後に、
//! heartbeat がどの画面からも IDLE の間届かなければ、自分で終了する(ブラウザを閉じれば止まる)。ジョブの実行中と、要求に応えている途中は止めず、終わってから判定を再開する。
//! IDLE を短くしないこと: ブラウザは隠れたタブのタイマーを間引く(Chrome は 5 分以上隠れたタブを 1 分に 1 回まで)。以前の 8 秒では、別のタブで作業している間に止まっていた。
//! 画面と保存の境界はこの API だけ(後でアプリ化するときに差し替える)。
//!
//! HTTP は標準ライブラリだけで話す(http.rs。127.0.0.1 の 1 人だけが使うので、外部の HTTP ライブラリと非同期の実行環境を持ち込まない)。
//! TS 版と同じ 1 つの振り分けにし、止めるときに接続をすべて切り、応答を送り終えるまでを「応えている途中」と数える。
//! 接続ごとに 1 本のスレッドで、要求の処理(ファイルの読み書き・描画・アップロード)もそのスレッドで、TS 版と同じ順に確かめてから本文を読む。

mod http;
#[cfg(test)]
mod tests;

use crate::chat_parts::{judged_session_ids, judged_turn_keys, list_chat_parts, ChatParts, ChatTarget};
use crate::config::{default_config_path, load_config, modify_config, parse_config, parse_upload_root, phase_names, update_config, ConfigEdit};
use crate::folders::{check_folder, folders_root_of, forget_folder, is_read_only_view, list_folder_states, list_folders, open_folder_report, FolderContext, FolderError};
use crate::jobs::{parse_job_request, running_job_in, FullCtx, JobRunner, JobRunnerOptions, RunFullFn, SpawnFn};
use atlas_core::js;
use atlas_core::nodepath::platform;
use atlas_report::memo::{is_safe_memo_id, memo_summary};
use atlas_report::memo_io::{image_ext, load_memo_index, memos_dir, read_memo, render_memo, save_memo, save_memo_image, MemoFile, MEMO_IMAGE_LIMIT};
use atlas_report::viewer::{encode_uri_component, render_view_document, render_viewer_shell, view_label, ViewKind, ViewerShellOptions, VIEW_KINDS, VIEW_LIMIT};
use http::{decode_uri_component, header, parse_request_target, BodyReader, Headers, ReqUrl, Resp};
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{Duration, Instant};

pub use http::simple_request;

pub const TOKEN_PLACEHOLDER: &str = "__ATLAS_TOKEN__";
pub const SERVE_STATE_FILE: &str = ".serve.json";
/// 画面が heartbeat を送る間隔(ms)
#[cfg(test)]
pub const HEARTBEAT_INTERVAL_MS: u64 = 3000;
/// どの画面からも heartbeat が届かなくなってから止まるまで(閉じたことを bye で知らせずに消えた画面・眠らされたタブのための保険)
pub const DEFAULT_IDLE_MS: u64 = 30 * 60_000;
/// 開いている画面がすべて bye を送ってから止まるまで(ページの移動なら、次のページの heartbeat がこの間に届く)
pub const BYE_GRACE_MS: u64 = 15_000;
/// この間 heartbeat の無い画面は、開いている画面に数えない(隠れたタブでも 1 分に 1 回は届く)
const CLIENT_STALE_MS: i64 = 3 * 60_000;
pub const DEFAULT_FIRST_HEARTBEAT_MS: u64 = 60_000;

/// 別のフォルダを開いた画面(読むだけ)で、書き換える操作を断るときの理由
pub const READ_ONLY_MESSAGE: &str = "別のフォルダを開いた画面は読むだけです。メモは、送った人が付けたものを出します(書き換えるのは、送った人の PC の画面です)";
const REFRESHING: &str = "集計し直している最中です(詳細ページと記録は作り直しの途中です)。集計が終わってから開き直してください。";

/// フォルダを選ぶ画面(題名と、最初に開く場所)。取り消したら None
pub type PickFn = Arc<dyn Fn(&str, Option<&str>) -> anyhow::Result<Option<String>> + Send + Sync>;
/// 別のプロセスで `atlas open <フォルダ>` を始める(引数と記録のファイル)。返すのは pid
pub type LaunchFnOwned = Arc<dyn Fn(&[String], &str) -> Option<u32> + Send + Sync>;
pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

/// 「別のフォルダを開く」の置き場(folders.rs)
#[derive(Clone, Default)]
pub struct ReportsOptions {
    /// フォルダごとの出力先の置き場(既定は <outDir>-folders)
    pub root: Option<PathBuf>,
    /// いつものメモの置き場(既定は notesDir)
    pub notes_base: Option<PathBuf>,
    /// いつもの出力先(既定は outDir)
    pub local_out: Option<PathBuf>,
    /// このサーバが出しているフォルダ(いつもの集計なら None)
    pub current: Option<String>,
    /// 別のプロセスの起動(テストで差し替える)
    pub launch: Option<LaunchFnOwned>,
}

pub struct ServeOptions {
    pub out_dir: PathBuf,
    pub notes_dir: PathBuf,
    /// 0 なら空きポート
    pub port: u16,
    /// 起動後に既定のブラウザで開く
    pub open: bool,
    pub log: LogFn,
    /// 最後の heartbeat からこの時間で終了
    pub idle_ms: u64,
    /// 開いている画面がすべて bye を送ってから、この時間で終了
    pub bye_grace_ms: u64,
    /// 最初の heartbeat をこの時間待つ
    pub first_heartbeat_ms: u64,
    /// メモの画像 1 枚の上限(バイト)
    pub memo_image_limit: u64,
    /// Phase 14: ジョブの子プロセスの起動(既定はこの実行ファイルを shell なしで)と環境変数の追加、全文の書き出し(既定は write_full_record)。テストで差し替える
    pub job_spawn: Option<SpawnFn>,
    pub job_env: Vec<(String, String)>,
    pub run_full: Option<RunFullFn>,
    /// Phase 14: 記録の表示で描く .md の上限(バイト)
    pub view_limit: u64,
    /// アップロード先(uploadRoot)を読み書きする設定ファイル。None なら default_config_path()
    pub config_path: Option<PathBuf>,
    /// フォルダを選ぶ画面(既定は folder_picker.rs。テストで差し替える)
    pub can_pick: Option<bool>,
    pub pick: Option<PickFn>,
    /// M365 Copilot のアプリを自動で操作する判定(m365.rs)を画面に出すか。既定は Windows のとき
    pub m365: Option<bool>,
    /// Copilot のデータの場所(画面の設定で、名前に wiki を含むインストール済みの skill を候補に出すのに使う)。既定は ATLAS_COPILOT_HOME か ~/.copilot
    pub copilot_home: Option<PathBuf>,
    /// 集計し直すときに読む場所(別のフォルダを開いたサーバ。省略時は CLI の既定 = この PC の Copilot のデータ)
    pub home: Option<String>,
    pub reports: ReportsOptions,
    /// 応答の x-atlas-code で返す版の目印。None なら version::CODE_STAMP(この実行ファイルを作ったときの目印)。Some(None) なら返さない(目印を返す前の古いサーバの代わり。テスト用)
    pub code_stamp: Option<Option<String>>,
}

impl ServeOptions {
    pub fn new(out_dir: impl Into<PathBuf>, notes_dir: impl Into<PathBuf>) -> Self {
        ServeOptions {
            out_dir: out_dir.into(),
            notes_dir: notes_dir.into(),
            port: 0,
            open: true,
            log: Arc::new(|_| {}),
            idle_ms: DEFAULT_IDLE_MS,
            bye_grace_ms: BYE_GRACE_MS,
            first_heartbeat_ms: DEFAULT_FIRST_HEARTBEAT_MS,
            memo_image_limit: MEMO_IMAGE_LIMIT,
            job_spawn: None,
            job_env: vec![],
            run_full: None,
            view_limit: VIEW_LIMIT,
            config_path: None,
            can_pick: None,
            pick: None,
            m365: None,
            copilot_home: None,
            home: None,
            reports: ReportsOptions::default(),
            code_stamp: None,
        }
    }
}

/// 画面に返す失敗(状態コードと理由)
#[derive(Debug, Clone, PartialEq)]
pub struct HttpError {
    pub status: u16,
    pub message: String,
}

impl HttpError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        HttpError { status, message: message.into() }
    }

    /// 思いがけない失敗(TS 版の「サーバの内部エラー」)
    fn internal(e: impl std::fmt::Display) -> Self {
        HttpError::new(500, format!("サーバの内部エラー: {e}"))
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HttpError {}

type R<T> = Result<T, HttpError>;

fn mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        ".html" => "text/html; charset=utf-8",
        ".md" => "text/markdown; charset=utf-8",
        ".json" => "application/json; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        ".txt" => "text/plain; charset=utf-8",
        ".zip" => "application/zip",
        _ => return None,
    })
}

/// 応答の種類を取り違えさせない(どの応答にも付ける)
const NOSNIFF: (&str, &str) = ("x-content-type-options", "nosniff");
/// HTML(token 入り)は他のサイトの枠に入れさせない(費用のかかる操作のボタンを押させるクリックジャッキングを防ぐ)
const HTML_HEADERS: [(&str, &str); 3] = [NOSNIFF, ("x-frame-options", "DENY"), ("content-security-policy", "frame-ancestors 'none'")];
/// HTML 以外の静的ファイル(.md・全文記録の assets・snapshot の写しなど、セッション由来の内容)は、直接開かれても
/// script を動かさない(svg などがサーバのオリジンで動くと token を読めてしまう)
const FILE_HEADERS: [(&str, &str); 2] = [NOSNIFF, ("content-security-policy", "sandbox")];
/// atlas 自身が作る HTML(token を差し込み、操作を出す)。out/ の直下のこれらと sessions/<id>.html だけ
const APP_PAGES: [&str; 5] = ["atlas.html", "failures.html", "glossary.html", "insights.html", "instructions.html"];

static SESSION_PAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^sessions/[^/]+\.html$").unwrap());

/// out/ からの相対パス(/ 区切り)が atlas の画面か。snapshot/(原本の files/ などの写し)・full/・library/ の下の .html は
/// セッション由来でありうるので、token を入れず静的ファイルとして(sandbox で)返す
pub fn is_app_page(rel: &str) -> bool {
    APP_PAGES.contains(&rel) || SESSION_PAGE.is_match(rel)
}

fn send_json(status: u16, body: &Value) -> Resp {
    Resp {
        status,
        headers: vec![("content-type", "application/json; charset=utf-8".into()), ("cache-control", "no-store".into()), ("x-atlas-serve", "1".into()), (NOSNIFF.0, NOSNIFF.1.into())],
        body: Vec::from(atlas_core::json::to_js_string(body).unwrap_or_default()),
    }
}

fn to_value<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

/// 既定のブラウザで URL を開く(失敗しても止めない)
pub fn open_in_browser(url: &str, log: &dyn Fn(&str)) {
    let mut c = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/c", "start", "", url]);
        c
    } else {
        let mut c = std::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" });
        c.arg(url);
        c
    };
    c.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    crate::self_update::hide_window(&mut c);
    if let Err(e) = c.spawn() {
        log(&format!("serve: ブラウザを開けませんでした({e})。{url} を手で開いてください"));
    }
}

/// 動いているサーバ
#[derive(Debug, Clone, PartialEq)]
pub struct RunningServer {
    pub port: u16,
    pub pid: u32,
    /// そのサーバの版の目印(返さない古いサーバは None)
    pub code: Option<String>,
}

/// 既に動いているサーバがあれば返す(out/.serve.json を見て GET /api/state が応えるか)
pub fn find_running_server(out_dir: &Path) -> Option<RunningServer> {
    let text = std::fs::read(out_dir.join(SERVE_STATE_FILE)).ok()?;
    let j = js::parse_json(&String::from_utf8_lossy(&text)).ok()?;
    let port = j.get("port").and_then(Value::as_f64).filter(|p| *p > 0.0 && *p <= 65535.0)? as u16;
    let pid = j.get("pid").and_then(Value::as_f64).unwrap_or(0.0) as u32;
    // 止められて(強制終了など).serve.json が残ったとき、そのポートには尋ねない。
    // Windows は閉じたポートへの接続を断られても送り直すので、待ちの時間を使い切る
    if pid != 0 && !crate::sys::alive(pid) {
        return None;
    }
    let r = simple_request(port, "GET", "/api/state", &[], &[], Duration::from_millis(1500)).ok()?;
    if r.header("x-atlas-serve") != Some("1") {
        return None;
    }
    Some(RunningServer { port, pid, code: r.header("x-atlas-code").map(str::to_string) })
}

/// folders.rs の FolderContext に渡す「その出力先で動いているサーバのポート」
fn find_running_port(out: &str) -> Option<u16> {
    find_running_server(Path::new(out)).map(|r| r.port)
}
static FIND_RUNNING: fn(&str) -> Option<u16> = find_running_port;

// ---------- サーバ ----------

struct SessionEntry {
    title: String,
    eligible: bool,
    /// 依頼ごとの記録(turnStats)の数。依頼ごとの判定の対象
    turns: usize,
    /// 始めた時刻(ミリ秒)と実働(ミリ秒)。タスクの工数に使う
    start_ms: Option<i64>,
    active_ms: Option<f64>,
    /// 開いただけのセッション(sessions.json の empty)と、題名か依頼の文があるか。LLM に紐づけを頼むセッションを数えるのに使う(links::llm_eligible)
    empty: bool,
    has_text: bool,
}

/// sessions.json の id → 表題と判定の対象か(本文は持たない)。集計元の形(読むだけの画面かを決める)も持つ
struct SessionIndex {
    ids: IndexMap<String, SessionEntry>,
    layout: Option<String>,
}

#[derive(Default)]
struct Life {
    closed: bool,
    /// 最初の heartbeat を待つ時計(番号が変われば取り消し)
    first_gen: u64,
    first_active: bool,
    /// 猶予の時計
    idle_gen: u64,
    /// 猶予の時計を張ったことがあるか(TS 版の idleTimer が null でないか)
    idle_ever: bool,
    /// heartbeat が途切れたが、ジョブの実行中か、要求に応えている途中なので待っている(理由)
    idle_pending: Option<String>,
    /// 応えている途中の要求の数(処理が済み、応答を送り終えるか相手が切るまで)
    inflight: usize,
    /// 開いている画面がすべて閉じられ、短い猶予(bye_grace_ms)を測っている
    leaving: bool,
    /// 開いている画面(heartbeat の x-atlas-client)と、最後に heartbeat が届いた時刻
    clients: HashMap<String, i64>,
    /// bye を送った画面と、その bye の番号。bye より前に出た heartbeat が遅れて届いても、開いている画面に数え直さない
    bye_seq: IndexMap<String, f64>,
}

struct Server {
    me: Weak<Server>,
    out_dir: PathBuf,
    out_s: String,
    /// 画面に返す notesDir(渡されたまま)
    notes_dir: PathBuf,
    memo_dir: PathBuf,
    token: String,
    code: Option<String>,
    idle_ms: u64,
    bye_grace_ms: u64,
    first_ms: u64,
    memo_image_limit: u64,
    view_limit: u64,
    config_path: String,
    can_pick: bool,
    pick: PickFn,
    m365: bool,
    copilot_home: PathBuf,
    current: Option<String>,
    folder_ctx: FolderContext<'static>,
    log: LogFn,
    jobs: Arc<JobRunner>,
    port: AtomicU16,
    clock: Arc<Clock>,
    sessions_cache: Mutex<Option<(f64, Arc<SessionIndex>)>>,
    picking: AtomicBool,
    css: OnceLock<String>,
    life: Mutex<Life>,
    memo_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// メモの置き場の親(atlas-notes/。tasks.json と task-links.json の場所)
    notes_abs: PathBuf,
    /// task-links.json の読み・変更・書き込みは順番に行う
    tasks_lock: Mutex<()>,
    /// 終わったら理由が入る
    done: Mutex<Option<String>>,
    done_cv: Condvar,
    conns: Mutex<Conns>,
}

/// 開いている接続(止めるときに、まだ何も送っていない接続も含めてすべて切る)
#[derive(Default)]
struct Conns {
    closed: bool,
    next: u64,
    open: HashMap<u64, TcpStream>,
}

/// 同時に開いておく接続の上限(ブラウザは 1 つの宛先に 6 本ほど。超えた分はすぐ切る)
const MAX_CONNS: usize = 256;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 止まり方の時計(最初の heartbeat を待つ時計と猶予の時計を 1 本のスレッドで測る)。
/// 張り直すと前の時計は取り消したことになる(どちらも番号が変わり、前の時計が鳴っても何もしないため、置き換えてよい)
#[derive(Default)]
struct Clock {
    slots: Mutex<ClockSlots>,
    cv: Condvar,
}

#[derive(Default)]
struct ClockSlots {
    stop: bool,
    first: Option<(Instant, u64, &'static str)>,
    idle: Option<(Instant, u64, &'static str)>,
}

impl Clock {
    fn set(&self, which: Timer, generation: u64, ms: u64, reason: &'static str) {
        let at = Instant::now() + Duration::from_millis(ms);
        let mut s = lock(&self.slots);
        match which {
            Timer::First => s.first = Some((at, generation, reason)),
            Timer::Idle => s.idle = Some((at, generation, reason)),
        }
        self.cv.notify_all();
    }

    fn stop(&self) {
        lock(&self.slots).stop = true;
        self.cv.notify_all();
    }

    /// 鳴った時計を順に渡す(止めるまで)
    fn run(&self, fire: impl Fn(Timer, u64, &'static str)) {
        let mut s = lock(&self.slots);
        loop {
            if s.stop {
                return;
            }
            let now = Instant::now();
            let due = [(Timer::First, s.first), (Timer::Idle, s.idle)].into_iter().filter_map(|(w, x)| x.map(|(at, g, r)| (at, w, g, r))).min_by_key(|x| x.0);
            match due {
                Some((at, which, generation, reason)) if at <= now => {
                    match which {
                        Timer::First => s.first = None,
                        Timer::Idle => s.idle = None,
                    }
                    drop(s);
                    fire(which, generation, reason);
                    s = lock(&self.slots);
                }
                Some((at, ..)) => s = self.cv.wait_timeout(s, at - now).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0),
                None => s = self.cv.wait(s).unwrap_or_else(|e| e.into_inner()),
            }
        }
    }
}

/// token(24 バイトの乱数の base64url)
fn new_token() -> String {
    let mut b = [0u8; 24];
    if getrandom_fill(&mut b).is_err() {
        // 乱数が取れないときは時刻とプロセスから作る(127.0.0.1 だけに出すので、推測されにくければよい)
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(format!("{:?}{}{:p}", std::time::SystemTime::now(), std::process::id(), &b).as_bytes());
        b.copy_from_slice(&h.finalize()[..24]);
    }
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut s = String::with_capacity(32);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (c[1] as u32) << 8 | c[2] as u32;
        for k in [18, 12, 6, 0] {
            s.push(T[(n >> k) as usize & 63] as char);
        }
    }
    s
}

/// OS の乱数で埋める
fn getrandom_fill(b: &mut [u8]) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        #[link(name = "advapi32")]
        unsafe extern "system" {
            #[link_name = "SystemFunction036"]
            fn rtl_gen_random(buf: *mut u8, len: u32) -> u8;
        }
        // SAFETY: b の長さだけ書かせる
        let ok = unsafe { rtl_gen_random(b.as_mut_ptr(), b.len() as u32) };
        if ok != 0 { Ok(()) } else { Err(std::io::Error::other("RtlGenRandom")) }
    }
    #[cfg(not(windows))]
    {
        use std::io::Read;
        std::fs::File::open("/dev/urandom")?.read_exact(b)
    }
}

pub struct ServeHandle {
    #[cfg(test)]
    pub port: u16,
    #[cfg(test)]
    pub url: String,
    #[cfg(test)]
    pub token: String,
    server: Arc<Server>,
}

impl ServeHandle {
    /// 終了するまで待ち、理由を返す
    pub fn wait(&self) -> String {
        let mut d = lock(&self.server.done);
        loop {
            if let Some(r) = d.clone() {
                return r;
            }
            d = self.server.done_cv.wait(d).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// 終わっていれば理由
    #[cfg(test)]
    pub fn finished(&self) -> Option<String> {
        lock(&self.server.done).clone()
    }

    #[cfg(test)]
    pub fn close(&self, reason: &str) {
        self.server.close(reason);
    }

    /// 別のスレッド(Ctrl+C を受けたときなど)から止める口
    pub fn closer(&self) -> impl Fn(&str) + Send + Sync + 'static {
        let s = Arc::downgrade(&self.server);
        move |reason: &str| {
            if let Some(s) = s.upgrade() {
                s.close(reason);
            }
        }
    }
}

/// サーバを起動する(受け付けと時計は別のスレッドで動き、すぐ戻る)
pub fn start_serve(o: ServeOptions) -> anyhow::Result<ServeHandle> {
    let log = o.log.clone();
    let out_dir = crate::paths::resolve(&o.out_dir);
    let out_s = out_dir.to_string_lossy().into_owned();
    let notes_abs = crate::paths::resolve(&o.notes_dir);
    let memo_dir = memos_dir(&notes_abs);
    let token = new_token();
    // このサーバの版の目印(画面がページの目印と比べ、違えば「版が違います」と出す)
    let code = match o.code_stamp.clone() {
        Some(c) => c,
        None => Some(crate::version::CODE_STAMP.to_string()),
    };
    let config_path = crate::paths::resolve(o.config_path.clone().unwrap_or_else(|| PathBuf::from(default_config_path()))).to_string_lossy().into_owned();
    let can_pick = o.can_pick.unwrap_or(crate::folder_picker::CAN_PICK_FOLDER);
    let pick: PickFn = o.pick.clone().unwrap_or_else(|| Arc::new(|t: &str, i: Option<&str>| crate::folder_picker::pick_folder(t, i)));
    let copilot_home = crate::paths::resolve(o.copilot_home.clone().or_else(|| std::env::var_os("ATLAS_COPILOT_HOME").map(PathBuf::from)).unwrap_or_else(|| crate::paths::home_dir().join(".copilot")));
    let current = o.reports.current.as_ref().map(|c| platform::resolve(&[c]));
    let launch: &'static (dyn Fn(&[String], &str) -> Option<u32> + Sync) = match o.reports.launch.clone() {
        // サーバはプロセスの終わりまで動くので、起動の口はそのまま持ち続ける
        Some(f) => Box::leak(Box::new(move |a: &[String], l: &str| f(a, l))),
        None => &crate::folders::launch_detached,
    };
    let s_of = |p: &Option<PathBuf>, d: &Path| crate::paths::resolve(p.clone().unwrap_or_else(|| d.to_path_buf())).to_string_lossy().into_owned();
    let mut extra_args: Vec<String> = Vec::new();
    // 開いたフォルダのサーバにも、同じ設定ファイルと、ブラウザを開くかどうかを引き継ぐ
    if let Some(c) = &o.config_path {
        extra_args.extend(["--config".into(), crate::paths::resolve(c).to_string_lossy().into_owned()]);
    }
    if !o.open {
        extra_args.push("--no-open".into());
    }
    let folder_ctx = FolderContext {
        root: o.reports.root.as_ref().map(|r| crate::paths::resolve(r).to_string_lossy().into_owned()).unwrap_or_else(|| folders_root_of(&out_s)),
        notes_base: s_of(&o.reports.notes_base, &o.notes_dir),
        local_out: s_of(&o.reports.local_out, &out_dir),
        current: current.clone(),
        can_pick,
        find_running: &FIND_RUNNING,
        launch,
        extra_args,
        pending: Mutex::new(HashSet::new()),
    };
    let mut env = o.job_env.clone();
    // --config で起動したサーバは、画面から動かす処理(集計し直す・判定)にも同じ設定ファイル(wiki・工程名・判定に使うモデル)を読ませる
    if let Some(c) = &o.config_path {
        env.insert(0, ("ATLAS_CONFIG".into(), crate::paths::resolve(c).to_string_lossy().into_owned()));
    }
    // 先に受け付けの口を開く(開けなければ何も始めない)
    let listener = TcpListener::bind(("127.0.0.1", o.port))?;
    let port = listener.local_addr()?.port();
    let clock = Arc::new(Clock::default());
    let server = Arc::new_cyclic(|me: &Weak<Server>| {
        let full_out = out_dir.clone();
        let run_full: RunFullFn = o.run_full.clone().unwrap_or_else(|| Arc::new(move |id: &str, ctx: &FullCtx| run_full_default(&full_out, id, ctx)));
        let end_me = me.clone();
        let jobs = JobRunner::new(JobRunnerOptions {
            out_dir: out_dir.clone(),
            notes_dir: notes_abs.clone(),
            home: o.home.clone(),
            spawn: o.job_spawn.clone(),
            env,
            run_full,
            log: log.clone(),
            // 画面が閉じられた後もジョブは最後まで走らせ、終わってから判定を再開する
            on_end: Some(Arc::new(move |_| {
                if let Some(s) = end_me.upgrade() {
                    s.resume();
                }
            })),
        });
        Server {
            me: me.clone(),
            out_dir: out_dir.clone(),
            out_s: out_s.clone(),
            notes_dir: o.notes_dir.clone(),
            memo_dir,
            token: token.clone(),
            code,
            idle_ms: o.idle_ms,
            bye_grace_ms: o.bye_grace_ms,
            first_ms: o.first_heartbeat_ms,
            memo_image_limit: o.memo_image_limit,
            view_limit: o.view_limit,
            config_path,
            can_pick,
            pick,
            m365: o.m365.unwrap_or(cfg!(windows)),
            copilot_home,
            current,
            folder_ctx,
            log: log.clone(),
            jobs,
            port: AtomicU16::new(0),
            clock: clock.clone(),
            sessions_cache: Mutex::new(None),
            picking: AtomicBool::new(false),
            css: OnceLock::new(),
            life: Mutex::new(Life::default()),
            memo_locks: Mutex::new(HashMap::new()),
            notes_abs: notes_abs.clone(),
            tasks_lock: Mutex::new(()),
            done: Mutex::new(None),
            done_cv: Condvar::new(),
            conns: Mutex::new(Conns::default()),
        }
    });
    server.port.store(port, Ordering::SeqCst);
    let url = format!("http://127.0.0.1:{port}/atlas.html");
    std::fs::write(
        out_dir.join(SERVE_STATE_FILE),
        format!("{}\n", atlas_core::json::to_js_string(&json!({ "port": port, "pid": std::process::id(), "startedAt": atlas_core::jsdate::now_iso() }))?),
    )?;
    // 時計(サーバへの弱い参照だけを持つ。止めたら終わる)
    let tick = Arc::downgrade(&server);
    std::thread::Builder::new().name("atlas-serve-clock".into()).spawn(move || {
        clock.run(|which, generation, reason| {
            if let Some(s) = tick.upgrade() {
                s.timer_fired(which, generation, reason);
            }
        })
    })?;
    // 受け付け(止めるときは close が自分につないで起こし、ここで抜けて口を閉じる)
    let acc = Arc::downgrade(&server);
    std::thread::Builder::new().name("atlas-serve-accept".into()).spawn(move || {
        loop {
            let r = listener.accept();
            let Some(s) = acc.upgrade() else { return };
            if lock(&s.conns).closed {
                return;
            }
            match r {
                Ok((stream, _)) => s.serve_connection(stream),
                // 受け付けの失敗(ハンドルが足りないなど)は、少し待ってから続ける
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    })?;
    {
        let mut l = lock(&server.life);
        l.first_active = true;
        l.first_gen += 1;
        let g = l.first_gen;
        server.spawn_timer(Timer::First, g, server.first_ms, "ブラウザから最初の heartbeat が届かなかった");
    }
    log(&format!("serve: {url}(127.0.0.1 だけに公開。ブラウザを閉じるか、この窓を閉じると終了します)"));
    if o.open {
        open_in_browser(&url, &*log);
    }
    #[cfg(not(test))]
    let _ = token;
    Ok(ServeHandle {
        #[cfg(test)]
        port,
        #[cfg(test)]
        url,
        #[cfg(test)]
        token,
        server,
    })
}

/// 1 件の全文記録を書く(サーバ内。atlas.html・coverage.json・他のセッションの全文は触らない)
fn run_full_default(out_dir: &Path, id: &str, ctx: &FullCtx) -> anyhow::Result<()> {
    let t = std::time::Instant::now();
    let p = out_dir.join("sessions.json");
    let text = std::fs::read(&p)?;
    let file = js::parse_json(&String::from_utf8_lossy(&text))?;
    let raw = file.get("sessions").and_then(Value::as_array).and_then(|a| a.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(id))).cloned();
    let Some(raw) = raw else { anyhow::bail!("セッション {id} は sessions.json にありません") };
    let record: atlas_core::types::SessionRecord = serde_json::from_value(raw)?;
    (ctx.log)(&format!("全文記録を書いています: {id}"));
    let wal_note = file.get("desktop").and_then(|d| d.get("wal")).and_then(|w| w.get("note")).and_then(Value::as_str);
    let canceled = ctx.canceled.clone();
    let r = atlas_report::full::write_full_record(&atlas_report::full::FullRecordInput {
        record: &record,
        snapshot_dir: &out_dir.join("snapshot"),
        out_dir,
        wal_note,
        canceled: &move || canceled.load(Ordering::SeqCst),
        generated_at: None,
    })?;
    (ctx.log)(&format!(
        "全文記録 {}({} MB、イベント {} 件、画像など {} ファイル、{} 秒)",
        r.path.display(),
        atlas_core::jsnum::to_fixed(r.bytes as f64 / 1024.0 / 1024.0, 2),
        r.events,
        r.assets.files,
        atlas_core::jsnum::to_fixed(t.elapsed().as_secs_f64(), 1)
    ));
    Ok(())
}

#[derive(Clone, Copy)]
enum Timer {
    First,
    Idle,
}

/// 要求の中身(処理のスレッドに渡す)
struct Req {
    method: String,
    headers: Headers,
    url: ReqUrl,
    body: BodyReader,
}

impl Req {
    fn header(&self, name: &str) -> Option<String> {
        header(&self.headers, name)
    }
}

impl Server {
    fn arc(&self) -> Arc<Server> {
        self.me.upgrade().expect("サーバ")
    }

    fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    // ---------- 止まり方 ----------

    fn spawn_timer(&self, which: Timer, generation: u64, ms: u64, reason: &'static str) {
        self.clock.set(which, generation, ms, reason);
    }

    fn timer_fired(&self, which: Timer, generation: u64, reason: &str) {
        let close = {
            let mut l = lock(&self.life);
            let live = match which {
                Timer::First => l.first_active && l.first_gen == generation,
                Timer::Idle => l.idle_gen == generation,
            };
            if !live || l.closed {
                return;
            }
            if let Timer::First = which {
                l.first_active = false;
            }
            self.expire(&mut l, reason)
        };
        if close {
            self.close(reason);
        }
    }

    /// 猶予が切れた。ジョブの実行中と、要求に応えている途中(アップロード・フォルダ選び・大きな記録の表示など)は止めずに待ち、終わってから(resume)猶予を測り直す。止めるなら true
    fn expire(&self, l: &mut Life, reason: &str) -> bool {
        if self.jobs.running() || l.inflight > 0 {
            if l.idle_pending.is_none() {
                (self.log)(&format!("serve: {reason}。処理が終わるまで止めずに待ちます"));
            }
            l.idle_pending = Some(reason.to_string());
            return false;
        }
        true
    }

    /// 待っていた処理(ジョブ・応えている途中の要求)が終わった。ほかに残っていなければ猶予を測り直す。画面がすべて閉じていたら短い猶予で
    fn resume(&self) {
        let mut l = lock(&self.life);
        if l.closed || l.idle_pending.is_none() || l.inflight > 0 || self.jobs.running() {
            return;
        }
        l.idle_pending = None;
        if l.leaving && l.clients.is_empty() {
            self.arm_leaving(&mut l);
        } else {
            self.arm_idle(&mut l);
        }
    }

    fn arm_idle(&self, l: &mut Life) {
        l.idle_gen += 1;
        l.idle_ever = true;
        self.spawn_timer(Timer::Idle, l.idle_gen, self.idle_ms, "画面が閉じられた(heartbeat が途切れた)");
    }

    /// 猶予(bye_grace_ms)を測り始める
    fn arm_leaving(&self, l: &mut Life) {
        l.leaving = true;
        l.idle_gen += 1;
        l.idle_ever = true;
        self.spawn_timer(Timer::Idle, l.idle_gen, self.bye_grace_ms, "画面がすべて閉じられた");
    }

    fn heartbeat(&self, client: Option<String>, seq: Option<f64>) {
        let mut l = lock(&self.life);
        l.first_active = false;
        if let Some(c) = client {
            // 閉じた後に届いた、閉じる前の heartbeat(keepalive の追い越し)は無視する。番号が新しければ戻ってきた画面(bfcache)なので数え直す
            if let Some(b) = l.bye_seq.get(&c).copied()
                && seq.is_none_or(|s| s <= b)
            {
                return;
            }
            l.bye_seq.shift_remove(&c);
            l.clients.insert(c, atlas_core::jsdate::now_ms());
        }
        l.idle_pending = None;
        l.leaving = false;
        self.arm_idle(&mut l);
    }

    /// 画面が閉じられた(bfcache に入るときも)。ほかに開いている画面が無ければ、少し待って(次のページの heartbeat が来なければ)止まる
    fn bye(&self, client: Option<String>, seq: Option<f64>) {
        let mut l = lock(&self.life);
        if let Some(c) = client {
            l.clients.remove(&c);
            // 番号の無い bye(番号を送らない古いページ)は記録しない。記録すると、そのページが戻ってきても heartbeat を数え直せない
            if let Some(s) = seq {
                l.bye_seq.insert(c, s);
            }
            // 覚えておくのは最近のものだけ(長く開いたままのサーバで増え続けないように)
            if l.bye_seq.len() > 200 {
                l.bye_seq.shift_remove_index(0);
            }
        }
        let now = atlas_core::jsdate::now_ms();
        l.clients.retain(|_, at| now - *at <= CLIENT_STALE_MS);
        if !l.clients.is_empty() {
            return;
        }
        (self.log)(&format!("serve: 開いている画面がすべて閉じられました。{} 秒のうちに次の画面が開かなければ止まります", js::round(self.bye_grace_ms as f64 / 1000.0)));
        self.arm_leaving(&mut l);
    }

    /// 重い処理(大きな記録の描画)の直後に猶予を測り直す(止まっていた間に溜まった heartbeat より先に期限切れで閉じないため)
    fn touch_idle(&self) {
        let mut l = lock(&self.life);
        if l.idle_ever && l.idle_pending.is_none() && !l.leaving {
            self.arm_idle(&mut l);
        }
    }

    fn close(&self, reason: &str) {
        {
            let mut l = lock(&self.life);
            if l.closed {
                return;
            }
            l.closed = true;
            l.first_active = false;
            l.idle_gen += 1;
        }
        let _ = atlas_core::jsfs::rm_force(&self.out_dir.join(SERVE_STATE_FILE));
        // 動いているジョブ(子プロセスと、その子孫)も止める(中断・窓を閉じたとき。猶予切れではジョブの実行中に来ない)。
        // 止めずに抜けると、印を消した後も子が out/ に書き続ける。Unix では子を別のプロセスグループで起動するので、端末の Ctrl+C は子に届かない
        if self.jobs.running() {
            let _ = self.jobs.cancel();
        }
        self.jobs.drop_lock();
        // 止めるときは、まだ何も送っていない接続(ブラウザが次の要求のために先に開けておくもの)や送りかけの要求も、待たずにすべて切る。
        // 自分から止まるとき(expire)は、応えている途中の要求が無いことを確かめてからここへ来る。切られるのは、中断(Ctrl+C)のときだけ
        {
            let mut c = lock(&self.conns);
            c.closed = true;
            for (_, s) in c.open.drain() {
                let _ = s.shutdown(Shutdown::Both);
            }
        }
        self.clock.stop();
        *lock(&self.done) = Some(reason.to_string());
        self.done_cv.notify_all();
        // 受け付けで待っているスレッドを起こす(起きると閉じたことを見て、受け付けの口を閉じる)
        let _ = TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], self.port())), Duration::from_secs(1));
    }

    // ---------- 接続と要求 ----------

    fn serve_connection(&self, stream: TcpStream) {
        // 応答を分けて書いても待たせない(Node の http サーバと同じく Nagle を切る。切らないと Windows の遅延 ACK で 1 回 200ms 待つ)
        let _ = stream.set_nodelay(true);
        let Ok(peer) = stream.try_clone() else { return };
        let id = {
            let mut c = lock(&self.conns);
            if c.closed || c.open.len() >= MAX_CONNS {
                return;
            }
            c.next += 1;
            let id = c.next;
            c.open.insert(id, peer);
            id
        };
        let me = self.arc();
        let spawned = std::thread::Builder::new().name("atlas-serve-conn".into()).spawn(move || {
            let _forget = ConnGuard(&me, id);
            http::serve_conn(stream, || me.begin_request(), |req| me.serve_request(req));
        });
        if spawned.is_err() {
            lock(&self.conns).open.remove(&id);
        }
    }

    /// 要求を受けてから、処理が済み、かつ応答を送り終える(か相手が切る)までを「応えている途中」と数える。
    /// 相手が先に切っても、処理(アップロードなど)が続いていれば待つ。返す印を落とすと数から外れる
    fn begin_request(&self) -> Inflight {
        lock(&self.life).inflight += 1;
        Inflight(self.me.clone())
    }

    fn serve_request(&self, req: http::Request) -> (Resp, BodyReader) {
        let url = parse_request_target(&req.target);
        let mut r = Req { method: req.method, headers: req.headers, url, body: req.body };
        // 処理の中で落ちても、接続と「応えている途中」の数を壊さずに 500 を返す
        let resp = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.handle(&mut r))).unwrap_or_else(|e| {
            let m = e.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| e.downcast_ref::<String>().cloned()).unwrap_or_default();
            send_json(500, &json!({ "error": format!("サーバの内部エラー: {m}") }))
        });
        let mut headers = Vec::with_capacity(resp.headers.len() + 1);
        if let Some(c) = &self.code {
            headers.push(("x-atlas-code", c.clone()));
        }
        headers.extend(resp.headers);
        (Resp { status: resp.status, headers, body: resp.body }, r.body)
    }

    fn handle(&self, req: &mut Req) -> Resp {
        let path = req.url.path.clone();
        let api = path.starts_with("/api/");
        let r = self.check_host(req).and_then(|()| if api { self.api(req, &path) } else { self.serve_static(req, &path) });
        match r {
            Ok(r) => r,
            Err(e) if api => send_json(e.status, &json!({ "error": e.message })),
            Err(e) => Resp { status: e.status, headers: vec![("content-type", "text/plain; charset=utf-8".into())], body: Vec::from(e.message) },
        }
    }

    /// DNS rebinding を防ぐ: Host が自分でなければ同一オリジンに見えても応えない
    fn check_host(&self, req: &Req) -> R<()> {
        let host = req.header("host");
        let port = self.port();
        if host.as_deref() != Some(&format!("127.0.0.1:{port}")) && host.as_deref() != Some(&format!("localhost:{port}")) {
            return Err(HttpError::new(403, "127.0.0.1 と localhost 以外の名前では開けません"));
        }
        Ok(())
    }

    fn check_origin(&self, req: &Req) -> R<()> {
        if let Some(site) = req.header("sec-fetch-site").filter(|s| !s.is_empty())
            && site != "same-origin"
            && site != "none"
        {
            return Err(HttpError::new(403, "同一オリジン以外からの要求は受け付けません"));
        }
        let port = self.port();
        if let Some(origin) = req.header("origin").filter(|s| !s.is_empty())
            && origin != format!("http://127.0.0.1:{port}")
            && origin != format!("http://localhost:{port}")
        {
            return Err(HttpError::new(403, "同一オリジン以外からの要求は受け付けません"));
        }
        Ok(())
    }

    fn check_token(&self, req: &Req) -> R<()> {
        if req.header("x-atlas-token").as_deref() != Some(self.token.as_str()) {
            return Err(HttpError::new(403, "token が無いか違います(atlas serve から開いた画面だけが書けます)"));
        }
        Ok(())
    }

    fn read_json_body(&self, req: &mut Req, limit: u64) -> R<Map<String, Value>> {
        let buf = req.body.read(limit)?;
        if buf.is_empty() {
            return Ok(Map::new());
        }
        match js::parse_json(&String::from_utf8_lossy(&buf)) {
            Ok(Value::Object(o)) => Ok(o),
            Ok(_) => Err(HttpError::new(400, "JSON を読めません: オブジェクトではない")),
            Err(e) => Err(HttpError::new(400, format!("JSON を読めません: {e}"))),
        }
    }

    fn json_body(&self, req: &mut Req) -> R<Map<String, Value>> {
        self.read_json_body(req, 1024 * 1024)
    }

    // ---------- 集計の読み取り ----------

    /// sessions.json の id → 表題と判定の対象か(mtime が変わるまで覚える。本文は持たない)
    fn session_index(&self) -> R<Option<Arc<SessionIndex>>> {
        let p = self.out_dir.join("sessions.json");
        let Ok(m) = std::fs::metadata(&p) else { return Ok(None) };
        let mt = atlas_core::jsfs::mtime_ms(&m);
        if let Some((at, ix)) = &*lock(&self.sessions_cache)
            && *at == mt
        {
            return Ok(Some(ix.clone()));
        }
        let file = std::fs::read(&p)
            .map_err(|e| e.to_string())
            .and_then(|b| js::parse_json(&String::from_utf8_lossy(&b)).map_err(|e| e.to_string()))
            .map_err(|e| HttpError::new(503, format!("sessions.json を読めません(集計の途中かもしれません): {e}")))?;
        let Some(sessions) = file.get("sessions").and_then(Value::as_array) else {
            return Err(HttpError::internal("sessions.json に sessions がありません"));
        };
        // 判定の対象は bundle と同じ「依頼の記録がある」セッション(judge の packet の hasRequest の近似。本文は sessions.json の範囲で見る)
        // turns は依頼ごとの記録(turnStats)の数。依頼ごとの判定の対象
        let mut ids: IndexMap<String, SessionEntry> = IndexMap::new();
        for r in sessions {
            let id = js::key_of(r.get("id").unwrap_or(&Value::Null));
            let name = r.get("name").and_then(Value::as_str).map(js::trim).unwrap_or("");
            let eligible = r.get("turns").and_then(Value::as_f64).is_some_and(|t| t > 0.0) || js::truthy(r.get("firstUserMessage"));
            let turns = r.get("analysis").and_then(|a| a.get("turnStats")).and_then(Value::as_array).map_or(0, Vec::len);
            let start_ms = r.get("createdAt").and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(atlas_core::jsdate::parse_ms);
            let active_ms = r.get("activeMs").and_then(Value::as_f64);
            let empty = r.get("empty").and_then(Value::as_bool).unwrap_or(false);
            // 題名か依頼の文(最初の依頼と、記録した各依頼の先頭)があるか。tasks bundle(links::llm_eligible)の SessionText と同じ項目を見る
            let prompt_text = r.get("firstUserMessage").and_then(Value::as_str).into_iter().chain(r.get("analysis").and_then(|a| a.get("requests")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str));
            let has_text = atlas_report::tasks::links::has_text(r.get("name").and_then(Value::as_str).unwrap_or(""), &prompt_text.collect::<Vec<_>>().join("\n"));
            ids.insert(id, SessionEntry { title: if name.is_empty() { "(名前なし)".into() } else { name.to_string() }, eligible, turns, start_ms, active_ms, empty, has_text });
        }
        let layout = file.get("source").and_then(|s| s.get("layout")).and_then(Value::as_str).map(str::to_string);
        let ix = Arc::new(SessionIndex { ids, layout });
        *lock(&self.sessions_cache) = Some((mt, ix.clone()));
        Ok(Some(ix))
    }

    /// 読むだけの画面か(build と同じ is_read_only_view)。sessions.json を読めないとき(集計の途中など)は前に読んだものを使う。
    /// atlas open が立てたサーバ(reports.current)は、まだ集計していなくても読むだけ
    fn read_only(&self) -> bool {
        let _ = self.session_index();
        let cache = lock(&self.sessions_cache).as_ref().map(|(_, ix)| ix.clone());
        self.current.is_some() || is_read_only_view(&self.out_s, cache.as_ref().and_then(|c| c.layout.as_deref()))
    }

    fn refreshing(&self) -> bool {
        self.jobs.current().is_some_and(|j| j.state == "running" && j.kind == "refresh")
    }

    // ---------- 設定 ----------

    /// 設定のアップロード先と、upload-project.bat がまとめて送るプロジェクト(読めない設定は理由つきで返す。画面に出す)
    fn upload_root_of(&self) -> (Option<String>, Vec<String>, Option<String>) {
        match load_config(&self.config_path, false) {
            Ok(c) => (c.upload_root, c.upload_projects.unwrap_or_default(), None),
            Err(e) => (None, vec![], Some(format!("{e:#}"))),
        }
    }

    /// upload-project.bat がまとめて送るプロジェクトに足す・外す(画面の「プロジェクト別」の印)。返すのは書いた後の一覧
    fn save_upload_project(&self, input: &Map<String, Value>) -> R<Vec<String>> {
        let project = match input.get("project") {
            Some(Value::String(p)) if !js::trim(p).is_empty() && js::utf16_len(p) <= 1000 => p.clone(),
            _ => return Err(HttpError::new(400, "project にプロジェクト名を指定してください")),
        };
        let Some(Value::Bool(on)) = input.get("on").cloned() else {
            return Err(HttpError::new(400, "on に true(まとめて送る)か false(送らない)を指定してください"));
        };
        // 読んでから書くまでを設定ファイルのロックの中で行う(続けて押したときや、bat が送り先を書き換えるときに、先に書いた分を消さない)
        let mut next: Vec<String> = Vec::new();
        let edit = modify_config(&self.config_path, "uploadProjects", |c, _| {
            let cur = c.upload_projects.clone().unwrap_or_default();
            next = if on {
                if cur.contains(&project) { cur.clone() } else { cur.iter().cloned().chain([project.clone()]).collect() }
            } else {
                cur.iter().filter(|x| **x != project).cloned().collect()
            };
            if next.len() == cur.len() {
                return ConfigEdit::NoChange;
            }
            if next.is_empty() { ConfigEdit::Remove } else { ConfigEdit::Set(json!(next)) }
        })
        .map_err(|e| HttpError::new(409, format!("{e:#}")))?;
        if edit != ConfigEdit::NoChange {
            (self.log)(&format!(
                "serve: 「{project}」を upload-project.bat で{}ようにしました(まとめて送るもの {} 件。{})",
                if on { "まとめて送る" } else { "送らない" },
                next.len(),
                self.config_path
            ));
        }
        Ok(next)
    }

    /// アップロード先を決めて設定に書く(実在するフォルダだけ)
    fn save_upload_root(&self, input: &Value) -> R<String> {
        let root = parse_upload_root(input).map_err(|e| HttpError::new(400, e))?;
        if !std::fs::metadata(&root).is_ok_and(|m| m.is_dir()) {
            return Err(HttpError::new(400, format!("フォルダが見つかりません: {root}")));
        }
        update_config(&self.config_path, "uploadRoot", Some(Value::String(root.clone()))).map_err(|e| HttpError::new(409, format!("{e:#}")))?;
        (self.log)(&format!("serve: アップロード先を {root} にしました({})", self.config_path));
        Ok(root)
    }

    /// 画面の設定に出す今の設定。読めない設定ファイルは理由を返す(画面は理由を出し、書き換えさせない)
    fn settings_of(&self) -> Value {
        let (c, error) = match load_config(&self.config_path, false) {
            Ok(c) => (Some(c), None),
            Err(e) => (None, Some(format!("{e:#}"))),
        };
        json!({
            "configPath": self.config_path,
            "error": error,
            "canPick": self.can_pick,
            "wikis": c.as_ref().and_then(|c| c.wikis.clone()).map(|w| to_value(&w)).unwrap_or_else(|| json!([])),
            "phases": c.as_ref().and_then(|c| c.phases.clone()),
            "defaultPhases": atlas_core::turns::DEFAULT_PHASE_NAMES,
            "uploadRoot": c.as_ref().and_then(|c| c.upload_root.clone()),
            "uploadProjects": c.as_ref().and_then(|c| c.upload_projects.clone()).unwrap_or_default(),
            // 名前に wiki を含むインストール済みの skill(vault を足すときに、wiki の skill として数えるか選べるように。setup.bat と同じ候補)
            "skillCandidates": crate::setup::wiki_skill_candidates(&self.copilot_home),
        })
    }

    /// 設定ファイルの 1 項目を書き換える。読めない設定・ロックが取れないときは 409、検査に通らない値は 400
    fn write_setting(&self, key: &str, f: impl FnOnce(&crate::config::AtlasConfig, &Map<String, Value>) -> R<ConfigEdit>) -> R<()> {
        let mut failed: Option<HttpError> = None;
        let r = modify_config(&self.config_path, key, |c, raw| match f(c, raw) {
            Ok(e) => e,
            Err(e) => {
                failed = Some(e);
                ConfigEdit::NoChange
            }
        });
        if let Some(e) = failed {
            return Err(e);
        }
        match r {
            Ok(_) => Ok(()),
            Err(e) => {
                let m = format!("{e:#}");
                if m.contains("読めないので書き換えません") || m.contains("別の処理が書き換えています") {
                    return Err(HttpError::new(409, m));
                }
                // ファイルを書けない(ほかのプログラムが開いている・フォルダが無い・権限が無いなど)は、入力の誤りではない
                if e.downcast_ref::<std::io::Error>().is_some() {
                    return Err(HttpError::new(500, format!("設定ファイルに書けませんでした({m})")));
                }
                Err(HttpError::new(400, m))
            }
        }
    }

    // ---------- API ----------

    fn api(&self, req: &mut Req, path: &str) -> R<Resp> {
        self.check_origin(req)?;
        let method = req.method.clone();
        if path == "/api/heartbeat" && method == "POST" {
            self.check_token(req)?;
            self.heartbeat(client_of(req), seq_of(req));
            return Ok(Resp { status: 204, headers: vec![("x-atlas-serve", "1".into())], body: Vec::new() });
        }
        if path == "/api/bye" && method == "POST" {
            self.check_token(req)?;
            self.bye(client_of(req), seq_of(req));
            return Ok(Resp { status: 204, headers: vec![], body: Vec::new() });
        }
        let read_only = self.read_only();
        if read_only && blocked_when_read_only(path, &method) {
            return Err(HttpError::new(403, READ_ONLY_MESSAGE));
        }
        if path == "/api/state" && method == "GET" && read_only {
            // 読むだけ: メモ・アップロード先は返さない(レポートに埋め込んだものを使う)
            return Ok(send_json(200, &json!({ "version": 1, "readOnly": true, "notesDir": self.notes_dir.to_string_lossy() })));
        }
        if path == "/api/state" && method == "GET" {
            let memos: Map<String, Value> = load_memo_index(&self.memo_dir).into_iter().map(|(id, x)| (id, to_value(&memo_summary(&x.text, Some(&x.updated_at))))).collect();
            let (root, projects, error) = self.upload_root_of();
            return Ok(send_json(200, &json!({ "version": 1, "memos": memos, "notesDir": self.notes_dir.to_string_lossy(), "upload": { "root": root, "projects": projects, "error": error, "canPick": self.can_pick } })));
        }
        if path == "/api/upload-root" {
            self.check_token(req)?;
            if method == "PUT" {
                let body = self.json_body(req)?;
                let root = self.save_upload_root(body.get("root").unwrap_or(&Value::Null))?;
                return Ok(send_json(200, &json!({ "root": root })));
            }
            if method == "POST" {
                // フォルダを選ぶ画面を出し、選んだ場所を既定にする(取り消したら root: null で何も変えない)
                if !self.can_pick {
                    return Err(HttpError::new(501, "この OS ではフォルダを選ぶ画面を出せません。パスを入力してください"));
                }
                let _p = self.picking()?;
                let cur = self.upload_root_of().0;
                let chosen = (self.pick)("アップロード先の基底フォルダを選んでください(この中にプロジェクト名のフォルダを作ります)", cur.as_deref()).map_err(|e| HttpError::new(500, format!("{e:#}")))?;
                let root = match chosen {
                    None => Value::Null,
                    Some(c) => Value::String(self.save_upload_root(&Value::String(c))?),
                };
                return Ok(send_json(200, &json!({ "root": root })));
            }
            return Err(HttpError::new(405, "この方法では使えません"));
        }
        if path == "/api/settings" || path.starts_with("/api/settings/") {
            return self.settings_api(req, path, &method);
        }
        if path == "/api/folders" || path.starts_with("/api/folders/") {
            self.check_token(req)?;
            return self.folders_api(req, path, &method).map_err(|e| match e {
                FolderOrHttp::Folder(f) => HttpError::new(f.status, f.message),
                FolderOrHttp::Http(h) => h,
            });
        }
        if path == "/api/upload-projects" {
            self.check_token(req)?;
            if method != "PUT" {
                return Err(HttpError::new(405, "この方法では使えません"));
            }
            let body = self.json_body(req)?;
            return Ok(send_json(200, &json!({ "projects": self.save_upload_project(&body)? })));
        }
        if path == "/api/memo-editor.js" && method == "GET" {
            // 読むだけの画面ではメモを書かせない(詳細ページには、送った人のメモを作ったときの HTML のまま出す)
            return Ok(js_resp(if read_only { "/* 読むだけの画面: メモは書き換えません */\n" } else { atlas_report::memo_editor::MEMO_EDITOR_JS }));
        }
        if path == "/api/session-tools.js" && method == "GET" {
            return Ok(js_resp(atlas_report::session_tools::SESSION_TOOLS_JS));
        }
        if path == "/api/jobs" || path.starts_with("/api/jobs/") {
            return self.jobs_api(req, &method, path);
        }
        if path == "/api/tasks" {
            if method != "GET" {
                return Err(HttpError::new(405, "この方法では使えません"));
            }
            return Ok(send_json(200, &self.tasks_payload()?));
        }
        if let Some(c) = TASK_LINK_API.captures(path) {
            let raw = c[1].to_string();
            return self.task_link_api(req, &method, &raw);
        }
        if path.starts_with("/api/judge/") {
            let target = ChatTarget::parse(req.url.param("target"));
            return self.chat_judge_api(req, &method, path, target);
        }
        if let Some(c) = VIEW_API.captures(path) {
            let raw = c[1].to_string();
            return self.view_api(req, &method, &raw);
        }
        if let Some(c) = MEMO_API.captures(path) {
            let raw = c[1].to_string();
            let images = c.get(2).is_some();
            return self.memo_api(req, &method, &raw, images);
        }
        Err(HttpError::new(404, "無い API です"))
    }

    /// フォルダを選ぶ画面を出している間の印(同時に 2 つ出さない)
    fn picking(&self) -> R<PickingGuard<'_>> {
        if self.picking.swap(true, Ordering::SeqCst) {
            return Err(HttpError::new(409, "フォルダを選ぶ画面が開いています(タスクバーを確かめてください)"));
        }
        Ok(PickingGuard(&self.picking))
    }

    fn settings_api(&self, req: &mut Req, path: &str, method: &str) -> R<Resp> {
        self.check_token(req)?;
        if path == "/api/settings" && method == "GET" {
            return Ok(send_json(200, &self.settings_of()));
        }
        if method != "POST" && method != "PUT" {
            return Err(HttpError::new(405, "この方法では使えません"));
        }
        if path == "/api/settings/vault/describe" {
            // 入力されたフォルダ名かパスを調べる(実在すればフォルダ名だけにし、中の index.md と wiki/ を見る。setup.bat と同じ)
            let body = self.json_body(req)?;
            let input = match body.get("input") {
                Some(Value::String(s)) if !js::trim(s).is_empty() => s.clone(),
                _ => return Err(HttpError::new(400, "vault のフォルダ名かパスを入力してください")),
            };
            let d = crate::setup::describe_vault(&input);
            if !VAULT_NAME.is_match(&d.name) {
                return Err(HttpError::new(400, format!("フォルダ名を読めませんでした: {input}")));
            }
            return Ok(send_json(200, &vault_json(&d)));
        }
        if path == "/api/settings/vault/pick" {
            if !self.can_pick {
                return Err(HttpError::new(501, "この OS ではフォルダを選ぶ画面を出せません。フォルダ名かパスを入力してください"));
            }
            let _p = self.picking()?;
            let chosen = (self.pick)("llm-wiki の vault のフォルダを選んでください", None).map_err(|e| HttpError::new(500, format!("{e:#}")))?;
            let d = chosen.as_deref().map(crate::setup::describe_vault);
            // ドライブの直下などはフォルダ名が無い(入力のときと同じく、足す前に止める)
            if let Some(d) = &d
                && !VAULT_NAME.is_match(&d.name)
            {
                return Err(HttpError::new(400, format!("フォルダ名を読めませんでした: {}(ドライブの直下ではなく、vault のフォルダを選んでください)", chosen.unwrap_or_default())));
            }
            return Ok(send_json(200, &d.as_ref().map(vault_json).unwrap_or(Value::Null)));
        }
        if path == "/api/settings/wikis" {
            // vault を 1 つ足す(同じ名前があれば足さない)
            let body = self.json_body(req)?;
            let spec = vault_spec(body.get("vault"))?;
            let name = match &spec {
                Value::String(s) => s.clone(),
                v => v.get("path").and_then(Value::as_str).unwrap_or("").to_string(),
            };
            parse_config(&json!({ "wikis": [spec.clone()] })).map_err(|e| HttpError::new(400, e))?;
            self.write_setting("wikis", |c, raw| {
                if let Some(same) = c.wikis.as_ref().and_then(|w| w.iter().find(|w| same_vault(&w.path, &name))) {
                    return Err(HttpError::new(409, format!("vault「{name}」はもう入っています({})", same.path)));
                }
                let mut list: Vec<Value> = raw.get("wikis").and_then(Value::as_array).cloned().unwrap_or_default();
                list.push(spec.clone());
                Ok(ConfigEdit::Set(Value::Array(list)))
            })?;
            (self.log)(&format!("serve: vault「{name}」を足しました({})", self.config_path));
            return Ok(send_json(200, &self.settings_of()));
        }
        if path == "/api/settings/wikis/remove" {
            // 見えている一覧の何番目かと名前で外す(開いてからほかで書き換えていたら、違うものを外さないよう止める)。書いてあるとおりの値から外す
            let body = self.json_body(req)?;
            let at = body.get("index").and_then(Value::as_f64).filter(|n| n.fract() == 0.0 && *n >= 0.0);
            let (Some(at), Some(Value::String(bpath))) = (at, body.get("path")) else {
                return Err(HttpError::new(400, "外す vault の番号と名前を指定してください"));
            };
            let at = at as usize;
            let bpath = bpath.clone();
            self.write_setting("wikis", |c, raw| {
                let Some(list) = raw.get("wikis").and_then(Value::as_array) else {
                    return Err(HttpError::new(409, "設定がほかで書き換えられました。設定を開き直してください(何も外していません)"));
                };
                if c.wikis.as_ref().and_then(|w| w.get(at)).map(|w| w.path.as_str()) != Some(bpath.as_str()) {
                    return Err(HttpError::new(409, "設定がほかで書き換えられました。設定を開き直してください(何も外していません)"));
                }
                let next: Vec<Value> = list.iter().enumerate().filter(|(i, _)| *i != at).map(|(_, v)| v.clone()).collect();
                Ok(if next.is_empty() { ConfigEdit::Remove } else { ConfigEdit::Set(Value::Array(next)) })
            })?;
            (self.log)(&format!("serve: vault「{bpath}」を外しました({})", self.config_path));
            return Ok(send_json(200, &self.settings_of()));
        }
        if path == "/api/settings/phases" {
            // 普段の工程名(null なら既定に戻す)
            let body = self.json_body(req)?;
            let mut phases: Option<Vec<String>> = None;
            if body.get("phases") != Some(&Value::Null) {
                phases = strings(body.get("phases"), "phases")?;
                let Some(p) = &phases else { return Err(HttpError::new(400, "工程名を 2 つ以上入力してください")) };
                parse_config(&json!({ "phases": p })).map_err(|e| HttpError::new(400, e))?;
            }
            let value = phases.clone();
            self.write_setting("phases", move |_, _| Ok(value.map_or(ConfigEdit::Remove, |p| ConfigEdit::Set(json!(p)))))?;
            (self.log)(&format!("serve: 普段の工程名を{}しました({})", phases.map_or("既定に".to_string(), |p| format!(" {} に", p.join(" / "))), self.config_path));
            return Ok(send_json(200, &self.settings_of()));
        }
        Err(HttpError::new(404, "見つかりません"))
    }

    fn folders_api(&self, req: &mut Req, path: &str, method: &str) -> Result<Resp, FolderOrHttp> {
        if path == "/api/folders" && method == "GET" {
            return Ok(send_json(200, &to_value(&list_folders(&self.folder_ctx))));
        }
        if method != "POST" {
            return Err(HttpError::new(405, "この方法では使えません").into());
        }
        if path == "/api/folders/pick" {
            // フォルダを選ぶ画面を出し、選んだ場所が集計できるかを確かめて返す(取り消したら path: null。開くのは画面の「集計して開く」)
            if !self.can_pick {
                return Err(HttpError::new(501, "この OS ではフォルダを選ぶ画面を出せません。パスを入力してください").into());
            }
            let _p = self.picking()?;
            let initial = self.current.clone().or_else(|| list_folder_states(&self.folder_ctx.root).first().map(|(_, s)| s.path.clone())).or_else(|| self.upload_root_of().0);
            let chosen = (self.pick)("集計して開くフォルダを選んでください(アップロード先・人ごとのフォルダ・プロジェクトのフォルダ)", initial.as_deref()).map_err(|e| HttpError::new(500, format!("{e:#}")))?;
            let Some(chosen) = chosen else { return Ok(send_json(200, &json!({ "path": null }))) };
            return Ok(send_json(
                200,
                &match check_folder(&Value::String(chosen.clone())) {
                    Ok(info) => json!({ "path": info.path, "ok": true, "name": info.name, "summary": info.summary }),
                    Err(e) => json!({ "path": chosen, "ok": false, "error": e.message }),
                },
            ));
        }
        let body = self.json_body(req)?;
        let input = body.get("path").cloned().unwrap_or(Value::Null);
        if path == "/api/folders/check" {
            // 集計できないフォルダは、失敗ではなく答えとして返す(ok: false と理由。選ぶ画面から選んだときと同じ形)
            return Ok(send_json(
                200,
                &match check_folder(&input) {
                    Ok(info) => json!({ "path": info.path, "ok": true, "name": info.name, "summary": info.summary }),
                    Err(e) => json!({ "path": input.as_str().unwrap_or(""), "ok": false, "error": e.message }),
                },
            ));
        }
        if path == "/api/folders/open" {
            let entry = open_folder_report(&self.folder_ctx, &input)?;
            if entry.status == "starting" {
                (self.log)(&format!("serve: 別のフォルダを集計して開きます({})", entry.path));
            }
            return Ok(send_json(200, &to_value(&entry)));
        }
        if path == "/api/folders/forget" {
            forget_folder(&self.folder_ctx.root, body.get("key").unwrap_or(&Value::Null))?;
            return Ok(send_json(200, &to_value(&list_folders(&self.folder_ctx))));
        }
        Err(HttpError::new(404, "見つかりません").into())
    }

    /// Phase 14: ジョブ。読みも書きも token が要る(ログに生の文字列が入るため)
    fn jobs_api(&self, req: &mut Req, method: &str, path: &str) -> R<Resp> {
        self.check_token(req)?;
        let je = |e: crate::jobs::JobError| HttpError::new(e.status, e.message);
        if path == "/api/jobs" && method == "POST" {
            let body = self.json_body(req)?;
            let ids = if body.get("kind").and_then(Value::as_str) == Some("full") { self.session_index()? } else { None };
            let known = |id: &str| ids.as_ref().is_some_and(|ix| ix.ids.contains_key(id));
            let r = parse_job_request(&body, &known).map_err(je)?;
            // 読むだけの画面の紐づけは送った人のもの。LLM で紐づけても画面には出ないので始めない
            if r.writes_task_links() && self.read_only() {
                return Err(HttpError::new(403, READ_ONLY_MESSAGE));
            }
            let snap = self.jobs.start(&r).map_err(je)?;
            return Ok(send_json(202, &to_value(&snap)));
        }
        if path == "/api/jobs/current" && method == "GET" {
            return Ok(send_json(200, &to_value(&self.jobs.current())));
        }
        if path == "/api/jobs/current/cancel" && method == "POST" {
            return Ok(send_json(200, &to_value(&self.jobs.cancel().map_err(je)?)));
        }
        if path == "/api/jobs/judge-preview" && method == "GET" {
            // 前の版の詳細ページは ?session=<id> で 1 セッションの件数を聞き、判定のボタンを出す。その判定は無くなったので、
            // 全体の件数を返さず断る(前の版のページは、答えが無いと判定の欄を出さない)
            if req.url.param("session").is_some() {
                return Err(HttpError::new(410, crate::jobs::GONE_MESSAGE));
            }
            // 添付ファイルを作る前に出す、未判定の数(?target=turns は依頼ごと、?target=tasks はタスクへの紐づけ)
            let counts = match ChatTarget::parse(req.url.param("target")) {
                ChatTarget::Turns => self.turn_preview()?,
                ChatTarget::Tasks => self.task_preview()?,
                ChatTarget::Effort => self.judge_preview()?,
            };
            return Ok(send_json(200, &Value::Object(counts)));
        }
        if ["/api/jobs", "/api/jobs/current", "/api/jobs/current/cancel", "/api/jobs/judge-preview"].contains(&path) {
            return Err(HttpError::new(405, "この方法では使えません"));
        }
        Err(HttpError::new(404, "無い API です"))
    }

    // ---------- 管理ツールのタスク ----------

    /// GET /api/tasks: 今のタスクの状態・紐づけ・工数(レポートの埋め込みと同じ形。集計し直さずに、今のファイルから数える)。
    /// 読むだけの画面は、送った人がセッションごとに添えた記録から
    fn tasks_payload(&self) -> R<Value> {
        let read_only = self.read_only();
        let cfg = match load_config(&self.config_path, false) {
            Ok(c) => crate::commands::tasks::TaskConfig { source: c.tasks, error: None },
            Err(e) => crate::commands::tasks::TaskConfig { source: None, error: Some(format!("{e:#}")) },
        };
        let ix = self.session_index()?;
        // 推定人手工数はレポート(build)と同じ読み方で、セッションの値は sessions.json の同じ項目(createdAt・activeMs)から。数えるのも同じ関数
        let human = crate::commands::tasks::judgment_hours(&self.out_dir.join("judgments.json"));
        let ids: Vec<&str> = ix.as_ref().map(|ix| ix.ids.keys().map(String::as_str).collect()).unwrap_or_default();
        let facts: HashMap<String, atlas_report::tasks::metrics::SessionFacts> = ix
            .as_ref()
            .map(|ix| ix.ids.iter().map(|(id, e)| (id.clone(), atlas_report::tasks::metrics::SessionFacts { start_ms: e.start_ms, active_ms: e.active_ms, human: human.get(id).copied() })).collect())
            .unwrap_or_default();
        let snapshot = self.out_dir.join("snapshot");
        let view = crate::commands::tasks::tasks_view(crate::commands::tasks::ViewInputs {
            notes: &self.notes_abs,
            snapshot: &snapshot,
            cfg: &cfg,
            read_only,
            all: &ids,
            shown: &ids,
            facts: &facts,
            refreshed: None,
            scoped: false,
        });
        // LLM に紐づけを頼むセッションの数: tasks bundle が束に入れるもの(同じ決め方の links::llm_eligible)
        let unresolved = match (&view, &ix) {
            (Some(_), Some(ix)) if !read_only => {
                let st = atlas_report::tasks::state::load_tasks(&atlas_report::tasks::tasks_path(&self.notes_abs)).file;
                let li = atlas_report::tasks::links::load_links(&atlas_report::tasks::task_links_path(&self.notes_abs)).file;
                ix.ids.iter().filter(|(id, e)| atlas_report::tasks::links::llm_eligible(&li, &st, id, e.empty, e.has_text, e.start_ms)).count()
            }
            _ => 0,
        };
        Ok(json!({ "readOnly": read_only, "tasks": view.as_ref().map(to_value), "unresolved": unresolved }))
    }

    /// PUT /api/tasks/links/<id>: { taskIds: ["<タスクの ID>", …] }(手動で紐づける。空の並びは「どのタスクでもない」。上限は links::MAX_TASKS_PER_SESSION)、
    /// 前の形の { taskId: "<タスクの ID>" | null }、か { auto: true }(手動の紐づけを外して自動に戻す。機械の紐づけをすぐ決め直す)。
    /// 返すのは GET /api/tasks と同じもの
    fn task_link_api(&self, req: &mut Req, method: &str, raw_id: &str) -> R<Resp> {
        if method != "PUT" {
            return Err(HttpError::new(405, "この方法では使えません"));
        }
        self.check_token(req)?;
        let id = decode_uri_component(raw_id).map_err(|()| HttpError::new(400, "セッション id を読めません"))?;
        if !is_safe_memo_id(&id) {
            return Err(HttpError::new(400, "セッション id の形が正しくありません"));
        }
        let body = self.json_body(req)?;
        let extra: Vec<&str> = body.keys().map(String::as_str).filter(|k| !["taskIds", "taskId", "auto"].contains(k)).collect();
        if !extra.is_empty() {
            return Err(HttpError::new(400, format!("使えない項目です: {}", extra.join(", "))));
        }
        let auto = match body.get("auto") {
            None => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err(HttpError::new(400, "auto は true か false です")),
        };
        let max = atlas_report::tasks::links::MAX_TASKS_PER_SESSION;
        let one = |v: &Value| match v {
            Value::String(t) if !js::trim(t).is_empty() && js::utf16_len(t) <= 400 => Ok(js::trim(t).to_string()),
            _ => Err(HttpError::new(400, "タスクの ID は空でない文字列です")),
        };
        let tasks: Vec<String> = match (auto, body.get("taskIds"), body.get("taskId")) {
            (true, None, None) => vec![],
            (true, ..) => return Err(HttpError::new(400, "auto と taskIds(taskId)は一緒に使えません")),
            (false, Some(_), Some(_)) => return Err(HttpError::new(400, "taskIds と taskId は一緒に使えません")),
            (false, Some(Value::Array(a)), None) => {
                // 重なりを除いてから上限を確かめる(同じ ID を何度送っても 1 つ)。並びは送られた順
                let mut ids: Vec<String> = Vec::new();
                for v in a {
                    let id = one(v)?;
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
                if ids.len() > max {
                    return Err(HttpError::new(400, format!("1 つのセッションに紐づけられるタスクは {max} 個までです(重なりを除いて {} 個)", ids.len())));
                }
                ids
            }
            (false, None, Some(Value::Null)) => vec![],
            (false, None, Some(v @ Value::String(_))) => vec![one(v)?],
            (false, ..) => return Err(HttpError::new(400, "taskIds にタスクの ID の並びを指定してください(空の並びは「どのタスクでもない」。自動に戻すときは auto: true)")),
        };
        let ix = self.session_index()?.ok_or_else(|| HttpError::new(404, "まだ集計していません(sessions.json がありません)"))?;
        if !ix.ids.contains_key(&id) {
            return Err(HttpError::new(404, format!("セッション {id} は sessions.json にありません(集計し直すと出ることがあります)")));
        }
        {
            let _g = lock(&self.tasks_lock);
            let state = atlas_report::tasks::state::load_tasks(&atlas_report::tasks::tasks_path(&self.notes_abs));
            if let Some(w) = state.warnings.first() {
                return Err(HttpError::new(409, w.clone()));
            }
            // 一覧に無いタスクは、どれが無いかを全部書いて断る(画面はこの文を出し、外す札が分かるようにする)
            let unknown: Vec<&str> = tasks.iter().filter(|t| !state.file.tasks.contains_key(*t)).map(String::as_str).collect();
            if !unknown.is_empty() {
                let names = unknown.iter().map(|t| format!("「{t}」")).collect::<String>();
                return Err(HttpError::new(400, format!("タスクの一覧にないタスクです: {names}。外してから保存してください(管理ツールの XML を読み直すと出ることがあります)")));
            }
            // 自動に戻すときの機械の紐づけに使う文は、ロックを取る前に読む(ロックは短く持つ)
            let text = if auto { self.session_text(&id)? } else { None };
            let links_path = atlas_report::tasks::task_links_path(&self.notes_abs);
            let now = atlas_core::jsdate::now_iso();
            // 返答を取り込むジョブ(別のプロセス)や集計と重ならないよう、ファイルのロックの中で読み直して、このセッションの分だけを直す
            atlas_report::tasks::links::update_links(&links_path, |links| {
                if auto {
                    // 手動でも LLM でも、紐づけを外して機械の紐づけをすぐ決め直す(LLM には頼んだときだけ聞く)
                    links.links.shift_remove(&id);
                    if let Some(text) = &text {
                        atlas_report::tasks::links::apply_machine(links, std::slice::from_ref(text), &state.file, &now);
                    }
                } else {
                    links.links.insert(id.clone(), atlas_report::tasks::links::TaskLink { task_ids: tasks, source: atlas_report::tasks::links::LinkSource::Manual, reason: String::new(), confidence: None, at: now });
                }
            })
            .map_err(|e| {
                // 別の書き手がロックを持ったまま・壊れたファイルは 409(待つか直してもらう)、ほかの書けなかった理由は 500
                let busy = e.downcast_ref::<atlas_report::tasks::LockBusy>().is_some() || e.downcast_ref::<atlas_report::tasks::BrokenFile>().is_some();
                HttpError::new(if busy { 409 } else { 500 }, format!("{e:#}"))
            })?;
        }
        Ok(send_json(200, &self.tasks_payload()?))
    }

    /// sessions.json の 1 件の、機械の紐づけに使う文(題名・最初の依頼・各依頼の先頭)。無ければ None
    fn session_text(&self, id: &str) -> R<Option<atlas_report::tasks::links::SessionText>> {
        let file = std::fs::read(self.out_dir.join("sessions.json"))
            .map_err(|e| e.to_string())
            .and_then(|b| js::parse_json(&String::from_utf8_lossy(&b)).map_err(|e| e.to_string()))
            .map_err(|e| HttpError::new(503, format!("sessions.json を読めません(集計の途中かもしれません): {e}")))?;
        let Some(r) = file.get("sessions").and_then(Value::as_array).and_then(|a| a.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(id))) else { return Ok(None) };
        let mut prompts: Vec<&str> = r.get("firstUserMessage").and_then(Value::as_str).into_iter().collect();
        prompts.extend(r.get("analysis").and_then(|a| a.get("requests")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str));
        Ok(Some(atlas_report::tasks::links::SessionText {
            id: id.to_string(),
            start_ms: r.get("createdAt").and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(atlas_core::jsdate::parse_ms),
            title: r.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            prompts: prompts.join("\n"),
        }))
    }

    /// 工数の判定の件数: 依頼の記録があるセッションのうち judgments.json に無いもの
    fn judge_preview(&self) -> R<Map<String, Value>> {
        let Some(ix) = self.session_index()? else { return Ok(obj(json!({ "eligible": 0, "judged": 0, "pending": 0 }))) };
        let judged = judged_session_ids(&self.out_dir).map_err(|e| HttpError::new(409, format!("{e:#}")))?;
        let (mut eligible, mut done) = (0, 0);
        for (id, x) in &ix.ids {
            if !x.eligible {
                continue;
            }
            eligible += 1;
            if judged.contains(id) {
                done += 1;
            }
        }
        Ok(obj(json!({ "eligible": eligible, "judged": done, "pending": eligible - done })))
    }

    /// 依頼ごとの判定の件数(依頼ごとの記録がある依頼のうち、turn-judgments.json に無いもの)
    fn turn_preview(&self) -> R<Map<String, Value>> {
        let Some(ix) = self.session_index()? else { return Ok(obj(json!({ "eligible": 0, "judged": 0, "pending": 0, "withoutTurns": 0 }))) };
        let judged = judged_turn_keys(&self.out_dir).map_err(|e| HttpError::new(409, format!("{e:#}")))?;
        let (mut eligible, mut done, mut without) = (0, 0, 0);
        for (id, x) in &ix.ids {
            // 依頼があるのに依頼ごとの記録が無いセッション(古い集計)。「集計し直す」で入る
            if x.eligible && x.turns == 0 {
                without += 1;
            }
            for t in 1..=x.turns {
                eligible += 1;
                if judged.contains(&format!("{id}#{t}")) {
                    done += 1;
                }
            }
        }
        Ok(obj(json!({ "eligible": eligible, "judged": done, "pending": eligible - done, "withoutTurns": without })))
    }

    /// タスクへの紐づけの件数: pending は LLM に頼むセッション(tasks bundle が束に入れるもの。links::llm_eligible)、
    /// judged は LLM で紐づけたセッション。読むだけの画面・タスクが無いときは 0
    fn task_preview(&self) -> R<Map<String, Value>> {
        let zero = || obj(json!({ "eligible": 0, "judged": 0, "pending": 0 }));
        let Some(ix) = self.session_index()? else { return Ok(zero()) };
        if self.read_only() {
            return Ok(zero());
        }
        let st = atlas_report::tasks::state::load_tasks(&atlas_report::tasks::tasks_path(&self.notes_abs)).file;
        let li = atlas_report::tasks::links::load_links(&atlas_report::tasks::task_links_path(&self.notes_abs)).file;
        let pending = ix.ids.iter().filter(|(id, e)| atlas_report::tasks::links::llm_eligible(&li, &st, id, e.empty, e.has_text, e.start_ms)).count();
        let judged = ix.ids.keys().filter(|id| li.links.get(*id).is_some_and(|l| l.source == atlas_report::tasks::links::LinkSource::Llm)).count();
        Ok(obj(json!({ "eligible": pending + judged, "judged": judged, "pending": pending })))
    }

    /// 添付ファイルの一覧(chat_parts.rs。manifest が読めなければ 409)
    fn parts_for(&self, target: ChatTarget) -> R<ChatParts> {
        list_chat_parts(&self.out_dir, &self.notes_abs, target).map_err(|e| HttpError::new(409, format!("{e:#}")))
    }

    /// 画面に返す添付ファイルの一覧(M365 Copilot を自動で操作できるかを足す。一覧を読んだときも、取り込んだ後も同じ形)
    fn parts_json(&self, target: ChatTarget) -> R<Value> {
        let mut v = obj(to_value(&self.parts_for(target)?));
        v.insert("canAutomate".into(), json!(self.m365));
        Ok(Value::Object(v))
    }

    /// 外部の LLM での判定。読みも書きも token が要る(進み具合にセッション id が入るため)。
    /// ?target=turns は依頼ごとの判定(turn-bundle/・turn-judgments.json)、?target=tasks は管理ツールのタスクへの紐づけ
    /// (task-bundle/・notes の task-links.json)、それ以外は工数の判定。
    /// GET  /api/judge/parts:  bundle/parts/ の各ファイルと、その中のセッションのうち判定済みの数(bundle が無ければ exists: false)。
    ///      今の束の ZIP(bundle.zip・turn-bundle.zip・task-bundle.zip)があれば zip: { path, bytes, modifiedAt }(保存は out/ の下のファイルとして GET /<名前>.zip。フルパスは返さない)
    /// GET  /api/judge/parts/<名前>: そのファイルの本文 { text }(画面の「本文をコピー」。manifest にある名前だけ)
    /// POST /api/judge/import: { text } 貼った返答を検証して judgments.json に取り込む(1 件でも形が合わなければ何も書かない)。
    ///      レポートへの反映は別(export のジョブ)。判定・集計のジョブや CLI が out/ に書いている間は 409
    fn chat_judge_api(&self, req: &mut Req, method: &str, path: &str, target: ChatTarget) -> R<Resp> {
        self.check_token(req)?;
        // 読むだけの画面のタスクの紐づけは送った人のもの。添付ファイルも返答の取り込みも断る(ほかのタスクの API と同じ)
        if target == ChatTarget::Tasks && self.read_only() {
            return Err(HttpError::new(403, READ_ONLY_MESSAGE));
        }
        if path == "/api/judge/parts" {
            if method != "GET" {
                return Err(HttpError::new(405, "この方法では使えません"));
            }
            return Ok(send_json(200, &self.parts_json(target)?));
        }
        if let Some(c) = JUDGE_PART.captures(path) {
            if method != "GET" {
                return Err(HttpError::new(405, "この方法では使えません"));
            }
            let name = decode_uri_component(&c[1]).map_err(|()| HttpError::new(400, "ファイル名を読めません"))?;
            let parts = self.parts_for(target)?;
            let Some(part) = parts.parts.as_ref().and_then(|p| p.iter().find(|p| p.name == name)) else {
                return Err(HttpError::new(404, format!("添付ファイル {name} はありません(作り直すと番号が変わります)")));
            };
            let mut file = self.out_dir.clone();
            for seg in part.path.split('/') {
                file.push(seg);
            }
            let text = std::fs::read(&file).map_err(HttpError::internal)?;
            return Ok(send_json(200, &json!({ "name": name, "text": String::from_utf8_lossy(&text) })));
        }
        if path == "/api/judge/import" {
            if method != "POST" {
                return Err(HttpError::new(405, "この方法では使えません"));
            }
            let body = self.read_json_body(req, IMPORT_BODY_MAX)?;
            let text = match body.get("text") {
                Some(Value::String(t)) if !js::trim(t).is_empty() => t.clone(),
                _ => return Err(HttpError::new(400, "返答を貼り付けてください")),
            };
            if self.jobs.running() {
                return Err(HttpError::new(409, "ほかの処理が動いています。終わってから取り込んでください"));
            }
            if let Some(other) = running_job_in(&self.out_dir) {
                return Err(HttpError::new(409, format!("別の atlas の処理({other})が動いています。終わってから取り込んでください")));
            }
            let ids = self.session_index()?;
            // 取り込みで除いたもの(候補に無い ID・上限を超えた ID)と、書かなかったセッションの知らせ(画面に出す)
            let mut notices: Vec<String> = Vec::new();
            let r: anyhow::Result<(usize, usize, usize, Vec<String>, usize)> = if target == ChatTarget::Tasks {
                // 画面の手動の紐づけ(同じプロセス)とも重ならないよう、紐づけを書く間はタスクのロックも持つ
                let _g = lock(&self.tasks_lock);
                crate::commands::tasks::import_task_links_text(&text, &self.notes_abs, &self.out_dir.join(crate::paths::TASK_BUNDLE_DIR)).map(|r| {
                    let lines = crate::commands::tasks::import_lines("tasks import(画面)", &r, &atlas_report::tasks::task_links_path(&self.notes_abs));
                    for l in &lines {
                        (self.log)(l);
                    }
                    // 画面には 1 行目(取り込んだ数)を除いた知らせを、先頭の名前を外して出す
                    notices.extend(lines.iter().skip(1).map(|l| l.trim_start_matches("tasks import(画面): ").to_string()));
                    // overwritten の代わりに、書かなかった(手動・前の LLM・機械の紐づけがあった)数を返す
                    (r.imported, r.kept_manual.len() + r.kept_llm.len() + r.kept_machine.len(), r.duplicates, vec![], r.imported)
                })
            } else if target == ChatTarget::Turns {
                (|| {
                    let phases = atlas_judge::turn_bundle::turn_import_phases(&self.out_dir.join("turn-bundle"), &phase_names()?);
                    let by: Option<HashMap<String, usize>> = ids.as_ref().map(|ix| ix.ids.iter().map(|(id, x)| (id.clone(), x.turns)).collect());
                    let r = atlas_judge::turn_schema::import_turn_judgments_text(
                        &text,
                        &self.out_dir.join("turn-judgments.json"),
                        atlas_judge::turn_schema::TurnImportOptions { phases: &phases, turns_by_session: by.as_ref(), now: None, backend: None, model: None },
                    )?;
                    Ok((r.imported, r.overwritten, 0, r.unknown, r.total))
                })()
            } else {
                let known: Option<HashSet<String>> = ids.as_ref().map(|ix| ix.ids.keys().cloned().collect());
                atlas_judge::judgments_io::import_judgments_text(&text, &self.out_dir.join("judgments.json"), atlas_judge::judgments_io::ImportOptions { known_ids: known.as_ref(), now: None, label: None })
                    .map(|r| {
                        // llm-wiki のページごとの判定の一部を捨てた(そのページは未判定)
                        for n in &r.notes {
                            (self.log)(&format!("judge import(画面): 注意 {n}"));
                        }
                        notices.extend(r.notes.iter().cloned());
                        (r.imported, r.overwritten, r.duplicates, r.unknown_ids, r.total)
                    })
            };
            let (imported, overwritten, duplicates, unknown_ids, total) = match r {
                Ok(r) => r,
                Err(e) => {
                    if let Some(v) = e.downcast_ref::<atlas_judge::schema::JudgmentValidationError>() {
                        let what = if target == ChatTarget::Tasks { "紐づけ" } else { "判定" };
                        return Ok(send_json(400, &json!({ "error": format!("返答の形が{what}の形式に合いません(何も取り込んでいません)"), "problems": v.problems })));
                    }
                    return Err(HttpError::new(400, format!("{e:#}")));
                }
            };
            if target != ChatTarget::Tasks {
                (self.log)(&format!("{}(画面): {imported} 件を取り込みました(既存の上書き {overwritten} 件)", target.import_command()));
            }
            let parts = self.parts_json(target)?;
            // タスクの紐づけでは、kept に書かなかった数(手動か前の LLM の紐づけがあった)を返す
            let mut body = json!({ "imported": imported, "overwritten": if target == ChatTarget::Tasks { 0 } else { overwritten }, "duplicates": duplicates, "unknownIds": unknown_ids, "total": total, "notices": notices, "parts": parts });
            if target == ChatTarget::Tasks {
                body["kept"] = json!(overwritten);
            }
            return Ok(send_json(200, &body));
        }
        Err(HttpError::new(404, "無い API です"))
    }

    fn view_target(&self, raw_id: &str, kind_param: Option<&str>) -> R<(String, ViewKind, PathBuf, String)> {
        let id = decode_uri_component(raw_id).map_err(|()| HttpError::new(400, "セッション id を読めません"))?;
        if !is_safe_memo_id(&id) {
            return Err(HttpError::new(400, "セッション id の形が正しくありません"));
        }
        let Some(kind) = ViewKind::parse(kind_param.unwrap_or("transcript")) else {
            return Err(HttpError::new(400, format!("kind は {} のどちらかです", VIEW_KINDS.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(" / "))));
        };
        let (name, dir) = match kind {
            ViewKind::Transcript => (atlas_report::transcript::transcript_file_name(&id), "sessions"),
            ViewKind::Full => (atlas_report::full::full_file_name(&id), "full"),
        };
        let md_href = format!("../{dir}/{}", encode_uri_component(&name));
        Ok((id, kind, self.out_dir.join(dir).join(name), md_href))
    }

    /// GET /api/view/<id>?kind=transcript|full: .md をメモと同じ規則で HTML にして返す(上限を超えたら描かない)
    fn view_api(&self, req: &mut Req, method: &str, raw_id: &str) -> R<Resp> {
        self.check_token(req)?;
        if method != "GET" {
            return Err(HttpError::new(405, "この方法では使えません"));
        }
        let (id, kind, file, md_href) = self.view_target(raw_id, req.url.param("kind"))?;
        let ix = self.session_index()?;
        let Some(entry) = ix.as_ref().and_then(|ix| ix.ids.get(&id)) else {
            return Err(HttpError::new(404, if self.refreshing() { REFRESHING.to_string() } else { format!("セッション {id} は sessions.json にありません") }));
        };
        let Ok(st) = std::fs::metadata(&file) else {
            return Err(HttpError::new(
                404,
                if self.refreshing() {
                    REFRESHING
                } else if kind == ViewKind::Full {
                    "全文記録はまだありません。詳細ページの「全文を作って読む」で作ってください。"
                } else {
                    "セッション記録(.md)がありません。atlas.html の「集計し直す」で作られます。"
                },
            ));
        };
        let mut base = obj(json!({ "id": id, "kind": kind.as_str(), "label": view_label(kind), "title": entry.title, "size": st.len(), "limit": self.view_limit, "updatedAt": atlas_core::jsfs::mtime_iso(&st), "mdHref": md_href }));
        if st.len() > self.view_limit {
            base.insert("tooLarge".into(), json!(true));
            return Ok(send_json(200, &Value::Object(base)));
        }
        let text = std::fs::read(&file).map_err(HttpError::internal)?;
        let doc = render_view_document(&String::from_utf8_lossy(&text), kind, &id, Some(&self.out_dir.join("full")));
        self.touch_idle();
        base.insert("tooLarge".into(), json!(false));
        if let Some(t) = doc.title {
            base.insert("docTitle".into(), json!(t));
        }
        base.insert("html".into(), json!(doc.html));
        base.insert("headings".into(), to_value(&doc.headings));
        Ok(send_json(200, &Value::Object(base)))
    }

    /// GET /view/<id>?kind=…: 表示の殻(本文は持たない。token は HTML の meta で渡し、本文は殻の script が API から取る)
    fn view_shell(&self, req: &mut Req, raw_id: &str) -> R<Resp> {
        self.check_origin(req)?;
        let (id, kind, _, md_href) = self.view_target(raw_id, req.url.param("kind"))?;
        let css = self.page_css()?;
        let detail_href = format!("../sessions/{}", encode_uri_component(&atlas_report::summarize::detail_file_name(&id)));
        let html = render_viewer_shell(&ViewerShellOptions { css: &css, id: &id, kind, detail_href: &detail_href, md_href: &md_href }).replacen(TOKEN_PLACEHOLDER, &self.token, 1);
        let mut headers = vec![("content-type", "text/html; charset=utf-8".to_string()), ("cache-control", "no-store".into()), ("x-atlas-serve", "1".into())];
        headers.extend(HTML_HEADERS.iter().map(|(k, v)| (*k, v.to_string())));
        Ok(Resp { status: 200, headers, body: if req.method == "HEAD" { Vec::new() } else { Vec::from(html) } })
    }

    fn page_css(&self) -> R<String> {
        if let Some(c) = self.css.get() {
            return Ok(c.clone());
        }
        let c = atlas_report::build::page_css();
        Ok(self.css.get_or_init(|| c).clone())
    }

    fn memo_body(&self, id: &str, x: Option<&MemoFile>) -> Value {
        match x {
            Some(x) => json!({ "text": x.text, "rev": x.rev, "html": render_memo(&self.memo_dir, id, &x.text), "updatedAt": x.updated_at }),
            None => json!({ "text": "", "rev": "", "html": "", "updatedAt": null }),
        }
    }

    /// GET / PUT /api/memos/<id>、POST /api/memos/<id>/images。PUT の rev が今の本文と違えば書かずに 409(Obsidian や CLI と同時に触っても黙って消さない)
    fn memo_api(&self, req: &mut Req, method: &str, raw_id: &str, images: bool) -> R<Resp> {
        let id = decode_uri_component(raw_id).map_err(|()| HttpError::new(400, "セッション id を読めません"))?;
        if !is_safe_memo_id(&id) {
            return Err(HttpError::new(400, "メモに使えないセッション id です"));
        }
        if images {
            if method != "POST" {
                return Err(HttpError::new(405, "この方法では使えません"));
            }
            self.check_token(req)?;
            let data = req.body.read(self.memo_image_limit)?;
            if image_ext(&data).is_none() {
                return Err(HttpError::new(415, "png / jpeg / gif / webp の画像だけ追加できます"));
            }
            let (name, markdown) = save_memo_image(&self.memo_dir, &id, &data).map_err(HttpError::internal)?;
            return Ok(send_json(201, &json!({ "name": name, "markdown": markdown })));
        }
        if method == "GET" {
            let m = read_memo(&self.memo_dir, &id).map_err(HttpError::internal)?;
            return Ok(send_json(200, &self.memo_body(&id, m.as_ref())));
        }
        if method != "PUT" {
            return Err(HttpError::new(405, "この方法では使えません"));
        }
        self.check_token(req)?;
        let body = self.json_body(req)?;
        let Some(Value::String(text)) = body.get("text") else { return Err(HttpError::new(400, "text は文字列です")) };
        let Some(Value::String(rev)) = body.get("rev") else { return Err(HttpError::new(400, "rev は文字列です")) };
        // 確認と書き込みの間に別の PUT が入らないよう、同じ id の保存は順番に行う(2 つのタブで同じ rev を送っても片方は 409 になる)
        let m = lock(&self.memo_locks).entry(id.clone()).or_default().clone();
        let r = {
            let _g = lock(&m);
            save_memo(&self.memo_dir, &id, text, Some(rev)).map_err(HttpError::internal)?
        };
        if let Some(c) = r.conflict {
            return Ok(send_json(409, &json!({ "error": "メモが別の場所で更新されました", "rev": c.rev })));
        }
        Ok(send_json(200, &self.memo_body(&id, r.memo.as_ref())))
    }

    // ---------- 静的ファイル ----------

    fn serve_static(&self, req: &mut Req, path: &str) -> R<Resp> {
        if let Some(c) = VIEW_PAGE.captures(path) {
            let raw = c[1].to_string();
            return self.view_shell(req, &raw);
        }
        if path == "/" {
            return Ok(Resp { status: 302, headers: vec![("location", "/atlas.html".into())], body: Vec::new() });
        }
        let decoded = decode_uri_component(path).map_err(|()| HttpError::new(400, "パスを読めません"))?;
        if decoded.contains('\0') {
            return Err(HttpError::new(400, "パスを読めません"));
        }
        // out/ の外は読めない(正規化して out/ 配下か見る)。.serve.json も出さない
        let file = platform::resolve(&[&self.out_s, &format!(".{decoded}")]);
        let sep = if cfg!(windows) { "\\" } else { "/" };
        if file != self.out_s && !file.starts_with(&format!("{}{sep}", self.out_s)) {
            return Err(HttpError::new(404, "ありません"));
        }
        if file == platform::join(&[&self.out_s, SERVE_STATE_FILE]) {
            return Err(HttpError::new(404, "ありません"));
        }
        // 集計し直している間は build が sessions/ を消してから書くので、詳細ページが一時的に無いことがある
        let Ok(st) = std::fs::metadata(&file) else {
            return Err(HttpError::new(404, if self.refreshing() { REFRESHING } else { "ありません" }));
        };
        if st.is_dir() {
            return Err(HttpError::new(404, "ありません"));
        }
        let ext = atlas_report::viewer::ext_lower(&file);
        let ctype = mime(&ext).unwrap_or("application/octet-stream");
        let rel = file[self.out_s.len()..].trim_start_matches(['\\', '/']).replace('\\', "/");
        let head = req.method == "HEAD";
        if ext == ".html" && is_app_page(&rel) {
            // token は HTML の meta のプレースホルダを置き換えて渡す(file:// で開いたときはプレースホルダのまま = 空扱い)
            let mut headers = vec![("content-type", ctype.to_string()), ("cache-control", "no-store".into())];
            headers.extend(HTML_HEADERS.iter().map(|(k, v)| (*k, v.to_string())));
            let body = if head {
                Vec::new()
            } else {
                let text = std::fs::read(&file).map_err(HttpError::internal)?;
                Vec::from(String::from_utf8_lossy(&text).replacen(TOKEN_PLACEHOLDER, &self.token, 1))
            };
            return Ok(Resp { status: 200, headers, body });
        }
        let mut headers = vec![("content-type", ctype.to_string()), ("content-length", st.len().to_string()), ("cache-control", "no-store".into())];
        headers.extend(FILE_HEADERS.iter().map(|(k, v)| (*k, v.to_string())));
        // HEAD でも本文を渡す(http.rs は HEAD には本文を送らず、大きさだけ content-length で返す)
        let body = std::fs::read(&file).map_err(HttpError::internal)?;
        Ok(Resp { status: 200, headers, body })
    }
}

/// 応えている途中の要求の印(落とすと数から外し、待っていた止まり方の判定を再開する)
struct Inflight(Weak<Server>);

impl Drop for Inflight {
    fn drop(&mut self) {
        if let Some(s) = self.0.upgrade() {
            {
                let mut l = lock(&s.life);
                l.inflight = l.inflight.saturating_sub(1);
            }
            s.resume();
        }
    }
}

/// 接続のスレッドが終わったら(落ちても)、開いている接続の一覧から外す
struct ConnGuard<'a>(&'a Server, u64);

impl Drop for ConnGuard<'_> {
    fn drop(&mut self) {
        lock(&self.0.conns).open.remove(&self.1);
    }
}

/// フォルダを選ぶ画面を閉じたら印を外す
struct PickingGuard<'a>(&'a AtomicBool);

impl Drop for PickingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

enum FolderOrHttp {
    Folder(FolderError),
    Http(HttpError),
}

impl From<FolderError> for FolderOrHttp {
    fn from(e: FolderError) -> Self {
        FolderOrHttp::Folder(e)
    }
}

impl From<HttpError> for FolderOrHttp {
    fn from(e: HttpError) -> Self {
        FolderOrHttp::Http(e)
    }
}

static VIEW_API: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/view/([^/]+)$").unwrap());
static VIEW_PAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/view/([^/]+)$").unwrap());
static MEMO_API: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/memos/([^/]+)(/images)?$").unwrap());
static TASK_LINK_API: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/tasks/links/([^/]+)$").unwrap());
/// 取り込む返答の本文の上限。画面はファイルを 5 MB まで読み、JSON の文字列にすると引用符と改行の分だけ増える(多くて 2 倍)ので、それが収まる大きさにする
const IMPORT_BODY_MAX: u64 = 12 * 1024 * 1024;

static JUDGE_PART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/judge/parts/([^/]+)$").unwrap());
/// フォルダ名として読める(. / \ ~ と空白だけではない)
static VAULT_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"[^./\\~{}]", &js::RE_S[1..js::RE_S.len() - 1])).unwrap());
static CLIENT_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9-]{1,64}$").unwrap());

fn js_resp(text: &str) -> Resp {
    Resp {
        status: 200,
        headers: vec![("content-type", "text/javascript; charset=utf-8".into()), ("cache-control", "no-store".into()), ("x-atlas-serve", "1".into()), (NOSNIFF.0, NOSNIFF.1.into())],
        body: Vec::from(text.to_string()),
    }
}

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(o) => o,
        _ => Map::new(),
    }
}

/// 開いている画面の印(heartbeat の x-atlas-client)
fn client_of(req: &Req) -> Option<String> {
    req.header("x-atlas-client").filter(|c| CLIENT_ID.is_match(c))
}

/// 画面が送った順の番号(x-atlas-seq)。古い画面は送らない(None)
fn seq_of(req: &Req) -> Option<f64> {
    let s = req.header("x-atlas-seq")?;
    let n = js_number(&s);
    (n.is_finite() && n.fract() == 0.0 && n >= 0.0 && n <= 9_007_199_254_740_991.0).then_some(n)
}

/// 別のフォルダ(送り先など)を開いた画面は読むだけ。メモは送った人が付けたものを出し、ここでは書き換えない。
/// 断るのは、メモ・アップロード先・まとめて送る印・タスクの紐づけ。
/// 集計し直す・判定(手元の出力先に書くだけで、送り先は書き換えない)・設定・別のフォルダを開く操作は使える
fn blocked_when_read_only(path: &str, method: &str) -> bool {
    if method == "GET" || method == "HEAD" {
        return false;
    }
    path.starts_with("/api/memos/") || path.starts_with("/api/tasks/") || path == "/api/upload-root" || path == "/api/upload-projects"
}

fn vault_json(d: &crate::setup::VaultInfo) -> Value {
    json!({ "name": d.name, "dir": d.dir, "hasIndex": d.has_index, "pagesDir": d.pages_dir })
}

/// 文字列の配列(前後の空白を除き、空のものは捨てる)。無い・null なら None、空になっても None
fn strings(v: Option<&Value>, where_: &str) -> R<Option<Vec<String>>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(a)) if a.iter().all(Value::is_string) => {
            let list: Vec<String> = a.iter().filter_map(Value::as_str).map(|x| js::trim(x).to_string()).filter(|x| !x.is_empty()).collect();
            Ok((!list.is_empty()).then_some(list))
        }
        Some(_) => Err(HttpError::new(400, format!("{where_} は文字列の配列で指定してください"))),
    }
}

/// 画面から足す vault の指定(path と、任意の index・pages・skills)。設定ファイルには setup.bat と同じ形(path だけなら文字列)で書く
fn vault_spec(v: Option<&Value>) -> R<Value> {
    let Some(Value::Object(r)) = v else { return Err(HttpError::new(400, "vault の指定がありません")) };
    let path = match r.get("path") {
        Some(Value::String(p)) if VAULT_NAME.is_match(p) => js::trim(p).to_string(),
        _ => return Err(HttpError::new(400, "vault のフォルダ名かパスを指定してください")),
    };
    let mut spec = Map::new();
    spec.insert("path".into(), json!(path));
    let index = strings(r.get("index"), "index")?;
    let pages = strings(r.get("pages"), "pages")?;
    let skills = strings(r.get("skills"), "skills")?;
    if let Some(i) = index {
        spec.insert("index".into(), json!(i));
    }
    // ページのフォルダが vault 全体(.)だけなら書かない(既定と同じ)
    if let Some(p) = pages
        && !(p.len() == 1 && p[0] == ".")
    {
        spec.insert("pages".into(), json!(p));
    }
    if let Some(s) = skills {
        let mut seen = HashSet::new();
        spec.insert("skills".into(), json!(s.into_iter().filter(|x| seen.insert(x.clone())).collect::<Vec<_>>()));
    }
    Ok(if spec.len() == 1 { json!(path) } else { Value::Object(spec) })
}

/// 同じ vault か。~/ を展開し、Windows では大文字小文字を区別しない。フルパスとフォルダ名(setup.bat はフォルダ名で登録する)は、
/// フルパスの最後のフォルダ名が同じなら同じ vault とみなす(同じ vault を二重に数えないように)
fn same_vault(a: &str, b: &str) -> bool {
    static TILDE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^~[\\/]").unwrap());
    let norm = |p: &str| -> String {
        let x = if TILDE.is_match(p) { platform::join(&[&crate::paths::home_dir().to_string_lossy(), &p[2..]]) } else { p.to_string() };
        let y = if platform::is_absolute(&x) { platform::resolve(&[&x]) } else { x.trim_end_matches(['\\', '/']).to_string() };
        if cfg!(windows) { js::to_lower(&y) } else { y }
    };
    let (x, y) = (norm(a), norm(b));
    if x == y {
        return true;
    }
    let last = |p: &str| p.split(['\\', '/']).filter(|s| !s.is_empty()).next_back().unwrap_or(p).to_string();
    let bare = |p: &str| !p.contains(['\\', '/']);
    (platform::is_absolute(&x) && bare(&y) && last(&x) == y) || (platform::is_absolute(&y) && bare(&x) && last(&y) == x)
}

/// JS の Number(文字列)(前後の空白を除き、空なら 0。0x・0o・0b と Infinity も読む。読めなければ NaN)
fn js_number(s: &str) -> f64 {
    let t = js::trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (p, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(rest) = t.strip_prefix(p) {
            return if !rest.is_empty() && rest.chars().all(|c| c.is_digit(radix)) { rest.chars().fold(0.0, |a, c| a * radix as f64 + c.to_digit(radix).unwrap_or(0) as f64) } else { f64::NAN };
        }
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body == "Infinity" {
        return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    if !body.is_empty() && body.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-')) && body.chars().any(|c| c.is_ascii_digit()) {
        return t.parse::<f64>().unwrap_or(f64::NAN);
    }
    f64::NAN
}
