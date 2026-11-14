//! 依頼単位の分析(packages/core/src/turns.ts の移植。段階 1。LLM を使わない規則)。
//! - tool_kind / command_kind: ツール呼び出し 1 回の種類(読む・編集・検証・git・シェル・計画・Web・委任・その他)
//! - phase_of: そのターンの工程(調査 / 計画 / 実装 / 検証 / 運用 / 回答のみ)。ツールの種類の回数から決める
//! - request_kind_of: 依頼の種類(作業 / 質問 / 修正 / 差し戻し / 続行)。依頼文の語で粗く分ける(段階 2 で LLM が分け直す)
//! - session_turns: セッションのターンを 1 行ずつにまとめる(CSV・集計・画面が同じものを使う)
//! - turn_metrics: 工程別・依頼の種類別の集計(metrics.json の turns)
//!
//! 段階 2 の判定の定数(OUTCOMES・MISMATCHES など)も持つ。

use crate::js::{self, JsMap, RE_DOT, RE_NOT_S, RE_S};
use crate::types::{SessionRecord, TurnStats};
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

pub const PHASES: [&str; 6] = ["research", "plan", "implement", "verify", "ops", "answer"];

/// 工程の名前(画面・CSV)
pub fn phase_label(p: &str) -> &'static str {
    match p {
        "research" => "調査",
        "plan" => "計画",
        "implement" => "実装",
        "verify" => "検証",
        "ops" => "運用",
        "answer" => "回答のみ",
        _ => "",
    }
}

pub const REQUEST_KINDS: [&str; 5] = ["task", "question", "fix", "revert", "continue"];

/// 依頼の種類の名前(画面・CSV)
pub fn request_kind_label(k: &str) -> &'static str {
    match k {
        "task" => "作業",
        "question" => "質問",
        "fix" => "修正",
        "revert" => "差し戻し",
        "continue" => "続行",
        _ => "",
    }
}

const READ_TOOLS: &[&str] = &["view", "rg", "glob", "grep", "lsp", "read", "get_changes_overview", "ide-get_diagnostics"];
/// ファイルを書く・作るツール(normalize の FILE_EDIT_TOOLS と同じ)
const EDIT_TOOLS: &[&str] = &["edit", "create", "str_replace_editor", "apply_patch"];
const SHELL_TOOLS: &[&str] = &["powershell", "bash", "shell", "write_powershell", "write_bash"];
/// 計画・確認(todo は session.db を sql ツールで書く)
const PLAN_TOOLS: &[&str] = &["ask_user", "sql", "update_todo", "exit_plan_mode", "todo_write"];
const WEB_TOOLS: &[&str] = &["web_fetch", "web_search", "fetch_copilot_cli_documentation"];
const DELEGATE_TOOLS: &[&str] = &["task", "read_agent", "list_agents", "run_dynamic_workflow", "dynamic_workflows_manage"];
/// 工程を決めるのに数えない
const NEUTRAL_TOOLS: &[&str] = &["read_powershell", "read_bash", "stop_powershell", "stop_bash", "list_powershell", "list_bash", "rename_session", "store_memory", "vote_memory", "task_complete", "skill"];

/// JS の正規表現(/u なし)を regex クレートの書き方にする: \s・\S・\w・\b・. を JS と同じ意味のものに置き換える
pub fn js_re(src: &str) -> String {
    let mut out = String::with_capacity(src.len() * 2);
    let mut chars = src.chars().peekable();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let Some(n) = chars.next() else {
                    out.push('\\');
                    break;
                };
                match n {
                    's' if in_class => out.push_str(&RE_S[1..RE_S.len() - 1]),
                    's' => out.push_str(RE_S),
                    'S' if !in_class => out.push_str(RE_NOT_S),
                    'w' if in_class => out.push_str("A-Za-z0-9_"),
                    'w' => out.push_str("[A-Za-z0-9_]"),
                    'd' if in_class => out.push_str("0-9"),
                    'd' => out.push_str("[0-9]"),
                    'b' if !in_class => out.push_str(r"(?-u:\b)"),
                    _ => {
                        out.push('\\');
                        out.push(n);
                    }
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push('[');
                if chars.peek() == Some(&'^') {
                    out.push(chars.next().unwrap());
                }
                // 先頭の ] は文字として扱われる(JS では空のクラスだが、ここでは使わない)
            }
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            '.' if !in_class => out.push_str(RE_DOT),
            _ => out.push(c),
        }
    }
    out
}

