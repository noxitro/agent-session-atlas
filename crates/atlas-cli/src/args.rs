//! atlas コマンドの引数解釈(packages/cli/src/args.ts の移植。純関数)。
//! Node の `util.parseArgs`(strict・allowPositionals・allowNegative)と同じ受け付け方をする。

use std::collections::HashMap;
use std::fmt;

pub const COMMANDS: &[&str] = &["snapshot", "extract", "metrics", "vcs", "build", "export", "all", "bundle", "judge", "turns", "memo", "tasks", "serve", "open", "skill-draft"];
pub const JUDGE_ACTIONS: &[&str] = &["import", "m365"];
/// skill-draft の --backend
pub const BACKEND_NAMES: &[&str] = &["copilot-cli", "anthropic"];
pub const TURNS_ACTIONS: &[&str] = &["bundle", "import", "m365"];
pub const MEMO_ACTIONS: &[&str] = &["list", "show", "set", "remove"];
pub const TASKS_ACTIONS: &[&str] = &["sync", "list", "link", "bundle", "import", "m365"];
/// 判定はこのツールの中では回さない(2026-11-23 に、外部の LLM に頼む形だけにした)。前の操作を指定したときの知らせ
pub const NO_IN_TOOL_JUDGING: &str = "このツールが LLM を呼んで判定する操作は無くなりました。判定は、添付ファイルをチャットに貼るか、ZIP にまとめてエージェントに渡して、外部の LLM に頼みます(画面の「判定する…」、または bundle / turns bundle / tasks bundle で作って judge import / turns import / tasks import で取り込む。docs/judge.md)";
/// --task(タスクで絞る)を使えるコマンド
pub const TASK_FILTER_COMMANDS: &[&str] = &["metrics", "build", "export", "all", "bundle", "turns", "judge"];

/// atlas judge import / m365(工数の判定の返答を取り込む・M365 Copilot のアプリで判定する)
#[derive(Debug, Clone, PartialEq)]
pub struct JudgeCliOptions {
    pub action: String,
    /// import するファイル
    pub file: Option<String>,
    /// m365: M365 Copilot のモデルの選択の名前(--model)
    pub model: Option<String>,
    /// m365: 送るファイルの数の上限
    pub limit: Option<u64>,
    /// m365: 1 ファイルの返答を待つ秒数
    pub timeout_sec: u64,
    /// judge では効かない絞り込みの指定(「--project」など)。judge は作ってある添付(out/bundle)を使うので、
    /// そのまま実行すると黙って添付の全体を扱ってしまう。指定されたら止める
    pub ignored_filters: Vec<String>,
}

