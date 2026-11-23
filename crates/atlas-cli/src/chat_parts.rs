//! 外部の LLM に渡す添付ファイル(bundle/parts/・turn-bundle/parts/・task-bundle/parts/)の一覧と、その中の判定済みの数
//! (packages/cli/src/chat-parts.ts の移植)。画面の「チャットに貼って判定する」(serve の /api/judge/parts)と、M365 Copilot の自動操作(m365.rs)が使う。
//! 同じ束をまとめた ZIP(bundle.zip・turn-bundle.zip・task-bundle.zip。画面の「ZIP にまとめてエージェントに渡す」)があるかも返す。

use anyhow::{anyhow, Result};
use atlas_judge::bundle::read_bundle_manifest;
use atlas_judge::task_link::read_task_bundle_manifest;
use atlas_judge::turn_bundle::read_turn_bundle_manifest;
use atlas_judge::turn_schema::read_turn_judgments;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

/// 判定するもの(工数はセッションごと、turns は依頼ごと、tasks は管理ツールのタスクへの紐づけ。セッションごと)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatTarget {
    Effort,
    Turns,
    Tasks,
}

impl ChatTarget {
    /// 束のフォルダの名前(<out> の下。ZIP は <名前>.zip)
    pub fn dir_name(self) -> &'static str {
        match self {
            ChatTarget::Effort => "bundle",
            ChatTarget::Turns => "turn-bundle",
            ChatTarget::Tasks => crate::paths::TASK_BUNDLE_DIR,
        }
    }

    /// 束を作るコマンド(知らせの文に使う)
    pub fn bundle_command(self) -> &'static str {
        match self {
            ChatTarget::Effort => "bundle --unjudged",
            ChatTarget::Turns => "turns bundle --unjudged",
            ChatTarget::Tasks => "tasks bundle",
        }
    }

    /// 返答を取り込むコマンド
    pub fn import_command(self) -> &'static str {
        match self {
            ChatTarget::Effort => "judge import",
            ChatTarget::Turns => "turns import",
            ChatTarget::Tasks => "tasks import",
        }
    }

    /// 画面の ?target= の値
    pub fn parse(v: Option<&str>) -> ChatTarget {
        match v {
            Some("turns") => ChatTarget::Turns,
            Some("tasks") => ChatTarget::Tasks,
            _ => ChatTarget::Effort,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChatPart {
    /// 出力先からの相対パス(bundle/parts/part-001.md など)
    pub path: String,
    pub name: String,
    /// 中のセッションの数(turns は依頼の数)
    pub sessions: i64,
    /// そのうち判定済みの数(tasks は紐づけのあるセッションの数)
    pub judged: i64,
    pub bytes: i64,
    /// 依頼の判定で、セッションの最後の依頼だけのファイルか(採用は判定不能で、種類と工程だけが決まる)。古い添付には無い
    #[serde(rename = "lastOnly", skip_serializing_if = "Option::is_none")]
    pub last_only: Option<bool>,
}

/// 依頼の判定で、採用を判定できる依頼の数(turns)と、それが入っている先頭のファイルの数(parts)・先頭の塊の数(chunks。ZIP の中の chunks/)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ChatDecidable {
    pub turns: i64,
    pub parts: i64,
    pub chunks: i64,
}

/// 束をまとめた ZIP(今の束と同じ回に作ったものだけを返す)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatZip {
    /// 出力先からの相対パス(bundle.zip など)
    pub path: String,
    pub bytes: i64,
    /// ZIP を書いた日時
    pub modified_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatParts {
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unjudged_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<ChatPart>>,
    /// 依頼の判定で、採用を判定できる依頼が先頭の何ファイルまでか。古い添付には無い
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decidable: Option<ChatDecidable>,
    /// 今の束をまとめた ZIP(あるときだけ)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zip: Option<ChatZip>,
    /// ZIP の中の、判定済みの数(工数とタスクはセッション、依頼ごとは依頼。count のうち)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub judged: Option<i64>,
}

impl ChatParts {
    fn none() -> Self {
        ChatParts { exists: false, generated_at: None, unjudged_only: None, count: None, parts: None, decidable: None, zip: None, judged: None }
    }
}

/// 判定済みの数を数えるファイル(工数の判定・依頼ごとの判定・タスクの紐づけの場所)。
/// 開いたフォルダで設定のフォルダを使うときは、どれも設定のフォルダ(Paths の judgments・turn_judgments・tasks_dir)
#[derive(Debug, Clone, Copy)]
pub struct JudgedFiles<'a> {
    pub judgments: &'a Path,
    pub turn_judgments: &'a Path,
    /// task-links.json を置くフォルダ
    pub tasks_dir: &'a Path,
}