fn re(src: &str, flags: &str) -> Regex {
    let body = js_re(src);
    let pre = if flags.contains('i') { "(?i)" } else { "" };
    Regex::new(&format!("{pre}{body}")).unwrap_or_else(|e| panic!("正規表現 {src}: {e}"))
}

const GIT: &str = r"git(?:\s+(?:-C\s+\S+|-c\s+\S+|--?[\w-]+(?:=\S+)?))*\s+";

/// テスト・ビルド・型検査・lint の実行、ビルドしたプログラムの起動(動作確認)
static VERIFY_SEGMENT: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check|e2e|ui)\b|npx\s+(?:vitest|jest|tsc|eslint|playwright)\b|(?:vitest|jest|pytest|tsc|eslint|ctest|ninja|msbuild|make|cmake)\b|go\s+(?:test|build|vet)\b|cargo\s+(?:test|build|check|clippy|run)\b|dotnet\s+(?:test|build|run)\b|\.?[\\/]?gradlew?\b|mvn\b|[^\s]+\.exe\b|\.{1,2}[\\/]\S+)",
        "i",
    )
});
/// 変更を残す・配る操作
static GIT_SEGMENT: LazyLock<Regex> = LazyLock::new(|| {
    re(
        &format!(r"^(?:{GIT}(?:commit|push|merge|rebase|tag|cherry-pick|reset|revert|checkout|switch|pull|stash|am|apply)\b|gh\s+(?:pr\s+(?:create|merge|close|edit|ready)|release\s+create|workflow\s+run)\b|docker\s+(?:build|push|compose)\b|kubectl\s+(?:apply|rollout|delete)\b)"),
        "i",
    )
});
/// 読むだけ
static READ_SEGMENT: LazyLock<Regex> = LazyLock::new(|| {
    re(
        &format!(
            r"^(?:{GIT}(?:status|diff|log|show|blame|branch|remote|ls-files|ls-tree|rev-parse|grep|describe|shortlog|reflog|cat-file|for-each-ref|config\s+--get|worktree\s+list|stash\s+list)\b|gh\s+(?:run\s+(?:list|view)|pr\s+(?:view|list|checks|diff)|issue\s+(?:view|list))\b|(?:ls|dir|cat|type|head|tail|Get-ChildItem|Get-Content|Get-Item|Select-String|Select-Object|Measure-Object|Test-Path|Resolve-Path|Get-Process|rg|grep|find|tree|wc|where|which|echo|Write-Output|Write-Host)\b)"
        ),
        "i",
    )
});
/// 段の先頭で読み飛ばすもの
static PREFIX: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:(?:cd|Set-Location|pushd|popd|chdir)(?:\s+\S+)?\s*$|\$[\w:]+\s*=|export\s+\w+=|set\s+\w+=|#)", "i"));
/// 環境を整えるだけの段
static SETUP: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:vcvars\w*|vsdevcmd|chcp|Import-Module|Add-Type)\b", "i"));
/// cmd /c
static CMD_C: LazyLock<Regex> = LazyLock::new(|| re(r"^cmd(?:\.exe)?\s+\/[ck]\b", "i"));
/// 引用符で囲んだプログラムのパス。JS の後方参照 \1 の代わりに引用符ごとに分ける
static QUOTED_PROGRAM_DQ: LazyLock<Regex> = LazyLock::new(|| re(r#"^"(?:[^"']*[\\/])?([^\\/"']+?)(\.(?:exe|bat|cmd))?"(.*)$"#, "i"));
static QUOTED_PROGRAM_SQ: LazyLock<Regex> = LazyLock::new(|| re(r#"^'(?:[^"']*[\\/])?([^\\/"']+?)(\.(?:exe|bat|cmd))?'(.*)$"#, "i"));
/// cmd /c の中身(/gim。. は改行で止まるので $ は常に当たる)
static CMD_INNER: LazyLock<Regex> = LazyLock::new(|| re(r"\bcmd(?:\.exe)?\s+\/[ck]\s+(.+)", "i"));
static LEAD_AMP: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:&|call\b)\s*", "i"));
static BRACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[{}()]+$").unwrap());
static QUOTED: LazyLock<Regex> = LazyLock::new(|| re(r#""(?:[^"\\]|\\.)*"|'[^']*'"#, ""));
static SPLIT_ALL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n|;|&&|\|\||\|").unwrap());
static MCP_READ: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[-_])(?:get|search|list|read)[-_]").unwrap());

/// ; && || | 改行で段に分ける。引用符の中では分けない。引用符が閉じないときは、引用符を見ずに分け直す
fn segments(cmd: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let chars: Vec<char> = cmd.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == '\\' && q == '"' && i + 1 < chars.len() {
                cur.push(c);
                cur.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
            cur.push(c);
            i += 1;
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            cur.push(c);
            i += 1;
            continue;
        }
        let next = chars.get(i + 1).copied();
        if (c == '&' && next == Some('&')) || (c == '|' && next == Some('|')) || (c == '\r' && next == Some('\n')) {
            out.push(std::mem::take(&mut cur));
            i += 2;
            continue;
        }
        if c == ';' || c == '|' || c == '\n' {
            out.push(std::mem::take(&mut cur));
            i += 1;
            continue;
        }
        cur.push(c);
        i += 1;
    }
    if quote.is_some() {
        return SPLIT_ALL.split(cmd).map(str::to_string).collect();
    }
    out.push(cur);
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CommandKind {
    Read = 0,
    Shell = 1,
    Git = 2,
    Verify = 3,
}

impl CommandKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CommandKind::Read => "read",
            CommandKind::Shell => "shell",
            CommandKind::Git => "git",
            CommandKind::Verify => "verify",
        }
    }
}

/// シェルのコマンド 1 つの種類(検証 > git > その他 > 読む のいちばん強いもの)
pub fn command_kind(cmd: &str) -> CommandKind {
    command_kind_at(cmd, 0)
}

fn command_kind_at(cmd: &str, depth: u32) -> CommandKind {
    let mut kind = CommandKind::Read;
    let mut raise = |k: CommandKind| {
        if k > kind {
            kind = k;
        }
    };
    if depth < 2 {
        for m in CMD_INNER.captures_iter(cmd) {
            let inner = crate::js::trim(&m[1]);
            let inner = inner.strip_prefix('"').unwrap_or(inner);
            let inner = inner.strip_suffix('"').unwrap_or(inner);
            let inner = inner.replace("\"\"", "\"");
            raise(command_kind_at(&inner, depth + 1));
        }
    }
    for raw in segments(cmd) {
        let t = crate::js::trim(&raw);
        let mut seg = LEAD_AMP.replace(t, "").into_owned();
        if seg.is_empty() || CMD_C.is_match(&seg) || PREFIX.is_match(&seg) || BRACES.is_match(&seg) {
            continue;
        }
        let mut program = false;
        let q = QUOTED_PROGRAM_DQ.captures(&seg).or_else(|| QUOTED_PROGRAM_SQ.captures(&seg));
        if let Some(q) = q {
            program = q.get(2).is_some_and(|m| m.as_str().to_lowercase() == ".exe");
            seg = format!("{}{}", &q[1], &q[3]);
        }
        if SETUP.is_match(&seg) {
            continue;
        }
        let bare = QUOTED.replace_all(&seg, "\"\"");
        let k = if VERIFY_SEGMENT.is_match(&bare) {
            CommandKind::Verify
        } else if GIT_SEGMENT.is_match(&bare) {
            CommandKind::Git
        } else if READ_SEGMENT.is_match(&bare) {
            CommandKind::Read
        } else {
            CommandKind::Shell
        };
        raise(if k == CommandKind::Shell && program { CommandKind::Verify } else { k });
    }
    kind
}

/// ツール呼び出し 1 回の種類。None は工程の判定に数えないもの
pub fn tool_kind(name: &str, args: Option<&Value>) -> Option<&'static str> {
    if NEUTRAL_TOOLS.contains(&name) {
        return None;
    }
    if EDIT_TOOLS.contains(&name) {
        return Some("edit");
    }
    if READ_TOOLS.contains(&name) {
        return Some("read");
    }
    if PLAN_TOOLS.contains(&name) {
        return Some("plan");
    }
    if WEB_TOOLS.contains(&name) {
        return Some("web");
    }
    if DELEGATE_TOOLS.contains(&name) {
        return Some("delegate");
    }
    if SHELL_TOOLS.contains(&name) {
        let cmd = match args {
            Some(Value::String(s)) => s.as_str(),
            Some(Value::Object(o)) => match (o.get("command"), o.get("input")) {
                (Some(Value::String(c)), _) => c.as_str(),
                (_, Some(Value::String(i))) => i.as_str(),
                _ => "",
            },
            _ => "",
        };
        return Some(command_kind(cmd).as_str());
    }
    // MCP の読み取り(github-mcp-server-get_file_contents / search_code など)
    if MCP_READ.is_match(name) {
        return Some("read");
    }
    Some("other")
}

