//! 設定ファイル atlas.config.json の読み込み(packages/cli/src/config.ts の読む側の移植)。
//! wiki の指定と、依頼ごとの判定に使う普段の工程名、グループのアップロード先、upload-project.bat がまとめて送るプロジェクト、
//! 判定に使うモデル、VCS の照合の設定を持つ。
//! TODO(段 7): 書く側(modifyConfig・updateConfig・ロック・書き方を残す差し替え)は config・setup の移植で足す。

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
}
