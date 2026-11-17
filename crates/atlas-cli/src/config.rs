//! 設定ファイル atlas.config.json の読み書き(packages/cli/src/config.ts の移植)。
//! wiki の指定と、依頼ごとの判定に使う普段の工程名、グループのアップロード先、upload-project.bat がまとめて送るプロジェクト、
//! 判定に使うモデル、VCS の照合の設定を持つ。
//! 書く側(modify_config・update_config)は、<設定ファイル>.lock のロックの中で読んでから書き、ほかの項目の書き方をできるだけ残す。

use crate::paths::{resolve, REPO_ROOT};
use atlas_core::js::{self, JsMap};
use atlas_core::nodepath::platform;
use atlas_core::project::os_homedir;
use atlas_core::turns::DEFAULT_PHASE_NAMES;
use atlas_core::wiki::WikiSpec;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::Path;
use std::sync::LazyLock;

pub const CONFIG_FILE: &str = "atlas.config.json";

// AI の変更の残存の状態の名前と、ログのパス → 今の場所の対応づけは core の vcs_retention.rs・vcs_step.rs のもの
use atlas_core::vcs_retention::RETENTION_STATUS_NAMES as RETENTION_STATUSES;
pub use atlas_core::vcs_step::PathMapping;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsConfig {
    pub path_map: Vec<PathMapping>,
    /// worktree / committed / fixed
    pub mode: Option<String>,
    /// mode が fixed のときの日数(1〜365。設定に無ければ省略)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lag_days: Option<i64>,
    /// 状態の名前の差し替え
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<JsMap<String>>,
    /// 画面の「AI の変更の残存」の節の説明に足す一文
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AtlasConfig {
    /// 読んだ設定ファイル。使っていなければ None
    pub path: Option<String>,
    /// 参照を数える vault。設定に無ければ None(wiki は数えない)
    pub wikis: Option<Vec<WikiSpec>>,
    /// 依頼ごとの判定(段階 2)で LLM に選ばせる普段の工程名。設定に無ければ None
    pub phases: Option<Vec<String>>,
    /// グループのアップロード先の基底フォルダ
    pub upload_root: Option<String>,
    /// upload-project.bat がまとめて送るプロジェクト
    pub upload_projects: Option<Vec<String>>,
    /// LLM の判定で Copilot CLI に渡すモデル
    pub judge_model: Option<String>,
    /// AI の変更がその後の VCS のファイルに残っているかの照合
    pub vcs: Option<VcsConfig>,
}

const KEYS: [&str; 6] = ["wikis", "phases", "uploadRoot", "uploadProjects", "judgeModel", "vcs"];
const VCS_LABEL_MAX: usize = 40;
const VCS_NOTE_MAX: usize = 1000;
const WIKI_LISTS: [&str; 4] = ["index", "pages", "extensions", "skills"];

static CONTROL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{Cc}\p{Cf}]").unwrap());
static WIN_ABS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:[\\/]").unwrap());
static TILDE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^~[\\/]").unwrap());
static WIKI_PATH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"[^./\\~{}]", &js::RE_S[1..js::RE_S.len() - 1])).unwrap());
static MODEL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r#"^[^"{}]+$"#, &js::RE_S[1..js::RE_S.len() - 1])).unwrap());
static BYOK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^[^/{s}]+/[^/{s}]+$", s = &js::RE_S[1..js::RE_S.len() - 1])).unwrap());
static QUOTED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^"([^\n\r\x{2028}\x{2029}]*)"$"#).unwrap());

type R<T> = std::result::Result<T, String>;

fn string_list(v: &Value, where_: &str) -> R<Vec<String>> {
    let err = || format!("{where_} は文字列の配列で指定してください");
    let Value::Array(a) = v else { return Err(err()) };
    a.iter().map(|x| match x {
        Value::String(s) if !js::trim(s).is_empty() => Ok(s.clone()),
        _ => Err(err()),
    })
    .collect()
}

fn is_absolute_path(p: &str) -> bool {
    platform::is_absolute(p) || WIN_ABS_RE.is_match(p)
}