/// judgments.json にあるセッション id(無ければ空。読めなければ例外)
pub fn judged_session_ids(jp: &Path) -> Result<HashSet<String>> {
    let mut judged = HashSet::new();
    if jp.exists() {
        let v = atlas_judge::read_text(jp).and_then(|t| atlas_core::js::parse_json(&t).map_err(anyhow::Error::from)).map_err(|e| anyhow!("{} を読めません: {e}", jp.display()))?;
        for it in v.get("items").and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = it.get("sessionId").and_then(Value::as_str) {
                judged.insert(id.to_string());
            }
        }
    }
    Ok(judged)
}

/// turn-judgments.json の判定済みの依頼(セッション ID#依頼番号)
pub fn judged_turn_keys(path: &Path) -> Result<HashSet<String>> {
    let j = read_turn_judgments(path).map_err(|e| anyhow!("{} を読めません: {e}", path.display()))?;
    Ok(j.map(|j| j.items.iter().map(|i| format!("{}#{}", i.session_id, i.turn)).collect()).unwrap_or_default())
}

/// task-links.json に紐づけ(どの出所でも。「どのタスクでもない」も)があるセッション
pub fn linked_session_ids(notes_dir: &Path) -> HashSet<String> {
    atlas_report::tasks::links::load_links(&atlas_report::tasks::task_links_path(notes_dir)).file.links.keys().cloned().collect()
}

