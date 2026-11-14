//! atlas serve(packages/cli/src/serve.ts の移植): out/ を 127.0.0.1 だけに配信し、画面からグループ(atlas-notes/groups.json)とメモ(atlas-notes/memos/)を書く小さな API を持つ。
//! Phase 14: 画面からの操作(集計し直す・工数を判定する・全文を作る。jobs.rs)と、記録・全文記録の表示(/view/<id>)も持つ。
//! チャットでの判定(M365 Copilot など): 添付ファイル(bundle/parts/)の一覧と進み具合(/api/judge/parts)、貼った返答の取り込み(/api/judge/import)。
//! 画面(3 画面)は 3 秒ごとに heartbeat を送り、ページを閉じるときは bye を送る。開いている画面がすべて bye を送ったら BYE_GRACE_MS 後に、
//! heartbeat がどの画面からも IDLE の間届かなければ、自分で終了する(ブラウザを閉じれば止まる)。ジョブの実行中と、要求に応えている途中は止めず、終わってから判定を再開する。
//! IDLE を短くしないこと: ブラウザは隠れたタブのタイマーを間引く(Chrome は 5 分以上隠れたタブを 1 分に 1 回まで)。以前の 8 秒では、別のタブで作業している間に止まっていた。
//! 画面と保存の境界はこの API だけ(後でアプリ化するときに差し替える)。
//!
//! HTTP は hyper をそのまま使う(axum の経路分けは使わない。TS 版と同じ 1 つの振り分けにし、止めるときに接続をすべて切り、
//! 応答を送り終えるまでを「応えている途中」と数えるため)。接続の受け付けは tokio、要求の処理(ファイルの読み書き・描画・アップロード)は
//! 処理ごとのスレッド(spawn_blocking)で、TS 版と同じ順に確かめてから本文を読む。

mod http;
#[cfg(test)]
mod tests;

use crate::chat_parts::{judged_session_ids, judged_turn_keys, list_chat_parts, ChatParts, ChatTarget};
use crate::config::{default_config_path, is_byok_model, load_config, modify_config, parse_config, parse_upload_root, phase_names, update_config, ConfigEdit};
use crate::folders::{check_folder, folders_root_of, forget_folder, is_read_only_view, list_folder_states, list_folders, open_folder_report, FolderContext, FolderError};
use crate::group_export::{export_group, GroupExportPaths};
use crate::group_upload::{check_upload, upload_dir, upload_group, uploaded_at, GroupUploadPaths, GroupUploadResult, UploadChangedError, UploadCheck, UploadOptions, UploadProgress};
use crate::jobs::{acquire_out_lock, parse_job_request, running_job_in, FullCtx, JobRunner, JobRunnerOptions, RunFullFn, SpawnFn};
use atlas_core::js;
use atlas_core::nodepath::platform;
use atlas_report::groups::{add_ids, member_groups, remove_ids, unique_ids, MemberSource, SessionGroup};
use atlas_report::groups_io::{load_groups, load_groups_for_write, save_groups};
use atlas_report::memo::{is_safe_memo_id, memo_summary};
use atlas_report::memo_io::{image_ext, load_memo_index, memos_dir, read_memo, render_memo, save_memo, save_memo_image, MemoFile, MEMO_IMAGE_LIMIT};
use atlas_report::viewer::{encode_uri_component, render_view_document, render_viewer_shell, view_label, ViewKind, ViewerShellOptions, VIEW_KINDS, VIEW_LIMIT};
use bytes::Bytes;
use http::{decode_uri_component, header, parse_request_target, BodyReader, ReqUrl, Resp, Settle, SettleBody};
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU8, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

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
pub const READ_ONLY_MESSAGE: &str = "別のフォルダを開いた画面は読むだけです。タスクタグとメモは、送った人が付けたものを出します(書き換えるのは、送った人の PC の画面です)";
const REFRESHING: &str = "集計し直している最中です(詳細ページと記録は作り直しの途中です)。集計が終わってから開き直してください。";
const LAST_UPLOAD_MS: i64 = 10 * 60_000;