/// vcs の項目。書き間違いは照合が 0 件になって気付きにくいので止める
fn parse_vcs(v: &Value) -> R<VcsConfig> {
    let Value::Object(o) = v else {
        return Err(r#"vcs はオブジェクトで指定してください(例: { "pathMap": [{ "from": "D:\\old\\repo", "to": "E:\\dev\\repo" }] })"#.into());
    };
    for k in o.keys() {
        if !["pathMap", "mode", "lagDays", "labels", "note"].contains(&k.as_str()) {
            return Err(format!("vcs の不明な項目です: {k}"));
        }
    }
    let mut labels: Option<JsMap<String>> = None;
    if let Some(l) = o.get("labels") {
        let Value::Object(lo) = l else {
            return Err(r#"vcs.labels は { "kept": "…", "modified": "…", "missing": "…", "unattributable": "…" } の形で指定してください"#.into());
        };
        let mut m = JsMap::new();
        for (k, name) in js_entries(lo) {
            if !RETENTION_STATUSES.contains(&k.as_str()) {
                return Err(format!("vcs.labels の不明な状態です: {k}({})", RETENTION_STATUSES.join(" / ")));
            }
            let ok = matches!(name, Value::String(n) if !js::trim(n).is_empty() && js::utf16_len(js::trim(n)) <= VCS_LABEL_MAX && !CONTROL_RE.is_match(n));
            if !ok {
                return Err(format!("vcs.labels.{k} には {VCS_LABEL_MAX} 文字以内の名前を指定してください"));
            }
            m.insert(k.clone(), js::trim(name.as_str().unwrap()).to_string());
        }
        labels = Some(m);
    }
    let mut note: Option<String> = None;
    if let Some(n) = o.get("note") {
        match n {
            Value::String(s) if !js::trim(s).is_empty() && js::utf16_len(s) <= VCS_NOTE_MAX => note = Some(js::trim(s).to_string()),
            _ => return Err(format!("vcs.note には {VCS_NOTE_MAX} 文字以内の文を指定してください")),
        }
    }
    let mut mode: Option<String> = None;
    if let Some(m) = o.get("mode") {
        match m {
            Value::String(s) if ["worktree", "committed", "fixed"].contains(&s.as_str()) => mode = Some(s.clone()),
            _ => return Err(r#"vcs.mode は "worktree"・"committed"・"fixed" のどれかです"#.into()),
        }
    }
    let mut lag_days: Option<i64> = None;
    if let Some(l) = o.get("lagDays") {
        match l.as_f64() {
            Some(d) if l.is_number() && d.fract() == 0.0 && (1.0..=365.0).contains(&d) => lag_days = Some(d as i64),
            _ => return Err("vcs.lagDays には 1〜365 の整数(日数)を指定してください".into()),
        }
    }
    let mut path_map = Vec::new();
    if let Some(pm) = o.get("pathMap") {
        let Value::Array(a) = pm else { return Err("vcs.pathMap は配列で指定してください".into()) };
        for (i, m) in a.iter().enumerate() {
            let where_ = format!("vcs.pathMap[{i}]");
            let Value::Object(mo) = m else { return Err(format!(r#"{where_} は {{ "from": "...", "to": "..." }} で指定してください"#)) };
            for k in mo.keys() {
                if k != "from" && k != "to" {
                    return Err(format!("{where_} の不明な項目です: {k}"));
                }
            }
            let (Some(Value::String(from)), Some(Value::String(to))) = (mo.get("from"), mo.get("to")) else {
                return Err(format!("{where_} の from と to にフォルダのパスを指定してください"));
            };
            if js::trim(from).is_empty() || js::trim(to).is_empty() {
                return Err(format!("{where_} の from と to にフォルダのパスを指定してください"));
            }
            let from = js::trim(from).to_string();
            let to = js::trim(to).to_string();
            // Windows のパスは、POSIX で集計するときもフルパスとして受け付ける
            if !is_absolute_path(&from) {
                return Err(format!("{where_}.from はフルパスで指定してください: {from}"));
            }
            if !is_absolute_path(&to) {
                return Err(format!("{where_}.to はフルパスで指定してください: {to}"));
            }
            path_map.push(PathMapping { from, to });
        }
    }
    Ok(VcsConfig { path_map, mode, lag_days: lag_days.filter(|d| *d != 0), labels, note })
}

/// `Object.entries` の順(添字の形のキーが先)
fn js_entries(o: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut idx: Vec<(u32, (&String, &Value))> = Vec::new();
    let mut rest = Vec::new();
    for (k, v) in o {
        match js::array_index(k) {
            Some(n) => idx.push((n, (k, v))),
            None => rest.push((k, v)),
        }
    }
    idx.sort_by_key(|x| x.0);
    idx.into_iter().map(|x| x.1).chain(rest).collect()
}

fn parse_wiki(v: &Value, i: usize) -> R<WikiSpec> {
    let where_ = format!("wikis[{i}]");
    if let Value::String(s) = v {
        let mut o = Map::new();
        o.insert("path".into(), Value::String(s.clone()));
        return parse_wiki(&Value::Object(o), i);
    }
    let Value::Object(o) = v else { return Err(format!("{where_} は文字列かオブジェクトで指定してください")) };
    for k in o.keys() {
        if k != "path" && !WIKI_LISTS.contains(&k.as_str()) {
            return Err(format!("{where_} の不明な項目です: {k}"));
        }
    }
    let path = match o.get("path") {
        Some(Value::String(p)) if WIKI_PATH_RE.is_match(p) => p.clone(),
        _ => return Err(format!("{where_}.path に vault のフォルダ名かパスを指定してください")),
    };
    let path = if TILDE_RE.is_match(&path) { platform::join(&[&os_homedir(), &path[2..]]) } else { path };
    let mut spec = WikiSpec { path, ..Default::default() };
    for k in WIKI_LISTS {
        if let Some(x) = o.get(k) {
            let list = Some(string_list(x, &format!("{where_}.{k}"))?);
            match k {
                "index" => spec.index = list,
                "pages" => spec.pages = list,
                "extensions" => spec.extensions = list,
                _ => spec.skills = list,
            }
        }
    }
    Ok(spec)
}

/// 設定の中身を検査して読む(path は呼ぶ側で入れる)
pub fn parse_config(v: &Value) -> R<AtlasConfig> {
    let Value::Object(o) = v else { return Err("全体をオブジェクトにしてください".into()) };
    for k in o.keys() {
        if !KEYS.contains(&k.as_str()) {
            return Err(format!("不明な項目です: {k}"));
        }
    }
    let mut cfg = AtlasConfig::default();
    if let Some(w) = o.get("wikis") {
        let Value::Array(a) = w else { return Err("wikis は配列で指定してください".into()) };
        cfg.wikis = Some(a.iter().enumerate().map(|(i, x)| parse_wiki(x, i)).collect::<R<Vec<_>>>()?);
    }
    if let Some(p) = o.get("phases") {
        let phases: Vec<String> = string_list(p, "phases")?.iter().map(|x| js::trim(x).to_string()).collect();
        if phases.len() < 2 {
            return Err("phases は 2 つ以上指定してください".into());
        }
        let uniq: std::collections::HashSet<&String> = phases.iter().collect();
        if uniq.len() != phases.len() {
            return Err("phases に同じ名前が 2 回あります".into());
        }
        cfg.phases = Some(phases);
    }
    if let Some(u) = o.get("uploadRoot") {
        cfg.upload_root = Some(parse_upload_root(u)?);
    }
    if let Some(u) = o.get("uploadProjects") {
        // 名前は集計のプロジェクト名そのもの(前後の空白も名前のうちなので削らない)。同じ名前は 1 つにする
        let mut names: Vec<String> = Vec::new();
        for n in string_list(u, "uploadProjects")? {
            if !names.contains(&n) {
                names.push(n);
            }
        }
        cfg.upload_projects = (!names.is_empty()).then_some(names);
    }
    if let Some(m) = o.get("judgeModel") {
        match m {
            Value::String(s) if MODEL_RE.is_match(js::trim(s)) => cfg.judge_model = Some(js::trim(s).to_string()),
            _ => return Err("judgeModel にはモデル名を 1 つ指定してください(例: anthropic/claude-sonnet-5-5)".into()),
        }
    }
    if let Some(v) = o.get("vcs") {
        cfg.vcs = Some(parse_vcs(v)?);
    }
    Ok(cfg)
}

/// Copilot CLI の BYOK のモデル(<プロバイダー名>/<モデル ID>)か
pub fn is_byok_model(model: Option<&str>) -> bool {
    model.is_some_and(|m| !m.is_empty() && BYOK_RE.is_match(m))
}

/// アップロード先の基底フォルダ。フルパス(~\ で始まるものはホームから)だけを受け付ける
pub fn parse_upload_root(v: &Value) -> R<String> {
    let s = match v {
        Value::String(s) if !js::trim(s).is_empty() => s,
        _ => return Err("uploadRoot にはアップロード先のフォルダのフルパスを指定してください".into()),
    };
    let raw = QUOTED_RE.replace(js::trim(s), "$1").into_owned();
    let full = if TILDE_RE.is_match(&raw) { platform::join(&[&os_homedir(), &raw[2..]]) } else { raw.clone() };
    if !platform::is_absolute(&full) {
        return Err(format!("uploadRoot はフルパスで指定してください(例: E:\\dev\\atlas-logs): {raw}"));
    }
    Ok(resolve(&full).to_string_lossy().into_owned())
}

/// 設定ファイルの既定の場所(環境変数 ATLAS_CONFIG、無ければリポジトリ直下の atlas.config.json)
pub fn default_config_path() -> String {
    match std::env::var("ATLAS_CONFIG").ok().filter(|v| !v.is_empty()) {
        Some(p) => resolve(&p).to_string_lossy().into_owned(),
        None => REPO_ROOT.join(CONFIG_FILE).to_string_lossy().into_owned(),
    }
}

/// 設定を読む。path を明示したときだけファイルが無いと失敗し、既定の場所に無ければ設定なしで続ける
pub fn load_config(path: &str, required: bool) -> anyhow::Result<AtlasConfig> {
    if !Path::new(path).exists() {
        if required {
            anyhow::bail!("設定ファイルがありません: {path}");
        }
        return Ok(AtlasConfig::default());
    }
    let read = || -> R<AtlasConfig> {
        let text = std::fs::read(path).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&text);
        // メモ帳などが付ける BOM は取り除く
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        let v = js::parse_json(text).map_err(|e| e.to_string())?;
        parse_config(&v)
    };
    match read() {
        Ok(c) => Ok(AtlasConfig { path: Some(path.to_string()), ..c }),
        Err(e) => anyhow::bail!("設定ファイル {path} を読めません: {e}"),
    }
}

/// 依頼ごとの判定に使う普段の工程名(設定の phases、無ければ既定)
pub fn phase_names() -> anyhow::Result<Vec<String>> {
    let explicit = std::env::var_os("ATLAS_CONFIG").is_some();
    Ok(load_config(&default_config_path(), explicit)?.phases.unwrap_or_else(|| DEFAULT_PHASE_NAMES.iter().map(|s| s.to_string()).collect()))
}

/// 判定に使うモデル(設定の judgeModel、無ければ None)
pub fn judge_model_setting() -> anyhow::Result<Option<String>> {
    let explicit = std::env::var_os("ATLAS_CONFIG").is_some();
    Ok(load_config(&default_config_path(), explicit)?.judge_model)
}

/// 判定に使うモデルを決めて、どこから来たかをログに書く。指定(--model)> 設定の judgeModel > なし(Copilot の既定のモデル)。
/// 設定は copilot-cli のときだけ使う(anthropic バックエンドのモデル名は形が違う)
pub fn resolve_judge_model(explicit: Option<&str>, label: &str, log: &(dyn Fn(&str) + Sync)) -> anyhow::Result<Option<String>> {
    if let Some(e) = explicit.filter(|e| !e.is_empty()) {
        return Ok(Some(e.to_string()));
    }
    let m = judge_model_setting()?;
    match m.as_deref().filter(|m| !m.is_empty()) {
        Some(m) => log(&format!(
            "{label}: 判定に使うモデル {m}(atlas.config.json の judgeModel{})",
            if is_byok_model(Some(m)) { "。自分の API キーのモデル(BYOK)なので、Copilot の AI クレジットは使いません" } else { "" }
        )),
        None => log(&format!(
            "{label}: 注意 モデルを指定していないので、Copilot の既定のモデルで判定します(AI クレジットを使います)。自分の API キーのモデル(BYOK)を使うときは、atlas.config.json に \"judgeModel\": \"anthropic/claude-sonnet-5-5\" のように書きます"
        )),
    }
    Ok(m)
}

// ---------- 書く側 ----------

/// modify_config の関数が返す値。NoChange なら何も書かない(変わらないときに書き方を崩さないように)、Remove なら項目を消す(TS の undefined)
#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)] // NoChange は段 5 の serve(印の付け外し)が使う
pub enum ConfigEdit {
    NoChange,
    Remove,
    Set(Value),
}

/// TS 版の NO_CHANGE
#[allow(dead_code)]
pub const NO_CHANGE: ConfigEdit = ConfigEdit::NoChange;

/// ロックを取れるまで待つ長さと、落ちた処理が残したロックとみなす古さ(ms)
const LOCK_WAIT_MS: u128 = 5000;
const LOCK_STALE_MS: f64 = 10_000.0;

/// ロックを作る・消す口(テストでは一時的な失敗を起こす偽物を渡す)。windows は、一時的な失敗(EPERM・EACCES・EBUSY)を待ってやり直すか
pub(crate) struct LockOps<'a> {
    pub create: &'a dyn Fn(&Path) -> std::io::Result<()>,
    /// 消す(TS 版の rm(lock, { force: true, maxRetries: 5, retryDelay: 50 }))。書き終えた後と、古いロックを消すときに使う
    pub remove: &'a dyn Fn(&Path) -> std::io::Result<()>,
    pub windows: bool,
}

fn real_create(p: &Path) -> std::io::Result<()> {
    std::fs::OpenOptions::new().write(true).create_new(true).open(p).map(|_| ())
}

/// `rm(p, { force: true, maxRetries: 5, retryDelay: 50 })`
fn real_remove(p: &Path) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match atlas_core::jsfs::rm_force(p) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 5 && matches!(atlas_core::jsfs::code(&e).as_str(), "EBUSY" | "EMFILE" | "ENFILE" | "ENOTEMPTY" | "EPERM") => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(50 * attempt));
            }
            Err(e) => return Err(e),
        }
    }
}

