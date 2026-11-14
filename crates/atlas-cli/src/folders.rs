//! 「別のフォルダを開く」(packages/cli/src/folders.ts の移植。ライブラリの部分。atlas open と serve の画面から使う)。
//! いつもの集計(この PC の Copilot のデータ → out/)とは別に、選んだフォルダを集計して別のタブで開く。
//! フォルダごとの出力先と状態は <いつもの out>-folders/<キー>/ に置き、いつもの out/ には混ぜない(1 つの出力先に 1 つのサーバ)。
//!   <キー>/folder.json … 開いたフォルダと、今の状態(集計中・表示中・失敗)。画面の一覧はこれを読む
//!   <キー>/open.log    … 画面から開いたときの、集計の出力(進み具合と失敗の理由)
//!   <キー>/out/        … 集計の出力先(atlas.html など)
//!   <キー>/built.json  … 前に集計したときの入力の印(open-reuse)
//! メモとタスクタグは <notes-dir>/folders/<キー>/ に分ける。設定ファイル(atlas.config.json)には書かない。
//! TODO(段 5): open コマンドと serve の API(GET/POST /api/folders)はここの関数を使って移す。

use crate::jobs::{alive, JOB_ENV, JOB_LOCK_FILE};
use atlas_core::js;
use atlas_core::nodepath::platform;
use atlas_core::snapshot::{describe_source, SourceShape, UPLOAD_PROBE_HINT};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

pub const FOLDER_STATE_FILE: &str = "folder.json";
pub const FOLDER_LOG_FILE: &str = "open.log";
/// 前に集計したときの入力の印(open-reuse の BUILT_FILE と同じ名前)
pub const BUILT_FILE: &str = "built.json";
/// 画面の一覧に出す数の上限(新しく開いた順)
pub const FOLDER_LIST_MAX: usize = 30;

fn resolve(p: &str) -> String {
    platform::resolve(&[p])
}

/// フォルダごとの出力先の置き場(いつもの出力先の隣。既定は <リポジトリ>/out-folders)
pub fn folders_root_of(local_out: &str) -> String {
    format!("{}-folders", resolve(local_out))
}

/// 同じフォルダかを比べる形(Windows は大文字小文字を区別しない)
fn normalized(path: &str) -> String {
    let p = resolve(path);
    if cfg!(windows) { js::to_lower(&p) } else { p }
}

/// フォルダの名前(画面に出す)。ドライブや共有の直下など、名前が取れないときはパスそのもの
pub fn folder_name(path: &str) -> String {
    let b = platform::basename(&resolve(path));
    if b.is_empty() { resolve(path) } else { b }
}

static SLUG_BAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9\x{3040}-\x{30ff}\x{3400}-\x{9fff}_-]+").unwrap());
static EDGE_DASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-+|-+$").unwrap());
static KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9\x{3040}-\x{30ff}\x{3400}-\x{9fff}_-]{1,60}$").unwrap());

/// フォルダごとの置き場の名前: <フォルダ名(40 文字まで)>-<パスのハッシュの先頭 8 桁>。同じ名前の別のフォルダを混ぜない
pub fn folder_key(path: &str) -> String {
    let base = platform::basename(&resolve(path));
    let slug = SLUG_BAD.replace_all(&base, "-");
    let slug = EDGE_DASH.replace_all(&slug, "");
    let slug = js::head(&slug, 40).into_owned();
    let slug = if slug.is_empty() { "folder".to_string() } else { slug };
    format!("{slug}-{}", &hex::encode(Sha256::digest(normalized(path).as_bytes()))[..8])
}