fn name_of(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// 添付ファイルの一覧(manifest にあって、ファイルが残っているもの)。manifest が読めなければ例外。
/// 判定済みの数は files の判定・紐づけから数える
pub fn list_chat_parts(out_dir: &Path, files: &JudgedFiles<'_>, target: ChatTarget) -> Result<ChatParts> {
    let dir = out_dir.join(target.dir_name());
    if !dir.join("manifest.json").exists() {
        return Ok(ChatParts::none());
    }
    match target {
        ChatTarget::Turns => {
            let m = read_turn_bundle_manifest(&dir)?;
            let judged = judged_turn_keys(files.turn_judgments)?;
            let d = m.decidable;
            let parts = m
                .parts
                .iter()
                .enumerate()
                // 先頭の d.parts ファイルが採用を判定できる依頼で、その後ろは最後の依頼だけ(消えたファイルを除く前の番号で決める)
                .filter(|(_, p)| atlas_core::jsfs::join_slash(&dir, &p.path).exists())
                .map(|(i, p)| ChatPart {
                    path: format!("turn-bundle/{}", p.path),
                    name: name_of(&p.path),
                    sessions: p.turns,
                    judged: p.chunks.iter().map(|c| c.turns.iter().filter(|t| judged.contains(&format!("{}#{t}", c.session_id))).count() as i64).sum(),
                    bytes: p.bytes,
                    last_only: d.map(|d| i as i64 >= d.parts),
                })
                .collect();
            let done = m.chunks.iter().map(|c| c.turns.iter().filter(|t| judged.contains(&format!("{}#{t}", c.session_id))).count() as i64).sum();
            Ok(ChatParts {
                exists: true,
                generated_at: Some(m.generated_at),
                unjudged_only: Some(m.unjudged_only),
                count: Some(m.count),
                parts: Some(parts),
                decidable: d.map(|d| ChatDecidable { turns: d.turns, parts: d.parts, chunks: d.chunks }),
                zip: bundle_zip(out_dir, &dir, target),
                judged: Some(done),
            })
        }
        ChatTarget::Tasks => {
            let m = read_task_bundle_manifest(&dir)?;
            let linked = linked_session_ids(files.tasks_dir);
            let parts = m
                .parts
                .iter()
                .filter(|p| atlas_core::jsfs::join_slash(&dir, &p.path).exists())
                .map(|p| ChatPart { path: format!("{}/{}", target.dir_name(), p.path), name: name_of(&p.path), sessions: p.sessions.len() as i64, judged: p.sessions.iter().filter(|id| linked.contains(*id)).count() as i64, bytes: p.bytes, last_only: None })
                .collect();
            let done = m.sessions.iter().filter(|e| linked.contains(&e.id)).count() as i64;
            // 束はいつも紐づけの無いセッションだけで作る
            Ok(ChatParts { exists: true, generated_at: Some(m.generated_at), unjudged_only: Some(true), count: Some(m.count), parts: Some(parts), decidable: None, zip: bundle_zip(out_dir, &dir, target), judged: Some(done) })
        }
        ChatTarget::Effort => {
            let m = read_bundle_manifest(&dir)?;
            let judged = judged_session_ids(files.judgments)?;
            let parts = m
                .parts
                .iter()
                .flatten()
                .filter(|p| atlas_core::jsfs::join_slash(&dir, &p.path).exists())
                .map(|p| ChatPart { path: format!("bundle/{}", p.path), name: name_of(&p.path), sessions: p.sessions.len() as i64, judged: p.sessions.iter().filter(|id| judged.contains(*id)).count() as i64, bytes: p.bytes, last_only: None })
                .collect();
            let unjudged = m.scope.get("unjudged").and_then(|v| v.as_deref()) == Some("yes");
            let done = m.sessions.iter().filter(|e| judged.contains(&e.id)).count() as i64;
            Ok(ChatParts { exists: true, generated_at: Some(m.generated_at), unjudged_only: Some(unjudged), count: Some(m.count), parts: Some(parts), decidable: None, zip: bundle_zip(out_dir, &dir, target), judged: Some(done) })
        }
    }
}

/// 今の束をまとめた ZIP(出力先の直下の <束の名前>.zip。bundle・turns bundle・tasks bundle の --zip が既定の束の隣に書くもの)。
/// 束の一覧(manifest.json)より前に書かれた ZIP は、前の束の中身なので無いものとして扱う
/// (--zip なしで束を作り直すと ZIP は消すが、消せなかったときと、消さなかった古い版が残したものに備える)
fn bundle_zip(out_dir: &Path, bundle_dir: &Path, target: ChatTarget) -> Option<ChatZip> {
    let name = format!("{}.zip", target.dir_name());
    let zip = std::fs::metadata(out_dir.join(&name)).ok().filter(|m| m.is_file())?;
    let manifest = std::fs::metadata(bundle_dir.join("manifest.json")).ok()?;
    if atlas_core::jsfs::mtime_ms(&zip) < atlas_core::jsfs::mtime_ms(&manifest) {
        return None;
    }
    Some(ChatZip { path: name, bytes: zip.len() as i64, modified_at: atlas_core::jsfs::mtime_iso(&zip) })
}

/// 保存・添付するときの名前(相手のチャットが .md を添付として受け付けるか分からないので .txt にする。中身は同じ)。画面の ChatJudge と同じ
pub fn chat_save_name(target: ChatTarget, name: &str) -> String {
    let base = name.strip_suffix(".md").map(|b| format!("{b}.txt")).unwrap_or_else(|| name.to_string());
    let prefix = match target {
        ChatTarget::Effort => "",
        ChatTarget::Turns => "turns-",
        ChatTarget::Tasks => "tasks-",
    };
    format!("{prefix}{base}")
}

/// チャットに添付ファイルと一緒に送る依頼文(画面の ChatJudge と同じ)
pub const CHAT_REQUEST: &str = "添付したファイルの指示に従って判定し、JSON を返してください。";