fn real_lock_ops() -> LockOps<'static> {
    LockOps { create: &real_create, remove: &real_remove, windows: cfg!(windows) }
}

/// Windows で、ロックを作る・消すときに一時的に出る失敗。消したばかりのロックをほかのプログラム(ウイルス対策の検査など)がまだ
/// 開いていると、同じ名前で作るのが EPERM(削除待ち)になり、消すのが EBUSY / EPERM になる。少し待ってやり直す
fn is_transient_lock_error(e: &std::io::Error, windows: bool) -> bool {
    windows && matches!(atlas_core::jsfs::code(e).as_str(), "EPERM" | "EACCES" | "EBUSY")
}

fn lock_age_ms(lock: &Path) -> std::io::Result<f64> {
    let m = std::fs::metadata(lock)?;
    Ok(atlas_core::jsdate::now_ms() as f64 - atlas_core::jsfs::mtime_ms(&m))
}

/// 設定ファイルの書き換えを 1 つずつ行うためのロック(<設定ファイル>.lock を排他で作る)。
/// serve(画面の印・アップロード先)と upload-project.bat(送り先の選び直し)は別のプロセスから同じファイルを読んで書くので、
/// 重なると先に書いた分が消える。落ちた処理が残したロックは、古ければ消して取り直す
pub(crate) fn with_config_lock<T>(path: &str, ops: &LockOps<'_>, f: impl FnOnce() -> anyhow::Result<T>) -> anyhow::Result<T> {
    let lock = std::path::PathBuf::from(format!("{path}.lock"));
    let started = std::time::Instant::now();
    // 一時的な失敗のまま待ちきったときに出す、元の失敗
    let mut transient: Option<std::io::Error> = None;
    let pause = || std::thread::sleep(std::time::Duration::from_millis(20));
    loop {
        match (ops.create)(&lock) {
            Ok(()) => break,
            Err(e) if is_transient_lock_error(&e, ops.windows) => {
                if started.elapsed().as_millis() > LOCK_WAIT_MS {
                    return Err(e.into());
                }
                transient = Some(e);
                pause();
                continue;
            }
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e.into()),
            Err(_) => {}
        }
        match lock_age_ms(&lock) {
            Ok(age) if age > LOCK_STALE_MS => {
                // 消せなくても、すぐ取り直す
                let _ = (ops.remove)(&lock);
                continue;
            }
            Ok(_) => {}
            // 調べる間に消えた: すぐ取り直す
            Err(_) => continue,
        }
        if started.elapsed().as_millis() > LOCK_WAIT_MS {
            if let Some(t) = transient {
                return Err(t.into());
            }
            anyhow::bail!("設定ファイル {path} を別の処理が書き換えています({})。少し待ってからやり直してください", lock.display());
        }
        pause();
    }
    let r = f();
    // 書き終えた後にロックを消せなくても、書いたことは失敗にしない(残ったロックは、古くなれば次の処理が消して取り直す)
    let _ = (ops.remove)(&lock);
    r
}

