//! 評価バンドルの生成(packages/judge/src/bundle.ts の移植):
//! <bundleDir>/sessions/<id>.md + manifest.json + INSTRUCTIONS.md + schema.json + parts/part-<番号>.md。
//! ZIP は作らない。フォルダごと ZIP にして外部 LLM に渡すか、ZIP を渡せない相手(M365 Copilot のようにテキストの添付だけ)には
//! parts/ のファイルを 1 つずつ渡す。

use crate::packet::{collect_texts, excerpt_texts, has_request, render_packet, PacketLimits, SessionTexts, TextSource, DEFAULT_LIMITS};
use crate::rubric::{packet_boundary, render_instructions, render_part_instructions, PartInstructions};
use crate::schema::judgments_json_schema;
use anyhow::{anyhow, bail, Result};
use atlas_core::collate::locale_compare;
use atlas_core::fs_retry::replace_entries;
use atlas_core::types::SessionRecord;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const BUNDLE_MANIFEST_VERSION: i64 = 1;

/// 1 つの分割ファイルに入れるパケットの既定の数。1 パケットは最大 24,000 字なので、1 ファイル最大 12 万字ほど
pub const DEFAULT_PER_PART: usize = 5;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleEntry {
    pub id: String,
    /// バンドルからの相対パス(/ 区切り)
    pub path: String,
    pub project: String,
    pub client: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub turns: i64,
    pub chars: i64,
    pub bytes: i64,
    pub text_source: TextSource,
    /// 上限で中略した本文の件数
    pub truncated: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BundleFiles {
    pub instructions: String,
    pub schema: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Skipped {
    pub id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BundlePart {
    pub path: String,
    pub sessions: Vec<String>,
    pub bytes: i64,
}

/// 読むときは欠けた項目を既定値で補う(TS 版は読む側で形を確かめない。version と sessions だけは read_bundle_manifest で確かめる)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BundleManifest {
    pub version: i64,
    pub generated_at: String,
    /// 絞り込み条件など(表示用)
    #[serde(default)]
    pub scope: IndexMap<String, Option<String>>,
    pub count: i64,
    pub total_bytes: i64,
    pub max_bytes: i64,
    pub limits: PacketLimits,
    pub files: BundleFiles,
    pub sessions: Vec<BundleEntry>,
    /// 依頼が無くて対象外にしたセッション
    pub skipped: Vec<Skipped>,
    /// 1 つの分割ファイル(parts/)に入れるパケットの数。古い manifest には無い
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_part: Option<i64>,
    /// 指示とパケットを数件ずつまとめた分割ファイル。並びは sessions と同じ。古い manifest には無い
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<BundlePart>>,
}

impl Default for BundleManifest {
    fn default() -> Self {
        BundleManifest {
            version: BUNDLE_MANIFEST_VERSION,
            generated_at: String::new(),
            scope: IndexMap::new(),
            count: 0,
            total_bytes: 0,
            max_bytes: 0,
            limits: DEFAULT_LIMITS,
            files: BundleFiles { instructions: "INSTRUCTIONS.md".into(), schema: "schema.json".into() },
            sessions: vec![],
            skipped: vec![],
            per_part: None,
            parts: None,
        }
    }
}

pub struct BundleOptions<'a> {
    /// 出力先(既定は <out>/bundle)
    pub bundle_dir: PathBuf,
    /// 本文を読み直すスナップショット(無ければ sessions.json の抜粋で代用)
    pub snapshot_dir: Option<PathBuf>,
    pub limits: Option<PacketLimits>,
    /// 依頼の無いセッションも含める
    pub include_empty: bool,
    /// 1 つの分割ファイルに入れるパケットの数(既定 DEFAULT_PER_PART)
    pub per_part: Option<usize>,
    /// テスト用: 分割ファイルの境界の文字列を作る
    pub boundary: Option<&'a dyn Fn() -> Result<String>>,
    pub scope: IndexMap<String, Option<String>>,
    pub log: &'a (dyn Fn(&str) + Sync),
    /// 生成時刻(ISO)。None なら今
    pub now: Option<String>,
}

/// `id.replace(/[^A-Za-z0-9._-]/g, '_') + '.md'`(UTF-16 の単位ごとに置き換える)
pub fn packet_file_name(id: &str) -> String {
    let mut s = String::with_capacity(id.len() + 3);
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            s.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                s.push('_');
            }
        }
    }
    s.push_str(".md");
    s
}

/// 入れ替える名前。先頭が一覧(manifest.json)。ここに無いもの(利用者が --bundle で指した先にあった別のファイル)には触らない
const BUNDLE_ENTRIES: [&str; 5] = ["manifest.json", "sessions", "parts", "INSTRUCTIONS.md", "schema.json"];

/// 作りかけの場所に全部を作ってから、前のものと入れ替える(絞り込みで減ったパケットは残らない)。
/// 途中で失敗したり止められたりしても、前に作ったものはそのまま使える
pub fn build_bundle(sessions: &[&SessionRecord], opts: &BundleOptions<'_>) -> Result<BundleManifest> {
    let per_part = opts.per_part.unwrap_or(DEFAULT_PER_PART);
    if per_part < 1 {
        bail!("perPart は 1 以上の整数です: {per_part}");
    }
    replace_entries(&opts.bundle_dir, &BUNDLE_ENTRIES, |dir| write_bundle(sessions, opts, dir, per_part))
}

