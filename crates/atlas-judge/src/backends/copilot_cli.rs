//! copilot -p を子プロセスで起動する判定バックエンド(既定。packages/judge/src/backends/copilot-cli.ts の移植)。
//! - 空の作業ディレクトリで起動し、パケットと指示はプロンプト本文に埋め込む(--add-dir は使わない:
//!   そのディレクトリの .github/skills / agents を信頼設定として読むため、他セッションの本文を含むバンドルが注入の入口になる)
//! - --no-custom-instructions でユーザーの AGENTS.md 等を読ませない(判定がそれに引きずられないように)
//! - 判定はツールを使わない作業なので、--allow-all-tools(非対話モードで必須)を付けても、シェル・ファイル書き込み・URL アクセスは
//!   --deny-tool で拒否する(`copilot help permissions`: 拒否は --allow-all-tools より優先される)。パケット本文からの指示注入で
//!   ツールが動くのを防ぐため
//! - MCP のツールは shell / write / url のどれにも当たらない(`copilot help permissions` の kind は <mcp-server-name>(tool) で別)ので、
//!   --allow-all-tools だけだと組み込みの github-mcp-server や利用者・プラグインの MCP サーバーが許可されてしまう。
//!   そこで (1) --available-tools でモデルに見せるツールを view だけにし(作業ディレクトリは空で、copilot は既定でその外のパスを拒否する)、
//!   (2) --disable-builtin-mcps で組み込みの MCP を止め、(3) `copilot mcp list --json` で得た各サーバーを
//!   --disable-mcp-server と --deny-tool <サーバー名> で止める
//! - 判定自体のトークン消費は --usage-output-file で受け取る

use super::output::{item_from_texts, parse_agent_jsonl};
use super::proc::{command_line_length, resolve_command, run_process, tail, ResolvedCommand, MAX_COMMAND_LINE};
use super::{AskResult, JudgeBackend, JudgePacket, JudgeResult};
use crate::rubric::build_judge_prompt;
use anyhow::{bail, Result};
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Debug, Clone, Default)]
pub struct CopilotCliOptions {
    /// 実行ファイル(既定: 環境変数 ATLAS_COPILOT_BIN、無ければ PATH の copilot)
    pub bin: Option<String>,
    pub model: Option<String>,
    /// --allow-all-tools を付けるか(既定 true。ヘルプでは非対話モードで必須とある)
    pub allow_tools: Option<bool>,
    pub timeout_ms: Option<u64>,
}

/// 判定では使わせないツールの種類(`copilot help permissions` の kind)。shell = シェル、write = ファイルの作成・変更、url = shell / web-fetch の URL アクセス
pub const JUDGE_DENIED_TOOL_KINDS: [&str; 3] = ["shell", "write", "url"];

/// 判定でモデルに見せるツール(--available-tools)。空の作業ディレクトリの外は既定で読めないので、view が残っても読めるものは無い
pub const JUDGE_AVAILABLE_TOOLS: [&str; 1] = ["view"];

/// 判定の作業フォルダの接頭辞。extract はこの名前の作業フォルダのセッションを「(atlas の判定)」に分類する
pub const JUDGE_WORK_DIR_PREFIX: &str = "atlas-judge-cwd-";

/// mcp_servers: `copilot mcp list --json` で得た MCP サーバー名(それぞれ止めて拒否する)
pub fn copilot_args(prompt: &str, usage_file: &str, model: Option<&str>, allow_tools: bool, mcp_servers: &[String]) -> Vec<String> {
    let mut args: Vec<String> = ["-p", prompt, "--output-format", "json", "--stream", "off", "--no-ask-user", "-s", "--no-custom-instructions"].iter().map(|s| s.to_string()).collect();
    if allow_tools {
        args.push("--allow-all-tools".into());
    }
    args.push(format!("--available-tools={}", JUDGE_AVAILABLE_TOOLS.join(",")));
    args.push("--disable-builtin-mcps".into());
    for kind in JUDGE_DENIED_TOOL_KINDS {
        args.push("--deny-tool".into());
        args.push(kind.into());
    }
    for server in mcp_servers {
        args.extend(["--disable-mcp-server".into(), server.clone(), "--deny-tool".into(), server.clone()]);
    }
    args.push("--usage-output-file".into());
    args.push(usage_file.into());
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        args.push("--model".into());
        args.push(m.into());
    }
    args
}

