//! M365 Copilot のアプリを UI Automation で操作して判定する(atlas judge m365 / turns m365 / tasks m365 と、画面の「M365 Copilot で自動で判定する」。
//! packages/cli/src/m365.ts の移植)。
//! 添付ファイル(bundle/parts/・turn-bundle/parts/・task-bundle/parts/)のうち未判定のものを 1 つずつ、新しいチャットで送り、返答を取り込む。
//! 画面の操作は m365-uia.ps1(Windows PowerShell)が 1 ファイルごとに行う。判定するのは M365 Copilot なので、このツールは AI クレジットを使わない。
//! 返答は <bundle>/replies/<名前>.md に残す(形が合わずに取り込めなかったとき、読んで確かめられるように)。
//! m365-uia.ps1 は TS 版と同じファイルを実行ファイルに埋め込み、一時フォルダに書き出して同じ引数で起動する(実行ファイル 1 つで動くように)。

use crate::chat_parts::{chat_save_name, list_chat_parts, ChatTarget, CHAT_REQUEST};
use crate::commands::judge::read_sessions_value;
use crate::commands::turns::turns_by_session;
use crate::config::phase_names;
use anyhow::{anyhow, bail, Result};
use atlas_judge::backends::copilot_cli::mkdtemp;
use atlas_judge::backends::proc::hide_window;
use atlas_judge::judgments_io::{import_judgments_text, ImportOptions};
use atlas_judge::schema::JudgmentValidationError;
use atlas_judge::turn_bundle::turn_import_phases;
use atlas_judge::turn_schema::{import_turn_judgments_text, TurnImportOptions};
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

/// M365 Copilot のモデル選択の既定(推論に時間をかけるもの。判定はパケットを読み比べる重い作業なので)
pub const M365_DEFAULT_MODEL: &str = "Think Deeper";
/// 1 ファイルの返答を待つ既定の秒数(Think Deeper は数分かかることがある)
#[allow(dead_code)] // 画面(serve)の移植で使う
pub const M365_DEFAULT_TIMEOUT_SEC: u64 = 900;
/// 画面を操作するスクリプト(assets/m365-uia.ps1。BOM 付きで、Windows PowerShell で読める)
pub const M365_SCRIPT: &[u8] = include_bytes!("../assets/m365-uia.ps1");

pub struct M365Request<'a> {
    /// 添付するファイル(名前がそのままチャットに出る)
    pub attach: PathBuf,
    pub prompt: &'a str,
    pub model: &'a str,
    pub timeout_sec: u64,
    /// 返答の文字を書くファイル
    pub out_file: PathBuf,
    /// 進み具合(m365-uia.ps1 の progress 行)
    pub on_progress: &'a dyn Fn(&str),
    /// 画面を操作するスクリプトを書き出した場所
    pub script: &'a Path,
}