/// そのターンの工程。優先順: 編集があれば実装 → テスト・ビルドの実行があれば検証 → git の書き込みなどがあれば運用 →
/// 計画・確認だけなら計画 → 作業のツールが無ければ回答のみ → それ以外(読む・調べる・その他のシェル)は調査
pub fn phase_of(kinds: &JsMap<i64>) -> &'static str {
    let n = |x: &str| kinds.get(x).copied().unwrap_or(0);
    let work = n("read") + n("edit") + n("verify") + n("git") + n("shell") + n("plan") + n("web") + n("delegate") + n("other");
    if work == 0 {
        return "answer";
    }
    if n("edit") > 0 {
        return "implement";
    }
    if n("verify") > 0 {
        return "verify";
    }
    if n("git") > 0 {
        return "ops";
    }
    if n("plan") > 0 && n("plan") == work {
        return "plan";
    }
    "research"
}

// 依頼文の規則。JS の /i(u なし)は ASCII の英字だけを大文字小文字を区別せずに比べるので、
// /i のものは入力の ASCII だけを小文字にしてから小文字の型で比べる(regex の (?i) は Unicode で畳むので K(ケルビン記号)なども当たる)
static REVERT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"元に戻|戻して|もどして|取り消|取消し|やめて|中止して|revert|ロールバック|なかったことに|消して元").unwrap());
/// 直前の成果の直し(「X ではなく Y」だけでは新しい指示のことが多いので含めない)
static FIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"違う|ちがう|そうじゃな|直して|なおして|修正して|おかしい|間違|まちが|動かない|うまくいかない|エラーが出|失敗して|崩れ|足りない|抜けて|漏れて").unwrap());
/// 直しをはっきり頼む言い方(これがあれば、問いの形でも修正)
static FIX_IMPERATIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"直して|なおして|修正して").unwrap());
/// 原因・理由を尋ねる語(「なぜ動かないの？」は不具合の報告より原因の質問)
static WHY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"なぜ|どうして|原因|理由|何が|どこが").unwrap());
/// 問いの言い方(最後の文で見る)
static QUESTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[？?]$|教えて|とは$|なぜ|どうして|どうやって|どうすれば|ですか$|ますか$|でしょうか$|ある$|できる$|わかる$").unwrap());
/// 「〜してもらえますか」など、問いの形をした依頼
static POLITE_REQUEST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:て|で)(?:もらえ|くれ|いただけ)(?:ます|ません|る|ない)か|お願いでき(?:ます|ません)か|してほしい").unwrap());
/// 短い返事(選択肢の記号 1 文字を含む)
static CONTINUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:はい|うん|ok|okay|yes|お願い(?:します)?|進めて|続けて|続き|それで|いいよ|いいです|やって|して|する|始める|go|lgtm|大丈夫|了解|[a-z0-9])[。.!！]?$").unwrap()
});
static SENTENCE_SEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[。\n!！]+").unwrap());
static TRAILING_CLOSE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r"[)）」』\s]+$")).unwrap());