/// キーの形(画面から受け取ったものを、置き場の下のパスに使う前に確かめる)
pub fn is_folder_key(key: &Value) -> bool {
    key.as_str().is_some_and(|k| KEY_RE.is_match(k))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FolderPaths {
    pub key: String,
    pub dir: String,
    pub out: String,
    pub notes: String,
    pub state: String,
    pub log: String,
    /// 前に集計したときの入力の印
    pub built: String,
}

/// 別のフォルダを開いた(atlas open)ときの出力先か。<置き場>/<キー>/out で、隣に folder.json がある
pub fn is_opened_folder_out(out_dir: &str) -> bool {
    let dir = resolve(out_dir);
    platform::basename(&dir) == "out" && Path::new(&platform::join(&[&platform::dirname(&dir), FOLDER_STATE_FILE])).exists()
}

/// 読むだけの画面にするか。build(埋め込むタスクタグとメモ)とサーバ(書き換えを断るか)で同じ判定を使う。
/// 送り先から集計した(layout が flat / merged)か、別のフォルダを開いた出力先なら読むだけ
pub fn is_read_only_view(out_dir: &str, layout: Option<&str>) -> bool {
    matches!(layout, Some("flat") | Some("merged")) || is_opened_folder_out(out_dir)
}

pub fn folder_paths(root: &str, notes_base: &str, path: &str) -> FolderPaths {
    let key = folder_key(path);
    let dir = platform::join(&[&resolve(root), &key]);
    FolderPaths {
        out: platform::join(&[&dir, "out"]),
        notes: platform::join(&[&resolve(notes_base), "folders", &key]),
        state: platform::join(&[&dir, FOLDER_STATE_FILE]),
        log: platform::join(&[&dir, FOLDER_LOG_FILE]),
        built: platform::join(&[&dir, BUILT_FILE]),
        key,
        dir,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FolderRun {
    /// aggregating: 集計している / serving: 集計が済み、サーバが動いている / failed: 失敗した(error に理由)
    pub state: String,
    pub pid: u32,
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderState {
    pub version: u32,
    pub path: String,
    pub name: String,
    pub added_at: String,
    pub opened_at: String,
    /// 画面の一覧に出すか(「一覧から外す」で false。出力は消さない)
    pub listed: bool,
    pub run: Option<FolderRun>,
}

pub fn read_folder_state(file: &str) -> Option<FolderState> {
    let j = js::parse_json(&String::from_utf8_lossy(&std::fs::read(file).ok()?)).ok()?;
    let path = j.get("path").and_then(Value::as_str).filter(|p| !p.is_empty())?.to_string();
    let run = j.get("run").filter(|r| r.is_object()).and_then(|r| {
        let state = r.get("state").and_then(Value::as_str).filter(|s| ["aggregating", "serving", "failed"].contains(s))?;
        let pid = r.get("pid").and_then(Value::as_f64)?;
        Some(FolderRun {
            state: state.into(),
            pid: pid as u32,
            at: r.get("at").and_then(Value::as_str).unwrap_or("").into(),
            error: r.get("error").and_then(Value::as_str).map(str::to_string),
        })
    });
    let s = |k: &str| j.get(k).and_then(Value::as_str).map(str::to_string);
    Some(FolderState {
        version: 1,
        name: s("name").filter(|n| !n.is_empty()).unwrap_or_else(|| folder_name(&path)),
        added_at: s("addedAt").unwrap_or_default(),
        opened_at: s("openedAt").unwrap_or_default(),
        listed: j.get("listed") != Some(&Value::Bool(false)),
        run,
        path,
    })
}

pub fn write_folder_state(file: &str, s: &FolderState) -> std::io::Result<()> {
    std::fs::create_dir_all(platform::dirname(file))?;
    std::fs::write(file, format!("{}\n", atlas_core::json::to_js_string_pretty(s).map_err(std::io::Error::other)?))
}

/// 開いたことのあるフォルダ(置き場の下の folder.json)。新しく開いた順
pub fn list_folder_states(root: &str) -> Vec<(String, FolderState)> {
    let Ok(es) = atlas_core::jsfs::read_dir(Path::new(root)) else { return vec![] };
    let mut out: Vec<(String, FolderState)> = es
        .into_iter()
        .filter(|d| d.is_dir())
        .filter_map(|d| read_folder_state(&platform::join(&[root, &d.name, FOLDER_STATE_FILE])).map(|s| (d.name, s)))
        .collect();
    out.sort_by(|a, b| js::cmp_utf16(&b.1.opened_at, &a.1.opened_at).then_with(|| atlas_core::collate::locale_compare(&a.0, &b.0)));
    out
}

/// 入力の誤り(フォルダが無い・集計できるものが無いなど)。画面には status で理由を返す
#[derive(Debug, Clone)]
pub struct FolderError {
    pub message: String,
    pub status: u16,
}

impl FolderError {
    fn new(message: impl Into<String>) -> Self {
        FolderError { message: message.into(), status: 400 }
    }
}

impl std::fmt::Display for FolderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for FolderError {}

#[derive(Debug, Clone, PartialEq)]
pub struct FolderInfo {
    /// 絶対パスにしたもの
    pub path: String,
    pub name: String,
    pub shape: SourceShape,
    /// 何を読むか(画面と CLI に出す一文)
    pub summary: String,
}

/// 名前を先頭から max 個まで並べ、残りは数で出す
fn head_of(names: &[String], max: usize, unit: &str) -> String {
    let h: Vec<&str> = names.iter().take(max).map(String::as_str).collect();
    format!("{}{}", h.join("、"), if names.len() > max { format!(" ほか {} {unit}", names.len() - max) } else { String::new() })
}

/// 読むものの説明。merged は下のフォルダの数(2 段下まで読むときは、人ごとのフォルダの名前)
pub fn describe_shape(shape: &SourceShape) -> String {
    match shape {
        SourceShape::Copilot => "Copilot のデータの形のフォルダです(この中のセッションを集計します)".into(),
        SourceShape::Flat => "セッションのフォルダが並んでいます(このフォルダ 1 つを集計します)".into(),
        SourceShape::None => String::new(),
        SourceShape::Merged { folders } => {
            let nested: Vec<&String> = folders.iter().filter(|f| f.contains('/')).collect();
            if nested.is_empty() {
                return format!("下のフォルダ {} 件をまとめて集計します({})", folders.len(), head_of(folders, 3, "件"));
            }
            let mut people: Vec<String> = Vec::new();
            for f in &nested {
                let p = f[..f.find('/').unwrap_or(f.len())].to_string();
                if !people.contains(&p) {
                    people.push(p);
                }
            }
            let direct = folders.len() - nested.len();
            let under = format!("2 段下まで読み、{} 個のフォルダ({})の下にある", people.len(), head_of(&people, 5, "個"));
            if direct == 0 {
                format!("{under} {} 件のフォルダをまとめて集計します", nested.len())
            } else {
                format!("{under} {} 件と、直下の {direct} 件を合わせて、{} 件のフォルダをまとめて集計します", nested.len(), folders.len())
            }
        }
    }
}

static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r#"^"({}*)"$"#, js::RE_DOT)).unwrap());

/// 開くフォルダを確かめる(絶対パス・実在するフォルダ・集計できる形)。だめなら FolderError
pub fn check_folder(input: &Value) -> Result<FolderInfo, FolderError> {
    let Some(input) = input.as_str() else { return Err(FolderError::new("フォルダのパスを指定してください")) };
    // エクスプローラーの「パスのコピー」は "…" で囲む
    let raw = js::trim(&QUOTED.replace(js::trim(input), "$1")).to_string();
    if raw.is_empty() {
        return Err(FolderError::new("フォルダのパスを指定してください"));
    }
    if js::utf16_len(&raw) > 2000 {
        return Err(FolderError::new("パスが長すぎます"));
    }
    if !platform::is_absolute(&raw) {
        return Err(FolderError::new(format!("フルパスで指定してください(例: \\\\server\\share\\logs や D:\\logs): {raw}")));
    }
    let path = resolve(&raw);
    let is_dir = match std::fs::metadata(&path) {
        Ok(m) => m.is_dir(),
        Err(_) => return Err(FolderError::new(format!("フォルダが見つかりません(つながっていないドライブや共有フォルダかもしれません): {path}"))),
    };
    if !is_dir {
        return Err(FolderError::new(format!("フォルダではありません: {path}")));
    }
    let shape = describe_source(Path::new(&path));
    if shape == SourceShape::None {
        return Err(FolderError::new(format!(
            "このフォルダには、集計できるセッションが見つかりません: {path}(アップロード先のフォルダ・その下の人ごとのフォルダ・プロジェクトのフォルダのどれかを指定してください。読むのは 2 段下までです。{})",
            *UPLOAD_PROBE_HINT
        )));
    }
    Ok(FolderInfo { name: folder_name(&path), summary: describe_shape(&shape), path, shape })
}

/// ログの最後の、空でない行(進み具合に出す)。大きくても末尾だけ読む
pub fn last_log_line(file: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(file).ok()?;
    let size = f.metadata().ok()?.len();
    if size == 0 {
        return None;
    }
    let len = size.min(4096);
    f.seek(SeekFrom::Start(size - len)).ok()?;
    let mut buf = vec![0u8; len as usize];
    f.read_exact(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.split('\n').map(|l| js::trim(l.strip_suffix('\r').unwrap_or(l))).filter(|l| !l.is_empty()).collect();
    // 末尾だけ読んだときの先頭の行は、途中で切れていることがある
    if size > len && !lines.is_empty() {
        lines.remove(0);
    }
    lines.last().map(|l| js::head(l, 300).into_owned())
}

/// 別のプロセスで `atlas open <フォルダ>` を始める。返すのは pid(起動できなければ None)
pub type LaunchFn<'a> = &'a (dyn Fn(&[String], &str) -> Option<u32> + Sync);

/// 既定の起動: この実行ファイルを、このサーバから切り離して動かす(このサーバが止まっても、開いたフォルダのサーバは残る)。出力は open.log へ
pub fn launch_detached(args: &[String], log_file: &str) -> Option<u32> {
    let _ = std::fs::create_dir_all(platform::dirname(log_file));
    let f = std::fs::File::create(log_file).ok()?;
    let f2 = f.try_clone().ok()?;
    let exe = std::env::current_exe().ok()?;
    let mut c = std::process::Command::new(exe);
    c.args(args).env_remove(JOB_ENV).stdin(std::process::Stdio::null()).stdout(f).stderr(f2);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        c.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    }
    c.spawn().ok().map(|ch| ch.id())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub key: String,
    pub path: String,
    pub name: String,
    pub opened_at: String,
    /// current: この画面が出しているフォルダ / open: 別のタブで開いている / starting: 集計している / failed: 失敗した / idle: 開いていない
    pub status: String,
    /// 開いているレポートの URL(open のとき)
    pub url: Option<String>,
    pub error: Option<String>,
    /// 集計の進み具合(starting のとき。ログの最後の行)
    pub progress: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CurrentFolder {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LocalStatus {
    /// current: この画面 / open: 別のタブで開いている / idle: 開いていない
    pub status: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderList {
    pub can_pick: bool,
    /// この画面が出しているフォルダ(いつもの集計なら null)
    pub current: Option<CurrentFolder>,
    pub local: LocalStatus,
    pub folders: Vec<FolderEntry>,
}

pub struct FolderContext<'a> {
    /// フォルダごとの出力先の置き場
    pub root: String,
    /// いつものメモとタスクタグの置き場(フォルダごとの分は、この下の folders/<キー>/)
    pub notes_base: String,
    /// いつもの出力先
    pub local_out: String,
    /// このサーバが出しているフォルダ(いつもの集計なら None)
    pub current: Option<String>,
    pub can_pick: bool,
    /// その出力先でサーバが動いていれば、ポート
    pub find_running: &'a (dyn Fn(&str) -> Option<u16> + Sync),
    pub launch: LaunchFn<'a>,
    /// `atlas open` に足す引数(--config・--no-open)
    pub extra_args: Vec<String>,
    /// 起動の途中のキー(続けて押しても 2 つ起動しない)
    pub pending: Mutex<HashSet<String>>,
}

/// 起動してからこの時間は、プロセスがあれば動いているとみなす(集計の印を置く前・サーバが応え始める前)
const RUN_GRACE_MS: i64 = 60_000;

/// 記録にある処理(集計・配信)が、まだ動いているか。プロセスの番号は使い回されるので、番号があるだけでは動いているとみなさない
pub fn run_live(run: Option<&FolderRun>, out_dir: &str, now_ms: i64) -> bool {
    let Some(run) = run else { return false };
    if run.state == "failed" || !alive(run.pid) {
        return false;
    }
    if let Some(at) = atlas_core::jsdate::parse_ms(&run.at) {
        let age = now_ms - at;
        if (0..RUN_GRACE_MS).contains(&age) {
            return true;
        }
    }
    if run.state != "aggregating" {
        return false;
    }
    std::fs::read(platform::join(&[out_dir, JOB_LOCK_FILE]))
        .ok()
        .and_then(|t| js::parse_json(&String::from_utf8_lossy(&t)).ok())
        .and_then(|v| v.get("pid").and_then(Value::as_f64))
        .is_some_and(|p| p == run.pid as f64)
}

fn report_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/atlas.html")
}

fn entry_of(ctx: &FolderContext<'_>, key: &str, state: &FolderState) -> FolderEntry {
    let dir = platform::join(&[&ctx.root, key]);
    let base = |status: &str| FolderEntry { key: key.into(), path: state.path.clone(), name: state.name.clone(), opened_at: state.opened_at.clone(), status: status.into(), url: None, error: None, progress: None };
    if ctx.current.as_deref().is_some_and(|c| folder_key(c) == key) {
        return base("current");
    }
    let out = platform::join(&[&dir, "out"]);
    if let Some(port) = (ctx.find_running)(&out) {
        return FolderEntry { url: Some(report_url(port)), ..base("open") };
    }
    if ctx.pending.lock().unwrap().contains(key) {
        return base("starting");
    }
    let Some(run) = &state.run else { return base("idle") };
    if run.state == "failed" {
        return FolderEntry { error: Some(run.error.clone().unwrap_or_else(|| "失敗しました".into())), ..base("failed") };
    }
    if run_live(Some(run), &out, atlas_core::jsdate::now_ms()) {
        return FolderEntry { progress: if run.state == "aggregating" { last_log_line(&platform::join(&[&dir, FOLDER_LOG_FILE])) } else { None }, ..base("starting") };
    }
    if run.state == "aggregating" {
        return FolderEntry { error: Some(format!("集計が途中で止まりました(記録: {})", platform::join(&[&dir, FOLDER_LOG_FILE]))), ..base("failed") };
    }
    base("idle")
}

/// 画面の一覧: 開いたことのあるフォルダと、今の状態
pub fn list_folders(ctx: &FolderContext<'_>) -> FolderList {
    let cur_key = ctx.current.as_deref().map(folder_key);
    let folders: Vec<FolderEntry> = list_folder_states(&ctx.root)
        .into_iter()
        .filter(|(k, s)| s.listed || cur_key.as_deref() == Some(k.as_str()))
        .take(FOLDER_LIST_MAX)
        .map(|(k, s)| entry_of(ctx, &k, &s))
        .collect();
    let local = match &ctx.current {
        None => LocalStatus { status: "current".into(), url: None },
        Some(_) => match (ctx.find_running)(&ctx.local_out) {
            Some(port) => LocalStatus { status: "open".into(), url: Some(report_url(port)) },
            None => LocalStatus { status: "idle".into(), url: None },
        },
    };
    FolderList { can_pick: ctx.can_pick, current: ctx.current.as_ref().map(|c| CurrentFolder { path: c.clone(), name: folder_name(c) }), local, folders }
}

/// `atlas open <フォルダ>` の引数(実行ファイルの後ろ)。画面からの文字列はフォルダのパスだけで、確かめた後の絶対パスを 1 つの引数として渡す
pub fn open_args(local_out: &str, notes_base: &str, extra_args: &[String], path: &str) -> Vec<String> {
    let mut v: Vec<String> = ["open", path, "--out", local_out, "--notes-dir", notes_base].map(String::from).to_vec();
    v.extend(extra_args.iter().cloned());
    v
}

/// 画面の「開く」: 開いていればその URL を返し、開いていなければ別のプロセスで集計を始める
pub fn open_folder_report(ctx: &FolderContext<'_>, input: &Value) -> Result<FolderEntry, FolderError> {
    let info = check_folder(input)?;
    let fp = folder_paths(&ctx.root, &ctx.notes_base, &info.path);
    let prev = read_folder_state(&fp.state);
    let now = atlas_core::jsdate::now_iso();
    let base = FolderState {
        version: 1,
        path: info.path.clone(),
        name: info.name.clone(),
        added_at: prev.as_ref().map(|p| p.added_at.clone()).filter(|a| !a.is_empty()).unwrap_or_else(|| now.clone()),
        opened_at: now.clone(),
        listed: true,
        run: None,
    };
    let prev_run = prev.as_ref().and_then(|p| p.run.clone());
    if ctx.current.as_deref().is_some_and(|c| folder_key(c) == fp.key) || ctx.pending.lock().unwrap().contains(&fp.key) {
        return Ok(entry_of(ctx, &fp.key, &FolderState { run: prev_run, ..base }));
    }
    ctx.pending.lock().unwrap().insert(fp.key.clone());
    let r = (|| -> std::io::Result<()> {
        let running = (ctx.find_running)(&fp.out).is_some();
        let busy = !running && run_live(prev_run.as_ref(), &fp.out, atlas_core::jsdate::now_ms());
        if running || busy {
            // 開いている・集計しているものは、そのまま使う(一覧に戻し、開いた日時だけ新しくする)
            write_folder_state(&fp.state, &FolderState { run: prev_run.clone(), ..base.clone() })
        } else {
            let pid = (ctx.launch)(&open_args(&ctx.local_out, &ctx.notes_base, &ctx.extra_args, &info.path), &fp.log);
            let run = match pid {
                Some(pid) => FolderRun { state: "aggregating".into(), pid, at: now.clone(), error: None },
                None => FolderRun { state: "failed".into(), pid: 0, at: now.clone(), error: Some("集計を始められませんでした(atlas を起動できません)".into()) },
            };
            write_folder_state(&fp.state, &FolderState { run: Some(run), ..base.clone() })
        }
    })();
    ctx.pending.lock().unwrap().remove(&fp.key);
    r.map_err(|e| FolderError { message: e.to_string(), status: 500 })?;
    Ok(entry_of(ctx, &fp.key, &read_folder_state(&fp.state).unwrap_or(base)))
}

/// 画面の「一覧から外す」: 一覧に出さなくする(出力先とメモは消さない。同じフォルダを開けば戻る)
pub fn forget_folder(root: &str, key: &Value) -> Result<(), FolderError> {
    if !is_folder_key(key) {
        return Err(FolderError::new("フォルダの指定が正しくありません"));
    }
    let file = platform::join(&[root, key.as_str().unwrap_or(""), FOLDER_STATE_FILE]);
    let Some(state) = read_folder_state(&file) else { return Err(FolderError { message: "そのフォルダは一覧にありません".into(), status: 404 }) };
    write_folder_state(&file, &FolderState { listed: false, ..state }).map_err(|e| FolderError { message: e.to_string(), status: 500 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    const EVENT: &str = "{\"type\":\"session.start\",\"data\":{\"sessionId\":\"x\",\"version\":1},\"id\":\"e1\",\"timestamp\":\"2026-07-02T09:00:00.000Z\",\"parentId\":null}\n";

    fn session(at: &str) {
        fs::create_dir_all(at).unwrap();
        fs::write(platform::join(&[at, "events.jsonl"]), EVENT).unwrap();
    }

    fn dead_pid() -> u32 {
        let mut c = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" }).args(if cfg!(windows) { ["/c", "exit 0"] } else { ["-c", "exit 0"] }).spawn().unwrap();
        let id = c.id();
        c.wait().unwrap();
        id
    }

    #[test]
    fn keys_and_paths() {
        let d = tempfile::tempdir().unwrap();
        let base = d.path().to_string_lossy().into_owned();
        let a = platform::join(&[&base, "x", "logs"]);
        let b = platform::join(&[&base, "y", "logs"]);
        assert_eq!(folder_key(&a), folder_key(&a));
        assert_ne!(folder_key(&a), folder_key(&b));
        assert!(folder_key(&a).starts_with("logs-"));
        assert!(is_folder_key(&json!(folder_key(&a))));
        assert!(!is_folder_key(&json!("../x")));
        assert!(!is_folder_key(&json!(1)));
        let p = folder_paths(&platform::join(&[&base, "out-folders"]), &platform::join(&[&base, "notes"]), &a);
        assert_eq!(p.out, platform::join(&[&p.dir, "out"]));
        assert_eq!(p.notes, platform::join(&[&base, "notes", "folders", &p.key]));
        assert!(!is_read_only_view(&p.out, None));
        write_folder_state(&p.state, &FolderState { version: 1, path: a.clone(), name: "logs".into(), added_at: "t".into(), opened_at: "t".into(), listed: true, run: None }).unwrap();
        assert!(is_opened_folder_out(&p.out));
        assert!(is_read_only_view(&p.out, None));
        assert!(is_read_only_view(&base, Some("merged")));
        assert_eq!(folders_root_of(&platform::join(&[&base, "out"])), platform::join(&[&base, "out-folders"]));
    }

    #[test]
    fn check_and_describe() {
        let d = tempfile::tempdir().unwrap();
        let base = d.path().to_string_lossy().into_owned();
        let logs = platform::join(&[&base, "logs"]);
        session(&platform::join(&[&logs, "alice", "proj", "s1"]));
        session(&platform::join(&[&logs, "bob", "proj", "s2"]));
        let all = check_folder(&json!(format!("\"{logs}\""))).unwrap();
        assert!(all.summary.starts_with("2 段下まで読み、2 個のフォルダ(alice、bob)の下にある 2 件のフォルダをまとめて集計します"), "{}", all.summary);
        let one = check_folder(&json!(platform::join(&[&logs, "alice"]))).unwrap();
        assert!(one.summary.starts_with("下のフォルダ 1 件をまとめて集計します(proj)"), "{}", one.summary);
        let flat = check_folder(&json!(platform::join(&[&logs, "alice", "proj"]))).unwrap();
        assert_eq!(flat.summary, "セッションのフォルダが並んでいます(このフォルダ 1 つを集計します)");
        assert_eq!(check_folder(&json!("rel")).unwrap_err().message, "フルパスで指定してください(例: \\\\server\\share\\logs や D:\\logs): rel");
        assert_eq!(check_folder(&json!(1)).unwrap_err().message, "フォルダのパスを指定してください");
        assert!(check_folder(&json!(platform::join(&[&base, "none"]))).unwrap_err().message.starts_with("フォルダが見つかりません"));
        let empty = platform::join(&[&base, "empty"]);
        fs::create_dir(&empty).unwrap();
        assert!(check_folder(&json!(empty)).unwrap_err().message.starts_with("このフォルダには、集計できるセッションが見つかりません"));
    }

    #[test]
    fn open_list_forget() {
        let d = tempfile::tempdir().unwrap();
        let base = d.path().to_string_lossy().into_owned();
        let logs = platform::join(&[&base, "logs"]);
        session(&platform::join(&[&logs, "s1"]));
        let launched = Mutex::new(Vec::<Vec<String>>::new());
        let dead = dead_pid();
        let launch = |args: &[String], _log: &str| {
            launched.lock().unwrap().push(args.to_vec());
            Some(dead)
        };
        let none = |_: &str| None;
        let ctx = FolderContext {
            root: platform::join(&[&base, "out-folders"]),
            notes_base: platform::join(&[&base, "notes"]),
            local_out: platform::join(&[&base, "out"]),
            current: None,
            can_pick: false,
            find_running: &none,
            launch: &launch,
            extra_args: vec!["--no-open".into()],
            pending: Mutex::default(),
        };
        let e = open_folder_report(&ctx, &json!(logs)).unwrap();
        assert_eq!(launched.lock().unwrap()[0], open_args(&ctx.local_out, &ctx.notes_base, &ctx.extra_args, &logs));
        // 起動した番号のプロセスはもう無く、集計の印も無い: 途中で止まったものとして失敗にする
        assert_eq!(e.status, "failed");
        assert!(e.error.unwrap().starts_with("集計が途中で止まりました(記録: "));
        let list = list_folders(&ctx);
        assert_eq!(list.folders.len(), 1);
        assert_eq!(list.local.status, "current");
        forget_folder(&ctx.root, &json!(e.key)).unwrap();
        assert!(list_folders(&ctx).folders.is_empty());
        assert_eq!(forget_folder(&ctx.root, &json!("nope-12345678")).unwrap_err().status, 404);
        // 起動できなければ失敗を記録する
        let fail = |_: &[String], _: &str| None;
        let ctx2 = FolderContext { launch: &fail, ..ctx };
        let e = open_folder_report(&ctx2, &json!(logs)).unwrap();
        assert_eq!(e.status, "failed");
        assert_eq!(e.error.as_deref(), Some("集計を始められませんでした(atlas を起動できません)"));
    }

    #[test]
    fn live_and_last_line() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().to_string_lossy().into_owned();
        let me = std::process::id();
        let run = |state: &str, at: &str| FolderRun { state: state.into(), pid: me, at: at.into(), error: None };
        let now = atlas_core::jsdate::now_ms();
        let fresh = atlas_core::jsdate::to_iso(now - 1000);
        let old = atlas_core::jsdate::to_iso(now - 120_000);
        assert!(run_live(Some(&run("serving", &fresh)), &out, now));
        assert!(!run_live(Some(&run("serving", &old)), &out, now));
        assert!(!run_live(Some(&run("aggregating", &old)), &out, now));
        fs::write(platform::join(&[&out, JOB_LOCK_FILE]), format!("{{\"pid\":{me}}}")).unwrap();
        assert!(run_live(Some(&run("aggregating", &old)), &out, now));
        assert!(!run_live(Some(&FolderRun { pid: dead_pid(), ..run("serving", &fresh) }), &out, now));
        let log = platform::join(&[&out, "open.log"]);
        fs::write(&log, "a\n\nb\n\n").unwrap();
        assert_eq!(last_log_line(&log).as_deref(), Some("b"));
        fs::write(&log, format!("{}\n最後\n", "x".repeat(5000))).unwrap();
        assert_eq!(last_log_line(&log).as_deref(), Some("最後"));
        fs::write(&log, "").unwrap();
        assert_eq!(last_log_line(&log), None);
    }
}