/// フォルダを選ぶ画面(題名と、最初に開く場所)。取り消したら None
pub type PickFn = Arc<dyn Fn(&str, Option<&str>) -> anyhow::Result<Option<String>> + Send + Sync>;
/// フォルダをエクスプローラーで開く
pub type OpenDirFn = Arc<dyn Fn(&str) + Send + Sync>;
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
    /// groups.json のパス(notesDir 配下)
    pub groups_path: PathBuf,
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
    /// グループのアップロード先(uploadRoot)を読み書きする設定ファイル。None なら default_config_path()
    pub config_path: Option<PathBuf>,
    /// フォルダを選ぶ画面とエクスプローラーで開く操作(既定は folder_picker.rs。テストで差し替える)
    pub can_pick: Option<bool>,
    pub pick: Option<PickFn>,
    pub open_dir: Option<OpenDirFn>,
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
    pub fn new(out_dir: impl Into<PathBuf>, notes_dir: impl Into<PathBuf>, groups_path: impl Into<PathBuf>) -> Self {
        ServeOptions {
            out_dir: out_dir.into(),
            notes_dir: notes_dir.into(),
            groups_path: groups_path.into(),
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
            open_dir: None,
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
const APP_PAGES: [&str; 4] = ["atlas.html", "glossary.html", "insights.html", "instructions.html"];

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
        body: Bytes::from(atlas_core::json::to_js_string(body).unwrap_or_default()),
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
    let r = simple_request(port, "GET", "/api/state", &[], &[], Duration::from_millis(1500)).ok()?;
    if r.header("x-atlas-serve") != Some("1") {
        return None;
    }
    Some(RunningServer { port, pid: j.get("pid").and_then(Value::as_f64).unwrap_or(0.0) as u32, code: r.header("x-atlas-code").map(str::to_string) })
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
}

/// sessions.json の id → 表題と判定の対象か(本文は持たない)。集計元の形(読むだけの画面かを決める)と、送った人のタスクタグも持つ
struct SessionIndex {
    ids: IndexMap<String, SessionEntry>,
    layout: Option<String>,
    members: Vec<SessionGroup>,
}

struct LastUpload {
    at: i64,
    ok: bool,
    error: Option<String>,
    result: Option<GroupUploadResult>,
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
    groups_path: PathBuf,
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
    open_dir: OpenDirFn,
    m365: bool,
    copilot_home: PathBuf,
    current: Option<String>,
    folder_ctx: FolderContext<'static>,
    log: LogFn,
    jobs: Arc<JobRunner>,
    port: AtomicU16,
    rt: tokio::runtime::Handle,
    anon_cache: Mutex<Option<(f64, bool)>>,
    sessions_cache: Mutex<Option<(f64, Arc<SessionIndex>)>>,
    /// タスクタグの書き出し・写す前の点検・アップロードのどれかをしている最中なら、その内容。その間はほかの書き出し・点検・アップロード・ジョブを始めない
    busy_with: Mutex<Option<String>>,
    /// 写している途中のアップロード(画面が進み具合を問い合わせる)
    uploading: Mutex<Option<(String, Arc<Mutex<UploadProgress>>)>>,
    /// タスクタグごとの直近のアップロードの結果(写している途中に別のページへ移って戻った画面が、成功か失敗かを出せるように。10 分だけ)
    last_upload: Mutex<HashMap<String, LastUpload>>,
    /// タスクタグごとの直近の点検(写すときに同じ指紋で来たら渡し、送り先の一覧を読み直さない)
    last_check: Mutex<HashMap<String, UploadCheck>>,
    picking: AtomicBool,
    css: OnceLock<String>,
    life: Mutex<Life>,
    /// groups.json の読み・変更・書き込みは順番に行う(2 つの要求が同じ内容を読み、後の書き込みが先の変更を消さないように)
    groups_lock: Mutex<()>,
    memo_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// 終わったら理由が入る
    done_tx: tokio::sync::watch::Sender<Option<String>>,
    conns: Mutex<Vec<tokio::task::AbortHandle>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
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
    done: tokio::sync::watch::Receiver<Option<String>>,
}

impl ServeHandle {
    /// 終了したときに理由を返す
    pub async fn done(&self) -> String {
        let mut rx = self.done.clone();
        loop {
            if let Some(r) = rx.borrow().clone() {
                return r;
            }
            if rx.changed().await.is_err() {
                return "停止".into();
            }
        }
    }

    /// 終わっていれば理由
    #[cfg(test)]
    pub fn finished(&self) -> Option<String> {
        self.done.borrow().clone()
    }

    pub fn close(&self, reason: &str) {
        self.server.close(reason);
    }
}

/// サーバを起動する(tokio の中で呼ぶ)
pub async fn start_serve(o: ServeOptions) -> anyhow::Result<ServeHandle> {
    let log = o.log.clone();
    let out_dir = crate::paths::resolve(&o.out_dir);
    let out_s = out_dir.to_string_lossy().into_owned();
    let groups_path = crate::paths::resolve(&o.groups_path);
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
    let open_dir: OpenDirFn = o.open_dir.clone().unwrap_or_else(|| Arc::new(crate::folder_picker::open_folder));
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
    let (done_tx, done_rx) = tokio::sync::watch::channel::<Option<String>>(None);
    let rt = tokio::runtime::Handle::current();
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
            groups_path,
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
            open_dir,
            m365: o.m365.unwrap_or(cfg!(windows)),
            copilot_home,
            current,
            folder_ctx,
            log: log.clone(),
            jobs,
            port: AtomicU16::new(0),
            rt: rt.clone(),
            anon_cache: Mutex::new(None),
            sessions_cache: Mutex::new(None),
            busy_with: Mutex::new(None),
            uploading: Mutex::new(None),
            last_upload: Mutex::new(HashMap::new()),
            last_check: Mutex::new(HashMap::new()),
            picking: AtomicBool::new(false),
            css: OnceLock::new(),
            life: Mutex::new(Life::default()),
            groups_lock: Mutex::new(()),
            memo_locks: Mutex::new(HashMap::new()),
            done_tx,
            conns: Mutex::new(Vec::new()),
        }
    });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", o.port)).await?;
    let port = listener.local_addr()?.port();
    server.port.store(port, Ordering::SeqCst);
    let url = format!("http://127.0.0.1:{port}/atlas.html");
    std::fs::write(
        out_dir.join(SERVE_STATE_FILE),
        format!("{}\n", atlas_core::json::to_js_string(&json!({ "port": port, "pid": std::process::id(), "startedAt": atlas_core::jsdate::now_iso() }))?),
    )?;
    let acc = server.clone();
    let mut stop = done_rx.clone();
    rt.spawn(async move {
        loop {
            tokio::select! {
                r = listener.accept() => {
                    let Ok((stream, _)) = r else { continue };
                    acc.serve_connection(stream);
                }
                _ = stop.changed() => break,
            }
        }
    });
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
        done: done_rx,
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
    headers: hyper::HeaderMap,
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
        let me = self.me.clone();
        self.rt.spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            if let Some(s) = me.upgrade() {
                s.timer_fired(which, generation, reason);
            }
        });
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
        self.jobs.drop_lock();
        // 止めるときは、まだ何も送っていない接続(ブラウザが次の要求のために先に開けておくもの)や送りかけの要求も、待たずにすべて切る。
        // 自分から止まるとき(expire)は、応えている途中の要求が無いことを確かめてからここへ来る。切られるのは、中断(Ctrl+C)のときだけ
        for c in lock(&self.conns).drain(..) {
            c.abort();
        }
        let _ = self.done_tx.send(Some(reason.to_string()));
    }

    // ---------- 接続と要求 ----------

    fn serve_connection(&self, stream: tokio::net::TcpStream) {
        // 応答を分けて書いても待たせない(Node の http サーバと同じく Nagle を切る。切らないと Windows の遅延 ACK で 1 回 200ms 待つ)
        let _ = stream.set_nodelay(true);
        let me = self.arc();
        let svc = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
            let s = me.clone();
            async move { Ok::<_, std::convert::Infallible>(s.serve_request(req).await) }
        });
        let io = hyper_util::rt::TokioIo::new(stream);
        let task = self.rt.spawn(async move {
            let _ = hyper::server::conn::http1::Builder::new().keep_alive(true).serve_connection(io, svc).await;
        });
        let mut conns = lock(&self.conns);
        conns.retain(|c| !c.is_finished());
        if lock(&self.life).closed {
            task.abort();
        } else {
            conns.push(task.abort_handle());
        }
    }

    /// 処理が済み、かつ応答を送り終える(か相手が切る)までを「応えている途中」と数える。相手が先に切っても、処理(アップロードなど)が続いていれば待つ
    async fn serve_request(self: Arc<Self>, req: hyper::Request<hyper::body::Incoming>) -> hyper::Response<SettleBody> {
        lock(&self.life).inflight += 1;
        let waiting = Arc::new(AtomicU8::new(2));
        let half = |s: &Arc<Server>| {
            let w = waiting.clone();
            let me = Arc::downgrade(s);
            Settle(Some(Box::new(move || {
                if w.fetch_sub(1, Ordering::SeqCst) == 1
                    && let Some(s) = me.upgrade()
                {
                    lock(&s.life).inflight -= 1;
                    s.resume();
                }
            })))
        };
        let sent = half(&self);
        let handled = half(&self);
        let target = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into());
        let url = parse_request_target(&target);
        let (parts, body) = req.into_parts();
        let rt = self.rt.clone();
        let s = self.clone();
        let resp = tokio::task::spawn_blocking(move || {
            let _done = handled;
            let mut r = Req { method: parts.method.as_str().to_string(), headers: parts.headers, url, body: BodyReader::new(body, rt) };
            s.handle(&mut r)
        })
        .await
        .unwrap_or_else(|e| send_json(500, &json!({ "error": format!("サーバの内部エラー: {e}") })));
        let mut b = hyper::Response::builder().status(resp.status);
        if let Some(c) = &self.code {
            b = b.header("x-atlas-code", c.as_str());
        }
        for (k, v) in &resp.headers {
            b = b.header(*k, v.as_str());
        }
        b.body(SettleBody::new(resp.body, sent)).unwrap_or_else(|_| hyper::Response::new(SettleBody::new(Bytes::new(), Settle(None))))
    }

    fn handle(&self, req: &mut Req) -> Resp {
        let path = req.url.path.clone();
        let api = path.starts_with("/api/");
        let r = self.check_host(req).and_then(|()| if api { self.api(req, &path) } else { self.serve_static(req, &path) });
        match r {
            Ok(r) => r,
            Err(e) if api => send_json(e.status, &json!({ "error": e.message })),
            Err(e) => Resp { status: e.status, headers: vec![("content-type", "text/plain; charset=utf-8".into())], body: Bytes::from(e.message) },
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

    /// 伏せ字版かどうかは atlas.html の埋め込みデータで判断(mtime が変わるまで覚える)
    fn is_anonymized(&self) -> bool {
        let p = self.out_dir.join("atlas.html");
        let Ok(m) = std::fs::metadata(&p) else { return false };
        let mt = atlas_core::jsfs::mtime_ms(&m);
        let mut c = lock(&self.anon_cache);
        if let Some((at, a)) = *c
            && at == mt
        {
            return a;
        }
        // 読めなければ通常版とみなす(編集できるだけで、壊れはしない)
        let anonymized = std::fs::read(&p)
            .ok()
            .and_then(|b| atlas_report::embed::extract_embedded(&String::from_utf8_lossy(&b)).ok())
            .is_some_and(|v| js::truthy(v.get("anonymized")));
        *c = Some((mt, anonymized));
        anonymized
    }

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
        let mut owners: Vec<(String, Option<String>, Vec<String>)> = Vec::new();
        for r in sessions {
            let id = js::key_of(r.get("id").unwrap_or(&Value::Null));
            let name = r.get("name").and_then(Value::as_str).map(js::trim).unwrap_or("");
            let eligible = r.get("turns").and_then(Value::as_f64).is_some_and(|t| t > 0.0) || js::truthy(r.get("firstUserMessage"));
            let turns = r.get("analysis").and_then(|a| a.get("turnStats")).and_then(Value::as_array).map_or(0, Vec::len);
            ids.insert(id.clone(), SessionEntry { title: if name.is_empty() { "(名前なし)".into() } else { name.to_string() }, eligible, turns });
            let tags: Vec<String> = r.get("uploadTags").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
            owners.push((id, r.get("person").and_then(Value::as_str).map(str::to_string), tags));
        }
        let members = member_groups(&owners.iter().map(|(id, person, tags)| MemberSource { id, person: person.as_deref(), upload_tags: tags }).collect::<Vec<_>>());
        let layout = file.get("source").and_then(|s| s.get("layout")).and_then(Value::as_str).map(str::to_string);
        let ix = Arc::new(SessionIndex { ids, layout, members });
        *lock(&self.sessions_cache) = Some((mt, ix.clone()));
        Ok(Some(ix))
    }

    /// 読むだけの画面か(build と同じ is_read_only_view)と、送った人のタスクタグ。sessions.json を読めないとき(集計の途中など)は前に読んだものを使う。
    /// atlas open が立てたサーバ(reports.current)は、まだ集計していなくても読むだけ
    fn view_state(&self) -> (bool, Vec<SessionGroup>) {
        let _ = self.session_index();
        let cache = lock(&self.sessions_cache).as_ref().map(|(_, ix)| ix.clone());
        let read_only = self.current.is_some() || is_read_only_view(&self.out_s, cache.as_ref().and_then(|c| c.layout.as_deref()));
        (read_only, cache.map(|c| c.members.clone()).unwrap_or_default())
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
            return Ok(Resp { status: 204, headers: vec![("x-atlas-serve", "1".into())], body: Bytes::new() });
        }
        if path == "/api/bye" && method == "POST" {
            self.check_token(req)?;
            self.bye(client_of(req), seq_of(req));
            return Ok(Resp { status: 204, headers: vec![], body: Bytes::new() });
        }
        if self.is_anonymized() {
            return Err(HttpError::new(403, "伏せ字版では編集できません"));
        }
        let (read_only, members) = self.view_state();
        if read_only && blocked_when_read_only(path, &method) {
            return Err(HttpError::new(403, READ_ONLY_MESSAGE));
        }
        if path == "/api/state" && method == "GET" && read_only {
            // 読むだけ: タスクタグは送った人のもの(集計の sessions.json から人ごとに作る。レポートに埋め込んだものと同じ)。メモ・アップロード先は返さない(埋め込みを使う)
            return Ok(send_json(200, &json!({ "version": 1, "readOnly": true, "groups": members, "notesDir": self.notes_dir.to_string_lossy(), "groupsPath": self.groups_path.to_string_lossy(), "exists": false, "warnings": [] })));
        }
        if path == "/api/state" && method == "GET" {
            let g = load_groups(&self.groups_path);
            let memos: Map<String, Value> = load_memo_index(&self.memo_dir).into_iter().map(|(id, x)| (id, to_value(&memo_summary(&x.text, Some(&x.updated_at))))).collect();
            let (root, projects, error) = self.upload_root_of();
            return Ok(send_json(
                200,
                &json!({ "version": 1, "groups": g.groups, "memos": memos, "notesDir": self.notes_dir.to_string_lossy(), "groupsPath": self.groups_path.to_string_lossy(), "exists": g.exists, "warnings": g.warnings, "upload": { "root": root, "projects": projects, "error": error, "canPick": self.can_pick } }),
            ));
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
                let chosen = (self.pick)("アップロード先の基底フォルダを選んでください(この中にタスクタグ名のフォルダを作ります)", cur.as_deref()).map_err(|e| HttpError::new(500, format!("{e:#}")))?;
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
        if path.starts_with("/api/judge/") {
            let target = if req.url.param("target") == Some("turns") { ChatTarget::Turns } else { ChatTarget::Effort };
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
        // upload(写す)・upload/check(写す前の点検: 大きさと秘密らしい文字列)・upload/progress(写している途中の進み具合)・upload/open(写した先を開く)
        if let Some(c) = GROUP_UPLOAD.captures(path) {
            let raw = c[1].to_string();
            let sub = c.get(2).map_or("", |m| m.as_str()).to_string();
            return self.upload_api(req, &method, &raw, &sub);
        }
        if let Some(c) = GROUP_EXPORT.captures(path) {
            let raw = c[1].to_string();
            return self.export_api(req, &method, &raw);
        }
        let Some(m) = GROUPS.captures(path) else { return Err(HttpError::new(404, "無い API です")) };
        let target = match m.get(1) {
            Some(t) => Some(decode_uri_component(t.as_str()).map_err(|()| HttpError::internal("URI malformed"))?),
            None => None,
        };
        self.groups_api(req, &method, target)
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
            let r = parse_job_request(&body, &|id| ids.as_ref().is_some_and(|ix| ix.ids.contains_key(id))).map_err(je)?;
            // グループの書き出しは out/ を読んでいるので、終わるまで集計などを始めない
            let busy = lock(&self.busy_with);
            if let Some(b) = &*busy {
                return Err(HttpError::new(409, format!("{b}最中です。終わってから実行してください")));
            }
            let snap = self.jobs.start(&r).map_err(je)?;
            drop(busy);
            return Ok(send_json(202, &to_value(&snap)));
        }
        if path == "/api/jobs/current" && method == "GET" {
            return Ok(send_json(200, &to_value(&self.jobs.current())));
        }
        if path == "/api/jobs/current/cancel" && method == "POST" {
            return Ok(send_json(200, &to_value(&self.jobs.cancel().map_err(je)?)));
        }
        if path == "/api/jobs/judge-preview" && method == "GET" {
            // 判定に使うモデル(設定の judgeModel)も返す。確認ダイアログが、Copilot の AI クレジットを使うか、自分の API キー(BYOK)かを出す
            let (model, model_error) = match load_config(&self.config_path, false) {
                Ok(c) => (c.judge_model, None),
                Err(e) => (None, Some(format!("{e:#}"))),
            };
            let mut counts = if req.url.param("target") == Some("turns") { self.turn_preview()? } else { self.judge_preview()? };
            counts.insert("model".into(), json!(model));
            counts.insert("byok".into(), json!(is_byok_model(model.as_deref())));
            counts.insert("modelError".into(), json!(model_error));
            return Ok(send_json(200, &Value::Object(counts)));
        }
        if ["/api/jobs", "/api/jobs/current", "/api/jobs/current/cancel", "/api/jobs/judge-preview"].contains(&path) {
            return Err(HttpError::new(405, "この方法では使えません"));
        }
        Err(HttpError::new(404, "無い API です"))
    }

    /// 判定の確認ダイアログの件数: 依頼の記録があるセッションのうち judgments.json に無いもの
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

    /// 添付ファイルの一覧(chat_parts.rs。manifest が読めなければ 409)
    fn parts_for(&self, target: ChatTarget) -> R<ChatParts> {
        list_chat_parts(&self.out_dir, target).map_err(|e| HttpError::new(409, format!("{e:#}")))
    }

    /// チャットでの判定。読みも書きも token が要る(進み具合にセッション id が入るため)。
    /// ?target=turns は依頼ごとの判定(turn-bundle/・turn-judgments.json)、それ以外は工数の判定。
    /// GET  /api/judge/parts:  bundle/parts/ の各ファイルと、その中のセッションのうち判定済みの数(bundle が無ければ exists: false)
    /// GET  /api/judge/parts/<名前>: そのファイルの本文 { text }(画面の「本文をコピー」。manifest にある名前だけ)
    /// POST /api/judge/import: { text } 貼った返答を検証して judgments.json に取り込む(1 件でも形が合わなければ何も書かない)。
    ///      レポートへの反映は別(export のジョブ)。判定・集計のジョブや CLI が out/ に書いている間は 409
    fn chat_judge_api(&self, req: &mut Req, method: &str, path: &str, target: ChatTarget) -> R<Resp> {
        self.check_token(req)?;
        if path == "/api/judge/parts" {
            if method != "GET" {
                return Err(HttpError::new(405, "この方法では使えません"));
            }
            let mut v = obj(to_value(&self.parts_for(target)?));
            v.insert("canAutomate".into(), json!(self.m365));
            return Ok(send_json(200, &Value::Object(v)));
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
            let body = self.read_json_body(req, 4 * 1024 * 1024)?;
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
            let r: anyhow::Result<(usize, usize, usize, Vec<String>, usize)> = if target == ChatTarget::Turns {
                (|| {
                    let phases = atlas_judge::turn_run::turn_import_phases(&self.out_dir.join("turn-bundle"), &phase_names()?);
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
                    .map(|r| (r.imported, r.overwritten, r.duplicates, r.unknown_ids, r.total))
            };
            let (imported, overwritten, duplicates, unknown_ids, total) = match r {
                Ok(r) => r,
                Err(e) => {
                    if let Some(v) = e.downcast_ref::<atlas_judge::schema::JudgmentValidationError>() {
                        return Ok(send_json(400, &json!({ "error": "返答の形が判定の形式に合いません(何も取り込んでいません)", "problems": v.problems })));
                    }
                    return Err(HttpError::new(400, format!("{e:#}")));
                }
            };
            (self.log)(&format!("{}(画面): {imported} 件を取り込みました(既存の上書き {overwritten} 件)", if target == ChatTarget::Turns { "turns import" } else { "judge import" }));
            let parts = to_value(&self.parts_for(target)?);
            return Ok(send_json(200, &json!({ "imported": imported, "overwritten": overwritten, "duplicates": duplicates, "unknownIds": unknown_ids, "total": total, "parts": parts })));
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
        if self.is_anonymized() {
            return Err(HttpError::new(403, "伏せ字版では記録を表示しません"));
        }
        let (id, kind, _, md_href) = self.view_target(raw_id, req.url.param("kind"))?;
        let css = self.page_css()?;
        let detail_href = format!("../sessions/{}", encode_uri_component(&atlas_report::summarize::detail_file_name(&id)));
        let html = render_viewer_shell(&ViewerShellOptions { css: &css, id: &id, kind, detail_href: &detail_href, md_href: &md_href }).replacen(TOKEN_PLACEHOLDER, &self.token, 1);
        let mut headers = vec![("content-type", "text/html; charset=utf-8".to_string()), ("cache-control", "no-store".into()), ("x-atlas-serve", "1".into())];
        headers.extend(HTML_HEADERS.iter().map(|(k, v)| (*k, v.to_string())));
        Ok(Resp { status: 200, headers, body: if req.method == "HEAD" { Bytes::new() } else { Bytes::from(html) } })
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

    fn upload_api(&self, req: &mut Req, method: &str, raw: &str, sub: &str) -> R<Resp> {
        if method != (if sub == "progress" { "GET" } else { "POST" }) {
            return Err(HttpError::new(405, "この方法では使えません"));
        }
        self.check_token(req)?;
        let name = decode_uri_component(raw).map_err(|()| HttpError::new(400, "タスクタグの名前を読めません"))?;
        if sub == "progress" {
            // 写している途中なら進み具合。終わっていれば直近の結果({ finished: true, ok, error, result })。どちらでもなければ null
            if let Some((n, p)) = &*lock(&self.uploading)
                && *n == name
            {
                return Ok(send_json(200, &to_value(&*lock(p))));
            }
            let now = atlas_core::jsdate::now_ms();
            let last = lock(&self.last_upload).get(&name).map(|l| (l.at, l.ok, l.error.clone(), l.result.clone()));
            let mut fresh = last.as_ref().is_some_and(|l| now - l.0 < LAST_UPLOAD_MS);
            // 失敗の後に、ほかから(CLI など)送り直して成功していれば、失敗は出さない(送り先の索引の日時が新しい)
            if let Some(l) = &last
                && fresh
                && !l.1
                && let Some(root) = self.upload_root_of().0
                && let Some(at) = uploaded_at(Path::new(&root), &name)
                && atlas_core::jsdate::parse_ms(&at).is_some_and(|a| a > l.0)
            {
                fresh = false;
            }
            return Ok(send_json(200, &match last.filter(|_| fresh) {
                Some((at, ok, error, result)) => json!({ "finished": true, "at": at, "ok": ok, "error": error, "result": result.as_ref().map(to_value) }),
                None => Value::Null,
            }));
        }
        let (root, _, error) = self.upload_root_of();
        if let Some(e) = error {
            return Err(HttpError::new(409, e));
        }
        let Some(root) = root else { return Err(HttpError::new(409, "アップロード先が決まっていません。先に場所を選んでください")) };
        let root = PathBuf::from(root);
        // 写すときは、確かめたときの点検の指紋(expect)を受け取り、写す直前に点検し直して違えば写さない(本文は、ほかの処理の最中かを見る前に読む)
        let body = if sub.is_empty() { self.json_body(req).unwrap_or_default() } else { Map::new() };
        let expect = body.get("expect").and_then(Value::as_str).map(str::to_string);
        if sub == "open" {
            // 写した先のフォルダを開く(開けるのは設定のアップロード先の中の、このグループのフォルダだけ)
            let dir = upload_dir(&root, &name);
            if !dir.exists() {
                return Err(HttpError::new(404, format!("まだアップロードしていません: {}", dir.display())));
            }
            (self.open_dir)(&dir.to_string_lossy());
            return Ok(send_json(200, &json!({ "dir": dir.to_string_lossy() })));
        }
        let what = if sub == "check" { format!("「{name}」を写す前に調べている") } else { format!("「{name}」をアップロードしている") };
        let out_lock = {
            let mut busy = lock(&self.busy_with);
            // 集計の途中は out/snapshot/ が書きかけのことがあるので待ってもらう
            if self.jobs.running() {
                return Err(HttpError::new(409, if self.refreshing() { "集計し直している最中です。終わってからアップロードしてください" } else { "ほかの処理が動いています。終わってからアップロードしてください" }));
            }
            if let Some(b) = &*busy {
                return Err(HttpError::new(409, format!("{b}最中です。終わってからもう一度押してください")));
            }
            if let Some(other) = running_job_in(&self.out_dir) {
                return Err(HttpError::new(409, format!("別の atlas の処理({other})が動いています。終わってからアップロードしてください")));
            }
            let l = acquire_out_lock(&self.out_dir, "group upload", "serve").map_err(|e| HttpError::new(409, e.0))?;
            *busy = Some(what);
            l
        };
        let paths = GroupUploadPaths { snapshot: self.out_dir.join("snapshot"), groups: self.groups_path.clone(), notes: Some(crate::paths::resolve(&self.notes_dir)), sessions: Some(self.out_dir.join("sessions.json")) };
        let r = (|| -> anyhow::Result<Value> {
            if sub == "check" {
                let c = check_upload(&paths, &name, &root)?;
                let v = to_value(&c);
                lock(&self.last_check).insert(name.clone(), c);
                return Ok(v);
            }
            let progress = Arc::new(Mutex::new(UploadProgress::default()));
            *lock(&self.uploading) = Some((name.clone(), progress.clone()));
            // 直近の点検と同じ指紋で来たときだけ、その点検を渡す(別の送り先・別の回の点検は使わない)
            let prev = lock(&self.last_check).remove(&name);
            let check = prev.filter(|p| expect.as_deref() == Some(p.fingerprint.as_str()) && Path::new(&p.dir) == upload_dir(&root, &name));
            let on_progress = |pr: &UploadProgress| *lock(&progress) = pr.clone();
            let log = |m: &str| (self.log)(m);
            match upload_group(&paths, &name, &root, &log, &UploadOptions { on_progress: Some(&on_progress), expect: expect.clone(), check: check.as_ref(), ..Default::default() }) {
                Ok(result) => {
                    lock(&self.last_upload).insert(name.clone(), LastUpload { at: atlas_core::jsdate::now_ms(), ok: true, error: None, result: Some(result.clone()) });
                    Ok(to_value(&result))
                }
                Err(e) => {
                    // 中身が変わったので写さなかったときは、失敗として覚えない(押した画面がその場で理由を出し、確かめ直してもらう)
                    if e.downcast_ref::<UploadChangedError>().is_none() {
                        lock(&self.last_upload).insert(name.clone(), LastUpload { at: atlas_core::jsdate::now_ms(), ok: false, error: Some(format!("{e:#}")), result: None });
                    }
                    Err(e)
                }
            }
        })();
        *lock(&self.uploading) = None;
        *lock(&self.busy_with) = None;
        out_lock.release();
        match r {
            Ok(v) => Ok(send_json(200, &v)),
            Err(e) => {
                let m = format!("{e:#}");
                Err(HttpError::new(if NO_TAG.is_match(&m) { 404 } else { 409 }, m))
            }
        }
    }

    fn export_api(&self, req: &mut Req, method: &str, raw: &str) -> R<Resp> {
        if method != "POST" {
            return Err(HttpError::new(405, "この方法では使えません"));
        }
        self.check_token(req)?;
        let name = decode_uri_component(raw).map_err(|()| HttpError::new(400, "タスクタグの名前を読めません"))?;
        // 書き出しの間は out/ の印を取り、別の atlas(CLI)が集計を始めないようにする。同じ serve のジョブは busy_with で止める
        let out_lock = {
            let mut busy = lock(&self.busy_with);
            // 集計・記録の書き出し中は sessions.json や記録が書きかけのことがあるので待ってもらう
            if self.jobs.running() {
                return Err(HttpError::new(409, if self.refreshing() { REFRESHING } else { "ほかの処理が動いています。終わってから書き出してください" }));
            }
            if let Some(b) = &*busy {
                return Err(HttpError::new(409, format!("{b}最中です。終わってから書き出してください")));
            }
            if let Some(other) = running_job_in(&self.out_dir) {
                return Err(HttpError::new(409, format!("別の atlas の処理({other})が動いています。終わってから書き出してください")));
            }
            let l = acquire_out_lock(&self.out_dir, "group export", "serve").map_err(|e| HttpError::new(409, e.0))?;
            *busy = Some(format!("「{name}」を書き出している"));
            l
        };
        let log = |m: &str| (self.log)(m);
        let r = export_group(
            &GroupExportPaths { out: &self.out_dir, sessions: &self.out_dir.join("sessions.json"), judgments: &self.out_dir.join("judgments.json"), groups: &self.groups_path, turn_judgments: None },
            &name,
            &log,
        );
        *lock(&self.busy_with) = None;
        out_lock.release();
        match r {
            Ok(v) => Ok(send_json(200, &to_value(&v))),
            Err(e) => {
                let m = format!("{e:#}");
                Err(HttpError::new(if m.contains("はありません") { 404 } else { 409 }, m))
            }
        }
    }

    fn load_for_write(&self) -> R<Vec<SessionGroup>> {
        load_groups_for_write(&self.groups_path).map_err(|e| HttpError::new(409, format!("{e:#}")))
    }

    fn groups_api(&self, req: &mut Req, method: &str, target: Option<String>) -> R<Resp> {
        let save = |groups: &[SessionGroup]| save_groups(&self.groups_path, groups).map_err(HttpError::internal);
        if method == "POST" && target.is_none() {
            self.check_token(req)?;
            let body = self.json_body(req)?;
            let input = group_input(&body, false)?;
            let g = SessionGroup { name: input.name.unwrap_or_default(), note: input.note.unwrap_or_default(), ids: input.ids.unwrap_or_default() };
            let _l = lock(&self.groups_lock);
            let mut groups = self.load_for_write()?;
            if groups.iter().any(|x| x.name == g.name) {
                return Err(HttpError::new(409, format!("タスクタグ「{}」は既にあります", g.name)));
            }
            groups.push(g.clone());
            save(&groups)?;
            return Ok(send_json(201, &json!({ "group": g, "groups": groups })));
        }
        if method == "PUT"
            && let Some(target) = &target
        {
            self.check_token(req)?;
            let body = self.json_body(req)?;
            let delta = delta_input(&body)?;
            let input = group_input(&body, true)?;
            let _l = lock(&self.groups_lock);
            let mut groups = self.load_for_write()?;
            let Some(i) = groups.iter().position(|g| g.name == *target) else {
                return Err(HttpError::new(404, format!("タスクタグ「{target}」はありません")));
            };
            if let Some(n) = &input.name
                && *n != groups[i].name
                && groups.iter().any(|g| g.name == *n)
            {
                return Err(HttpError::new(409, format!("タスクタグ「{n}」は既にあります")));
            }
            let cur = &mut groups[i];
            if let Some(n) = input.name {
                cur.name = n;
            }
            if let Some(n) = input.note {
                cur.note = n;
            }
            if let Some(ids) = input.ids {
                cur.ids = ids;
            }
            let (mut added, mut dup, mut removed) = (0, 0, 0);
            if let Some((add, remove)) = delta {
                let a = add_ids(cur, add.iter().map(String::as_str));
                added = a.added;
                dup = a.dup;
                let (g, r) = remove_ids(&a.group, remove.iter().map(String::as_str));
                removed = r;
                cur.ids = g.ids;
            }
            let cur = cur.clone();
            save(&groups)?;
            return Ok(send_json(200, &json!({ "group": cur, "groups": groups, "added": added, "dup": dup, "removed": removed })));
        }
        if method == "DELETE"
            && let Some(target) = &target
        {
            self.check_token(req)?;
            let _l = lock(&self.groups_lock);
            let mut groups = self.load_for_write()?;
            let Some(i) = groups.iter().position(|g| g.name == *target) else {
                return Err(HttpError::new(404, format!("タスクタグ「{target}」はありません")));
            };
            groups.remove(i);
            save(&groups)?;
            return Ok(send_json(200, &json!({ "groups": groups })));
        }
        Err(HttpError::new(405, "この方法では使えません"))
    }

    // ---------- 静的ファイル ----------

    fn serve_static(&self, req: &mut Req, path: &str) -> R<Resp> {
        if let Some(c) = VIEW_PAGE.captures(path) {
            let raw = c[1].to_string();
            return self.view_shell(req, &raw);
        }
        if path == "/" {
            return Ok(Resp { status: 302, headers: vec![("location", "/atlas.html".into())], body: Bytes::new() });
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
                Bytes::new()
            } else {
                let text = std::fs::read(&file).map_err(HttpError::internal)?;
                Bytes::from(String::from_utf8_lossy(&text).replacen(TOKEN_PLACEHOLDER, &self.token, 1))
            };
            return Ok(Resp { status: 200, headers, body });
        }
        let mut headers = vec![("content-type", ctype.to_string()), ("content-length", st.len().to_string()), ("cache-control", "no-store".into())];
        headers.extend(FILE_HEADERS.iter().map(|(k, v)| (*k, v.to_string())));
        // HEAD でも本文を渡す(hyper は HEAD には本文を送らず、大きさだけ content-length で返す)
        let body = Bytes::from(std::fs::read(&file).map_err(HttpError::internal)?);
        Ok(Resp { status: 200, headers, body })
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
static GROUP_UPLOAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/groups/([^/]+)/upload(?:/(open|check|progress))?$").unwrap());
static GROUP_EXPORT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/groups/([^/]+)/export$").unwrap());
static GROUPS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/groups(?:/(.+))?$").unwrap());
static JUDGE_PART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/judge/parts/([^/]+)$").unwrap());
static NO_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^タスクタグ「.*」はありません").unwrap());
/// フォルダ名として読める(. / \ ~ と空白だけではない)
static VAULT_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"[^./\\~{}]", &js::RE_S[1..js::RE_S.len() - 1])).unwrap());
static CLIENT_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9-]{1,64}$").unwrap());

fn js_resp(text: &str) -> Resp {
    Resp {
        status: 200,
        headers: vec![("content-type", "text/javascript; charset=utf-8".into()), ("cache-control", "no-store".into()), ("x-atlas-serve", "1".into()), (NOSNIFF.0, NOSNIFF.1.into())],
        body: Bytes::from(text.to_string()),
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

/// 別のフォルダ(送り先など)を開いた画面は読むだけ。タスクタグとメモは送った人が付けたものを出し、ここでは書き換えない。
/// 断るのは、タスクタグ(付け外し・作る・消す・書き出し・アップロード)・メモ・アップロード先・まとめて送る印。
/// 集計し直す・判定(手元の出力先に書くだけで、送り先は書き換えない)・設定・別のフォルダを開く操作は使える
fn blocked_when_read_only(path: &str, method: &str) -> bool {
    if method == "GET" || method == "HEAD" {
        return false;
    }
    path == "/api/groups" || path.starts_with("/api/groups/") || path.starts_with("/api/memos/") || path == "/api/upload-root" || path == "/api/upload-projects"
}

fn id_list(v: &Value, key: &str) -> R<Vec<String>> {
    match v {
        Value::Array(a) if a.iter().all(Value::is_string) => Ok(unique_ids(a.iter().filter_map(Value::as_str))),
        _ => Err(HttpError::new(400, format!("{key} は文字列の配列です"))),
    }
}

/// PUT の差分: { add, remove }。ids(全置換)と同時には使えない(400)。
/// 画面は差分だけを送り、サーバが読み直した最新の ids に適用する(画面を開いたまま CLI で足した id が消えない)
fn delta_input(body: &Map<String, Value>) -> R<Option<(Vec<String>, Vec<String>)>> {
    if !body.contains_key("add") && !body.contains_key("remove") {
        return Ok(None);
    }
    if body.contains_key("ids") {
        return Err(HttpError::new(400, "ids と add / remove は同時に指定できません"));
    }
    let add = match body.get("add") {
        None => vec![],
        Some(v) => id_list(v, "add")?,
    };
    let remove = match body.get("remove") {
        None => vec![],
        Some(v) => id_list(v, "remove")?,
    };
    Ok(Some((add, remove)))
}

#[derive(Default)]
struct GroupInput {
    name: Option<String>,
    note: Option<String>,
    ids: Option<Vec<String>>,
}

fn group_input(body: &Map<String, Value>, partial: bool) -> R<GroupInput> {
    let mut out = GroupInput::default();
    if body.contains_key("name") || !partial {
        let name = body.get("name").and_then(Value::as_str).map(js::trim).unwrap_or("").to_string();
        if name.is_empty() {
            return Err(HttpError::new(400, "名前を入れてください"));
        }
        if js::utf16_len(&name) > 100 {
            return Err(HttpError::new(400, "名前は 100 文字までです"));
        }
        out.name = Some(name);
    }
    match body.get("note") {
        Some(Value::String(n)) => out.note = Some(js::trim(n).to_string()),
        Some(_) => return Err(HttpError::new(400, "note は文字列です")),
        None if !partial => out.note = Some(String::new()),
        None => {}
    }
    if body.contains_key("ids") || !partial {
        out.ids = Some(match body.get("ids") {
            Some(Value::Array(a)) if a.iter().all(Value::is_string) => unique_ids(a.iter().filter_map(Value::as_str)),
            _ => return Err(HttpError::new(400, "ids は文字列の配列です")),
        });
    }
    Ok(out)
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