/// 依頼の種類(依頼文の語による粗い分類。質問かどうかは最後の文で決める)
pub fn request_kind_of(text: &str) -> &'static str {
    let s = js::trim(text);
    if s.is_empty() {
        return "task";
    }
    if js::utf16_len(s) <= 12 && CONTINUE.is_match(&s.to_ascii_lowercase()) {
        return "continue";
    }
    if REVERT.is_match(&s.to_ascii_lowercase()) {
        return "revert";
    }
    let sentences: Vec<&str> = SENTENCE_SEP.split(s).map(js::trim).filter(|x| !x.is_empty()).collect();
    let last_raw = sentences.last().copied().unwrap_or(s);
    let last = TRAILING_CLOSE.replace(last_raw, "");
    let asks = QUESTION.is_match(&last) && !POLITE_REQUEST.is_match(&last);
    // 「CI が失敗してる？」は不具合の報告なので修正。「なぜ動かないの？」のように原因を尋ねるだけなら質問
    if FIX.is_match(s) && !(asks && WHY.is_match(&last) && !FIX_IMPERATIVE.is_match(s)) {
        return "fix";
    }
    if asks { "question" } else { "task" }
}

/// 1 ターン 1 行(CSV・集計・画面で使う)。text は依頼文の先頭(伏せ字版では使わない)。
/// TS 版の TurnRow は TurnStats を展開したものなので、ここでは stats を借りて持つ
#[derive(Debug, Clone, Copy)]
pub struct TurnRow<'a> {
    pub stats: &'a TurnStats,
    pub session_id: &'a str,
    /// セッションの中の通し番号(1 から)
    pub index: usize,
    pub phase: &'static str,
    pub kind: &'static str,
    /// 次の依頼の種類(セッションの最後のターンは None)
    pub next_kind: Option<&'static str>,
    pub ms: Option<f64>,
    pub active_ms: Option<f64>,
    pub text: &'a str,
}