/// JS の /\s/ に当たる文字か
fn js_space(c: Option<char>) -> bool {
    c.is_some_and(js::is_js_whitespace)
}

/// raw(JSON のオブジェクト)の一番外側にある "key": <値> の、名前の始まりと値の範囲(バイトの位置)。文字列と括弧の対応を見て読む。見つからなければ None。
/// 外れても、書く前に中身が狙いどおりかを確かめるので、整えて書く方に倒れる
fn top_level_span(raw: &str, key: &str) -> Option<(usize, usize, usize)> {
    let b = raw.as_bytes();
    let n = b.len();
    let at = |i: usize| -> Option<char> { raw.get(i..).and_then(|s| s.chars().next()) };
    let skip_string = |k: usize| -> usize {
        let mut j = k + 1;
        while j < n {
            if b[j] == b'\\' {
                j += 1;
            } else if b[j] == b'"' {
                return j + 1;
            }
            j += 1;
        }
        n
    };
    let skip_space = |mut k: usize| -> usize {
        while k < n && js_space(at(k)) {
            k += at(k).map_or(1, char::len_utf8);
        }
        k
    };
    let mut depth: i64 = 0;
    let mut i = 0;
    while i < n {
        let c = b[i];
        if c == b'"' {
            let close = skip_string(i);
            let colon = skip_space(close);
            let is_key = depth == 1 && b.get(colon) == Some(&b':') && raw.get(i..close).and_then(|s| js::parse_json(s).ok()).is_some_and(|v| v.as_str() == Some(key));
            if is_key {
                let start = skip_space(colon + 1);
                let mut end = start;
                match b.get(start) {
                    Some(b'"') => end = skip_string(start),
                    Some(b'[') | Some(b'{') => {
                        let mut d = 0i64;
                        while end < n {
                            if b[end] == b'"' {
                                end = skip_string(end);
                                continue;
                            }
                            if b[end] == b'[' || b[end] == b'{' {
                                d += 1;
                            } else if b[end] == b']' || b[end] == b'}' {
                                d -= 1;
                                if d == 0 {
                                    end += 1;
                                    break;
                                }
                            }
                            end += 1;
                        }
                    }
                    _ => {
                        while end < n && !(js_space(at(end)) || matches!(b[end], b',' | b'}' | b']')) {
                            end += 1;
                        }
                    }
                }
                return Some((i, start, end));
            }
            i = close;
            continue;
        }
        if c == b'{' || c == b'[' {
            depth += 1;
        } else if c == b'}' || c == b']' {
            depth -= 1;
        }
        i += 1;
    }
    None
}

