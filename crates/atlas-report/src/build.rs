//! Node 側の build(packages/report/src/build.ts の移植): テンプレート(dist/template.html)にデータを埋め込んで out/atlas.html を書き、
//! out/sessions/<id>.html(詳細)・glossary.html・insights.html / insights.json と、export のときはセッション記録(.md)・全文記録・閲覧ページを書く。
//!
//! TS 版はセッションを 1 件ずつ順に処理していた。Rust 版は次の順で、重いところを rayon で並べる(出力は同じ):
//!   1. 要約(summarize・pack)を並べて作り、atlas.html などを書く
//!   2. セッションごとに events.jsonl を 1 回読み、記録(.md)と全文記録の本体を並べて書く(閲覧ページに集める本文は、イベントの順のまま持ち帰る)
//!   3. 順に: 網羅の集計を足し、全文記録の末尾(それまでのセッションで出た未分類のキーを含む)を書き足し、閲覧ページの収集を進める
//!   4. 詳細ページを並べて書く(閲覧ページへのリンクは、TS 版がそのセッションを書いた時点の収集の状態で決める)

use crate::anonymize::{create_anonymizer, identity_anonymizer, AnonSource, Anonymizer};
use crate::coverage::{coverage_file, desktop_coverage, CoverageCounter};
use crate::detail::{render_detail_html, DetailMemo, DetailOptions};
use crate::embed::embed_data;
use crate::full::{finish_full_file, full_file_name, full_tail, render_full_body, write_full_body, Counted, Excluded, FullOptions};
use crate::glossary_page::{render_glossary_html, GlossaryPageOptions, GLOSSARY_FILE};
use crate::groups::SessionGroup;
use crate::highlights::{installed_view, InstalledView};
use crate::html::{byte_length, write_text};
use crate::insights::{embedded_candidates, insight_meta, instruction_findings, instruction_versions, skill_candidates, skill_stats, stuck_by_project, stuck_sessions, Candidate, CandidateSource, VersionMeta};
use crate::insights_page::{render_insights_html, InsightsPageOptions, INSIGHTS_FILE, INSIGHTS_JSON};
use crate::judgments::JudgmentsIndex;
use crate::library::{instruction_events, render_instructions_html, write_library, BodyInterner, InstructionsPageOptions, LibraryCollector, LibraryEvent, ResolvedInstruction, INSTRUCTIONS_FILE, LIBRARY_DIR};
use crate::memo::memo_summary;
use crate::memo_io::{load_member_memos, load_memo_index, render_member_memo, render_memo, MemoFile};
use crate::pack::pack_summary;
use crate::raw_events::{read_raw_events, RawEvent};
use crate::retention::{retention_item, retention_meta, turn_starts, RetentionMeta};
use crate::summarize::{detail_file_name, summarize};
use crate::transcript::{render_transcript, safe_name, transcript_file_name, ToolOutputMode, TranscriptOptions, TranscriptSource};
use crate::types::{SessionSummary, REPORT_DATA_VERSION};
use crate::verdicts::{verdict_tuples, VerdictIndex};
use crate::viewer::encode_uri_component;
use anyhow::{anyhow, bail, Context, Result};
use atlas_core::atlas_version::{describe_atlas_builds, summarize_atlas_builds, AtlasBuild, AtlasBuildSummary, FolderUpload, SentSession};
use atlas_core::instructions::content_hash;
use atlas_core::js::{self, JsMap};
use atlas_core::types::{DbUsageRow, InstalledInventory, InstructionFile, SessionRecord, SessionsDesktop};
use atlas_core::vcs_step::VcsRetentionFile;
use indexmap::IndexMap;
use rayon::prelude::*;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, OnceLock};
use std::time::Instant;

/// events.jsonl を同時に読むセッションの数の上限
const EVENT_THREADS: usize = 8;

/// template.html の版の目印のプレースホルダ(集計が code_stamp に置き換える)
pub const CODE_PLACEHOLDER: &str = "__ATLAS_CODE__";
/// atlas.html の大きさの上限(docs/PLAN.md「HTML の方針」。超えても出力はするが、CLI が注意を出す)
pub const HTML_SIZE_LIMIT: u64 = 5 * 1024 * 1024;

/// 実行ファイルに埋め込んだ base.css(リポジトリの外に置いた実行ファイルが使う)
pub const EMBEDDED_BASE_CSS: &str = include_str!("../../../packages/report/src/styles/base.css");

/// 実行ファイルに埋め込んだテンプレート(cargo build のときに packages/report/dist/template.html があったときだけ)
pub fn embedded_template() -> Option<&'static str> {
    #[cfg(atlas_embedded_template)]
    {
        Some(include_str!(concat!(env!("OUT_DIR"), "/template.html")))
    }
    #[cfg(not(atlas_embedded_template))]
    {
        None
    }
}

/// テンプレートの版の目印の位置(CODE_PLACEHOLDER)を目印に置き換える。位置が無ければ止める
pub fn embed_code_stamp(template: &str, stamp: &str) -> Result<String> {
    let Some(i) = template.find(CODE_PLACEHOLDER) else {
        bail!("テンプレートに版の目印の位置 {CODE_PLACEHOLDER} がありません(report のビルドが古いか壊れています。packages/report/dist を消してから、もう一度実行してください)");
    };
    Ok(format!("{}{stamp}{}", &template[..i], &template[i + CODE_PLACEHOLDER.len()..]))
}

static CSS_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/\*(?s:.)*?\*/").unwrap());
static CSS_WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{}+", js::RE_S)).unwrap());
static CSS_PUNCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{s}*([{{}};:,>]){s}*", s = js::RE_S)).unwrap());