/// 設定されている MCP サーバー名(利用者・ワークスペース・プラグイン・組み込み)。LLM は呼ばない。
/// 取れなかったときは空にして理由を返す(--available-tools と --disable-builtin-mcps の制限は残る)
pub fn copilot_mcp_servers(cmd: &ResolvedCommand, cwd: &Path) -> (Vec<String>, Option<String>) {
    let r = (|| -> Result<Vec<String>> {
        let r = run_process(cmd, &["mcp".into(), "list".into(), "--json".into()], cwd, Duration::from_millis(60_000), None)?;
        if r.timed_out || r.code != Some(0) {
            bail!("{}", if r.timed_out { "時間切れ".to_string() } else { format!("終了コード {}: {}", code_str(r.code), tail(if r.stderr.is_empty() { &r.stdout } else { &r.stderr }, 200)) });
        }
        let v = atlas_core::js::parse_json(&r.stdout)?;
        Ok(match v.get("mcpServers") {
            Some(Value::Object(m)) => crate::schema::js_object_entries(m).into_iter().map(|(k, _)| k.clone()).collect(),
            _ => vec![],
        })
    })();
    match r {
        Ok(s) => (s, None),
        Err(e) => (vec![], Some(format!("MCP サーバーの一覧(copilot mcp list --json)を取れなかったため、サーバーごとの拒否は付けていません({e})"))),
    }
}

/// 終了コードの表示(`${code}`。シグナルで終わったときは null)
pub fn code_str(c: Option<i32>) -> String {
    c.map_or_else(|| "null".into(), |c| c.to_string())
}

/// 一時フォルダ(Node の mkdtemp(join(tmpdir(), prefix)))。消すのは呼ぶ側(TempDir を落とすと消える)
pub fn mkdtemp(prefix: &str) -> Result<tempfile::TempDir> {
    Ok(tempfile::Builder::new().prefix(prefix).rand_bytes(6).tempdir_in(std::env::temp_dir())?)
}

pub struct CopilotCliBackend {
    bin: String,
    model: Option<String>,
    allow_tools: bool,
    timeout_ms: u64,
    cmd: Mutex<Option<ResolvedCommand>>,
    mcp: Mutex<Option<(Vec<String>, Option<String>)>>,
}

pub fn copilot_cli_backend(o: CopilotCliOptions) -> CopilotCliBackend {
    CopilotCliBackend {
        bin: o.bin.or_else(|| std::env::var("ATLAS_COPILOT_BIN").ok()).unwrap_or_else(|| "copilot".into()),
        model: o.model,
        allow_tools: o.allow_tools.unwrap_or(true),
        timeout_ms: o.timeout_ms.unwrap_or(600_000),
        cmd: Mutex::new(None),
        mcp: Mutex::new(None),
    }
}

impl CopilotCliBackend {
    fn resolved(&self) -> Result<ResolvedCommand> {
        let mut c = self.cmd.lock().unwrap();
        if c.is_none() {
            *c = Some(resolve_command(&self.bin)?);
        }
        Ok(c.clone().unwrap())
    }

