//! チャットで判定する添付ファイル(bundle/parts/・turn-bundle/parts/)の一覧と、その中の判定済みの数(packages/cli/src/chat-parts.ts の移植)。
//! 画面の「チャットに貼って判定する」(serve の /api/judge/parts)と、M365 Copilot の自動操作(m365.rs)が使う。

use anyhow::{anyhow, Result};
use atlas_judge::bundle::read_bundle_manifest;
use atlas_judge::turn_run::read_turn_bundle_manifest;
use atlas_judge::turn_schema::read_turn_judgments;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

/// 判定するもの(工数はセッションごと、turns は依頼ごと)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatTarget {
    Effort,
    Turns,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChatPart {
    /// 出力先からの相対パス(bundle/parts/part-001.md など)
    pub path: String,
    pub name: String,
    /// 中のセッションの数(turns は依頼の数)
    pub sessions: i64,
    /// そのうち判定済みの数
    pub judged: i64,
    pub bytes: i64,
    /// 依頼の判定で、セッションの最後の依頼だけのファイルか(採用は判定不能で、種類と工程だけが決まる)。古い添付には無い
    #[serde(rename = "lastOnly", skip_serializing_if = "Option::is_none")]
    pub last_only: Option<bool>,
}

/// 依頼の判定で、採用を判定できる依頼の数(turns)と、それが入っている先頭のファイルの数(parts)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ChatDecidable {
    pub turns: i64,
    pub parts: i64,
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
}

impl ChatParts {
    fn none() -> Self {
        ChatParts { exists: false, generated_at: None, unjudged_only: None, count: None, parts: None, decidable: None }
    }
}

/// judgments.json にあるセッション id(無ければ空。読めなければ例外)
pub fn judged_session_ids(out_dir: &Path) -> Result<HashSet<String>> {
    let mut judged = HashSet::new();
    let jp = out_dir.join("judgments.json");
    if jp.exists() {
        let v = atlas_judge::read_text(&jp).and_then(|t| atlas_core::js::parse_json(&t).map_err(anyhow::Error::from)).map_err(|e| anyhow!("judgments.json を読めません: {e}"))?;
        for it in v.get("items").and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = it.get("sessionId").and_then(Value::as_str) {
                judged.insert(id.to_string());
            }
        }
    }
    Ok(judged)
}

/// turn-judgments.json の判定済みの依頼(セッション ID#依頼番号)
pub fn judged_turn_keys(out_dir: &Path) -> Result<HashSet<String>> {
    let j = read_turn_judgments(&out_dir.join("turn-judgments.json")).map_err(|e| anyhow!("turn-judgments.json を読めません: {e}"))?;
    Ok(j.map(|j| j.items.iter().map(|i| format!("{}#{}", i.session_id, i.turn)).collect()).unwrap_or_default())
}

fn name_of(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// 添付ファイルの一覧(manifest にあって、ファイルが残っているもの)。manifest が読めなければ例外
pub fn list_chat_parts(out_dir: &Path, target: ChatTarget) -> Result<ChatParts> {
    if target == ChatTarget::Turns {
        let dir = out_dir.join("turn-bundle");
        if !dir.join("manifest.json").exists() {
            return Ok(ChatParts::none());
        }
        let m = read_turn_bundle_manifest(&dir)?;
        let judged = judged_turn_keys(out_dir)?;
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
        return Ok(ChatParts {
            exists: true,
            generated_at: Some(m.generated_at),
            unjudged_only: Some(m.unjudged_only),
            count: Some(m.count),
            parts: Some(parts),
            decidable: d.map(|d| ChatDecidable { turns: d.turns, parts: d.parts }),
        });
    }
    let dir = out_dir.join("bundle");
    if !dir.join("manifest.json").exists() {
        return Ok(ChatParts::none());
    }
    let m = read_bundle_manifest(&dir)?;
    let judged = judged_session_ids(out_dir)?;
    let parts = m
        .parts
        .iter()
        .flatten()
        .filter(|p| atlas_core::jsfs::join_slash(&dir, &p.path).exists())
        .map(|p| ChatPart { path: format!("bundle/{}", p.path), name: name_of(&p.path), sessions: p.sessions.len() as i64, judged: p.sessions.iter().filter(|id| judged.contains(*id)).count() as i64, bytes: p.bytes, last_only: None })
        .collect();
    let unjudged = m.scope.get("unjudged").and_then(|v| v.as_deref()) == Some("yes");
    Ok(ChatParts { exists: true, generated_at: Some(m.generated_at), unjudged_only: Some(unjudged), count: Some(m.count), parts: Some(parts), decidable: None })
}

/// 保存・添付するときの名前(相手のチャットが .md を添付として受け付けるか分からないので .txt にする。中身は同じ)。画面の ChatJudge と同じ
pub fn chat_save_name(target: ChatTarget, name: &str) -> String {
    let base = name.strip_suffix(".md").map(|b| format!("{b}.txt")).unwrap_or_else(|| name.to_string());
    format!("{}{base}", if target == ChatTarget::Turns { "turns-" } else { "" })
}

/// チャットに添付ファイルと一緒に送る依頼文(画面の ChatJudge と同じ)
pub const CHAT_REQUEST: &str = "添付したファイルの指示に従って判定し、JSON を返してください。";