/// 画面を操作して 1 ファイルを判定させ、返答を out_file に書く。失敗はエラー(理由はそのまま利用者に出す)
pub type M365Driver<'a> = &'a dyn Fn(&M365Request<'_>) -> Result<()>;

/// やり直しても同じ失敗(M365 Copilot の画面が無いなど)。残りのファイルを送らずに止まる
#[derive(Debug)]
pub struct M365FatalError(pub String);

impl std::fmt::Display for M365FatalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for M365FatalError {}

/// テスト用: 画面を操作するスクリプトの代わりに動かす偽物(node で動かす .mjs。fixtures/fake-m365.mjs)。
/// 本物の M365 Copilot と PowerShell に触れずに、画面からのジョブ(子プロセスと、その子の止め方)と返答の取り込みを確かめるため。
/// 指定すると Windows でなくても動かす(偽物は画面を操作しない)
pub const FAKE_DRIVER_ENV: &str = "ATLAS_M365_FAKE_DRIVER";

/// 偽物を使うか(テスト用。FAKE_DRIVER_ENV)
pub fn fake_driver() -> Option<std::ffi::OsString> {
    std::env::var_os(FAKE_DRIVER_ENV).filter(|v| !v.is_empty())
}

/// m365-uia.ps1 を Windows PowerShell で動かす(FAKE_DRIVER_ENV があれば、その偽物を node で同じ引数で動かす)
pub fn powershell_driver(req: &M365Request<'_>) -> Result<()> {
    let args: Vec<String> = vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-File".into(),
        req.script.display().to_string(),
        "-Attach".into(),
        req.attach.display().to_string(),
        "-Prompt".into(),
        req.prompt.into(),
        "-Model".into(),
        req.model.into(),
        "-TimeoutSec".into(),
        req.timeout_sec.to_string(),
        "-OutFile".into(),
        req.out_file.display().to_string(),
    ];
    let mut c = match fake_driver() {
        Some(fake) => {
            let mut c = Command::new("node");
            c.arg(fake);
            c
        }
        None => Command::new("powershell.exe"),
    };
    c.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut c);
    let mut child = c.spawn().map_err(|e| anyhow!("Windows PowerShell を起動できません: {e}"))?;
    let mut err_pipe = child.stderr.take().expect("stderr");
    let te = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err_pipe.read_to_end(&mut b);
        String::from_utf8_lossy(&b).into_owned()
    });
    let out = child.stdout.take().expect("stdout");
    // 画面の操作が止まったまま戻らないときのため、待つ秒数に余裕を足して止める
    let deadline = Duration::from_secs(req.timeout_sec + 180);
    let start = Instant::now();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let tl = std::thread::spawn(move || {
        let mut r = BufReader::new(out);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match r.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let mut error = String::new();
    let mut stderr = String::new();
    let mut on_line = |line: &str| {
        let t = atlas_core::js::trim(line);
        if let Some(m) = t.strip_prefix("progress: ") {
            (req.on_progress)(m);
        } else if let Some(e) = t.strip_prefix("error: ") {
            error = e.to_string();
        } else if !t.is_empty() {
            stderr.push_str(&format!("{t}\n"));
        }
    };
    let status = loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => on_line(&line),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(s) = child.try_wait()? {
                    break s;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        if start.elapsed() >= deadline {
            let _ = child.kill();
        }
        if let Some(s) = child.try_wait()? {
            // 残りの行を読み切る
            let _ = tl.join();
            while let Ok(line) = rx.try_recv() {
                on_line(&line);
            }
            break s;
        }
    };
    stderr.push_str(&te.join().unwrap_or_default());
    if status.success() {
        return Ok(());
    }
    let lines: Vec<&str> = atlas_core::js::trim(&stderr).split('\n').collect();
    let tail = lines[lines.len().saturating_sub(3)..].join(" / ");
    let message = if !error.is_empty() {
        error
    } else if !tail.is_empty() {
        tail
    } else {
        format!("画面の操作が終了コード {} で止まりました", status.code().map_or_else(|| "null".into(), |c| c.to_string()))
    };
    // 終了コード 3 は画面が見つからないとき(やり直しても同じ)
    if status.code() == Some(3) {
        return Err(M365FatalError(message).into());
    }
    Err(anyhow!(message))
}

pub struct M365Paths {
    pub out: PathBuf,
    /// メモの置き場(タスクの紐づけ task-links.json を書く)
    pub notes: PathBuf,
    pub sessions: PathBuf,
    pub judgments: PathBuf,
    pub turn_judgments: PathBuf,
    pub turn_bundle: PathBuf,
}

pub struct M365Options {
    pub target: ChatTarget,
    /// モデル選択の名前(先頭が合うものを選ぶ。Auto / Quick Response / Think Deeper)
    pub model: String,
    /// 送るファイルの数の上限(None は全部)
    pub limit: Option<u64>,
    pub timeout_sec: u64,
    /// 画面の操作が途中で崩れたとき、同じファイルを新しいチャットでやり直す回数(None は既定の 2)
    pub retries: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct M365Failure {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct M365Summary {
    /// 送ったファイル
    pub attempted: usize,
    /// 取り込めたファイル
    pub succeeded: usize,
    /// 取り込んだ判定の数(セッション、turns は依頼)
    pub imported: usize,
    pub failed: Vec<M365Failure>,
    /// 画面の操作が止まり、残りのファイルを送らなかった
    pub stopped: bool,
}

/// pause はやり直す前に待つ(テストでは待たない)
pub fn run_m365_judge(p: &M365Paths, o: &M365Options, log: &dyn Fn(&str), driver: M365Driver<'_>, windows: bool, pause: &dyn Fn(Duration)) -> Result<M365Summary> {
    if !windows {
        bail!("M365 Copilot の自動操作は Windows でだけ使えます(ほかの OS では、添付ファイルを手で渡してください)");
    }
    let turns = o.target == ChatTarget::Turns;
    let label = if turns { "依頼" } else { "セッション" };
    let info = list_chat_parts(&p.out, &p.notes, o.target)?;
    let all_parts = info.parts.clone().unwrap_or_default();
    if !info.exists || all_parts.is_empty() {
        bail!("添付ファイルがまだありません。先に「添付ファイルを作る」(atlas {})を実行してください", o.target.bundle_command());
    }
    let pending: Vec<_> = all_parts.iter().filter(|x| x.judged < x.sessions).collect();
    let todo: Vec<_> = match o.limit {
        Some(l) => pending.iter().take(l as usize).copied().collect(),
        None => pending.clone(),
    };
    let mut summary = M365Summary::default();
    if todo.is_empty() {
        log(&format!("m365: 未判定の添付ファイルはありません({} ファイルとも判定済み)", all_parts.len()));
        return Ok(summary);
    }
    log(&format!("m365: 未判定の添付ファイル {} 個のうち {} 個を、M365 Copilot({})で 1 つずつ判定します。終わるまで M365 Copilot の画面に触らないでください", pending.len(), todo.len(), o.model));
    log("m365: 添付したファイルは、M365 Copilot の決まりどおり OneDrive に入ります");
    let known = if p.sessions.exists() { read_sessions_value(&p.sessions)? } else { vec![] };
    let known_ids: HashSet<String> = known.iter().filter_map(|s| s.get("id").and_then(Value::as_str).map(str::to_string)).collect();
    let tbs = turns_by_session(&known);
    let phases = if turns { turn_import_phases(&p.turn_bundle, &phase_names()?) } else { vec![] };
    let replies_dir = p.out.join(o.target.dir_name()).join("replies");
    std::fs::create_dir_all(&replies_dir)?;
    // 添付に使う一時のファイルと画面を操作するスクリプトは、終わったら消す(TempDir を落とすと消える)
    let work = mkdtemp("atlas-m365-")?;
    let script = work.path().join("m365-uia.ps1");
    std::fs::write(&script, M365_SCRIPT)?;
    for (i, part) in todo.iter().enumerate() {
        let name = chat_save_name(o.target, &part.name);
        let attach = work.path().join(&name);
        let reply = replies_dir.join(format!("{}.md", name.strip_suffix(".txt").unwrap_or(&name)));
        std::fs::copy(atlas_core::jsfs::join_slash(&p.out, &part.path), &attach)?;
        atlas_core::jsfs::rm_force(&reply)?;
        log(&format!("m365: [{}/{}] {name}({label} {} 件が未判定)を送ります", i + 1, todo.len(), part.sessions - part.judged));
        summary.attempted += 1;
        let progress = |m: &str| log(&format!("m365:   {m}"));
        // 利用者がほかのアプリで作業していると、画面の操作が途中で崩れることがある。新しいチャットからやり直す(画面が無いときはやり直さない)
        let tries = 1 + o.retries.unwrap_or(2);
        let mut failure: Option<anyhow::Error> = None;
        for t in 1..=tries {
            if t > 1 {
                log(&format!("m365:   {name} をやり直します({t}/{tries} 回目)"));
                pause(Duration::from_millis(5000));
                atlas_core::jsfs::rm_force(&reply)?;
            }
            match driver(&M365Request { attach: attach.clone(), prompt: CHAT_REQUEST, model: &o.model, timeout_sec: o.timeout_sec, out_file: reply.clone(), on_progress: &progress, script: &script }) {
                Ok(()) => {
                    failure = None;
                    break;
                }
                Err(e) => {
                    let fatal = e.downcast_ref::<M365FatalError>().is_some();
                    if !fatal && t < tries {
                        log(&format!("m365:   画面の操作が崩れました: {e}"));
                    }
                    failure = Some(e);
                    if fatal {
                        break;
                    }
                }
            }
        }
        if let Some(e) = failure {
            // 画面の状態が分からないので、残りは送らない
            summary.failed.push(M365Failure { name: name.clone(), reason: e.to_string() });
            summary.stopped = todo.len() > i + 1;
            log(&format!("m365: {name} で画面の操作が止まりました: {e}"));
            break;
        }
        // 画面から読んだ文字はコードブロックの囲みが無く、行番号とボタンの名前が混じる。組み立て直したものを残して取り込む(読んだままの文字も残す)
        let raw = if reply.exists() { atlas_judge::read_text(&reply)? } else { String::new() };
        let text = clean_copilot_reply(&raw);
        std::fs::write(replies_dir.join(format!("{}.raw.txt", name.strip_suffix(".txt").unwrap_or(&name))), &raw)?;
        std::fs::write(&reply, &text)?;
        let r = match o.target {
            ChatTarget::Turns => import_turn_judgments_text(&text, &p.turn_judgments, TurnImportOptions { phases: &phases, turns_by_session: Some(&tbs), now: None, backend: None, model: None }).map(|r| (r.imported, r.overwritten, Vec::new())),
            ChatTarget::Effort => import_judgments_text(&text, &p.judgments, ImportOptions { known_ids: Some(&known_ids), label: Some(name.clone()), now: None }).map(|r| (r.imported, r.overwritten, r.notes)),
            // 手動と、前に LLM で決めた紐づけは書かない(その知らせを注意に出す)
            ChatTarget::Tasks => crate::commands::tasks::import_task_links_text(&text, &p.notes, &p.out.join(o.target.dir_name())).map(|r| {
                let mut notes = r.notes.clone();
                if !r.kept_manual.is_empty() {
                    notes.push(format!("手動で紐づけてあるので書かなかったセッション {} 件", r.kept_manual.len()));
                }
                if !r.kept_llm.is_empty() {
                    notes.push(format!("前に LLM で紐づけてあるので書かなかったセッション {} 件", r.kept_llm.len()));
                }
                if !r.kept_machine.is_empty() {
                    notes.push(format!("答えは「どのタスクでもない」でしたが、機械がタスクに紐づけてあるので書かなかったセッション {} 件", r.kept_machine.len()));
                }
                (r.imported, 0, notes)
            }),
        };
        match r {
            Ok((imported, overwritten, notes)) => {
                summary.succeeded += 1;
                summary.imported += imported;
                log(&format!("m365: {name} の返答から {imported} 件を取り込みました(既存の上書き {overwritten} 件)"));
                // llm-wiki のページごとの判定の一部を捨てた(そのページは未判定)
                for n in notes {
                    log(&format!("m365:   注意 {n}"));
                }
            }
            Err(e) => {
                let problems: Vec<String> = e.downcast_ref::<JudgmentValidationError>().map(|v| v.problems.iter().take(5).cloned().collect()).unwrap_or_default();
                summary.failed.push(M365Failure { name: name.clone(), reason: e.to_string() });
                log(&format!(
                    "m365: {name} の返答を取り込めませんでした(何も書いていません): {e}{}",
                    if problems.is_empty() { String::new() } else { format!("\n{}", problems.iter().map(|x| format!("m365:   - {x}")).collect::<Vec<_>>().join("\n")) }
                ));
                log(&format!("m365:   返答は {} にあります(直して atlas {} で取り込めます)", reply.display(), o.target.import_command()));
            }
        }
    }
    drop(work);
    log(&format!(
        "m365: 完了 送った {} / 取り込めた {} / 取り込んだ{label} {} 件{}",
        summary.attempted,
        summary.succeeded,
        summary.imported,
        if summary.stopped { "(途中で止まったので、残りは送っていません)" } else { "" }
    ));
    Ok(summary)
}

/// コードブロックの上に出るボタン(この行の後ろから行番号つきの本文が始まる)
const CODE_TOOLBAR: [&str; 3] = ["コードをコピー", "Copy code", "Copy"];
/// コードブロックの上下に出る、本文ではない行(言語名の後ろのボタン・返答の下のボタン・画像などの置き換え文字)
const UI_LINES: [&str; 10] = ["その他のオプション", "More options", "応答のコピー", "Copy response", "気に入った点がある", "不満な点がある", "Like", "Dislike", "\u{FFFC}", ""];

static LANG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_+#-]{0,15}$").unwrap());
static BLANKS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());

/// M365 Copilot の画面から UI Automation で読んだ返答を、取り込める Markdown に直す。
/// 画面のコードブロックは「行番号(と行頭の空白)」の行と「その行の本文」の行が交互に並び、```json の囲みが無い。
/// 「コードをコピー」のボタンの後ろの、1 から続く行番号の並びを見つけ、本文の行を元の字下げでつなぎ直して ```json で囲む。
/// 行番号は 1 つずつ増えるものだけを行番号とみなす(本文に数字だけの行があっても崩さない)。それ以外の行はそのまま残す
pub fn clean_copilot_reply(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let trim = atlas_core::js::trim;
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let t = trim(lines[i]);
        if !CODE_TOOLBAR.contains(&t) {
            if t != "\u{FFFC}" {
                out.push(lines[i].to_string());
            }
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < lines.len() && UI_LINES.contains(&trim(lines[j])) {
            j += 1;
        }
        if lines.get(j).map(|l| trim(l)) != Some("1") {
            i += 1;
            continue;
        }
        // 直前の言語名(JSON など)の行は囲みの言語にする
        let lang = match out.last() {
            Some(last) if LANG_RE.is_match(trim(last)) => {
                let l = trim(&out.pop().unwrap()).to_ascii_lowercase();
                l
            }
            _ => String::new(),
        };
        let mut code: Vec<String> = Vec::new();
        let mut n = 1usize;
        let mut k = j;
        while k < lines.len() && trim(lines[k]) == n.to_string() {
            // 行番号の後ろの空白は、その行の字下げ
            let ns = n.to_string();
            let pos = lines[k].find(&ns).unwrap_or(0);
            let indent = &lines[k][pos + ns.len()..];
            k += 1;
            let mut body: Vec<&str> = Vec::new();
            // 本文の行の終わり: 次の行番号か、本文ではないボタンの行
            let ends = |line: &str| {
                let s = trim(line);
                s == (n + 1).to_string() || CODE_TOOLBAR.contains(&s) || (!s.is_empty() && UI_LINES.contains(&s))
            };
            while k < lines.len() && !ends(lines[k]) {
                body.push(lines[k]);
                k += 1;
            }
            // 画面のコードには、ノーブレークスペース(U+00A0)だけの行が混じることがある。JSON の空白として読めないので普通の空白にする
            code.push(format!("{indent}{}", body.join("")).replace('\u{00A0}', " "));
            n += 1;
        }
        out.push(format!("```{lang}"));
        out.extend(code);
        out.push("```".into());
        i = k;
    }
    let joined = BLANKS_RE.replace_all(&out.join("\n"), "\n\n").into_owned();
    format!("{}\n", trim(&joined))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    fn item(id: &str) -> Value {
        json!({
            "sessionId": id,
            "taskCategory": "feature",
            "taskSummary": "要約",
            "humanEffort": { "hours": 2, "low": 1, "high": 4, "confidence": 0.5, "rationale": "根拠" },
            "aiOutcome": { "completed": true, "quality": 4, "rework": 1, "rationale": "成果" },
            "instructionsEffect": { "score": 1, "evidence": "e" },
            "wikiEffect": { "score": 0, "evidence": "参照なし" },
            "skillsAgentsEffect": { "score": 0, "evidence": "参照なし" },
        })
    }

    fn reply(ids: &[&str]) -> String {
        format!("判定しました。\n```json\n{}\n```", json!({ "schemaVersion": 1, "judge": { "backend": "external", "model": "m365", "ranAt": null }, "items": ids.iter().map(|i| item(i)).collect::<Vec<_>>() }))
    }

    fn setup() -> (tempfile::TempDir, M365Paths) {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out");
        std::fs::create_dir_all(out.join("bundle").join("parts")).unwrap();
        for (n, ids) in [("part-01.md", "s1 s2"), ("part-02.md", "s3"), ("part-03.md", "s4")] {
            std::fs::write(out.join("bundle").join("parts").join(n), format!("# 指示\nパケット {ids}")).unwrap();
        }
        std::fs::write(
            out.join("bundle").join("manifest.json"),
            json!({
                "version": 1, "generatedAt": "2026-11-12T00:00:00.000Z", "scope": { "unjudged": "yes" }, "count": 4, "sessions": [],
                "parts": [
                    { "path": "parts/part-01.md", "sessions": ["s1", "s2"], "bytes": 30 },
                    { "path": "parts/part-02.md", "sessions": ["s3"], "bytes": 20 },
                    { "path": "parts/part-03.md", "sessions": ["s4"], "bytes": 20 }
                ]
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(out.join("sessions.json"), json!({ "version": 12, "sessions": [{"id": "s1"}, {"id": "s2"}, {"id": "s3"}, {"id": "s4"}] }).to_string()).unwrap();
        let p = M365Paths { sessions: out.join("sessions.json"), judgments: out.join("judgments.json"), turn_judgments: out.join("turn-judgments.json"), turn_bundle: out.join("turn-bundle"), notes: dir.path().join("notes"), out };
        (dir, p)
    }

    fn base(p: &Path) -> String {
        p.file_name().unwrap().to_string_lossy().into_owned()
    }

    /// 渡されたファイルの中のセッションを判定した返答を書く(bad の名前のファイルは形の合わない返答)
    fn recorder<'a>(calls: &'a RefCell<Vec<(String, String, String, u64)>>, bad: &'a [&'a str]) -> impl Fn(&M365Request<'_>) -> Result<()> + 'a {
        move |req| {
            calls.borrow_mut().push((base(&req.attach), req.prompt.to_string(), req.model.to_string(), req.timeout_sec));
            let text = std::fs::read_to_string(&req.attach)?;
            let ids: Vec<&str> = text.split('\n').nth(1).unwrap().trim_start_matches("パケット ").split(' ').collect();
            (req.on_progress)("送りました");
            assert!(req.script.exists());
            std::fs::write(&req.out_file, if bad.contains(&base(&req.attach).as_str()) { "すみません、判定できません。".to_string() } else { reply(&ids) })?;
            Ok(())
        }
    }

    #[test]
    fn sends_only_unjudged_parts_and_imports_replies() {
        let (_d, p) = setup();
        let calls = RefCell::new(vec![]);
        let logs = RefCell::new(Vec::<String>::new());
        let log = |m: &str| logs.borrow_mut().push(m.to_string());
        let o = |model: &str, limit: Option<u64>| M365Options { target: ChatTarget::Effort, model: model.into(), limit, timeout_sec: 60, retries: None };
        let rec = recorder(&calls, &["part-02.txt"]);
        let s = run_m365_judge(&p, &o(M365_DEFAULT_MODEL, None), &log, &rec, true, &|_| {}).unwrap();
        let names: Vec<String> = calls.borrow().iter().map(|c| c.0.clone()).collect();
        assert_eq!(names, ["part-01.txt", "part-02.txt", "part-03.txt"]);
        assert_eq!(calls.borrow()[0].1, CHAT_REQUEST);
        assert_eq!((calls.borrow()[0].2.as_str(), calls.borrow()[0].3), ("Think Deeper", 60));
        assert_eq!((s.attempted, s.succeeded, s.imported, s.stopped), (3, 2, 3, false));
        assert_eq!(s.failed.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["part-02.txt"]);
        let j: Value = serde_json::from_str(&std::fs::read_to_string(&p.judgments).unwrap()).unwrap();
        let mut ids: Vec<&str> = j["items"].as_array().unwrap().iter().map(|i| i["sessionId"].as_str().unwrap()).collect();
        ids.sort();
        assert_eq!(ids, ["s1", "s2", "s4"]);
        assert!(std::fs::read_to_string(p.out.join("bundle").join("replies").join("part-02.md")).unwrap().contains("判定できません"));
        assert!(logs.borrow().iter().any(|l| l.contains("送りました")));
        assert!(logs.borrow().iter().any(|l| l.contains("OneDrive")));

        // 2 回目は、まだ判定できていない part-02 だけを送る
        let again = RefCell::new(vec![]);
        let rec2 = recorder(&again, &[]);
        let s2 = run_m365_judge(&p, &o("Auto", None), &|_| {}, &rec2, true, &|_| {}).unwrap();
        assert_eq!(again.borrow().iter().map(|c| c.0.clone()).collect::<Vec<_>>(), ["part-02.txt"]);
        assert_eq!((s2.attempted, s2.succeeded, s2.imported, s2.failed.len()), (1, 1, 1, 0));
        let none = RefCell::new(vec![]);
        let rec3 = recorder(&none, &[]);
        assert_eq!(run_m365_judge(&p, &o("Auto", None), &|_| {}, &rec3, true, &|_| {}).unwrap().attempted, 0);
        assert!(none.borrow().is_empty());
    }

    /// タスクの紐づけ(tasks m365): 紐づけの無いセッションの添付ファイルを送り、返答を task-links.json に書く。
    /// 送る前に手動か LLM で紐づいたセッションは書かずに知らせ、返答は task-bundle/replies/ に残す。紐づいたファイルは次に送らない
    #[test]
    fn tasks_target_imports_links_and_reports_kept_sessions() {
        use atlas_judge::task_link::{build_task_bundle, LinkQuery, TaskBundleOptions};
        use atlas_report::tasks::links::{load_links, update_links, LinkSource, TaskLink};
        let (_d, p) = setup();
        let q = |id: &str| LinkQuery { session_id: id.into(), title: "題名".into(), prompts: vec!["直して".into()], candidates: vec![("T-1".into(), "一つ目".into()), ("T-2".into(), "二つ目".into())] };
        build_task_bundle(&[q("s1"), q("s2"), q("s3")], &TaskBundleOptions { bundle_dir: p.out.join("task-bundle"), per_part: Some(1), boundary: None, scope: Default::default(), now: None }).unwrap();
        // 束を作った後に、s2 は手動で、s3 は LLM で紐づいた
        let links_path = atlas_report::tasks::task_links_path(&p.notes);
        let link = |t: &str, source| TaskLink { task_ids: vec![t.into()], source, reason: String::new(), confidence: None, at: "t".into() };
        update_links(&links_path, |l| {
            l.links.insert("s2".into(), link("T-2", LinkSource::Manual));
            l.links.insert("s3".into(), link("T-2", LinkSource::Llm));
        })
        .unwrap();
        let calls = RefCell::new(Vec::<String>::new());
        // 添付の中のセッションに、候補の先頭を選んだ返答を書く
        let answer = |req: &M365Request<'_>| -> Result<()> {
            calls.borrow_mut().push(base(&req.attach));
            let text = std::fs::read_to_string(&req.attach)?;
            assert!(text.starts_with("# 管理ツールのタスクへの紐づけの指示"));
            let id = text.lines().find_map(|l| l.strip_prefix("- セッション ID: ")).unwrap().to_string();
            std::fs::write(&req.out_file, format!("決めました。\n```json\n{}\n```", json!({ "links": [{ "sessionId": id, "taskIds": ["T-1"], "confidence": 0.7, "reason": "画面から" }] })))?;
            Ok(())
        };
        let logs = RefCell::new(Vec::<String>::new());
        let log = |m: &str| logs.borrow_mut().push(m.to_string());
        let o = M365Options { target: ChatTarget::Tasks, model: "Think Deeper".into(), limit: None, timeout_sec: 60, retries: None };
        let s = run_m365_judge(&p, &o, &log, &answer, true, &|_| {}).unwrap();
        // s2 と s3 は紐づいているので送らない(取り込み済みのファイル)。s1 のファイルだけを送って取り込む
        assert_eq!(*calls.borrow(), ["tasks-part-01.txt"]);
        assert_eq!((s.attempted, s.succeeded, s.imported, s.failed.len()), (1, 1, 1, 0));
        let got = load_links(&links_path).file;
        assert_eq!((got.links["s1"].task_ids.clone(), got.links["s1"].source, got.links["s1"].reason.as_str()), (vec!["T-1".to_string()], LinkSource::Llm, "画面から"));
        assert_eq!(got.links["s2"].source, LinkSource::Manual);
        assert!(std::fs::read_to_string(p.out.join("task-bundle").join("replies").join("tasks-part-01.md")).unwrap().contains("\"sessionId\":\"s1\""));
        assert!(p.out.join("task-bundle").join("replies").join("tasks-part-01.raw.txt").exists());
        assert!(logs.borrow().iter().any(|l| l == "m365: tasks-part-01.txt の返答から 1 件を取り込みました(既存の上書き 0 件)"), "{:?}", logs.borrow());
        // 送る前に s1 が手動で、別の回では s3 が LLM で紐づいていたら、書かずに知らせる(ファイルは取り込めた扱い)
        update_links(&links_path, |l| {
            l.links.shift_remove("s2");
            l.links.shift_remove("s3");
        })
        .unwrap();
        let reply_for = |id: &'static str| move |req: &M365Request<'_>| -> Result<()> {
            std::fs::write(&req.out_file, format!("```json\n{}\n```", json!({ "links": [{ "sessionId": id, "taskIds": ["T-1"], "confidence": 0.7 }] })))?;
            Ok(())
        };
        // 送っている間に s2 が手動で紐づけられた
        let manual_meanwhile = |req: &M365Request<'_>| -> Result<()> {
            update_links(&links_path, |l| {
                l.links.insert("s2".into(), link("T-2", LinkSource::Manual));
            })
            .unwrap();
            reply_for("s2")(req)
        };
        let logs2 = RefCell::new(Vec::<String>::new());
        let log2 = |m: &str| logs2.borrow_mut().push(m.to_string());
        let s2 = run_m365_judge(&p, &M365Options { limit: Some(1), ..o }, &log2, &manual_meanwhile, true, &|_| {}).unwrap();
        assert_eq!((s2.succeeded, s2.imported), (1, 0));
        assert!(logs2.borrow().iter().any(|l| l == "m365:   注意 手動で紐づけてあるので書かなかったセッション 1 件"), "{:?}", logs2.borrow());
        let llm_meanwhile = |req: &M365Request<'_>| -> Result<()> {
            update_links(&links_path, |l| {
                l.links.insert("s3".into(), link("T-2", LinkSource::Llm));
            })
            .unwrap();
            reply_for("s3")(req)
        };
        let logs3 = RefCell::new(Vec::<String>::new());
        let log3 = |m: &str| logs3.borrow_mut().push(m.to_string());
        let s3 = run_m365_judge(&p, &M365Options { target: ChatTarget::Tasks, model: "Think Deeper".into(), limit: None, timeout_sec: 60, retries: None }, &log3, &llm_meanwhile, true, &|_| {}).unwrap();
        assert_eq!((s3.succeeded, s3.imported), (1, 0));
        assert!(logs3.borrow().iter().any(|l| l == "m365:   注意 前に LLM で紐づけてあるので書かなかったセッション 1 件"), "{:?}", logs3.borrow());
        // 全部紐づいたら、送るファイルは無い
        assert_eq!(run_m365_judge(&p, &M365Options { target: ChatTarget::Tasks, model: "Think Deeper".into(), limit: None, timeout_sec: 60, retries: None }, &|_| {}, &answer, true, &|_| {}).unwrap().attempted, 0);
    }

    /// 画面が見つからないときはやり直さず、残りのファイルも送らない。--limit で送る数を絞れる。Windows 以外と、添付ファイルが無いときは止まる
    #[test]
    fn stops_after_fatal_driver_failure_and_limits() {
        let (_d, p) = setup();
        let calls = RefCell::new(Vec::<String>::new());
        let broken = |req: &M365Request<'_>| -> Result<()> {
            calls.borrow_mut().push(base(&req.attach));
            Err(M365FatalError("M365 Copilot の画面が見つかりません".into()).into())
        };
        let o = |target, limit| M365Options { target, model: "Think Deeper".into(), limit, timeout_sec: 60, retries: None };
        let s = run_m365_judge(&p, &o(ChatTarget::Effort, None), &|_| {}, &broken, true, &|_| {}).unwrap();
        assert_eq!(*calls.borrow(), ["part-01.txt"]);
        assert_eq!((s.attempted, s.succeeded, s.stopped), (1, 0, true));
        assert_eq!(s.failed, vec![M365Failure { name: "part-01.txt".into(), reason: "M365 Copilot の画面が見つかりません".into() }]);
        let limited = RefCell::new(vec![]);
        let rec = recorder(&limited, &[]);
        let s = run_m365_judge(&p, &o(ChatTarget::Effort, Some(1)), &|_| {}, &rec, true, &|_| {}).unwrap();
        assert_eq!((s.attempted, s.succeeded), (1, 1));
        assert!(run_m365_judge(&p, &o(ChatTarget::Effort, None), &|_| {}, &rec, false, &|_| {}).unwrap_err().to_string().contains("Windows でだけ"));
        assert!(run_m365_judge(&p, &o(ChatTarget::Turns, None), &|_| {}, &rec, true, &|_| {}).unwrap_err().to_string().contains("添付ファイルがまだありません"));
    }

    /// 画面の操作が途中で崩れたら、同じファイルを既定で 2 回までやり直す。やり直しても崩れたら残りを送らない
    #[test]
    fn retries_part_when_driver_breaks_midway() {
        let (_d, p) = setup();
        let o = |retries| M365Options { target: ChatTarget::Effort, model: "Think Deeper".into(), limit: None, timeout_sec: 60, retries };
        // part-01 は 1 回目だけ崩れる → やり直しで通り、次へ進む
        let calls = RefCell::new(Vec::<String>::new());
        let logs = RefCell::new(Vec::<String>::new());
        let paused = RefCell::new(Vec::<Duration>::new());
        let ok_calls = RefCell::new(vec![]);
        let ok = recorder(&ok_calls, &[]);
        let flaky = |req: &M365Request<'_>| -> Result<()> {
            calls.borrow_mut().push(base(&req.attach));
            if calls.borrow().len() == 1 {
                bail!("添付した part-01.txt が 120 秒たっても見つかりません");
            }
            ok(req)
        };
        let s = run_m365_judge(&p, &o(None), &|m| logs.borrow_mut().push(m.to_string()), &flaky, true, &|d| paused.borrow_mut().push(d)).unwrap();
        assert_eq!(*calls.borrow(), ["part-01.txt", "part-01.txt", "part-02.txt", "part-03.txt"]);
        assert_eq!((s.attempted, s.succeeded, s.imported, s.stopped), (3, 3, 4, false));
        assert!(s.failed.is_empty());
        assert!(logs.borrow().iter().any(|l| l.contains("やり直します(2/3 回目)")));
        assert!(logs.borrow().iter().any(|l| l.contains("画面の操作が崩れました: 添付した part-01.txt が 120 秒たっても見つかりません")));
        assert_eq!(*paused.borrow(), [Duration::from_millis(5000)]);

        // 毎回崩れる → 3 回送って止まる。retries: Some(0) ならやり直さない
        std::fs::remove_file(&p.judgments).unwrap();
        let always = RefCell::new(Vec::<String>::new());
        let broken = |req: &M365Request<'_>| -> Result<()> {
            always.borrow_mut().push(base(&req.attach));
            bail!("送ってから 180 秒たっても返答が始まりません")
        };
        let s = run_m365_judge(&p, &o(None), &|_| {}, &broken, true, &|_| {}).unwrap();
        assert_eq!((s.attempted, s.stopped), (1, true));
        assert_eq!(s.failed.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["part-01.txt"]);
        assert_eq!(*always.borrow(), ["part-01.txt", "part-01.txt", "part-01.txt"]);
        always.borrow_mut().clear();
        run_m365_judge(&p, &o(Some(0)), &|_| {}, &broken, true, &|_| {}).unwrap();
        assert_eq!(*always.borrow(), ["part-01.txt"]);
    }

    #[test]
    fn cleans_reply_read_from_screen() {
        let raw = ["\u{FFFC}", "判定しました。", "JSON", "コードをコピー", "その他のオプション", "\u{FFFC}", "1", "{", "2  ", "\"items\": [", "3    ", "7,", "4    ", "8", "5  ", "]", "6", "}", "応答のコピー", "気に入った点がある", "不満な点がある", "\u{FFFC}", "その他のオプション"].join("\n");
        let md = clean_copilot_reply(&raw);
        assert!(md.contains("判定しました。"));
        assert!(md.contains("```json\n{\n  \"items\": [\n    7,\n    8\n  ]\n}\n```"), "{md}");
        assert!(!md.contains('\u{FFFC}'));
        // ノーブレークスペースだけの行(画面のコードに混じる)は、JSON として読めるように普通の空白にする
        let nbsp = clean_copilot_reply(&["コードをコピー", "1", "[", "2  ", "7,", "3", "\u{00A0}", "4  ", "8", "5", "]"].join("\n"));
        let body = nbsp.split("```\n").nth(1).and_then(|b| b.split("\n```").next()).unwrap();
        assert_eq!(serde_json::from_str::<Value>(body).unwrap(), json!([7, 8]), "{nbsp}");
        assert_eq!(clean_copilot_reply("すみません、判定できません。"), "すみません、判定できません。\n");
    }

    #[test]
    fn script_is_embedded_with_bom_and_request_matches_ui() {
        assert_eq!(&M365_SCRIPT[..3], &[0xef, 0xbb, 0xbf]);
        let ui = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/report/src/app/components/ChatJudge.svelte")).unwrap();
        assert!(ui.contains(&format!("const REQUEST = '{CHAT_REQUEST}';")));
    }
}