fn write_bundle(sessions: &[&SessionRecord], opts: &BundleOptions<'_>, dir: &Path, per_part: usize) -> Result<BundleManifest> {
    let log = opts.log;
    let limits = opts.limits.unwrap_or(DEFAULT_LIMITS);
    let generated_at = opts.now.clone().unwrap_or_else(atlas_core::jsdate::now_iso);

    let mut texts: HashMap<String, SessionTexts> = HashMap::new();
    match &opts.snapshot_dir {
        Some(sd) if sd.join("session-state").exists() => texts = collect_texts(sd, sessions, None)?,
        _ => log(&format!(
            "bundle: 注意 スナップショット{}が無いため、本文は sessions.json の抜粋(先頭・末尾 2,000 字)で代用します",
            opts.snapshot_dir.as_ref().map(|d| format!("({})", d.display())).unwrap_or_default()
        )),
    }

    std::fs::create_dir_all(dir.join("sessions"))?;

    let mut entries: Vec<BundleEntry> = Vec::new();
    let mut markdowns: HashMap<String, String> = HashMap::new();
    let mut skipped: Vec<Skipped> = Vec::new();
    for s in sessions {
        let ex;
        let t = match texts.get(&s.id) {
            Some(t) => t,
            None => {
                ex = excerpt_texts(s);
                &ex
            }
        };
        if !opts.include_empty && !has_request(s, Some(t)) {
            skipped.push(Skipped { id: s.id.clone(), reason: "ユーザーの依頼が記録されていない".into() });
            continue;
        }
        let p = render_packet(s, t, &limits)?;
        let file = packet_file_name(&s.id);
        let bytes = p.markdown.len() as i64;
        std::fs::write(dir.join("sessions").join(&file), &p.markdown)?;
        markdowns.insert(s.id.clone(), p.markdown);
        entries.push(BundleEntry {
            id: s.id.clone(),
            path: format!("sessions/{file}"),
            project: s.project.clone(),
            client: s.client.clone(),
            created_at: s.created_at.clone(),
            updated_at: s.updated_at.clone(),
            turns: s.turns,
            chars: p.chars,
            bytes,
            text_source: t.source,
            truncated: p.truncated,
        });
    }
    entries.sort_by(|a, b| locale_compare(a.created_at.as_deref().unwrap_or(""), b.created_at.as_deref().unwrap_or("")).then_with(|| locale_compare(&a.id, &b.id)));

    let schema_json = format!("{}\n", atlas_core::json::to_js_string_pretty(&judgments_json_schema())?);
    let mut parts: Vec<BundlePart> = Vec::new();
    let part_count = entries.len().div_ceil(per_part);
    if part_count > 0 {
        std::fs::create_dir_all(dir.join("parts"))?;
    }
    let width = 2.max(part_count.to_string().len());
    for i in 0..part_count {
        let chunk = &entries[i * per_part..((i + 1) * per_part).min(entries.len())];
        let boundary = match opts.boundary {
            Some(f) => f()?,
            None => packet_boundary(),
        };
        let ids: Vec<&str> = chunk.iter().map(|e| e.id.as_str()).collect();
        let head = render_part_instructions(&PartInstructions { part: i + 1, parts: part_count, ids: &ids, total: entries.len(), generated_at: &generated_at, boundary: &boundary, schema_json: &schema_json });
        let mut md = head;
        for e in chunk {
            md.push_str(&format!("\n<<<PACKET_BEGIN {boundary}\n{}\nPACKET_END {boundary}>>>\n", atlas_core::js::trim_end(&markdowns[&e.id])));
        }
        let path = format!("parts/part-{:0width$}.md", i + 1);
        std::fs::write(dir.join("parts").join(format!("part-{:0width$}.md", i + 1)), &md)?;
        parts.push(BundlePart { path, sessions: ids.iter().map(|s| s.to_string()).collect(), bytes: md.len() as i64 });
    }

    let manifest = BundleManifest {
        version: BUNDLE_MANIFEST_VERSION,
        generated_at: generated_at.clone(),
        scope: opts.scope.clone(),
        count: entries.len() as i64,
        total_bytes: entries.iter().map(|e| e.bytes).sum(),
        max_bytes: entries.iter().map(|e| e.bytes).max().unwrap_or(0),
        limits,
        files: BundleFiles { instructions: "INSTRUCTIONS.md".into(), schema: "schema.json".into() },
        sessions: entries,
        skipped,
        per_part: Some(per_part as i64),
        parts: Some(parts),
    };
    std::fs::write(dir.join("INSTRUCTIONS.md"), render_instructions(manifest.count as usize, &generated_at))?;
    std::fs::write(dir.join("schema.json"), &schema_json)?;
    std::fs::write(dir.join("manifest.json"), format!("{}\n", atlas_core::json::to_js_string_pretty(&manifest)?))?;
    Ok(manifest)
}

pub fn read_bundle_manifest(bundle_dir: &Path) -> Result<BundleManifest> {
    let p = bundle_dir.join("manifest.json");
    if !p.exists() {
        bail!("{} がありません。先に atlas bundle を実行してください。", p.display());
    }
    let text = std::fs::read(&p)?;
    let v = atlas_core::js::parse_json(&String::from_utf8_lossy(&text)).map_err(|e| anyhow!("{}: {e}", p.display()))?;
    let version = v.get("version");
    if version.and_then(|x| x.as_f64()) != Some(BUNDLE_MANIFEST_VERSION as f64) || !v.get("sessions").is_some_and(|s| s.is_array()) {
        bail!("{} の形式が想定と違います(version {})", p.display(), version.map_or_else(|| "undefined".into(), atlas_core::js::to_js_string));
    }
    serde_json::from_value(v).map_err(|e| anyhow!("{} の形式が想定と違います({e})", p.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names() {
        assert_eq!(packet_file_name("ab-1.x_y"), "ab-1.x_y.md");
        assert_eq!(packet_file_name("a/b c"), "a_b_c.md");
        assert_eq!(packet_file_name("😀"), "__.md");
    }
}
