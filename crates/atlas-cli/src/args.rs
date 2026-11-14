//! atlas コマンドの引数解釈(packages/cli/src/args.ts の移植。純関数)。
//! Node の `util.parseArgs`(strict・allowPositionals・allowNegative)と同じ受け付け方をする。

use std::collections::HashMap;
use std::fmt;

pub const COMMANDS: &[&str] = &["snapshot", "extract", "metrics", "vcs", "build", "export", "all", "bundle", "judge", "turns", "group", "memo", "serve", "open", "skill-draft"];
pub const JUDGE_ACTIONS: &[&str] = &["run", "import", "m365"];
pub const BACKEND_NAMES: &[&str] = &["copilot-cli", "anthropic"];
pub const TURNS_ACTIONS: &[&str] = &["bundle", "run", "import", "m365"];
pub const GROUP_ACTIONS: &[&str] = &["list", "add", "remove", "export", "upload"];
pub const MEMO_ACTIONS: &[&str] = &["list", "show", "set", "remove"];

#[derive(Debug, Clone, PartialEq)]
pub struct JudgeCliOptions {
    pub action: String,
    /// import するファイル
    pub file: Option<String>,
    pub backend: String,
    /// 判定に使うモデル(judge のときの --model)
    pub model: Option<String>,
    pub limit: Option<u64>,
    pub only: Option<Vec<String>>,
    pub concurrency: u64,
    pub force: bool,
    /// copilot-cli に --allow-all-tools を付けるか
    pub allow_tools: bool,
    /// 1 件あたりの制限時間(秒)
    pub timeout_sec: u64,
}

