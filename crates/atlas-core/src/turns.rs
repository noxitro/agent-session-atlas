//! 依頼単位の分析(packages/core/src/turns.ts)のうち、extract が使う部分の移植(段 1b)。
//! - tool_kind / command_kind: ツール呼び出し 1 回の種類(normalize がターンごとの内訳に使う)
//! - TurnMetrics・TurnBucket: metrics.json の型
//! TODO(段 3・6): phaseOf・requestKindOf・sessionTurns・turnMetrics などの残りは metrics・judge の移植で足す

use crate::js::{JsMap, RE_DOT, RE_NOT_S, RE_S};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

pub const PHASES: [&str; 6] = ["research", "plan", "implement", "verify", "ops", "answer"];
pub const REQUEST_KINDS: [&str; 5] = ["task", "question", "fix", "revert", "continue"];
/// 依頼ごとの判定(段階 2)で使う普段の工程名の既定
pub const DEFAULT_PHASE_NAMES: [&str; 8] = ["要件定義", "設計", "実装", "テスト", "レビュー", "調査", "運用", "その他"];

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
pub(crate) fn js_re(src: &str) -> String {
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