/// 静的ページに埋め込む CSS からコメントと余分な空白を落とす(atlas.html は Vite が同じことをする)
pub fn compact_css(css: &str) -> String {
    let a = CSS_COMMENT.replace_all(css, "");
    let b = CSS_WS.replace_all(&a, " ");
    let c = CSS_PUNCT.replace_all(&b, "$1");
    js::trim(&c.replace(";}", "}")).to_string()
}

/// 静的ページに埋め込む CSS(base.css を詰めたもの)。リポジトリの packages/report/src/styles/base.css があればそれを、無ければ埋め込んだものを使う
pub fn read_page_css(report_root: Option<&Path>) -> Result<String> {
    let path = report_root.map(|r| r.join("src").join("styles").join("base.css"));
    match path.filter(|p| p.exists()) {
        Some(p) => Ok(compact_css(&std::fs::read_to_string(&p).with_context(|| format!("{} を読めません", p.display()))?)),
        None => Ok(compact_css(EMBEDDED_BASE_CSS)),
    }
}

fn mtime_ms(p: &Path) -> std::io::Result<f64> {
    Ok(atlas_core::jsfs::mtime_ms(&std::fs::metadata(p)?))
}

fn newest_mtime(paths: &[PathBuf]) -> std::io::Result<f64> {
    let mut max = 0f64;
    for p in paths {
        if !p.exists() {
            continue;
        }
        if p.is_dir() {
            for e in walkdir_files(p)? {
                max = max.max(mtime_ms(&e)?);
            }
        } else {
            max = max.max(mtime_ms(p)?);
        }
    }
    Ok(max)
}

fn walkdir_files(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in atlas_core::jsfs::read_dir(&d)? {
            let p = d.join(&e.name);
            if e.is_dir() {
                stack.push(p);
            } else if e.is_file() {
                out.push(p);
            }
        }
    }
    Ok(out)
}