/// 依頼ごとの判定(段階 2)。run は GitHub Copilot CLI だけ(従量課金の anthropic は使わない)
#[derive(Debug, Clone, PartialEq)]
pub struct TurnsCliOptions {
    pub action: String,
    pub file: Option<String>,
    pub limit: Option<u64>,
    pub model: Option<String>,
    pub unjudged: bool,
    pub timeout_sec: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GroupCliOptions {
    pub action: String,
    pub name: Option<String>,
    pub ids: Vec<String>,
    pub note: Option<String>,
    pub to: Option<String>,
    pub force: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemoCliOptions {
    pub action: String,
    pub id: Option<String>,
    pub text: Option<String>,
    pub file: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SkillDraftOptions {
    pub index: u64,
    pub backend: String,
    pub model: Option<String>,
    pub timeout_sec: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolOutput {
    Fail,
    All,
    None,
}

impl ToolOutput {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolOutput::Fail => "fail",
            ToolOutput::All => "all",
            ToolOutput::None => "none",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CliOptions {
    pub command: String,
    pub home: Option<String>,
    pub out: Option<String>,
    pub since: Option<String>,
    pub project: Option<String>,
    pub client: Option<String>,
    pub model: Option<String>,
    pub branch: Option<String>,
    pub group: Option<String>,
    pub sessions: Option<Vec<String>>,
    pub notes_dir: Option<String>,
    pub anonymize: bool,
    pub judgments: Option<String>,
    pub bundle: Option<String>,
    pub include_empty: bool,
    pub per_part: Option<u64>,
    pub unjudged: bool,
    pub temp_dirs: Option<Vec<String>>,
    pub config: Option<String>,
    pub tool_output: ToolOutput,
    pub max_chars: Option<u64>,
    pub full: bool,
    pub snapshot_all: bool,
    pub snapshot_prune: bool,
    pub judge: Option<JudgeCliOptions>,
    pub turns: Option<TurnsCliOptions>,
    pub group_cmd: Option<GroupCliOptions>,
    pub memo_cmd: Option<MemoCliOptions>,
    pub port: Option<u64>,
    pub open: bool,
    pub target: Option<String>,
    pub pick: bool,
    pub rebuild: bool,
    /// worktree / committed / fixed
    pub vcs_mode: Option<String>,
    pub skill_draft: Option<SkillDraftOptions>,
    pub help: bool,
}

pub const USAGE: &str = include_str!("usage.txt");

#[derive(Debug, Clone, PartialEq)]
pub struct UsageError(pub String);

impl fmt::Display for UsageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for UsageError {}

fn err<T>(msg: impl Into<String>) -> Result<T, UsageError> {
    Err(UsageError(msg.into()))
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Str,
    StrMulti,
    Bool,
}

const OPTIONS: &[(&str, Kind)] = &[
    ("home", Kind::Str),
    ("out", Kind::Str),
    ("since", Kind::Str),
    ("project", Kind::Str),
    ("client", Kind::Str),
    ("model", Kind::Str),
    ("branch", Kind::Str),
    ("group", Kind::Str),
    ("session", Kind::StrMulti),
    ("notes-dir", Kind::Str),
    ("note", Kind::Str),
    ("to", Kind::Str),
    ("file", Kind::Str),
    ("anonymize", Kind::Bool),
    ("judgments", Kind::Str),
    ("bundle", Kind::Str),
    ("include-empty", Kind::Bool),
    ("per-part", Kind::Str),
    ("unjudged", Kind::Bool),
    ("temp-dir", Kind::StrMulti),
    ("config", Kind::Str),
    ("tool-output", Kind::Str),
    ("full", Kind::Bool),
    ("snapshot-all", Kind::Bool),
    ("snapshot-prune", Kind::Bool),
    ("max-chars", Kind::Str),
    ("vcs-mode", Kind::Str),
    ("backend", Kind::Str),
    ("limit", Kind::Str),
    ("only", Kind::Str),
    ("concurrency", Kind::Str),
    ("force", Kind::Bool),
    ("allow-tools", Kind::Bool),
    ("timeout", Kind::Str),
    ("port", Kind::Str),
    ("open", Kind::Bool),
    ("pick", Kind::Bool),
    ("rebuild", Kind::Bool),
    ("help", Kind::Bool),
];

/// parseArgs の結果(値を指定されたものだけ入る)
#[derive(Default)]
struct Values {
    strs: HashMap<&'static str, String>,
    multi: HashMap<&'static str, Vec<String>>,
    bools: HashMap<&'static str, bool>,
}

impl Values {
    fn s(&self, k: &str) -> Option<&String> {
        self.strs.get(k)
    }
    fn has(&self, k: &str) -> bool {
        self.strs.contains_key(k)
    }
    fn b(&self, k: &str, default: bool) -> bool {
        self.bools.get(k).copied().unwrap_or(default)
    }
}

fn lookup(name: &str) -> Option<(&'static str, Kind)> {
    OPTIONS.iter().find(|(n, _)| *n == name).copied()
}

/// Node の util.parseArgs(strict: true, allowPositionals: true, allowNegative: true)
fn parse_args(argv: &[String]) -> Result<(Values, Vec<String>), UsageError> {
    let mut values = Values::default();
    let mut positionals = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let arg = &argv[i];
        i += 1;
        if arg == "--" {
            positionals.extend(argv[i..].iter().cloned());
            break;
        }
        if arg.starts_with("--") {
            let body = &arg[2..];
            let (name, inline) = match body.find('=') {
                Some(p) => (&body[..p], Some(body[p + 1..].to_string())),
                None => (body, None),
            };
            if let Some((key, kind)) = lookup(name) {
                match kind {
                    Kind::Bool => {
                        if inline.is_some() {
                            return err(format!("Option '--{name}' does not take an argument"));
                        }
                        values.bools.insert(key, true);
                    }
                    Kind::Str | Kind::StrMulti => {
                        let v = match inline {
                            Some(v) => v,
                            None => {
                                if i >= argv.len() {
                                    return err(format!("Option '--{name} <value>' argument missing"));
                                }
                                let v = argv[i].clone();
                                if v.starts_with('-') && v.len() > 1 {
                                    return err(format!(
                                        "Option '--{name}' argument is ambiguous.\nDid you forget to specify the option argument for '--{name}'?\nTo specify an option argument starting with a dash use '--{name}=-XYZ'."
                                    ));
                                }
                                i += 1;
                                v
                            }
                        };
                        if kind == Kind::StrMulti {
                            values.multi.entry(key).or_default().push(v);
                        } else {
                            values.strs.insert(key, v);
                        }
                    }
                }
                continue;
            }
            // allowNegative: --no-<boolean>
            if let Some(neg) = name.strip_prefix("no-") {
                if let Some((key, Kind::Bool)) = lookup(neg) {
                    if inline.is_some() {
                        return err(format!("Option '--{name}' does not take an argument"));
                    }
                    values.bools.insert(key, false);
                    continue;
                }
            }
            return err(format!(
                "Unknown option '--{name}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--{name}\"'"
            ));
        }
        if arg.starts_with('-') && arg.len() > 1 {
            // 短い形は -h だけ(-hh のような束ねも -h として扱う)
            let shorts = &arg[1..];
            for ch in shorts.chars() {
                if ch == 'h' {
                    values.bools.insert("help", true);
                } else {
                    return err(format!(
                        "Unknown option '-{ch}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"-{ch}\"'"
                    ));
                }
            }
            continue;
        }
        positionals.push(arg.clone());
    }
    Ok((values, positionals))
}

/// JS の Number(v) と同じく数として読む(空文字は 0、前後の空白は無視)
fn js_number(v: &str) -> Option<f64> {
    let t = v.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return u64::from_str_radix(hex, 16).ok().map(|n| n as f64);
    }
    if t == "Infinity" || t == "+Infinity" {
        return Some(f64::INFINITY);
    }
    if t == "-Infinity" {
        return Some(f64::NEG_INFINITY);
    }
    // Rust の f64 の解釈は inf・nan などの語も受け付けるので、数字の形だけに絞る
    if !t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-')) {
        return None;
    }
    t.parse::<f64>().ok()
}

fn pos_int(v: Option<&String>, name: &str, min: u64) -> Result<Option<u64>, UsageError> {
    let Some(v) = v else { return Ok(None) };
    match js_number(v) {
        Some(n) if n.fract() == 0.0 && n.is_finite() && n >= min as f64 => Ok(Some(n as u64)),
        _ => err(format!("{name} には {min} 以上の整数を指定してください: {v}")),
    }
}

fn split_list<'a>(items: impl IntoIterator<Item = &'a String>) -> Vec<String> {
    items.into_iter().flat_map(|s| s.split(',')).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

pub fn parse_cli(argv: &[String]) -> Result<CliOptions, UsageError> {
    let (values, positionals) = parse_args(argv)?;
    let cmd = positionals.first().cloned().unwrap_or_else(|| "all".to_string());
    if !COMMANDS.contains(&cmd.as_str()) {
        return err(format!("不明なコマンドです: {cmd}"));
    }
    let extra = |from: usize| positionals[from..].join(" ");

    let mut judge = None;
    if cmd == "judge" {
        let Some(action) = positionals.get(1).cloned() else { return err("judge の後に run / import / m365 を指定してください") };
        if !JUDGE_ACTIONS.contains(&action.as_str()) {
            return err(format!("judge の不明な操作です: {action}(run / import / m365)"));
        }
        if action == "m365" {
            for k in ["only", "concurrency", "backend"] {
                if values.has(k) {
                    return err(format!("--{k} は judge m365 では使えません"));
                }
            }
            if values.b("force", false) {
                return err("--force は judge m365 では使えません(判定済みのセッションは添付ファイルに入りません)");
            }
        }
        let file = positionals.get(2).cloned();
        if action == "import" && file.is_none() {
            return err("judge import には取り込むファイルを指定してください");
        }
        let max_pos = if action == "import" { 3 } else { 2 };
        if positionals.len() > max_pos {
            return err(format!("余分な引数があります: {}", extra(max_pos)));
        }
        let backend = values.s("backend").cloned().unwrap_or_else(|| "copilot-cli".into());
        if !BACKEND_NAMES.contains(&backend.as_str()) {
            return err(format!("不明なバックエンドです: {backend}({})", BACKEND_NAMES.join(" / ")));
        }
        let only = values.s("only").map(|o| split_list([o]));
        if values.has("only") && only.as_ref().is_none_or(|o| o.is_empty()) {
            return err("--only にセッション ID を指定してください");
        }
        // JS の `values.only ? … : null`: 空文字は null
        let only = if values.s("only").is_some_and(|o| !o.is_empty()) { only } else { None };
        judge = Some(JudgeCliOptions {
            file,
            backend,
            model: values.s("model").cloned(),
            limit: pos_int(values.s("limit"), "--limit", 0)?,
            only,
            concurrency: pos_int(values.s("concurrency"), "--concurrency", 1)?.unwrap_or(1),
            force: values.b("force", false),
            allow_tools: values.b("allow-tools", true),
            // m365 は 1 ファイルの返答を待つ秒数(Think Deeper は数分かかることがあるので長め)
            timeout_sec: pos_int(values.s("timeout"), "--timeout", 1)?.unwrap_or(if action == "m365" { 900 } else { 600 }),
            action,
        });
    }
    let mut skill_draft = None;
    if cmd == "skill-draft" {
        let Some(n) = positionals.get(1) else { return err("skill-draft には候補の番号(out/insights.json の順、1 から)を指定してください") };
        let index = match js_number(n) {
            Some(v) if v.fract() == 0.0 && v.is_finite() && v >= 1.0 => v as u64,
            _ => return err(format!("候補の番号は 1 以上の整数です: {n}")),
        };
        if positionals.len() > 2 {
            return err(format!("余分な引数があります: {}", extra(2)));
        }
        let backend = values.s("backend").cloned().unwrap_or_else(|| "copilot-cli".into());
        if !BACKEND_NAMES.contains(&backend.as_str()) {
            return err(format!("不明なバックエンドです: {backend}({})", BACKEND_NAMES.join(" / ")));
        }
        skill_draft = Some(SkillDraftOptions { index, backend, model: values.s("model").cloned(), timeout_sec: pos_int(values.s("timeout"), "--timeout", 1)?.unwrap_or(600) });
    }
    let mut turns = None;
    if cmd == "turns" {
        let Some(action) = positionals.get(1).cloned() else { return err("turns の後に bundle / run / import / m365 を指定してください") };
        if !TURNS_ACTIONS.contains(&action.as_str()) {
            return err(format!("turns の不明な操作です: {action}(bundle / run / import / m365)"));
        }
        let file = positionals.get(2).cloned();
        if action == "import" && file.is_none() {
            return err("turns import には取り込むファイルを指定してください");
        }
        let max_pos = if action == "import" { 3 } else { 2 };
        if positionals.len() > max_pos {
            return err(format!("余分な引数があります: {}", extra(max_pos)));
        }
        if values.s("backend").is_some_and(|b| b != "copilot-cli") {
            return err("turns run は GitHub Copilot CLI(copilot-cli)でだけ回せます(ほかはチャットに貼る方法を使ってください)");
        }
        for k in ["only", "concurrency"] {
            if values.has(k) {
                return err(format!("--{k} は turns では使えません"));
            }
        }
        if values.b("force", false) {
            return err("--force は turns では使えません");
        }
        if action != "run" && action != "m365" {
            for k in ["limit", "model", "timeout"] {
                if values.has(k) {
                    return err(format!("--{k} は turns run と turns m365 でだけ使えます"));
                }
            }
        }
        if values.b("unjudged", false) && action != "bundle" {
            return err("--unjudged は bundle と turns bundle でだけ使えます");
        }
        turns = Some(TurnsCliOptions {
            file,
            limit: pos_int(values.s("limit"), "--limit", 0)?,
            model: values.s("model").cloned(),
            unjudged: values.b("unjudged", false),
            timeout_sec: pos_int(values.s("timeout"), "--timeout", 1)?.unwrap_or(if action == "m365" { 900 } else { 600 }),
            action,
        });
    }
    let mut group_cmd = None;
    if cmd == "group" {
        let Some(action) = positionals.get(1).cloned() else { return err("group の後に list / add / remove / export / upload を指定してください") };
        if !GROUP_ACTIONS.contains(&action.as_str()) {
            return err(format!("group の不明な操作です: {action}(list / add / remove / export / upload)"));
        }
        let name = positionals.get(2).cloned().filter(|s| !s.is_empty());
        let ids = split_list(positionals.iter().skip(3));
        if action == "list" && positionals.len() > 2 {
            return err(format!("余分な引数があります: {}", extra(2)));
        }
        if action != "list" && name.is_none() {
            return err(format!("group {action} にはグループ名を指定してください"));
        }
        if action == "add" && ids.is_empty() {
            return err("group add にはセッション id を 1 つ以上指定してください");
        }
        if matches!(action.as_str(), "remove" | "export" | "upload") && positionals.len() > 3 {
            return err(format!("余分な引数があります: {}", extra(3)));
        }
        if values.has("note") && action != "add" {
            return err("--note は group add でだけ使えます");
        }
        if values.has("to") && action != "upload" {
            return err("--to は group upload でだけ使えます");
        }
        if values.b("force", false) && action != "upload" {
            return err("--force は judge run と group upload でだけ使えます");
        }
        // JS 版は positionals[2] ?? null(空文字もそのまま)。上の検査は空文字を名前なしとして扱う
        let name = positionals.get(2).cloned();
        group_cmd = Some(GroupCliOptions { action, name, ids, note: values.s("note").cloned(), to: values.s("to").cloned(), force: values.b("force", false) });
    } else if values.has("note") {
        return err("--note は group add でだけ使えます");
    } else if values.has("to") {
        return err("--to は group upload でだけ使えます");
    }
    let mut memo_cmd = None;
    if cmd == "memo" {
        let Some(action) = positionals.get(1).cloned() else { return err("memo の後に list / show / set / remove を指定してください") };
        if !MEMO_ACTIONS.contains(&action.as_str()) {
            return err(format!("memo の不明な操作です: {action}(list / show / set / remove)"));
        }
        let id = positionals.get(2).cloned();
        let rest: Vec<String> = positionals.iter().skip(3).cloned().collect();
        if action == "list" && positionals.len() > 2 {
            return err(format!("余分な引数があります: {}", extra(2)));
        }
        if action != "list" && id.as_ref().is_none_or(|s| s.is_empty()) {
            return err(format!("memo {action} にはセッション id を指定してください"));
        }
        if action != "set" && !rest.is_empty() {
            return err(format!("余分な引数があります: {}", rest.join(" ")));
        }
        if action == "set" && rest.is_empty() && !values.has("file") {
            return err("memo set には本文か --file を指定してください");
        }
        if action == "set" && !rest.is_empty() && values.has("file") {
            return err("memo set の本文と --file は同時に指定できません");
        }
        memo_cmd = Some(MemoCliOptions { action, id, text: if rest.is_empty() { None } else { Some(rest.join(" ")) }, file: values.s("file").cloned() });
    }
    if values.has("file") && memo_cmd.as_ref().is_none_or(|m| m.action != "set") {
        return err("--file は memo set でだけ使えます");
    }
    let mut target = None;
    if cmd == "open" {
        target = positionals.get(1).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if values.b("pick", false) && positionals.len() > 1 {
            return err("open では、フォルダの指定と --pick を一緒に使えません(どちらか 1 つにしてください)");
        }
        if target.is_none() && !values.b("pick", false) {
            return err("open には、集計して開くフォルダを指定してください(例: atlas open \\\\server\\share\\logs。選ぶ画面から選ぶときは atlas open --pick)");
        }
        if positionals.len() > 2 {
            return err(format!("余分な引数があります: {}(空白を含むパスは \"…\" で囲んでください)", extra(2)));
        }
        if values.has("home") {
            return err("open では --home を使えません(開くフォルダは open の後ろに指定します)");
        }
        for k in ["judgments", "bundle"] {
            if values.has(k) {
                return err(format!("--{k} は open では使えません"));
            }
        }
    }
    if !matches!(cmd.as_str(), "judge" | "turns" | "group" | "memo" | "skill-draft") {
        if cmd != "open" && positionals.len() > 1 {
            return err(format!("コマンドは 1 つだけ指定してください: {}", positionals.join(" ")));
        }
        for k in ["backend", "limit", "only", "concurrency", "timeout"] {
            if values.has(k) {
                return err(format!("--{k} は judge run でだけ使えます"));
            }
        }
        if values.b("force", false) {
            return err("--force は judge run と group upload でだけ使えます");
        }
    }
    let tool_output = match values.s("tool-output").map(String::as_str).unwrap_or("fail") {
        "fail" => ToolOutput::Fail,
        "all" => ToolOutput::All,
        "none" => ToolOutput::None,
        other => return err(format!("--tool-output は fail / all / none のどれかです: {other}")),
    };
    if (values.has("tool-output") || values.has("max-chars")) && cmd != "export" {
        return err("--tool-output と --max-chars は export でだけ使えます");
    }
    if values.has("per-part") && cmd != "bundle" {
        return err("--per-part は bundle でだけ使えます");
    }
    if values.b("unjudged", false) && cmd != "bundle" && cmd != "turns" {
        return err("--unjudged は bundle と turns bundle でだけ使えます");
    }
    let full = values.b("full", false);
    let anonymize = values.b("anonymize", false);
    if full && cmd != "export" {
        return err("--full は export でだけ使えます");
    }
    if full && anonymize {
        return err("--full(解析用の全文記録)は --anonymize と併用できません");
    }
    // 伏せ字に対応していないコマンドで黙って無視すると、伏せたつもりの評価バンドル(依頼文の全文・パス入り)を外部へ渡してしまう
    if anonymize && !matches!(cmd.as_str(), "build" | "export" | "all") {
        return err(format!("--anonymize は build / export / all でだけ使えます({cmd} の出力は伏せ字になりません。評価バンドルを外部の LLM に渡すときは中身を確認してください)"));
    }
    if (values.b("snapshot-all", false) || values.b("snapshot-prune", false)) && !matches!(cmd.as_str(), "snapshot" | "all" | "export" | "open") {
        return err("--snapshot-all と --snapshot-prune は snapshot / all / export / open で使えます");
    }
    let vcs_mode = values.s("vcs-mode").cloned();
    if vcs_mode.is_some() && cmd != "vcs" && cmd != "all" {
        return err("--vcs-mode は vcs と all でだけ使えます");
    }
    if let Some(m) = &vcs_mode {
        if !matches!(m.as_str(), "worktree" | "committed" | "fixed") {
            return err(format!("--vcs-mode は worktree / committed / fixed のどれかです: {m}"));
        }
    }
    if values.has("config") && !matches!(cmd.as_str(), "extract" | "vcs" | "all" | "serve" | "open") && !(cmd == "group" && positionals.get(1).is_some_and(|a| a == "upload")) {
        return err("--config は extract・vcs・all・serve・open・group upload でだけ使えます");
    }
    if let Some(since) = values.s("since") {
        if atlas_core::jsdate::parse_ms(since).is_none() {
            return err(format!("--since の日時を解釈できません: {since}"));
        }
    }
    if (values.has("port") || !values.b("open", true)) && cmd != "serve" && cmd != "open" {
        return err("--port と --no-open は serve と open でだけ使えます");
    }
    if values.b("pick", false) && cmd != "open" {
        return err("--pick は open でだけ使えます");
    }
    if values.b("rebuild", false) && cmd != "open" {
        return err("--rebuild は open でだけ使えます");
    }
    let port = pos_int(values.s("port"), "--port", 0)?;
    if let Some(p) = port {
        if p > 65535 {
            return err(format!("--port は 65535 以下です: {p}"));
        }
    }
    let sessions = values.multi.get("session").map(split_list);
    if values.multi.contains_key("session") && sessions.as_ref().is_none_or(|s| s.is_empty()) {
        return err("--session にセッション id を指定してください");
    }
    if values.s("group").is_some_and(|g| g.trim().is_empty()) {
        return err("--group にグループ名を指定してください");
    }
    let temp_dirs = values.multi.get("temp-dir").filter(|v| !v.is_empty()).cloned();
    Ok(CliOptions {
        command: cmd,
        home: values.s("home").cloned(),
        out: values.s("out").cloned(),
        since: values.s("since").cloned(),
        project: values.s("project").cloned(),
        client: values.s("client").cloned(),
        model: values.s("model").cloned(),
        branch: values.s("branch").cloned(),
        group: values.s("group").map(|g| g.trim().to_string()),
        sessions,
        notes_dir: values.s("notes-dir").cloned(),
        anonymize,
        judgments: values.s("judgments").cloned(),
        bundle: values.s("bundle").cloned(),
        include_empty: values.b("include-empty", false),
        per_part: pos_int(values.s("per-part"), "--per-part", 1)?,
        unjudged: values.b("unjudged", false),
        temp_dirs,
        config: values.s("config").cloned(),
        tool_output,
        max_chars: pos_int(values.s("max-chars"), "--max-chars", 200)?,
        full,
        snapshot_all: values.b("snapshot-all", false),
        snapshot_prune: values.b("snapshot-prune", false),
        judge,
        turns,
        group_cmd,
        memo_cmd,
        port,
        open: values.b("open", true),
        target,
        pick: values.b("pick", false),
        rebuild: values.b("rebuild", false),
        vcs_mode,
        skill_draft,
        help: values.b("help", false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str]) -> Result<CliOptions, UsageError> {
        parse_cli(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn defaults_to_all() {
        let o = p(&[]).unwrap();
        assert_eq!(o.command, "all");
        assert!(o.open);
        assert_eq!(o.tool_output, ToolOutput::Fail);
    }

    #[test]
    fn parses_common_options() {
        let o = p(&["extract", "--home", "h", "--out=o", "--session", "a,b", "--session", " c ", "--temp-dir", "t"]).unwrap();
        assert_eq!(o.home.as_deref(), Some("h"));
        assert_eq!(o.out.as_deref(), Some("o"));
        assert_eq!(o.sessions, Some(vec!["a".into(), "b".into(), "c".into()]));
        assert_eq!(o.temp_dirs, Some(vec!["t".into()]));
    }

    #[test]
    fn judge_and_errors() {
        let o = p(&["judge", "run", "--limit", "3", "--no-allow-tools"]).unwrap();
        let j = o.judge.unwrap();
        assert_eq!(j.limit, Some(3));
        assert!(!j.allow_tools);
        assert_eq!(j.timeout_sec, 600);
        assert_eq!(p(&["judge", "m365"]).unwrap().judge.unwrap().timeout_sec, 900);
        assert_eq!(p(&["nope"]).unwrap_err().0, "不明なコマンドです: nope");
        assert_eq!(p(&["build", "--limit", "1"]).unwrap_err().0, "--limit は judge run でだけ使えます");
        assert_eq!(p(&["judge", "run", "--limit", "1.5"]).unwrap_err().0, "--limit には 0 以上の整数を指定してください: 1.5");
        assert!(p(&["build", "--bogus"]).unwrap_err().0.starts_with("Unknown option '--bogus'"));
        assert_eq!(p(&["build", "--since", "yesterday"]).unwrap_err().0, "--since の日時を解釈できません: yesterday");
        assert!(p(&["-h"]).unwrap().help);
    }

    #[test]
    fn open_and_memo() {
        let o = p(&["open", " C:\\x "]).unwrap();
        assert_eq!(o.target.as_deref(), Some("C:\\x"));
        assert_eq!(p(&["open"]).unwrap_err().0.chars().take(10).collect::<String>(), "open には、集計".chars().take(10).collect::<String>());
        let m = p(&["memo", "set", "abc", "hello", "world"]).unwrap().memo_cmd.unwrap();
        assert_eq!(m.text.as_deref(), Some("hello world"));
    }
}