impl TurnRow<'_> {
    /// 集計に使う項目
    pub fn facts(&self) -> TurnFacts {
        let t = self.stats;
        TurnFacts {
            kind: self.kind,
            next_kind: self.next_kind,
            active_ms: self.active_ms,
            tools: t.tools,
            tool_failures: t.tool_failures,
            denied: t.denied,
            aborts: t.aborts,
            errors: t.errors,
            external_errors: t.external_errors,
            subagent_failures: t.subagent_failures,
            compactions: t.compactions,
            edits: t.edits,
            re_edits: t.re_edits,
            ask_user: t.ask_user,
            input: t.input,
            output: t.output,
            nano_aiu: t.nano_aiu,
        }
    }

    pub fn is_stuck(&self) -> bool {
        is_stuck_stats(self.stats)
    }

    pub fn followed_by_fix(&self) -> bool {
        followed_by_fix(self.next_kind)
    }
}

/// セッションのターンを 1 行ずつにする。turnStats の無い古い記録や DB だけのセッションは空
pub fn session_turns(r: &SessionRecord) -> Vec<TurnRow<'_>> {
    let a = &r.analysis;
    let Some(stats) = a.turn_stats.as_ref().filter(|x| !x.is_empty()) else {
        return Vec::new();
    };
    let text = |i: usize| a.requests.get(i).map_or("", String::as_str);
    let kinds: Vec<&'static str> = (0..stats.len()).map(|i| request_kind_of(text(i))).collect();
    stats
        .iter()
        .enumerate()
        .map(|(i, t)| TurnRow {
            stats: t,
            session_id: &r.id,
            index: i + 1,
            phase: phase_of(&t.kinds),
            kind: kinds[i],
            next_kind: kinds.get(i + 1).copied(),
            ms: a.turn_ms.get(i).copied().flatten(),
            active_ms: a.turn_active_ms.get(i).copied().flatten(),
            text: text(i),
        })
        .collect()
}

/// 次の依頼が直しか差し戻しか(段階 1 の「手戻りの兆し」。採用の判定は段階 2)
pub fn followed_by_fix(next_kind: Option<&str>) -> bool {
    matches!(next_kind, Some("fix") | Some("revert"))
}

/// 詰まりのあったターンか(同じ依頼の中で同じファイルを重ねて編集するのは普通の進め方なので数えない。前の依頼で編集したファイルの再編集は数える)
pub fn is_stuck(tool_failures: i64, denied: i64, aborts: i64, errors: i64, re_edits: i64, compactions: i64) -> bool {
    tool_failures + denied + aborts + errors + re_edits + compactions > 0
}