/// 依頼ごとの判定: bundle(添付ファイルと ZIP を作る)/ import / m365
#[derive(Debug, Clone, PartialEq)]
pub struct TurnsCliOptions {
    pub action: String,
    pub file: Option<String>,
    pub limit: Option<u64>,
    pub model: Option<String>,
    pub unjudged: bool,
    pub timeout_sec: u64,
    /// import・m365 では効かない絞り込みの指定(judge と同じ。import は返答の全体を取り込み、m365 は作ってある添付を送るので、
    /// そのまま実行すると黙って全体を扱ってしまう。指定されたら止める)。bundle では空
    pub ignored_filters: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemoCliOptions {
    pub action: String,
    pub id: Option<String>,
    pub text: Option<String>,
    pub file: Option<String>,
}

/// atlas tasks(管理ツールのタスク)。bundle・import・m365 は、機械で決まらなかったセッションの紐づけを外部の LLM に頼む
#[derive(Debug, Clone, PartialEq)]
pub struct TasksCliOptions {
    pub action: String,
    /// import するファイル
    pub file: Option<String>,
    /// m365: M365 Copilot のモデルの選択の名前・送るファイルの数の上限・1 ファイルの返答を待つ秒数
    pub model: Option<String>,
    pub limit: Option<u64>,
    pub timeout_sec: u64,
    /// import・m365 では効かない絞り込みの指定(judge・turns と同じく、実行のときに断る)
    pub ignored_filters: Vec<String>,
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
    pub sessions: Option<Vec<String>>,
    /// タスクで絞る(管理ツールのタスクの ID)
    pub task: Option<String>,
    pub notes_dir: Option<String>,
    pub judgments: Option<String>,
    pub bundle: Option<String>,
    pub include_empty: bool,
    pub per_part: Option<u64>,
    pub unjudged: bool,
    /// bundle: 判定済みのセッションを n 件まで判定し直す束を作る(判定のぶれを測る。rejudge.rs)
    pub rejudge: Option<u64>,
    pub zip: bool,
    pub temp_dirs: Option<Vec<String>>,
    pub config: Option<String>,
    /// 設定のフォルダ(atlas.config.json と、管理ツールのタスクの状態・紐づけを置く共有の場所。settings_dir.rs)
    pub settings: Option<String>,
    pub tool_output: ToolOutput,
    pub max_chars: Option<u64>,
    pub full: bool,
    pub snapshot_all: bool,
    pub snapshot_prune: bool,
    pub judge: Option<JudgeCliOptions>,
    pub turns: Option<TurnsCliOptions>,
    pub memo_cmd: Option<MemoCliOptions>,
    pub tasks_cmd: Option<TasksCliOptions>,
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
    ("session", Kind::StrMulti),
    ("task", Kind::Str),
    ("notes-dir", Kind::Str),
    ("file", Kind::Str),
    ("judgments", Kind::Str),
    ("bundle", Kind::Str),
    ("include-empty", Kind::Bool),
    ("per-part", Kind::Str),
    ("unjudged", Kind::Bool),
    ("rejudge", Kind::Str),
    ("zip", Kind::Bool),
    ("temp-dir", Kind::StrMulti),
    ("config", Kind::Str),
    ("settings", Kind::Str),
    ("tool-output", Kind::Str),
    ("full", Kind::Bool),
    ("snapshot-all", Kind::Bool),
    ("snapshot-prune", Kind::Bool),
    ("max-chars", Kind::Str),
    ("vcs-mode", Kind::Str),
    ("backend", Kind::Str),
    ("limit", Kind::Str),
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

/// 判定の取り込み(import)と M365 Copilot での判定(m365)では効かない絞り込みの指定(「--session」「--project」など)。
/// judge・turns・tasks の import と m365 で使う。
/// import では --model も絞り込み(モデルで絞る)なので効かない。m365 の --model は M365 Copilot のモデルの選択
fn ignored_filters_of(values: &Values, action: &str) -> Vec<String> {
    let mut out: Vec<String> = ["project", "since", "client", "branch", "task"].iter().filter(|k| values.has(k)).map(|k| format!("--{k}")).collect();
    if values.multi.get("session").map(split_list).is_some_and(|s| !s.is_empty()) {
        out.insert(0, "--session".into());
    }
    if action == "import" && values.has("model") {
        out.push("--model".into());
    }
    out
}

pub fn parse_cli(argv: &[String]) -> Result<CliOptions, UsageError> {
    // 前の版の tasks link --llm(このツールが LLM を呼んで紐づける)は、知らないオプションとしてではなく、代わりの手順を知らせる
    if argv.iter().any(|a| a == "--llm") {
        return err(format!("--llm は無くなりました。{NO_IN_TOOL_JUDGING}"));
    }
    let (values, positionals) = parse_args(argv)?;
    let cmd = positionals.first().cloned().unwrap_or_else(|| "all".to_string());
    if !COMMANDS.contains(&cmd.as_str()) {
        return err(format!("不明なコマンドです: {cmd}"));
    }
    let extra = |from: usize| positionals[from..].join(" ");

    let mut judge = None;
    if cmd == "judge" {
        let Some(action) = positionals.get(1).cloned() else { return err("judge の後に import / m365 を指定してください") };
        if action == "run" {
            return err(format!("judge run は無くなりました。{NO_IN_TOOL_JUDGING}"));
        }
        if !JUDGE_ACTIONS.contains(&action.as_str()) {
            return err(format!("judge の不明な操作です: {action}(import / m365)"));
        }
        let file = positionals.get(2).cloned();
        if action == "import" && file.is_none() {
            return err("judge import には取り込むファイルを指定してください");
        }
        let max_pos = if action == "import" { 3 } else { 2 };
        if positionals.len() > max_pos {
            return err(format!("余分な引数があります: {}", extra(max_pos)));
        }
        if action != "m365" {
            for k in ["limit", "timeout"] {
                if values.has(k) {
                    return err(format!("--{k} は judge m365 でだけ使えます"));
                }
            }
        }
        // 絞り込みは添付を作るときのもので、judge では効かない(作ってある添付の全体を扱う)
        let ignored_filters = ignored_filters_of(&values, &action);
        judge = Some(JudgeCliOptions {
            file,
            model: values.s("model").cloned(),
            limit: pos_int(values.s("limit"), "--limit", 0)?,
            // Think Deeper は数分かかることがあるので長め
            timeout_sec: pos_int(values.s("timeout"), "--timeout", 1)?.unwrap_or(900),
            ignored_filters,
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
        let Some(action) = positionals.get(1).cloned() else { return err("turns の後に bundle / import / m365 を指定してください") };
        if action == "run" {
            return err(format!("turns run は無くなりました。{NO_IN_TOOL_JUDGING}"));
        }
        if !TURNS_ACTIONS.contains(&action.as_str()) {
            return err(format!("turns の不明な操作です: {action}(bundle / import / m365)"));
        }
        let file = positionals.get(2).cloned();
        if action == "import" && file.is_none() {
            return err("turns import には取り込むファイルを指定してください");
        }
        let max_pos = if action == "import" { 3 } else { 2 };
        if positionals.len() > max_pos {
            return err(format!("余分な引数があります: {}", extra(max_pos)));
        }
        if action != "m365" {
            for k in ["limit", "timeout"] {
                if values.has(k) {
                    return err(format!("--{k} は turns m365 でだけ使えます"));
                }
            }
        }
        if values.b("unjudged", false) && action != "bundle" {
            return err("--unjudged は bundle・turns bundle・tasks bundle でだけ使えます");
        }
        if values.b("zip", false) && action != "bundle" {
            return err("--zip は bundle・turns bundle・tasks bundle でだけ使えます");
        }
        // import・m365 では、judge と同じく絞り込みを断る(bundle では絞り込みに使う)
        let ignored_filters = if action == "bundle" { vec![] } else { ignored_filters_of(&values, &action) };
        turns = Some(TurnsCliOptions {
            file,
            limit: pos_int(values.s("limit"), "--limit", 0)?,
            model: values.s("model").cloned(),
            unjudged: values.b("unjudged", false),
            timeout_sec: pos_int(values.s("timeout"), "--timeout", 1)?.unwrap_or(900),
            ignored_filters,
            action,
        });
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
    let mut tasks_cmd = None;
    if cmd == "tasks" {
        let Some(action) = positionals.get(1).cloned() else { return err("tasks の後に sync / list / link / bundle / import / m365 を指定してください") };
        if !TASKS_ACTIONS.contains(&action.as_str()) {
            return err(format!("tasks の不明な操作です: {action}(sync / list / link / bundle / import / m365)"));
        }
        let file = positionals.get(2).cloned();
        if action == "import" && file.is_none() {
            return err("tasks import には取り込むファイルを指定してください");
        }
        let max_pos = if action == "import" { 3 } else { 2 };
        if positionals.len() > max_pos {
            return err(format!("余分な引数があります: {}", extra(max_pos)));
        }
        // import・m365 は、judge・turns と同じく絞り込みを集めて断る(実行のときに、何が起きるかと代わりの手順を知らせる)
        let collects_filters = action == "import" || action == "m365";
        let ignored_filters = if collects_filters { ignored_filters_of(&values, &action) } else { vec![] };
        if action != "bundle" && !collects_filters && values.multi.contains_key("session") {
            return err("--session は tasks bundle でだけ使えます");
        }
        for k in ["unjudged", "zip"] {
            if values.b(k, false) && action != "bundle" {
                return err(format!("--{k} は bundle・turns bundle・tasks bundle でだけ使えます"));
            }
        }
        if action != "m365" {
            for k in ["limit", "timeout", "model"] {
                // import の --model は絞り込み(モデルで絞る)として断る(ignored_filters)
                if values.has(k) && !(k == "model" && action == "import") {
                    return err(format!("--{k} は tasks m365 でだけ使えます"));
                }
            }
        }
        if !collects_filters {
            for k in ["since", "project", "client", "branch"] {
                if values.has(k) {
                    return err(format!("--{k} は tasks では使えません"));
                }
            }
        }
        tasks_cmd = Some(TasksCliOptions {
            file,
            model: values.s("model").cloned().filter(|_| action == "m365"),
            limit: pos_int(values.s("limit"), "--limit", 0)?,
            timeout_sec: pos_int(values.s("timeout"), "--timeout", 1)?.unwrap_or(900),
            ignored_filters,
            action,
        });
    }
    let tasks_collects_task = tasks_cmd.as_ref().is_some_and(|t| t.action == "import" || t.action == "m365");
    if values.has("task") && !TASK_FILTER_COMMANDS.contains(&cmd.as_str()) && !tasks_collects_task {
        return err(format!("--task は {} でだけ使えます", TASK_FILTER_COMMANDS.join("・")));
    }
    if values.s("task").is_some_and(|t| t.trim().is_empty()) {
        return err("--task にタスクの ID を指定してください");
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
    if !matches!(cmd.as_str(), "judge" | "turns" | "memo" | "tasks" | "skill-draft") {
        if cmd != "open" && positionals.len() > 1 {
            return err(format!("コマンドは 1 つだけ指定してください: {}", positionals.join(" ")));
        }
        for k in ["limit", "timeout"] {
            if values.has(k) {
                return err(format!("--{k} は judge m365・turns m365・tasks m365 でだけ使えます"));
            }
        }
    }
    if values.has("backend") && cmd != "skill-draft" {
        return err("--backend は skill-draft でだけ使えます(判定はこのツールの中では回しません)");
    }
    if values.has("limit") && cmd == "skill-draft" {
        return err("--limit は judge m365・turns m365・tasks m365 でだけ使えます");
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
    if values.has("per-part") && cmd != "bundle" && !(cmd == "tasks" && tasks_cmd.as_ref().is_some_and(|t| t.action == "bundle")) {
        return err("--per-part は bundle と tasks bundle でだけ使えます");
    }
    if values.b("unjudged", false) && !matches!(cmd.as_str(), "bundle" | "turns" | "tasks") {
        return err("--unjudged は bundle・turns bundle・tasks bundle でだけ使えます");
    }
    if values.has("rejudge") && cmd != "bundle" {
        return err("--rejudge は bundle でだけ使えます(依頼ごとの判定とタスクの紐づけには、判定し直す束はありません)");
    }
    if values.has("rejudge") && values.b("unjudged", false) {
        return err("--rejudge と --unjudged は一緒に使えません(--rejudge は判定済みのセッションだけで、--unjudged は未判定のセッションだけで束を作ります)");
    }
    let rejudge = pos_int(values.s("rejudge"), "--rejudge", 1)?;
    if let Some(n) = rejudge.filter(|n| *n > atlas_judge::rejudge::REJUDGE_MAX) {
        return err(format!("--rejudge は {} 以下です: {n}", atlas_judge::rejudge::REJUDGE_MAX));
    }
    if values.b("zip", false) && !matches!(cmd.as_str(), "bundle" | "turns" | "tasks") {
        return err("--zip は bundle・turns bundle・tasks bundle でだけ使えます");
    }
    let full = values.b("full", false);
    if full && cmd != "export" {
        return err("--full は export でだけ使えます");
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
    if values.has("config") && !matches!(cmd.as_str(), "extract" | "vcs" | "metrics" | "all" | "serve" | "open" | "tasks") {
        return err("--config は extract・vcs・metrics・all・serve・open・tasks でだけ使えます");
    }
    if values.has("settings") && !matches!(cmd.as_str(), "extract" | "vcs" | "metrics" | "build" | "export" | "all" | "bundle" | "turns" | "judge" | "serve" | "open" | "tasks") {
        return err("--settings は extract・vcs・metrics・build・export・all・bundle・turns・judge・serve・open・tasks でだけ使えます");
    }
    if values.has("settings") && values.has("config") {
        return err("--settings と --config は一緒に使えません(--settings のときは、設定のフォルダの atlas.config.json を読みます)");
    }
    if values.s("settings").is_some_and(|s| s.trim().is_empty()) {
        return err("--settings に設定のフォルダを指定してください");
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
        sessions,
        task: values.s("task").map(|t| t.trim().to_string()),
        notes_dir: values.s("notes-dir").cloned(),
        judgments: values.s("judgments").cloned(),
        bundle: values.s("bundle").cloned(),
        include_empty: values.b("include-empty", false),
        per_part: pos_int(values.s("per-part"), "--per-part", 1)?,
        unjudged: values.b("unjudged", false),
        rejudge,
        zip: values.b("zip", false),
        temp_dirs,
        config: values.s("config").cloned(),
        settings: values.s("settings").map(|s| s.trim().to_string()),
        tool_output,
        max_chars: pos_int(values.s("max-chars"), "--max-chars", 200)?,
        full,
        snapshot_all: values.b("snapshot-all", false),
        snapshot_prune: values.b("snapshot-prune", false),
        judge,
        turns,
        memo_cmd,
        tasks_cmd,
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

    /// judge では効かない絞り込みは覚えておく(実行するときに止める)
    #[test]
    fn judge_ignored_filters() {
        let j = p(&["judge", "import", "r.md", "--session", "ab12", "--project", "x"]).unwrap().judge.unwrap();
        assert_eq!(j.ignored_filters, vec!["--session", "--project"]);
        let j = p(&["judge", "m365", "--model", "Auto", "--limit", "2"]).unwrap().judge.unwrap();
        assert_eq!((j.model.as_deref(), j.limit, j.ignored_filters.is_empty(), j.timeout_sec), (Some("Auto"), Some(2), true, 900));
        assert_eq!(p(&["judge", "import", "r.md", "--model", "m"]).unwrap().judge.unwrap().ignored_filters, vec!["--model"]);
        // judge 以外では今までどおり(絞り込みとして使う)
        assert!(p(&["bundle", "--session", "ab12"]).unwrap().judge.is_none());
    }

    /// このツールの中で判定する操作(judge run・turns run・--backend など)は無い
    #[test]
    fn in_tool_judging_is_gone() {
        for args in [vec!["judge", "run"], vec!["turns", "run"]] {
            let e = p(&args).unwrap_err().0;
            assert!(e.contains("無くなりました") && e.contains("docs/judge.md"), "{e}");
        }
        assert_eq!(p(&["judge"]).unwrap_err().0, "judge の後に import / m365 を指定してください");
        for (args, want) in [
            (vec!["judge", "m365", "--backend", "copilot-cli"], "--backend は skill-draft でだけ使えます"),
            (vec!["build", "--limit", "1"], "--limit は judge m365・turns m365・tasks m365 でだけ使えます"),
            (vec!["judge", "import", "r.md", "--limit", "1"], "--limit は judge m365 でだけ使えます"),
            (vec!["turns", "bundle", "--timeout", "1"], "--timeout は turns m365 でだけ使えます"),
            (vec!["skill-draft", "1", "--limit", "1"], "--limit は judge m365・turns m365・tasks m365 でだけ使えます"),
        ] {
            assert!(p(&args).unwrap_err().0.starts_with(want), "{args:?}");
        }
        for opt in ["--only", "--force", "--concurrency", "--no-allow-tools"] {
            assert!(p(&["judge", "m365", opt]).unwrap_err().0.starts_with(&format!("Unknown option '{opt}'")), "{opt}");
        }
        assert_eq!(p(&["skill-draft", "1", "--backend", "anthropic"]).unwrap().skill_draft.unwrap().backend, "anthropic");
    }

    #[test]
    fn judge_and_errors() {
        let o = p(&["judge", "m365", "--limit", "3"]).unwrap();
        assert_eq!(o.judge.unwrap().limit, Some(3));
        assert_eq!(p(&["nope"]).unwrap_err().0, "不明なコマンドです: nope");
        assert_eq!(p(&["judge", "m365", "--limit", "1.5"]).unwrap_err().0, "--limit には 0 以上の整数を指定してください: 1.5");
        assert!(p(&["build", "--bogus"]).unwrap_err().0.starts_with("Unknown option '--bogus'"));
        assert_eq!(p(&["build", "--since", "yesterday"]).unwrap_err().0, "--since の日時を解釈できません: yesterday");
        assert!(p(&["-h"]).unwrap().help);
        // turns bundle と tasks bundle にも ZIP がある
        assert!(p(&["turns", "bundle", "--unjudged", "--zip"]).unwrap().zip);
        assert_eq!(p(&["turns", "import", "x.json", "--zip"]).unwrap_err().0, "--zip は bundle・turns bundle・tasks bundle でだけ使えます");
        assert_eq!(p(&["export", "--zip"]).unwrap_err().0, "--zip は bundle・turns bundle・tasks bundle でだけ使えます");
    }

    #[test]
    fn tasks_command_and_task_filter() {
        let t = p(&["tasks", "bundle", "--session", "ab", "--zip", "--per-part", "3", "--unjudged"]).unwrap();
        assert_eq!(t.tasks_cmd, Some(TasksCliOptions { action: "bundle".into(), file: None, model: None, limit: None, timeout_sec: 900, ignored_filters: vec![] }));
        assert_eq!((t.sessions, t.zip, t.per_part, t.unjudged), (Some(vec!["ab".into()]), true, Some(3), true));
        assert_eq!(p(&["tasks", "import", "reply.md"]).unwrap().tasks_cmd.unwrap().file.as_deref(), Some("reply.md"));
        assert_eq!(p(&["tasks", "import"]).unwrap_err().0, "tasks import には取り込むファイルを指定してください");
        let m = p(&["tasks", "m365", "--model", "Auto", "--limit", "1", "--timeout", "60"]).unwrap().tasks_cmd.unwrap();
        assert_eq!((m.model.as_deref(), m.limit, m.timeout_sec), (Some("Auto"), Some(1), 60));
        assert_eq!(p(&["tasks", "sync", "--config", "c.json"]).unwrap().config.as_deref(), Some("c.json"));
        assert_eq!(p(&["metrics", "--config", "c.json"]).unwrap().config.as_deref(), Some("c.json"));
        assert!(p(&["build", "--config", "c.json"]).unwrap_err().0.starts_with("--config は extract・vcs・metrics"));
        assert_eq!(p(&["tasks", "bundle", "--settings", " S "]).unwrap().settings.as_deref(), Some("S"));
        assert_eq!(p(&["export", "--settings", "S"]).unwrap().settings.as_deref(), Some("S"));
        assert!(p(&["memo", "list", "--settings", "S"]).unwrap_err().0.starts_with("--settings は extract・vcs・metrics・build"));
        assert_eq!(p(&["judge", "m365", "--settings", "S"]).unwrap().settings.as_deref(), Some("S"));
        assert!(p(&["open", "C:/x", "--settings", "S", "--config", "c.json"]).unwrap_err().0.starts_with("--settings と --config は一緒に使えません"));
        assert_eq!(p(&["open", "C:/x", "--settings", " "]).unwrap_err().0, "--settings に設定のフォルダを指定してください");
        assert_eq!(p(&["tasks"]).unwrap_err().0, "tasks の後に sync / list / link / bundle / import / m365 を指定してください");
        assert!(p(&["tasks", "nope"]).unwrap_err().0.starts_with("tasks の不明な操作です"));
        assert_eq!(p(&["tasks", "list", "--session", "a"]).unwrap_err().0, "--session は tasks bundle でだけ使えます");
        assert_eq!(p(&["tasks", "link", "--zip"]).unwrap_err().0, "--zip は bundle・turns bundle・tasks bundle でだけ使えます");
        assert_eq!(p(&["tasks", "link", "--per-part", "2"]).unwrap_err().0, "--per-part は bundle と tasks bundle でだけ使えます");
        assert!(p(&["tasks", "link", "--llm"]).unwrap_err().0.starts_with("--llm は無くなりました。"));
        assert_eq!(p(&["tasks", "link", "--limit", "1"]).unwrap_err().0, "--limit は tasks m365 でだけ使えます");
        assert_eq!(p(&["tasks", "bundle", "--timeout", "5"]).unwrap_err().0, "--timeout は tasks m365 でだけ使えます");
        assert_eq!(p(&["build", "--task", " T-1 "]).unwrap().task.as_deref(), Some("T-1"));
        assert_eq!(p(&["build", "--task", " "]).unwrap_err().0, "--task にタスクの ID を指定してください");
        assert!(p(&["serve", "--task", "T"]).unwrap_err().0.starts_with("--task は metrics・build"));
        // judge では効かない絞り込み(judge を直に実行したときは止める)
        assert_eq!(p(&["judge", "m365", "--task", "T"]).unwrap().judge.unwrap().ignored_filters, vec!["--task"]);
        // tasks の import・m365 も、効かない絞り込みを集めて断る(import の --model も絞り込み。m365 の --model はモデルの選択)
        let ti = p(&["tasks", "import", "r.md", "--session", "ab", "--project", "p", "--task", "T", "--model", "m"]).unwrap().tasks_cmd.unwrap();
        assert_eq!((ti.ignored_filters, ti.model), (vec!["--session".to_string(), "--project".into(), "--task".into(), "--model".into()], None));
        let tm = p(&["tasks", "m365", "--since", "2026-11-01", "--branch", "b", "--model", "Auto"]).unwrap().tasks_cmd.unwrap();
        assert_eq!((tm.ignored_filters, tm.model.as_deref()), (vec!["--since".to_string(), "--branch".into()], Some("Auto")));
        // ほかの操作はこれまでどおり、その場で断る
        assert!(p(&["tasks", "bundle", "--session", "ab"]).unwrap().tasks_cmd.unwrap().ignored_filters.is_empty());
        assert_eq!(p(&["tasks", "sync", "--project", "p"]).unwrap_err().0, "--project は tasks では使えません");
        assert!(p(&["tasks", "link", "--task", "T"]).unwrap_err().0.starts_with("--task は metrics・build"));
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