/// 使うテンプレート
pub enum TemplateSource {
    /// リポジトリの dist/template.html
    File(PathBuf),
    /// 実行ファイルに埋め込んだもの
    Embedded(&'static str),
}

impl TemplateSource {
    pub fn read(&self) -> Result<String> {
        match self {
            TemplateSource::File(p) => std::fs::read_to_string(p).with_context(|| format!("{} を読めません", p.display())),
            TemplateSource::Embedded(s) => Ok((*s).to_string()),
        }
    }
}

/// dist/template.html が無いか、report のソースより古ければ Vite でビルドする(TS 版の ensureTemplate)。
/// report_root はリポジトリの packages/report。無ければ(リポジトリの外の実行ファイル)埋め込んだテンプレートを使う
pub fn ensure_template(report_root: Option<&Path>, repo_root: Option<&Path>, log: &dyn Fn(&str)) -> Result<TemplateSource> {
    let Some(root) = report_root.filter(|r| r.join("src").exists()) else {
        return match embedded_template() {
            Some(t) => Ok(TemplateSource::Embedded(t)),
            None => bail!("画面のテンプレートがありません(この実行ファイルにはテンプレートが入っていません。リポジトリで npm run build:report の後に cargo build し直してください)"),
        };
    };
    let template = root.join("dist").join("template.html");
    let sources = [root.join("src"), root.join("template.html"), root.join("vite.config.ts"), root.join("svelte.config.js")];
    let fresh = template.exists() && mtime_ms(&template)? >= newest_mtime(&sources)?;
    if !fresh {
        log("レポートのテンプレートをビルドしています(初回またはソース更新時のみ)…");
        let candidates = [repo_root.map(|r| r.join("node_modules").join("vite").join("bin").join("vite.js")), Some(root.join("node_modules").join("vite").join("bin").join("vite.js"))];
        let Some(vite) = candidates.into_iter().flatten().find(|p| p.exists()) else {
            bail!("テンプレートを作る Vite がありません(リポジトリで npm install を実行してから、もう一度実行してください)");
        };
        let status = std::process::Command::new("node")
            .arg(&vite)
            .args(["build", "--config"])
            .arg(root.join("vite.config.ts"))
            .args(["--logLevel", "warn"])
            .current_dir(root)
            .stdin(std::process::Stdio::null())
            .status()
            .map_err(|e| anyhow!("テンプレートのビルド(node)を起動できません: {e}"))?;
        if !status.success() || !template.exists() {
            bail!("テンプレートのビルドに失敗しました: {} がありません", template.display());
        }
    }
    Ok(TemplateSource::File(template))
}

/// このプロセスが動かしているコードの目印(core の code-stamp.ts の codeStamp と同じ値。最初に呼んだときの中身)。
/// packages_root(リポジトリの packages/)があればそこから作る(TS 版と同じ)。無ければ(リポジトリの外の実行ファイル)
/// 埋め込んだテンプレートと base.css から作る(TODO(段 8): TS のコードを消すときに作り方を決め直す)
pub fn code_stamp(packages_root: Option<&Path>) -> Result<String> {
    static CACHED: OnceLock<String> = OnceLock::new();
    if let Some(s) = CACHED.get() {
        return Ok(s.clone());
    }
    let s = match packages_root.filter(|p| p.exists()) {
        Some(p) => atlas_core::atlas_build::compute_code_stamp(p).with_context(|| format!("{} から版の目印を作れません", p.display()))?,
        None => {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(embedded_template().unwrap_or("").as_bytes());
            h.update(b"\0");
            h.update(EMBEDDED_BASE_CSS.as_bytes());
            hex::encode(h.finalize())[..16].to_string()
        }
    };
    Ok(CACHED.get_or_init(|| s).clone())
}

/// アップロードしたフォルダを集計したときの、そのフォルダ(画面の見出しに出す。伏せ字版には入れない)
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReportSource {
    pub name: String,
    pub path: String,
    pub layout: atlas_core::types::UploadLayout,
    pub folders: usize,
}

#[derive(Debug, Clone, Default)]
pub struct BuildWarnings {
    pub unknown_event_types: i64,
    pub bad_lines: i64,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct BuildScope {
    pub since: Option<String>,
    pub project: Option<String>,
    pub client: Option<String>,
    pub model: Option<String>,
    pub branch: Option<String>,
}

/// export: セッション記録(Markdown)も書く。snapshot_dir の events.jsonl と session-store.db から本文と明細を読む
#[derive(Debug, Clone)]
pub struct TranscriptSettings {
    pub tool_output: ToolOutputMode,
    pub max_text_chars: usize,
    pub max_tool_chars: usize,
    pub gap_ms: i64,
    pub snapshot_dir: PathBuf,
}

pub struct BuildInput<'a> {
    /// CLI のフィルタを適用済みのセッション
    pub sessions: Vec<&'a SessionRecord>,
    /// 同じセッション集合に対する metrics(metrics.json の値のまま。キーの順を変えずに埋め込む)
    pub metrics: Value,
    pub installed: Option<&'a InstalledInventory>,
    pub installed_by_person: Option<&'a JsMap<InstalledInventory>>,
    /// sessions.json の総件数(フィルタ前)
    pub total_sessions_in_source: usize,
    pub source: Option<ReportSource>,
    pub warnings: BuildWarnings,
    pub judgments: Option<&'a JudgmentsIndex>,
    /// 段階 2: 依頼ごとの LLM 判定
    pub verdicts: Option<&'a VerdictIndex>,
    /// AI の変更がその後の VCS のファイルに残っているか
    pub retention: Option<&'a VcsRetentionFile>,
    pub groups: Vec<SessionGroup>,
    /// Phase 13: メモの置き場(<notes-dir>/memos)
    pub memos_dir: Option<PathBuf>,
    /// 送り先から集計したとき: 送った人のメモを読む、写したセッションのフォルダ(<snapshot>/session-state)。あれば memos_dir より優先する
    pub member_memos_dir: Option<PathBuf>,
    /// 読むだけの画面として作る
    pub read_only: bool,
    /// 集計したこの PC の atlas の版
    pub atlas_local: Option<AtlasBuild>,
    /// 送り先から集計したときの、フォルダごとの最後に送ったときの日時と版
    pub atlas_uploads: Option<JsMap<FolderUpload>>,
    pub out_dir: PathBuf,
    pub anonymize: bool,
    pub scope: BuildScope,
    /// テンプレート(ensure_template の結果を読んだもの)
    pub template: String,
    /// 静的ページに埋め込む CSS(read_page_css の結果)
    pub css: String,
    /// 版の目印(code_stamp)
    pub code: String,
    pub transcripts: Option<TranscriptSettings>,
    /// Phase 11: 全文記録(out/full/)と coverage.json も書く(伏せ字とは併用しない)
    pub full: bool,
    /// Phase 11: 指示文・skill の閲覧ページ。transcripts のときの既定は true(伏せ字版では作らない)
    pub library: Option<bool>,
    /// sessions.json の desktop(data.db の読み取りの状態)
    pub desktop_meta: Option<&'a SessionsDesktop>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TranscriptStat {
    pub files: u64,
    pub bytes: u64,
    pub secret_hits: u64,
    pub truncated: u64,
    pub from_record_only: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct FullStat {
    pub files: u64,
    pub bytes: u64,
    pub assets: Counted,
    pub secret_hits: u64,
    pub excluded: Excluded,
    pub unclassified: Vec<String>,
    pub coverage_path: PathBuf,
    pub events: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LibraryStat {
    pub groups: u64,
    pub versions: u64,
    pub files: u64,
    pub bytes: u64,
    pub secret_hits: u64,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Stale {
    pub full: Option<String>,
    pub library: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BuildResult {
    pub html_path: PathBuf,
    pub html_bytes: u64,
    /// html_bytes が HTML_SIZE_LIMIT 以上
    pub oversized: bool,
    pub embedded_bytes: i64,
    pub detail_dir: PathBuf,
    pub detail_pages: usize,
    pub detail_bytes: u64,
    pub transcripts: Option<TranscriptStat>,
    pub full: Option<FullStat>,
    pub library: Option<LibraryStat>,
    /// Phase 11: 今回は作らなかったが前回の出力が残っているもの(生成日時)
    pub stale: Stale,
    pub ms: f64,
}

/// metrics の byProject を伏せ字のプロジェクト名にする(TS 版の anonymizeMetrics)
pub fn anonymize_metrics(mut m: Value, anon: &Anonymizer) -> Value {
    if !anon.enabled {
        return m;
    }
    if let Some(Value::Object(by)) = m.get_mut("byProject") {
        let old = std::mem::take(by);
        let mut out = serde_json::Map::new();
        for (k, v) in old {
            out.insert(anon.project(&k), v);
        }
        *by = out;
    }
    m
}

/// 伏せ字版の送った版の集計(人の名前とフォルダを出さない。TS 版の anonymizeAtlasBuilds)
fn anonymize_atlas_builds(s: &AtlasBuildSummary) -> AtlasBuildSummary {
    let mut s = s.clone();
    s.unknown_persons.clear();
    s.older_persons.clear();
    for g in &mut s.builds {
        g.persons.clear();
    }
    if let Some(f) = &mut s.folders {
        for (i, x) in f.iter_mut().enumerate() {
            x.folder = format!("フォルダ {}", i + 1);
        }
    }
    s
}

#[derive(Serialize)]
struct AtlasBuildsOut {
    ok: bool,
    short: String,
    headline: String,
    lines: Vec<String>,
}

#[derive(Serialize)]
struct ScopeOut {
    since: Option<String>,
    project: Option<String>,
    client: Option<String>,
    model: Option<String>,
    branch: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JudgmentsOut {
    available: bool,
    backend: Option<String>,
    model: Option<String>,
    ran_at: Option<String>,
    items: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnJudgmentsOut {
    available: bool,
    model: Option<String>,
    ran_at: Option<String>,
    items: usize,
    phases: Vec<String>,
}

#[derive(Serialize)]
struct GroupOut {
    name: String,
    note: String,
    ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InsightsOut {
    meta: JsMap<VersionMeta>,
    candidates: Vec<Candidate>,
    candidate_total: usize,
    computed_over: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WarningsOut {
    unknown_event_types: i64,
    bad_lines: i64,
    notes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportData<'a> {
    version: i64,
    generated_at: &'a str,
    anonymized: bool,
    scope: ScopeOut,
    total_sessions_in_source: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'a ReportSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    read_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    atlas_builds: Option<AtlasBuildsOut>,
    metrics: Value,
    sessions: Vec<Value>,
    judgments: JudgmentsOut,
    turn_judgments: TurnJudgmentsOut,
    retention: Option<&'a RetentionMeta>,
    installed: Option<&'a InstalledView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    installed_by_person: Option<JsMap<InstalledView>>,
    groups: Vec<GroupOut>,
    library: bool,
    insights: InsightsOut,
    warnings: WarningsOut,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InsightsJson<'a> {
    version: i64,
    generated_at: &'a str,
    anonymized: bool,
    sessions: usize,
    candidates: &'a [Candidate],
}

/// セッション 1 件の、events.jsonl を読んで書いたものの結果(手順 2)
#[derive(Default)]
struct SessionWork {
    transcript: Option<(u64, u64, u64, bool)>,
    /// 全文記録: tmp に書いた本体と、末尾に書く集計
    full: Option<FullWork>,
    library: Vec<LibraryEvent>,
}

struct FullWork {
    path: PathBuf,
    events: u64,
    secret_hits: u64,
    assets: Counted,
    excluded: Excluded,
    coverage: CoverageCounter,
}

/// 閲覧ページ(指示文と skill)に集める本文(イベントを読んだ順)
fn library_events(e: &RawEvent, interner: &BodyInterner) -> Vec<LibraryEvent> {
    let at = e.timestamp();
    match e.kind() {
        "system.message" => e.d_str("content").map(|c| instruction_events(c, at, interner)).unwrap_or_default(),
        "skill.invoked" => match (e.d_str("content"), e.d_str("name")) {
            (Some(c), Some(n)) => {
                let hash = content_hash(c);
                vec![LibraryEvent::Skill { name: n.to_string(), body: interner.get(&hash, c), hash, at: at.map(str::to_string), path: e.d_str("path").map(str::to_string) }]
            }
            _ => vec![],
        },
        _ => vec![],
    }
}

fn mtime_iso(p: &Path) -> Result<String> {
    Ok(atlas_core::jsfs::mtime_iso(&std::fs::metadata(p)?))
}

pub fn build_report(input: BuildInput<'_>) -> Result<BuildResult> {
    let t0 = Instant::now();
    let css = input.css.as_str();
    let code = input.code.as_str();
    let anon = if input.anonymize { create_anonymizer(&input.sessions.iter().map(|r| AnonSource::from(*r)).collect::<Vec<_>>()) } else { identity_anonymizer() };
    let generated_at = atlas_core::jsdate::now_iso();
    let j = input.judgments;

    // 伏せ字版にはメモを一切出さない(自由記述のため。抜粋も件数も持たない)
    let member_dir = input.member_memos_dir.as_deref();
    let memos: IndexMap<String, MemoFile> = if anon.enabled {
        IndexMap::new()
    } else if let Some(d) = member_dir {
        load_member_memos(d, input.sessions.iter().map(|s| s.id.as_str()))
    } else if let Some(d) = &input.memos_dir {
        load_memo_index(d)
    } else {
        IndexMap::new()
    };
    let memo_html = |id: &str, text: &str| -> String {
        match member_dir {
            Some(d) => render_member_memo(d, id, text),
            None => render_memo(input.memos_dir.as_deref().unwrap_or(Path::new("")), id, text),
        }
    };
    let vx = input.verdicts;
    let rx = input.retention;
    let retention_by_id: HashMap<&str, &atlas_core::vcs_retention::SessionRetention> = rx.iter().flat_map(|x| x.sessions.iter()).map(|r| (r.session_id.as_str(), r)).collect();
    let sessions: Vec<SessionSummary> = input
        .sessions
        .par_iter()
        .map(|r| {
            let mut s = summarize(r, &anon, j.and_then(|j| j.by_session.get(&r.id)));
            if let Some(vx) = vx {
                let vt = verdict_tuples(vx.by_session.get(&r.id), &vx.phases);
                if !vt.is_empty() {
                    s.turn_verdicts = Some(vt);
                }
            }
            if let Some(rt) = retention_by_id.get(r.id.as_str()) {
                s.retention = Some(retention_item(rt, &turn_starts(r)));
            }
            if let Some(m) = memos.get(&r.id) {
                s.memo = Some(memo_summary(&m.text, Some(&m.updated_at)));
            }
            s
        })
        .collect();
    let summaries: Vec<&SessionSummary> = sessions.iter().collect();

    // 送り先から集計したときの、送った atlas の版。伏せ字版では人の名前を出さない
    let sent: Vec<SentSession<'_>> = input.sessions.iter().map(|x| SentSession { person: x.person.as_ref().and_then(|p| p.as_deref()), upload_atlas: x.upload_atlas.as_ref().map(|a| a.as_ref()) }).collect();
    let atlas_builds = summarize_atlas_builds(&sent, input.atlas_local.as_ref(), input.atlas_uploads.as_ref()).map(|b| {
        let d = describe_atlas_builds(&if anon.enabled { anonymize_atlas_builds(&b) } else { b });
        AtlasBuildsOut { ok: d.ok, short: d.short, headline: d.headline, lines: d.lines }
    });
    let retention_out = rx.map(retention_meta);
    let installed = input.installed.map(installed_view);
    let library_on = input.transcripts.is_some() && input.library.unwrap_or(true) && !anon.enabled;
    let masked = |v: &Option<String>| -> Option<String> {
        match v.as_deref().filter(|s| !s.is_empty()) {
            Some(x) => Some(if anon.enabled { "(伏せ字)".to_string() } else { x.to_string() }),
            None => None,
        }
    };

    // Phase 12: 改善点。候補は本文(依頼文・ツールの列)から build 時に求め、結果だけ埋め込む
    let insight_meta_all = insight_meta(&input.sessions, false);
    let cand_src: Vec<CandidateSource<'_>> = input.sessions.iter().map(|r| CandidateSource { id: &r.id, project: &r.project, analysis: &r.analysis }).collect();
    let candidates = skill_candidates(&cand_src, anon.enabled);
    let meta_for_page: JsMap<VersionMeta> = if anon.enabled { JsMap::new() } else { insight_meta_all.clone() };

    std::fs::create_dir_all(&input.out_dir)?;
    let packed: Vec<Value> = sessions.par_iter().map(pack_summary).collect();
    let data = ReportData {
        version: REPORT_DATA_VERSION,
        generated_at: &generated_at,
        anonymized: anon.enabled,
        scope: ScopeOut {
            since: input.scope.since.clone(),
            project: masked(&input.scope.project),
            client: input.scope.client.clone(),
            model: input.scope.model.clone(),
            branch: masked(&input.scope.branch),
        },
        total_sessions_in_source: input.total_sessions_in_source,
        source: if anon.enabled { None } else { input.source.as_ref() },
        read_only: input.read_only.then_some(true),
        atlas_builds,
        metrics: anonymize_metrics(input.metrics.clone(), &anon),
        sessions: packed,
        judgments: JudgmentsOut {
            available: j.is_some(),
            backend: j.and_then(|j| j.backend.clone()),
            model: j.and_then(|j| j.model.clone()),
            ran_at: j.and_then(|j| j.ran_at.clone()),
            items: j.map_or(0, |j| input.sessions.iter().filter(|s| j.by_session.contains_key(&s.id)).count()),
        },
        turn_judgments: TurnJudgmentsOut {
            available: vx.is_some(),
            model: vx.and_then(|v| v.model.clone()),
            ran_at: vx.and_then(|v| v.ran_at.clone()),
            items: vx.map_or(0, |v| input.sessions.iter().map(|s| v.by_session.get(&s.id).map_or(0, |m| m.len())).sum()),
            phases: vx.map(|v| v.phases.clone()).unwrap_or_default(),
        },
        retention: retention_out.as_ref(),
        installed: installed.as_ref(),
        // 人に絞ったときに、その人のインストール済みの skill で「未使用」を出す。伏せ字版では入れない
        installed_by_person: match input.installed_by_person {
            Some(m) if !anon.enabled => Some(JsMap(m.js_entries().into_iter().map(|(k, v)| (k.clone(), installed_view(v))).collect())),
            _ => None,
        },
        // 伏せ字モードではグループ名と note は出さず、ファイルの順で「タスクタグ 1, 2, …」にする
        groups: input
            .groups
            .iter()
            .enumerate()
            .map(|(i, g)| if anon.enabled { GroupOut { name: format!("タスクタグ {}", i + 1), note: String::new(), ids: g.ids.clone() } } else { GroupOut { name: g.name.clone(), note: g.note.clone(), ids: g.ids.clone() } })
            .collect(),
        library: library_on,
        insights: InsightsOut { meta: meta_for_page.clone(), candidates: embedded_candidates(&candidates), candidate_total: candidates.len(), computed_over: input.sessions.len() },
        // 警告文には groups.json の絶対パスが入るので、伏せ字モードでは <path> に置き換える
        warnings: WarningsOut { unknown_event_types: input.warnings.unknown_event_types, bad_lines: input.warnings.bad_lines, notes: input.warnings.notes.iter().map(|n| anon.scrub(n)).collect() },
    };

    // 版の目印はデータを埋める前に置き換える(記録の本文に同じ文字列があっても触れない)
    let html = embed_data(&embed_code_stamp(&input.template, code)?, &data)?;
    let html_path = input.out_dir.join("atlas.html");
    write_text(&html_path, &html)?;
    // 用語の説明は 1 枚だけ別ページ
    write_text(&input.out_dir.join(GLOSSARY_FILE), &render_glossary_html(&GlossaryPageOptions { css, generated_at: &generated_at, code }))?;
    // Phase 12: 改善点の全件(insights.html)と候補の JSON(skill-draft が読む)
    {
        let versions = instruction_versions(&summaries);
        let names: HashMap<&str, String> = sessions
            .iter()
            .map(|s| {
                let n = if anon.enabled {
                    format!("セッション {}", js::utf16_slice(&s.id, 0, 8))
                } else {
                    let base = s.name.as_deref().filter(|x| !x.is_empty()).or(s.first_user_message.as_deref().filter(|x| !x.is_empty())).map(str::to_string).unwrap_or_else(|| js::utf16_slice(&s.id, 0, 8).into_owned());
                    js::utf16_slice(&WS.replace_all(&base, " "), 0, 60).into_owned()
                };
                (s.id.as_str(), n)
            })
            .collect();
        let stuck = stuck_sessions(&summaries);
        let page = render_insights_html(&InsightsPageOptions {
            css,
            generated_at: &generated_at,
            code,
            anonymized: anon.enabled,
            sessions: sessions.len(),
            empty_sessions: sessions.iter().filter(|s| s.empty).count(),
            versions: &versions,
            meta: &meta_for_page,
            findings: &instruction_findings(&versions, &meta_for_page, sessions.len()),
            skills: &skill_stats(&summaries, installed.as_ref().map(|i| i.skills.as_slice())),
            disabled_skills: installed.as_ref().map(|i| i.disabled.as_slice()).unwrap_or(&[]),
            stuck: &stuck,
            stuck_projects: &stuck_by_project(&stuck, &summaries),
            candidates: &candidates,
            session_name: &|id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string()),
            library_href: library_on.then_some(INSTRUCTIONS_FILE),
        });
        write_text(&input.out_dir.join(INSIGHTS_FILE), &page)?;
        let json = atlas_core::json::to_js_string_indent(&InsightsJson { version: 1, generated_at: &generated_at, anonymized: anon.enabled, sessions: sessions.len(), candidates: &candidates }, b" ")?;
        write_text(&input.out_dir.join(INSIGHTS_JSON), &json)?;
    }

    // 詳細ページ: 前回の生成物を消してから書く(フィルタで減ったセッションのページを残さない)
    let detail_dir = input.out_dir.join("sessions");
    atlas_core::fs_retry::remove_tree(&detail_dir)?;
    std::fs::create_dir_all(&detail_dir)?;
    let tr = input.transcripts.as_ref();
    let store = match tr {
        Some(t) => Some(atlas_core::extract::load_store(&t.snapshot_dir.join("session-store.db"))?),
        None => None,
    };
    // Phase 11: 全文記録と閲覧ページ(どちらも events.jsonl を読み直す)
    let want_full = tr.is_some() && input.full;
    if want_full && anon.enabled {
        bail!("--full(全文記録)は --anonymize と併用できません(解析用の完全出力は共有しない前提のため)");
    }
    let want_library = library_on;
    let full_dir = input.out_dir.join("full");
    let coverage_path = input.out_dir.join("coverage.json");
    let instructions_path = input.out_dir.join(INSTRUCTIONS_FILE);
    // ユーザーの生成物を黙って消さない: 作り直すときと伏せ字モードだけ消す。それ以外は残して日時を返す
    let mut stale = Stale::default();
    if want_full || anon.enabled {
        atlas_core::fs_retry::remove_tree(&full_dir)?;
        atlas_core::jsfs::rm_force(&coverage_path)?;
    } else if coverage_path.exists() {
        stale.full = Some(mtime_iso(&coverage_path)?);
    } else if full_dir.exists() {
        stale.full = Some(mtime_iso(&full_dir)?);
    }
    if want_library || anon.enabled {
        atlas_core::fs_retry::remove_tree(&input.out_dir.join(LIBRARY_DIR))?;
        atlas_core::jsfs::rm_force(&instructions_path)?;
    } else if instructions_path.exists() {
        stale.library = Some(mtime_iso(&instructions_path)?);
    }
    if want_full {
        std::fs::create_dir_all(&full_dir)?;
    }

    // 2. セッションごとに events.jsonl を 1 回読み、記録と全文記録の本体を書く
    let empty_usage: Vec<DbUsageRow> = Vec::new();
    let interner = BodyInterner::default();
    let tr_writer = FileWriter::new();
    let wal_note = input.desktop_meta.and_then(|d| d.wal.as_ref()).map(|w| w.note.as_str());
    // events.jsonl は 1 セッション分をまるごと読むので、同時に読む数を絞る(多いとメモリが増え、速さはほとんど変わらない)
    let threads = EVENT_THREADS.min(rayon::current_num_threads()).max(1);
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build()?;
    let work: Vec<Result<SessionWork>> = pool.install(|| input
        .sessions
        .par_iter()
        .map(|r| -> Result<SessionWork> {
            let mut w = SessionWork::default();
            let (Some(t), Some(store)) = (tr, store.as_ref()) else { return Ok(w) };
            let session_dir = t.snapshot_dir.join("session-state").join(&r.id);
            let events_path = session_dir.join("events.jsonl");
            let events: Option<Vec<RawEvent>> = if events_path.exists() { Some(read_raw_events(&events_path).with_context(|| format!("{} を読めません", events_path.display()))?) } else { None };
            let usage = store.usage.get(&r.id).unwrap_or(&empty_usage);
            if want_library && let Some(ev) = &events {
                w.library = ev.iter().flat_map(|e| library_events(e, &interner)).collect();
            }
            let tres = render_transcript(r, events.as_deref(), usage, &TranscriptOptions { anon: &anon, generated_at: &generated_at, tool_output: t.tool_output, max_text_chars: t.max_text_chars, max_tool_chars: t.max_tool_chars, gap_ms: t.gap_ms });
            w.transcript = Some((byte_length(&tres.markdown), tres.secret_hits, tres.truncated, tres.source == TranscriptSource::Record));
            tr_writer.write(detail_dir.join(transcript_file_name(&r.id)), tres.markdown);
            if want_full {
                let file = full_file_name(&r.id);
                let path = full_dir.join(&file);
                let folder = safe_name(&r.id);
                let has_dir = session_dir.exists();
                let mut coverage = CoverageCounter::new();
                let body = render_full_body(
                    r,
                    events.as_deref().unwrap_or(&[]),
                    usage,
                    &FullOptions {
                        generated_at: &generated_at,
                        assets_dir: full_dir.join("assets").join(&folder),
                        assets_href: format!("assets/{folder}"),
                        session_dir: has_dir.then(|| session_dir.clone()),
                        session_dir_href: has_dir.then(|| format!("../snapshot/session-state/{}", encode_uri_component(&r.id))),
                        wal_note,
                    },
                    &mut coverage,
                );
                // 本体は <id>.md.tmp に書いておき、末尾を足してから rename する(途中で失敗した壊れた記録を残さない)
                write_full_body(&path, &body.text).map_err(|e| anyhow!("全文記録を書けませんでした ({}): {e:#}", r.id))?;
                w.full = Some(FullWork { path, events: body.events, secret_hits: body.secret_hits, assets: body.assets, excluded: body.excluded, coverage });
            }
            Ok(w)
        })
        .collect());
    tr_writer.finish()?;
    let mut works: Vec<SessionWork> = Vec::with_capacity(work.len());
    for (r, w) in input.sessions.iter().zip(work) {
        works.push(w.with_context(|| format!("セッション記録を書けませんでした ({})", r.id))?);
    }

    // 3. 順に: 網羅の集計を足し、全文記録の末尾を書き足し、閲覧ページの収集を進める
    let mut tr_stat = tr.map(|_| TranscriptStat::default());
    let mut full_stat = want_full.then(|| FullStat { coverage_path: coverage_path.clone(), ..Default::default() });
    let mut full_unclassified: BTreeSet<Vec<u16>> = BTreeSet::new();
    let mut coverage = CoverageCounter::new();
    let mut lib = want_library.then(LibraryCollector::new);
    // TS 版が詳細ページを書いた時点(そのセッションまでを集めた時点)の、閲覧ページの状態
    let mut skill_first: HashMap<String, usize> = HashMap::new();
    let mut session_first: HashMap<String, usize> = HashMap::new();
    let mut full_href: Vec<Option<String>> = vec![None; works.len()];
    for (k, (r, w)) in input.sessions.iter().zip(works.iter_mut()).enumerate() {
        if let (Some(st), Some((bytes, hits, truncated, record))) = (tr_stat.as_mut(), w.transcript) {
            st.files += 1;
            st.bytes += bytes;
            st.secret_hits += hits;
            st.truncated += truncated;
            if record {
                st.from_record_only += 1;
            }
        }
        if let Some(lib) = lib.as_mut() {
            for e in &w.library {
                lib.add(&r.id, e);
                if let LibraryEvent::Skill { name, .. } = e {
                    skill_first.entry(name.clone()).or_insert(k);
                }
                session_first.entry(r.id.clone()).or_insert(k);
            }
        }
        if let (Some(fs), Some(f)) = (full_stat.as_mut(), w.full.take()) {
            coverage.merge(&f.coverage);
            let mut uc: Vec<String> = coverage.unclassified_keys();
            uc.sort_by(|a, b| js::cmp_utf16(a, b));
            uc.dedup();
            // 本文で見つけた未分類のキーは、全体の集計の未分類のキーに含まれる(同じイベントを数えている)
            let tail = full_tail(f.secret_hits, f.excluded, f.assets, &uc);
            finish_full_file(&f.path, &tail).map_err(|e| anyhow!("全文記録を書けませんでした ({}): {e:#}", r.id))?;
            full_href[k] = Some(format!("../full/{}", full_file_name(&r.id)));
            fs.files += 1;
            fs.bytes += std::fs::metadata(&f.path)?.len();
            fs.assets.files += f.assets.files;
            fs.assets.bytes += f.assets.bytes;
            fs.secret_hits += f.secret_hits;
            fs.excluded.n += f.excluded.n;
            fs.excluded.bytes += f.excluded.bytes;
            fs.events += f.events;
            for x in uc {
                full_unclassified.insert(x.encode_utf16().collect());
            }
        }
    }
    // has_session は、そのセッションの本文から指示ブロックか skill を 1 つでも集めたか(TS 版の LibraryCollector.sessions)
    if let Some(lib) = &lib {
        session_first.retain(|id, _| lib.has_session(id));
    }
    drop(works);

    // 4. 詳細ページを並べて書く
    let library_href = library_on.then(|| format!("../{INSTRUCTIONS_FILE}"));
    let retention_meta_ref = retention_out.as_ref();
    // 描くのは並べ、書くのは 1 本のスレッドに任せる(Windows では同じフォルダへ並べて書くと遅くなる)
    let writer = FileWriter::new();
    let pages: Vec<u64> = input
        .sessions
        .par_iter()
        .enumerate()
        .map(|(k, r)| -> u64 {
            // 詳細ページには根拠も出す(伏せ字モードでは自由記述を出さない)
            let judgment = j.and_then(|j| j.by_session.get(&r.id)).map(|full| {
                let mut x = full.clone();
                x.task_summary = anon.free_text(full.task_summary.as_deref());
                x.rationale = anon.free_text(full.rationale.as_deref());
                x
            });
            let memo = memos.get(&r.id).map(|m| DetailMemo { html: memo_html(&r.id, &m.text), updated_at: m.updated_at.clone() });
            let transcript_href = tr.map(|_| transcript_file_name(&r.id));
            let has_page = |name: &str| lib.is_some() && skill_first.get(name).is_some_and(|i| *i <= k);
            let page = render_detail_html(
                r,
                &DetailOptions {
                    anon: &anon,
                    css,
                    code,
                    judgment: judgment.as_ref(),
                    verdicts: vx.and_then(|v| v.by_session.get(&r.id)),
                    generated_at: &generated_at,
                    transcript_href: transcript_href.as_deref(),
                    library_href: library_href.as_deref(),
                    skill_has_page: &has_page,
                    library_has_session: lib.is_some() && session_first.get(&r.id).is_some_and(|i| *i <= k),
                    full_href: full_href[k].as_deref(),
                    memo: memo.as_ref(),
                    retention: retention_by_id.get(r.id.as_str()).copied(),
                    retention_meta: retention_meta_ref,
                },
            );
            let bytes = byte_length(&page);
            writer.write(detail_dir.join(detail_file_name(&r.id)), page);
            bytes
        })
        .collect();
    writer.finish()?;
    let detail_bytes: u64 = pages.iter().sum();

    let full_out = match full_stat {
        Some(mut fs) => {
            let desktop = input.desktop_meta.map(|d| desktop_coverage(Some(&d.coverage)));
            let cf = coverage_file(&coverage, input.sessions.len() as i64, desktop, &generated_at);
            write_text(&coverage_path, &atlas_core::json::to_js_string_indent(&cf, b" ")?)?;
            fs.unclassified = full_unclassified.iter().map(|u| String::from_utf16_lossy(u)).collect();
            Some(fs)
        }
        None => None,
    };
    let lib_out = match lib {
        Some(lib) => {
            let groups = lib.result();
            let w = write_library(&input.out_dir.join(LIBRARY_DIR), &groups)?;
            let names: HashMap<&str, String> = sessions
                .iter()
                .map(|s| (s.id.as_str(), s.name.as_deref().filter(|x| !x.is_empty()).or(s.first_user_message.as_deref().filter(|x| !x.is_empty())).map(str::to_string).unwrap_or_else(|| js::utf16_slice(&s.id, 0, 8).into_owned())))
                .collect();
            let projects: HashMap<&str, &str> = sessions.iter().map(|s| (s.id.as_str(), s.project_label.as_str())).collect();
            // 版ごとのファイルと範囲は、全セッションを見て特定した値を多い順に採る
            let mut votes: HashMap<&str, IndexMap<(InstructionFile, &str), i64>> = HashMap::new();
            for r in &input.sessions {
                for i in &r.instructions {
                    if i.file == InstructionFile::Unknown {
                        continue;
                    }
                    *votes.entry(i.content_hash.as_str()).or_default().entry((i.file, i.scope.as_str())).or_insert(0) += 1;
                }
            }
            let resolve = |hash: &str| -> Option<ResolvedInstruction> {
                let m = votes.get(hash)?;
                let mut best: Option<(&(InstructionFile, &str), i64)> = None;
                for (k, n) in m {
                    if best.is_none_or(|b| *n > b.1) {
                        best = Some((k, *n));
                    }
                }
                best.map(|(k, _)| ResolvedInstruction { file: k.0.as_str().to_string(), scope: k.1.to_string() })
            };
            let page = render_instructions_html(&InstructionsPageOptions {
                css,
                generated_at: &generated_at,
                code,
                groups: &groups,
                session_name: &|id: &str| js::utf16_slice(&WS.replace_all(names.get(id).map(String::as_str).unwrap_or(id), " "), 0, 60).into_owned(),
                session_project: &|id: &str| projects.get(id).map(|s| s.to_string()),
                resolve_instruction: &resolve,
            });
            write_text(&instructions_path, &page)?;
            Some(LibraryStat {
                groups: groups.len() as u64,
                versions: groups.iter().map(|g| g.versions.len() as u64).sum(),
                files: w.files,
                bytes: w.bytes,
                secret_hits: w.secret_hits,
                path: instructions_path.clone(),
            })
        }
        None => None,
    };

    let html_bytes = byte_length(&html);
    Ok(BuildResult {
        html_path,
        html_bytes,
        oversized: html_bytes >= HTML_SIZE_LIMIT,
        embedded_bytes: html_bytes as i64 - byte_length(&input.template) as i64,
        detail_dir,
        detail_pages: input.sessions.len(),
        detail_bytes,
        transcripts: tr_stat,
        full: full_out,
        library: lib_out,
        stale,
        ms: t0.elapsed().as_secs_f64() * 1000.0,
    })
}

static WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{}+", js::RE_S)).unwrap());

/// ファイルを 1 本のスレッドで順に書く(描くスレッドは待たせない。溜める数は 64 まで)。最初の失敗を finish で返す
struct FileWriter {
    tx: std::sync::mpsc::SyncSender<(PathBuf, String)>,
    handle: std::thread::JoinHandle<std::io::Result<()>>,
}

impl FileWriter {
    fn new() -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel::<(PathBuf, String)>(64);
        let handle = std::thread::spawn(move || -> std::io::Result<()> {
            let mut first: std::io::Result<()> = Ok(());
            for (path, text) in rx {
                if first.is_ok() {
                    first = write_text(&path, &text).map_err(|e| std::io::Error::new(e.kind(), format!("{} を書けません: {e}", path.display())));
                }
            }
            first
        });
        FileWriter { tx, handle }
    }

    fn write(&self, path: PathBuf, text: String) {
        // 受け手が止まっていれば finish が理由を返す
        let _ = self.tx.send((path, text));
    }

    fn finish(self) -> Result<()> {
        drop(self.tx);
        self.handle.join().map_err(|_| anyhow!("ファイルを書くスレッドが止まりました"))??;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_css_like_ts() {
        assert_eq!(compact_css("/* c */\n.a  >  .b {\n  color : red ;\n}\n\n.c{x:1;}"), ".a>.b{color:red}.c{x:1}");
    }

    #[test]
    fn code_stamp_placeholder() {
        assert_eq!(embed_code_stamp("a __ATLAS_CODE__ b", "x1").unwrap(), "a x1 b");
        assert!(embed_code_stamp("a b", "x1").unwrap_err().to_string().contains("__ATLAS_CODE__"));
    }
}