/// 書き方をできるだけ残して、1 項目を差し替える・足す・消した JSON の文字列。作れなければ None
fn keep_formatting(raw: &str, cur: &Map<String, Value>, key: &str, value: Option<&Value>) -> Option<String> {
    let span = top_level_span(raw, key);
    let b = raw.as_bytes();
    let Some(value) = value else {
        let (key_start, _, end) = span?;
        // 前の区切りの , から消す。先頭の項目なら後ろの , と、その行の残りまで消す
        let (mut a, mut z) = (key_start, end);
        let before = raw[..a].trim_end_matches(js::is_js_whitespace);
        if before.ends_with(',') {
            a = before.len() - 1;
        } else {
            while a > 0 && matches!(b[a - 1], b' ' | b'\t') {
                a -= 1;
            }
            let after = raw[z..].trim_start_matches(js::is_js_whitespace);
            if after.starts_with(',') {
                z = raw.len() - after.len() + 1;
                while z < b.len() && matches!(b[z], b' ' | b'\t') {
                    z += 1;
                }
                if b.get(z) == Some(&b'\r') {
                    z += 1;
                }
                if b.get(z) == Some(&b'\n') {
                    z += 1;
                }
            }
        }
        return Some(format!("{}{}", &raw[..a], &raw[z..]));
    };
    // 値は 2 字下げの形で書く(setup.bat が書く形と同じ。文字列なら 1 行)
    let lit = atlas_core::json::to_js_string_pretty(value).ok()?.replace('\n', "\n  ");
    if cur.contains_key(key) {
        let (_, start, end) = span?;
        return Some(format!("{}{lit}{}", &raw[..start], &raw[end..]));
    }
    let end = raw.rfind('}').filter(|e| *e > 0)?;
    Some(format!("{}{}\n  \"{key}\": {lit}\n{}", js::trim_end(&raw[..end]), if cur.is_empty() { "" } else { "," }, &raw[end..]))
}

/// 一時ファイルの名前(TS 版は randomUUID。同じ時に書く他のプロセス・スレッドと重ならなければよい)
fn tmp_name(path: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{path}.{}-{nanos:x}-{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed))
}

/// 設定ファイルの 1 項目を、今の設定から決めて書き換える(読んでから書くまでをロックの中で行い、別の処理の書き換えと重ならないようにする)。
/// f は今の設定(読めた中身を検査したもの)と、書いてあるとおりの中身(~/ などを展開していないもの)を受け取り、新しい値を返す。Remove なら項目を消し、NoChange なら何も書かない。
/// 書く前に読むときと同じ検査を通す。ファイルが無ければ作る。読めない(壊れた)ファイルは上書きしない。
/// 値を差し替える・末尾に足す・消すだけで済むときは、他の項目の書き方(手で詰めた配列など)をそのまま残す。済まなければ全体を整えて書く。
/// 一時ファイルに書いてから置き換える(途中で止まっても設定ファイルが欠けない)。返すのは f の返した値
pub fn modify_config(path: &str, key: &str, f: impl FnOnce(&AtlasConfig, &Map<String, Value>) -> ConfigEdit) -> anyhow::Result<ConfigEdit> {
    modify_config_with(path, key, &real_lock_ops(), f)
}

pub(crate) fn modify_config_with(path: &str, key: &str, ops: &LockOps<'_>, f: impl FnOnce(&AtlasConfig, &Map<String, Value>) -> ConfigEdit) -> anyhow::Result<ConfigEdit> {
    with_config_lock(path, ops, || {
        let mut cur: Map<String, Value> = Map::new();
        let mut raw: Option<String> = None;
        if Path::new(path).exists() {
            let read = || -> R<(String, Map<String, Value>)> {
                let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
                let text = String::from_utf8_lossy(&bytes);
                let text = text.strip_prefix('\u{feff}').unwrap_or(&text).to_string();
                match js::parse_json(&text).map_err(|e| e.to_string())? {
                    Value::Object(o) => Ok((text, o)),
                    _ => Err("全体がオブジェクトではありません".into()),
                }
            };
            match read() {
                Ok((t, o)) => {
                    raw = Some(t);
                    cur = o;
                }
                Err(e) => anyhow::bail!("設定ファイル {path} を読めないので書き換えません({e})。setup.bat で作り直すか、手で直してください"),
            }
        }
        let parsed = parse_config(&Value::Object(cur.clone())).map_err(anyhow::Error::msg)?;
        let edit = f(&parsed, &cur);
        let value = match &edit {
            ConfigEdit::NoChange => return Ok(edit),
            ConfigEdit::Remove => None,
            ConfigEdit::Set(v) => Some(v.clone()),
        };
        let mut next = cur.clone();
        match &value {
            Some(v) => {
                next.insert(key.to_string(), v.clone());
            }
            None => {
                next.shift_remove(key);
            }
        }
        parse_config(&Value::Object(next.clone())).map_err(anyhow::Error::msg)?;
        let mut text = if next.is_empty() { "{}\n".to_string() } else { format!("{}\n", atlas_core::json::to_js_string_pretty(&next)?) };
        if let (Some(raw), false) = (&raw, next.is_empty()) {
            // 差し替えた結果が狙いどおりの中身になったときだけ使う(読み違えたら、整えて書く)
            if let Some(kept) = keep_formatting(raw, &cur, key, value.as_ref()) {
                if js::parse_json(&kept).is_ok_and(|v| v == Value::Object(next.clone())) {
                    text = kept;
                }
            }
        }
        let tmp = tmp_name(path);
        std::fs::write(&tmp, text)?;
        if let Err(e) = atlas_core::fs_retry::rename_replacing(Path::new(&tmp), Path::new(path)) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }
        Ok(edit)
    })
}

