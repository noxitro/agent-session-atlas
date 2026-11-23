//! copilot -p を子プロセスで起動するときの引数(skill-draft が使う。packages/judge/src/backends/copilot-cli.ts の移植)。
//! 判定はこのツールの中では回さない(外部の LLM に頼む。docs/judge.md)。下書きでも、判定で使っていたのと同じ安全策を付ける:
//! - 空の作業ディレクトリで起動し、材料はプロンプト本文に埋め込む(--add-dir は使わない:
//!   そのディレクトリの .github/skills / agents を信頼設定として読むため、ログの本文が注入の入口になる)
//! - --no-custom-instructions でユーザーの AGENTS.md 等を読ませない
//! - --allow-all-tools(非対話モードで必須)を付けても、シェル・ファイル書き込み・URL アクセスは --deny-tool で拒否する
//!   (`copilot help permissions`: 拒否は --allow-all-tools より優先される)
//! - MCP のツールは shell / write / url のどれにも当たらない(`copilot help permissions` の kind は <mcp-server-name>(tool) で別)ので、
//!   (1) --available-tools でモデルに見せるツールを view だけにし(作業ディレクトリは空で、copilot は既定でその外のパスを拒否する)、
//!   (2) --disable-builtin-mcps で組み込みの MCP を止め、(3) `copilot mcp list --json` で得た各サーバーを
//!   --disable-mcp-server と --deny-tool <サーバー名> で止める
//! - トークン消費は --usage-output-file で受け取る

use super::proc::{run_process, tail, ResolvedCommand};
use anyhow::{bail, Result};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// 使わせないツールの種類(`copilot help permissions` の kind)。shell = シェル、write = ファイルの作成・変更、url = shell / web-fetch の URL アクセス
pub const JUDGE_DENIED_TOOL_KINDS: [&str; 3] = ["shell", "write", "url"];

/// モデルに見せるツール(--available-tools)。空の作業ディレクトリの外は既定で読めないので、view が残っても読めるものは無い
pub const JUDGE_AVAILABLE_TOOLS: [&str; 1] = ["view"];

/// 作業フォルダの接頭辞。extract はこの名前の作業フォルダのセッションを「(atlas の判定)」に分類する
/// (前の版のこのツールが判定に使った作業フォルダと、skill-draft の作業フォルダ)
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