pub fn is_stuck_stats(t: &TurnStats) -> bool {
    is_stuck(t.tool_failures, t.denied, t.aborts, t.errors, t.re_edits, t.compactions)
}

/// 集計に使う項目(埋め込みから戻した行にも、時刻・依頼文・ツールの種類は無い)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnFacts {
    pub kind: &'static str,
    pub next_kind: Option<&'static str>,
    pub active_ms: Option<f64>,
    pub tools: i64,
    pub tool_failures: i64,
    pub denied: i64,
    pub aborts: i64,
    pub errors: i64,
    pub external_errors: i64,
    pub subagent_failures: i64,
    pub compactions: i64,
    pub edits: i64,
    pub re_edits: i64,
    pub ask_user: i64,
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub nano_aiu: Option<f64>,
}

pub fn empty_turn_bucket() -> TurnBucket {
    TurnBucket { kinds: JsMap(REQUEST_KINDS.iter().map(|k| (k.to_string(), 0)).collect()), ..Default::default() }
}

pub fn add_turn(b: &mut TurnBucket, t: &TurnFacts) {
    b.turns += 1;
    b.active_ms += t.active_ms.unwrap_or(0.0);
    b.tools += t.tools;
    b.tool_failures += t.tool_failures;
    b.denied += t.denied;
    b.aborts += t.aborts;
    b.errors += t.errors;
    b.external_errors += t.external_errors;
    b.subagent_failures += t.subagent_failures;
    b.compactions += t.compactions;
    b.edits += t.edits;
    b.re_edits += t.re_edits;
    b.ask_user += t.ask_user;
    b.input += t.input.unwrap_or(0.0);
    b.output += t.output.unwrap_or(0.0);
    b.nano_aiu += t.nano_aiu.unwrap_or(0.0);
    if is_stuck(t.tool_failures, t.denied, t.aborts, t.errors, t.re_edits, t.compactions) {
        b.stuck += 1;
    }
    if t.next_kind.is_some() {
        b.with_next += 1;
        if followed_by_fix(t.next_kind) {
            b.followed_by_fix += 1;
        }
    }
    *b.kinds.entry(t.kind.to_string()).or_insert(0) += 1;
}

/// セッション群のターンを工程別・依頼の種類別に集計する。
/// 依頼文の分類はセッションごとに並列に行い、足し算は TS 版と同じ順(セッション順・ターン順)にする(浮動小数の和を同じにするため)
pub fn turn_metrics(sessions: &[&SessionRecord]) -> TurnMetrics {
    struct Per {
        turns: i64,
        rows: Vec<(&'static str, TurnFacts)>,
    }
    let per: Vec<Per> = sessions
        .par_iter()
        .map(|s| Per { turns: s.turns, rows: session_turns(s).iter().map(|t| (t.phase, t.facts())).collect() })
        .collect();
    let mut by_phase: JsMap<TurnBucket> = JsMap(PHASES.iter().map(|p| (p.to_string(), empty_turn_bucket())).collect());
    let mut by_kind: JsMap<TurnBucket> = JsMap(REQUEST_KINDS.iter().map(|k| (k.to_string(), empty_turn_bucket())).collect());
    let (mut turns, mut with_turns, mut without, mut truncated) = (0i64, 0i64, 0i64, 0i64);
    for s in &per {
        if s.rows.is_empty() {
            if s.turns > 0 {
                without += 1;
            }
            continue;
        }
        with_turns += 1;
        if s.turns > s.rows.len() as i64 {
            truncated += 1;
        }
        for (phase, f) in &s.rows {
            turns += 1;
            add_turn(by_phase.get_mut(*phase).expect("PHASES の工程"), f);
            add_turn(by_kind.get_mut(f.kind).expect("REQUEST_KINDS の種類"), f);
        }
    }
    TurnMetrics { turns, sessions: with_turns, sessions_without_turns: without, truncated_sessions: truncated, by_phase, by_kind }
}

// ---------- 段階 2: LLM による依頼ごとの判定(judge が作り、report と CSV が読む) ----------

/// 作業の依頼の成果の扱い(次の依頼と拒否・中断から LLM が決める)
pub const WORK_OUTCOMES: [&str; 5] = ["as_is", "fix_content", "fix_style", "rejected", "unknown"];
/// 質問の依頼の回答の扱い
pub const QUESTION_OUTCOMES: [&str; 4] = ["helpful", "follow_up", "off_target", "unknown"];
pub const OUTCOMES: [&str; 8] = ["as_is", "fix_content", "fix_style", "rejected", "helpful", "follow_up", "off_target", "unknown"];

pub fn outcome_label(o: &str) -> &'static str {
    match o {
        "as_is" => "そのまま採用",
        "fix_content" => "中身を修正して採用",
        "fix_style" => "体裁を修正して採用",
        "rejected" => "不採用",
        "helpful" => "役に立った",
        "follow_up" => "追加で聞いた",
        "off_target" => "的外れ",
        "unknown" => "判定不能",
        _ => "",
    }
}