/// 設定ファイルの 1 項目だけを、決まった値に書き換える(None なら消す)。書き方の残し方とロックは modify_config と同じ
pub fn update_config(path: &str, key: &str, value: Option<Value>) -> anyhow::Result<()> {
    modify_config(path, key, |_, _| value.map_or(ConfigEdit::Remove, ConfigEdit::Set)).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn err(v: Value) -> String {
        parse_config(&v).unwrap_err()
    }

    #[test]
    fn wikis_and_phases() {
        let c = parse_config(&json!({"wikis": ["my-notes", {"path": "D:/x/v", "pages": ["wiki"], "skills": ["q"]}], "phases": [" 設計 ", "実装"]})).unwrap();
        let w = c.wikis.unwrap();
        assert_eq!(w[0].path, "my-notes");
        assert_eq!(w[1].pages.as_deref(), Some(&["wiki".to_string()][..]));
        assert_eq!(c.phases.unwrap(), vec!["設計", "実装"]);
        assert_eq!(err(json!([])), "全体をオブジェクトにしてください");
        assert_eq!(err(json!({"wiki": []})), "不明な項目です: wiki");
        assert_eq!(err(json!({"wikis": {}})), "wikis は配列で指定してください");
        assert_eq!(err(json!({"wikis": [1]})), "wikis[0] は文字列かオブジェクトで指定してください");
        assert_eq!(err(json!({"wikis": [{"path": "x", "page": []}]})), "wikis[0] の不明な項目です: page");
        assert_eq!(err(json!({"wikis": ["./"]})), "wikis[0].path に vault のフォルダ名かパスを指定してください");
        assert_eq!(err(json!({"wikis": [{"path": "x", "index": [""]}]})), "wikis[0].index は文字列の配列で指定してください");
        assert_eq!(err(json!({"phases": ["a"]})), "phases は 2 つ以上指定してください");
        assert_eq!(err(json!({"phases": ["a", " a"]})), "phases に同じ名前が 2 回あります");
    }

    #[test]
    fn other_keys() {
        let c = parse_config(&json!({"uploadProjects": ["a", "a", " b"], "judgeModel": " anthropic/claude-x "})).unwrap();
        assert_eq!(c.upload_projects.unwrap(), vec!["a", " b"]);
        assert_eq!(c.judge_model.as_deref(), Some("anthropic/claude-x"));
        assert!(is_byok_model(Some("anthropic/claude-x")));
        assert!(!is_byok_model(Some("gpt-5")));
        assert_eq!(err(json!({"judgeModel": "a b"})), "judgeModel にはモデル名を 1 つ指定してください(例: anthropic/claude-sonnet-5-5)");
        assert_eq!(err(json!({"uploadRoot": "rel\\x"})), "uploadRoot はフルパスで指定してください(例: E:\\dev\\atlas-logs): rel\\x");
        let v = parse_config(&json!({"vcs": {"pathMap": [{"from": "D:\\old", "to": "E:\\new"}], "mode": "fixed", "lagDays": 3, "labels": {"kept": " 残った "}}})).unwrap().vcs.unwrap();
        assert_eq!(v.path_map[0].to, "E:\\new");
        assert_eq!(v.lag_days, Some(3));
        assert_eq!(v.labels.unwrap()["kept"], "残った");
        assert_eq!(err(json!({"vcs": {"x": 1}})), "vcs の不明な項目です: x");
        assert_eq!(err(json!({"vcs": {"mode": "w"}})), r#"vcs.mode は "worktree"・"committed"・"fixed" のどれかです"#);
        assert_eq!(err(json!({"vcs": {"lagDays": 1.5}})), "vcs.lagDays には 1〜365 の整数(日数)を指定してください");
        assert_eq!(err(json!({"vcs": {"labels": {"gone": "x"}}})), "vcs.labels の不明な状態です: gone(kept / modified / missing / unattributable)");
        assert_eq!(err(json!({"vcs": {"pathMap": [{"from": "rel", "to": "E:\\x"}]}})), "vcs.pathMap[0].from はフルパスで指定してください: rel");
    }

    #[test]
    fn more_cases() {
        assert_eq!(parse_config(&json!({})).unwrap(), AtlasConfig::default());
        assert_eq!(parse_config(&json!({"wikis": []})).unwrap().wikis, Some(vec![]));
        let v = parse_config(&json!({"vcs": {}})).unwrap().vcs.unwrap();
        assert_eq!(serde_json::to_value(&v).unwrap(), json!({"pathMap": [], "mode": null}));
        let v = parse_config(&json!({"vcs": {"pathMap": [{"from": r" D:\old\repo ", "to": r"E:\dev\repo"}, {"from": "/home/zz/a", "to": "/srv/a"}], "mode": "committed"}})).unwrap().vcs.unwrap();
        assert_eq!(v.path_map[0], PathMapping { from: r"D:\old\repo".into(), to: r"E:\dev\repo".into() });
        assert_eq!(v.path_map[1].from, "/home/zz/a");
        assert!(err(json!({"vcs": {"lagDays": 0}})).contains("vcs.lagDays"));
        assert!(err(json!({"vcs": {"labels": {"kept": ""}}})).contains("vcs.labels.kept"));
        assert!(err(json!({"vcs": {"labels": {"kept": "x".repeat(41)}}})).contains("40 文字"));
        assert!(err(json!({"vcs": {"note": 1}})).contains("vcs.note"));
        assert!(err(json!({"vcs": {"pathMap": [{"from": r"D:\x"}]}})).contains("from と to"));
        assert!(err(json!({"vcs": {"pathMap": [{"from": r"D:\x", "to": r"E:\y", "note": 1}]}})).contains("不明な項目"));
        for bad in [json!(""), json!(1)] {
            assert!(err(json!({ "uploadRoot": bad })).contains("uploadRoot"));
        }
        assert!(err(json!({"uploadRoot": "atlas-logs"})).contains("フルパス"));
        let home_root = parse_config(&json!({"uploadRoot": " \"~/logs\" "})).unwrap().upload_root.unwrap();
        assert_eq!(home_root, resolve(platform::join(&[&os_homedir(), "logs"])).to_string_lossy());
        assert!(err(json!({"uploadProjects": "owner/app"})).contains("uploadProjects"));
        assert!(err(json!({"uploadProjects": ["  "]})).contains("uploadProjects"));
        for bad in [json!(""), json!("  "), json!("a b"), json!(1), Value::Null] {
            assert!(err(json!({ "judgeModel": bad })).contains("judgeModel"));
        }
        assert_eq!(parse_config(&json!({"wikis": ["~/notes"]})).unwrap().wikis.unwrap()[0].path, platform::join(&[&os_homedir(), "notes"]));
        assert!(err(json!({"wikis": "x"})).contains("配列"));
        assert!(err(json!({"wikis": [{"index": ["a"]}]})).contains("path"));
        for path in ["", ".", "/", "~", "../"] {
            assert!(err(json!({"wikis": [{ "path": path }]})).contains("path"), "{path}");
        }
    }

    #[test]
    fn load() {
        let dir = std::env::temp_dir().join(format!("atlas-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(CONFIG_FILE);
        let ps = p.to_string_lossy().into_owned();
        assert_eq!(load_config(&ps, false).unwrap(), AtlasConfig::default());
        assert_eq!(load_config(&ps, true).unwrap_err().to_string(), format!("設定ファイルがありません: {ps}"));
        std::fs::write(&p, "\u{feff}{\"wikis\":[\"v\"]}").unwrap();
        let c = load_config(&ps, true).unwrap();
        assert_eq!(c.path.as_deref(), Some(ps.as_str()));
        std::fs::write(&p, "{\"x\":1}").unwrap();
        assert_eq!(load_config(&ps, false).unwrap_err().to_string(), format!("設定ファイル {ps} を読めません: 不明な項目です: x"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------- 書く側(config.test.ts・config-lock.test.ts) ----------

    fn read(p: &std::path::Path) -> String {
        std::fs::read_to_string(p).unwrap()
    }

    fn up(p: &std::path::Path, key: &str, v: Option<Value>) -> anyhow::Result<()> {
        update_config(&p.to_string_lossy(), key, v)
    }

    #[test]
    fn update_keeps_other_items_and_rejects_bad() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("c.json");
        std::fs::write(&p, format!("\u{feff}{}", json!({ "wikis": ["notes"], "phases": ["a", "b"] }))).unwrap();
        let root = d.path().join("logs").to_string_lossy().into_owned();
        up(&p, "uploadRoot", Some(json!(root))).unwrap();
        assert_eq!(js::parse_json(&read(&p)).unwrap(), json!({ "wikis": ["notes"], "phases": ["a", "b"], "uploadRoot": root }));
        assert!(up(&p, "uploadRoot", Some(json!("relative"))).unwrap_err().to_string().contains("フルパス"));
        assert_eq!(js::parse_json(&read(&p)).unwrap()["uploadRoot"], json!(root));
        let fresh = d.path().join("new.json");
        up(&fresh, "uploadRoot", Some(json!(root))).unwrap();
        assert_eq!(js::parse_json(&read(&fresh)).unwrap(), json!({ "uploadRoot": root }));
        let broken = d.path().join("broken.json");
        std::fs::write(&broken, "{").unwrap();
        assert!(up(&broken, "uploadRoot", Some(json!(root))).unwrap_err().to_string().contains("書き換えません"));
        assert_eq!(read(&broken), "{");
        assert!(std::fs::read_dir(d.path()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn keeps_hand_formatting() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("hand.json");
        let head = "{\n  \"wikis\": [\n    {\n      \"path\": \"my-notes\",\n      \"index\": [\"README.md\", \"00-home.md\"]\n    }\n  ]";
        std::fs::write(&p, format!("{head}\n}}\n")).unwrap();
        let a = d.path().join("a \"x\"").to_string_lossy().into_owned();
        up(&p, "uploadRoot", Some(json!(a))).unwrap();
        assert_eq!(read(&p), format!("{head},\n  \"uploadRoot\": {}\n}}\n", serde_json::to_string(&a).unwrap()));
        let b = d.path().join("b$1").to_string_lossy().into_owned();
        up(&p, "uploadRoot", Some(json!(b))).unwrap();
        assert_eq!(read(&p), format!("{head},\n  \"uploadRoot\": {}\n}}\n", serde_json::to_string(&b).unwrap()));
        let e = d.path().join("empty.json");
        std::fs::write(&e, "{}").unwrap();
        up(&e, "uploadRoot", Some(json!(b))).unwrap();
        assert_eq!(js::parse_json(&read(&e)).unwrap(), json!({ "uploadRoot": b }));
        // 配列の値も、足す・差し替える・消すだけなら手で書いた他の項目の書き方を変えない(全部消えたら {})
        let q = d.path().join("arr.json");
        std::fs::write(&q, format!("{head}\n}}\n")).unwrap();
        up(&q, "uploadProjects", Some(json!(["owner/app"]))).unwrap();
        assert_eq!(read(&q), format!("{head},\n  \"uploadProjects\": [\n    \"owner/app\"\n  ]\n}}\n"));
        up(&q, "uploadProjects", Some(json!(["owner/app", "a \"]\" b"]))).unwrap();
        assert_eq!(read(&q), format!("{head},\n  \"uploadProjects\": [\n    \"owner/app\",\n    \"a \\\"]\\\" b\"\n  ]\n}}\n"));
        up(&q, "uploadProjects", None).unwrap();
        assert_eq!(read(&q), format!("{head}\n}}\n"));
        let f = d.path().join("first.json");
        std::fs::write(&f, "{\n  \"uploadProjects\": [\"x\"],\n  \"phases\": [\"a\", \"b\"]\n}\n").unwrap();
        up(&f, "uploadProjects", None).unwrap();
        assert_eq!(read(&f), "{\n  \"phases\": [\"a\", \"b\"]\n}\n");
        up(&f, "phases", None).unwrap();
        assert_eq!(read(&f), "{}\n");
    }

    #[test]
    fn modify_and_no_change() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("mod.json");
        let ps = p.to_string_lossy().into_owned();
        let hand = "{ \"uploadProjects\": [\"a\"],   \"phases\": [\"x\", \"y\"] }\n";
        std::fs::write(&p, hand).unwrap();
        let r = modify_config(&ps, "uploadProjects", |c, _| if c.upload_projects.as_ref().is_some_and(|u| u.contains(&"a".to_string())) { NO_CHANGE } else { ConfigEdit::Set(json!(["a"])) }).unwrap();
        assert_eq!(r, NO_CHANGE);
        assert_eq!(read(&p), hand);
        let r = modify_config(&ps, "uploadProjects", |c, _| {
            let mut v = c.upload_projects.clone().unwrap_or_default();
            v.push("b".into());
            ConfigEdit::Set(json!(v))
        })
        .unwrap();
        assert_eq!(r, ConfigEdit::Set(json!(["a", "b"])));
        assert_eq!(js::parse_json(&read(&p)).unwrap(), json!({ "uploadProjects": ["a", "b"], "phases": ["x", "y"] }));
        std::fs::write(&p, "{ 壊れた").unwrap();
        assert!(modify_config(&ps, "uploadProjects", |_, _| ConfigEdit::Set(json!(["c"]))).unwrap_err().to_string().contains("書き換えません"));
        assert_eq!(read(&p), "{ 壊れた");
        assert!(!std::path::Path::new(&format!("{ps}.lock")).exists());
    }

    #[test]
    fn lock_serializes_writers_and_handles_stale_locks() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("lock.json");
        let ps = p.to_string_lossy().into_owned();
        std::fs::write(&p, "{}").unwrap();
        let names: Vec<String> = (0..12).map(|i| format!("p{i}")).collect();
        std::thread::scope(|s| {
            for n in &names {
                let ps = ps.clone();
                s.spawn(move || {
                    modify_config(&ps, "uploadProjects", |c, _| {
                        let mut v = c.upload_projects.clone().unwrap_or_default();
                        v.push(n.clone());
                        ConfigEdit::Set(json!(v))
                    })
                    .unwrap()
                });
            }
        });
        let mut got: Vec<String> = serde_json::from_value(js::parse_json(&read(&p)).unwrap()["uploadProjects"].clone()).unwrap();
        got.sort();
        let mut want = names.clone();
        want.sort();
        assert_eq!(got, want);
        let lock = std::path::PathBuf::from(format!("{ps}.lock"));
        assert!(!lock.exists());
        // 落ちた処理が残した古いロック(10 秒より前)は消して取り直す
        std::fs::write(&lock, "").unwrap();
        let old = atlas_core::jsdate::now_ms() - 60_000;
        atlas_core::jsfs::utimes(&lock, old, old).unwrap();
        let dir = d.path().to_string_lossy().into_owned();
        up(&p, "uploadRoot", Some(json!(dir))).unwrap();
        assert_eq!(js::parse_json(&read(&p)).unwrap()["uploadRoot"], json!(dir));
        assert!(!lock.exists());
        // 新しいロック(別の処理が書いている最中)は、消えるまで待ってから書く
        std::fs::write(&lock, "").unwrap();
        let l2 = lock.clone();
        let h = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            std::fs::remove_file(&l2).unwrap();
        });
        let t = std::time::Instant::now();
        up(&p, "uploadProjects", Some(json!(["after"]))).unwrap();
        assert!(t.elapsed() >= std::time::Duration::from_millis(150));
        h.join().unwrap();
        assert_eq!(js::parse_json(&read(&p)).unwrap()["uploadProjects"], json!(["after"]));
    }

    fn eperm() -> std::io::Error {
        #[cfg(windows)]
        let e = std::io::Error::from_raw_os_error(5);
        #[cfg(not(windows))]
        let e = std::io::Error::from_raw_os_error(1);
        e
    }

    #[test]
    fn transient_lock_errors_on_windows() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("c.json");
        let ps = p.to_string_lossy().into_owned();
        std::fs::write(&p, "{}").unwrap();
        let failing = |n: &AtomicUsize| n.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |x| x.checked_sub(1)).is_ok();
        // ロックを作るのが一時的に EPERM(削除待ち)になっても、待って取り直す
        let fail_open = AtomicUsize::new(5);
        let create = |l: &Path| if failing(&fail_open) { Err(eperm()) } else { real_create(l) };
        let ops = LockOps { create: &create, remove: &real_remove, windows: true };
        modify_config_with(&ps, "uploadProjects", &ops, |_, _| ConfigEdit::Set(json!(["a"]))).unwrap();
        assert_eq!(fail_open.load(Ordering::SeqCst), 0);
        assert_eq!(js::parse_json(&read(&p)).unwrap()["uploadProjects"], json!(["a"]));
        assert!(!Path::new(&format!("{ps}.lock")).exists());
        // 書き終えた後にロックを消せなくても失敗にしない。残ったロックは古くなれば次の書き換えが消して取り直す
        let fail_rm = AtomicUsize::new(1);
        let remove = |l: &Path| if failing(&fail_rm) { Err(eperm()) } else { real_remove(l) };
        let ops = LockOps { create: &real_create, remove: &remove, windows: true };
        modify_config_with(&ps, "uploadProjects", &ops, |_, _| ConfigEdit::Set(json!(["a"]))).unwrap();
        let lock = format!("{ps}.lock");
        assert!(Path::new(&lock).exists());
        let old = atlas_core::jsdate::now_ms() - 60_000;
        atlas_core::jsfs::utimes(Path::new(&lock), old, old).unwrap();
        modify_config_with(&ps, "uploadProjects", &ops, |_, _| ConfigEdit::Set(json!(["b"]))).unwrap();
        assert_eq!(js::parse_json(&read(&p)).unwrap()["uploadProjects"], json!(["b"]));
        assert!(!Path::new(&lock).exists());
        // Windows でなければ、EPERM は本当に書けないものとして、すぐに失敗にする
        let fail_open = AtomicUsize::new(1);
        let create = |l: &Path| if failing(&fail_open) { Err(eperm()) } else { real_create(l) };
        let ops = LockOps { create: &create, remove: &real_remove, windows: false };
        let e = modify_config_with(&ps, "uploadProjects", &ops, |_, _| ConfigEdit::Set(json!(["c"]))).unwrap_err();
        assert!(e.downcast_ref::<std::io::Error>().is_some());
        assert_eq!(js::parse_json(&read(&p)).unwrap()["uploadProjects"], json!(["b"]));
    }
}