    /// プロンプトを 1 回渡して、本文と使用量を受け取る(判定の検証は呼ぶ側)
    fn ask_inner(&self, prompt: &str, label: &str) -> Result<AskResult> {
        let cmd = self.resolved()?;
        // 一時フォルダは成功でも失敗でも消す(TempDir を落とすと消える)
        let work = mkdtemp(JUDGE_WORK_DIR_PREFIX)?;
        let usage_dir = mkdtemp("atlas-judge-usage-")?;
        let usage_file = usage_dir.path().join("usage.json");
        let (servers, mcp_note) = {
            let mut m = self.mcp.lock().unwrap();
            if m.is_none() {
                *m = Some(copilot_mcp_servers(&cmd, work.path()));
            }
            m.clone().unwrap()
        };
        let args = copilot_args(prompt, &usage_file.display().to_string(), self.model.as_deref(), self.allow_tools, &servers);
        let len = command_line_length(&cmd, &args);
        if cfg!(windows) && len > MAX_COMMAND_LINE {
            bail!("プロンプトが長すぎてコマンドラインに収まりません({len} 字 > {MAX_COMMAND_LINE})。atlas bundle を小さい上限で作り直してください。");
        }
        let r = run_process(&cmd, &args, work.path(), Duration::from_millis(self.timeout_ms), None)?;
        // ATLAS_JUDGE_RAW_DIR を指定すると、出力の形を確かめるために生の stdout / stderr / usage を残す
        if let Some(raw_dir) = std::env::var_os("ATLAS_JUDGE_RAW_DIR").filter(|d| !d.is_empty()) {
            let raw_dir = std::path::PathBuf::from(raw_dir);
            std::fs::create_dir_all(&raw_dir)?;
            std::fs::write(raw_dir.join(format!("{label}.stdout.jsonl")), &r.stdout)?;
            std::fs::write(raw_dir.join(format!("{label}.stderr.txt")), &r.stderr)?;
            let usage = std::fs::read(&usage_file).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_else(|e| format!("(読めません: {e})"));
            std::fs::write(raw_dir.join(format!("{label}.usage.json")), usage)?;
        }
        if r.timed_out {
            bail!("copilot が {} 秒以内に終わりませんでした", atlas_core::js::round(self.timeout_ms as f64 / 1000.0));
        }
        let out = parse_agent_jsonl(&r.stdout);
        if r.code != Some(0) {
            // session.error(quota 超過など)があればその本文を出し、無ければ出力の末尾を出す
            let err = if out.errors.is_empty() { tail(if r.stderr.is_empty() { &r.stdout } else { &r.stderr }, 600) } else { out.errors.join(" / ") };
            bail!("copilot が終了コード {} で失敗しました: {err}", code_str(r.code));
        }
        let mut notes: Vec<String> = mcp_note.into_iter().collect();
        let usage = match std::fs::read(&usage_file).map_err(anyhow::Error::from).and_then(|b| Ok(atlas_core::js::parse_json(&String::from_utf8_lossy(&b))?)) {
            Ok(v) => Some(v),
            Err(e) => {
                notes.push(format!("usage-output-file を読めませんでした({e})"));
                None
            }
        };
        Ok(AskResult { texts: out.texts, usage, notes })
    }
}

impl JudgeBackend for CopilotCliBackend {
    fn name(&self) -> &str {
        "copilot-cli"
    }
    fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }
    fn can_ask(&self) -> bool {
        true
    }
    fn ask(&self, prompt: &str, label: &str) -> Result<AskResult> {
        self.ask_inner(prompt, label)
    }
    fn judge(&self, packet: &JudgePacket<'_>) -> Result<JudgeResult> {
        let r = self.ask_inner(&build_judge_prompt(packet.markdown, packet.session_id, None), packet.session_id)?;
        Ok(JudgeResult { item: item_from_texts(&r.texts, packet.session_id)?, usage: r.usage, notes: r.notes })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn denied(args: &[String]) -> Vec<String> {
        args.iter().enumerate().filter(|(_, x)| *x == "--deny-tool").map(|(i, _)| args[i + 1].clone()).collect()
    }

    #[test]
    fn args_never_add_dir_and_always_deny() {
        let a = copilot_args("PROMPT", "u.json", Some("m"), true, &[]);
        assert!(!a.iter().any(|x| x == "--add-dir"));
        assert_eq!(&a[..2], ["-p", "PROMPT"]);
        for w in ["--output-format", "json", "--stream", "off", "--no-ask-user", "-s", "--allow-all-tools", "--usage-output-file", "u.json", "--model", "m", "--available-tools=view", "--disable-builtin-mcps", "--no-custom-instructions"] {
            assert!(a.iter().any(|x| x == w), "{w}");
        }
        assert_eq!(denied(&a), JUDGE_DENIED_TOOL_KINDS);
        let b = copilot_args("P", "u", None, false, &[]);
        assert!(!b.iter().any(|x| x == "--allow-all-tools"));
        assert!(!b.iter().any(|x| x == "--model"));
        assert_eq!(denied(&b), JUDGE_DENIED_TOOL_KINDS);
        let c = copilot_args("P", "u", None, true, &["srv-a".into(), "srv-b".into()]);
        assert_eq!(denied(&c), ["shell", "write", "url", "srv-a", "srv-b"]);
        let disabled: Vec<&String> = c.iter().enumerate().filter(|(_, x)| *x == "--disable-mcp-server").map(|(i, _)| &c[i + 1]).collect();
        assert_eq!(disabled, ["srv-a", "srv-b"]);
        // 引数の並びは TS 版と同じ
        assert_eq!(
            copilot_args("P", "u", Some("m"), true, &["s".into()]),
            ["-p", "P", "--output-format", "json", "--stream", "off", "--no-ask-user", "-s", "--no-custom-instructions", "--allow-all-tools", "--available-tools=view", "--disable-builtin-mcps", "--deny-tool", "shell", "--deny-tool", "write", "--deny-tool", "url", "--disable-mcp-server", "s", "--deny-tool", "s", "--usage-output-file", "u", "--model", "m"]
        );
    }
}