/// 合わなかった点(修正・不採用・的外れのときだけ)
pub const MISMATCHES: [&str; 6] = ["requirement", "defect", "quality", "scope", "environment", "other"];

pub fn mismatch_label(m: &str) -> &'static str {
    match m {
        "requirement" => "意図・要件の取り違え",
        "defect" => "誤り・不具合",
        "quality" => "品質・体裁・決まりごと",
        "scope" => "やり過ぎ・足りない",
        "environment" => "環境・ツール・権限",
        "other" => "その他",
        _ => "",
    }
}

/// 合わなかった点を必ず付ける扱い
pub const NEEDS_MISMATCH: [&str; 4] = ["fix_content", "fix_style", "rejected", "off_target"];
/// 普段の工程名の既定(atlas.config.json の phases で置き換えられる)
pub const DEFAULT_PHASE_NAMES: [&str; 8] = ["要件定義", "設計", "実装", "テスト", "レビュー", "調査", "運用", "その他"];

// ---------- metrics.json の型 ----------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnBucket {
    pub turns: i64,
    pub active_ms: f64,
    pub tools: i64,
    pub tool_failures: i64,
    pub denied: i64,
    pub aborts: i64,
    pub errors: i64,
    pub external_errors: i64,
    pub subagent_failures: i64,
    pub compactions: i64,
    pub edits: i64,
    pub re_edits: i64,
    pub ask_user: i64,
    pub input: f64,
    pub output: f64,
    pub nano_aiu: f64,
    /// 詰まりのあったターン
    pub stuck: i64,
    /// 次の依頼が修正・差し戻しだったターン
    pub followed_by_fix: i64,
    /// 次の依頼があったターン
    pub with_next: i64,
    /// 依頼の種類別のターン数(REQUEST_KINDS の順)
    pub kinds: JsMap<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnMetrics {
    pub turns: i64,
    pub sessions: i64,
    pub sessions_without_turns: i64,
    pub truncated_sessions: i64,
    /// PHASES の順
    pub by_phase: JsMap<TurnBucket>,
    /// REQUEST_KINDS の順
    pub by_kind: JsMap<TurnBucket>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shell_kinds() {
        assert_eq!(command_kind("npm test"), CommandKind::Verify);
        assert_eq!(command_kind("git -C repo commit -m \"fix; npm test\""), CommandKind::Git);
        assert_eq!(command_kind("git status && ls"), CommandKind::Read);
        assert_eq!(command_kind("cd foo; make"), CommandKind::Verify);
        assert_eq!(command_kind("\"C:\\tools\\cmake.exe\" --build ."), CommandKind::Verify);
        assert_eq!(command_kind("cmd /c \"npm run build\""), CommandKind::Verify);
        assert_eq!(command_kind("python script.py"), CommandKind::Shell);
        assert_eq!(command_kind("echo don't"), CommandKind::Read);
        assert_eq!(tool_kind("powershell", Some(&json!({"command": "git push"}))), Some("git"));
        assert_eq!(tool_kind("github-mcp-server-get_file_contents", None), Some("read"));
        assert_eq!(tool_kind("skill", None), None);
        assert_eq!(tool_kind("foo", None), Some("other"));
    }
}
