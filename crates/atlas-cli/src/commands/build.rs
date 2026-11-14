//! atlas build / export(packages/cli/src/commands.ts の runBuild・uploadsFor の移植)。ログの文言は TS 版と同じ(所要時間だけ違う)。
//! 描くのは atlas-report の build(build_report)。テンプレートと CSS は実行ファイルに埋め込んだもの(template・page_css)、版の目印は version::CODE_STAMP。

use super::metrics::{has_filter, select_sessions, write_tables, SessionFilter};
use super::{mb, ms, Log};
use crate::args::ToolOutput;
use crate::paths::{Paths, REPO_ROOT};
use anyhow::{anyhow, Result};
use atlas_core::atlas_build::current_atlas_build;
use atlas_core::atlas_version::FolderUpload;
use atlas_core::js::{self, JsMap};
use atlas_core::jsdate;
use atlas_core::metrics::compute_metrics;
use atlas_core::types::{SessionRecord, SessionsFile, METRICS_SCHEMA_VERSION};
use atlas_core::vcs_step::read_vcs_retention;
use atlas_report::build::{build_report, page_css, template, BuildInput, BuildScope, BuildWarnings, ReportSource, TranscriptSettings, HTML_SIZE_LIMIT};
use atlas_report::groups::{member_groups, MemberSource};
use atlas_report::judgments::parse_judgments;
use atlas_report::memo_io::memos_dir;
use atlas_report::transcript::{ToolOutputMode, DEFAULT_GAP_MS, DEFAULT_MAX_TEXT_CHARS, DEFAULT_MAX_TOOL_CHARS};
use atlas_report::verdicts::parse_verdicts;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

pub use atlas_report::build::BuildResult;

/// export: セッション記録(Markdown)も書く
#[derive(Debug, Clone)]
pub struct TranscriptCli {
    pub tool_output: ToolOutput,
    pub max_chars: Option<u64>,
    /// Phase 11: 全文記録(out/full/)と coverage.json も書く
    pub full: bool,
}

#[derive(Debug, Clone, Default)]
pub struct BuildOptions {
    pub filter: SessionFilter,
    pub anonymize: bool,
    pub transcripts: Option<TranscriptCli>,
}

/// レポートで見るフォルダごとの記録。絞り込んだときは、対象のセッションを数えたフォルダだけにする
pub fn uploads_for(uploads: Option<&JsMap<FolderUpload>>, sessions: &[&SessionRecord], filtered: bool) -> Option<JsMap<FolderUpload>> {
    let uploads = uploads?;
    if !filtered {
        return Some(uploads.clone());
    }
    let keep: HashSet<&str> = sessions.iter().filter_map(|r| r.upload_folder.as_ref().and_then(|f| f.as_deref())).collect();
    Some(JsMap(uploads.js_entries().into_iter().filter(|(f, _)| keep.contains(f.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect()))
}

/// JSON を読む(TS 版の readJson。読めなければ「<path> を読めません: <理由>」)
fn read_json(path: &Path) -> Result<Value> {
    let text = std::fs::read(path).map_err(|e| anyhow!("{} を読めません: {e}", path.display()))?;
    js::parse_json(&String::from_utf8_lossy(&text)).map_err(|e| anyhow!("{} を読めません: {e}", path.display()))
}

/// path.basename(Windows では \ と / の両方で区切る)
fn basename(p: &str) -> &str {
    let seps: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
    p.trim_end_matches(seps).rsplit(seps).next().unwrap_or("")
}

fn date_ms(v: Option<&Value>) -> Option<i64> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(jsdate::parse_ms)
}

fn secs(ms_f: f64) -> Duration {
    Duration::from_secs_f64((ms_f / 1000.0).max(0.0))
}

/// build と export(TS 版の runBuild)
pub fn run_build(p: &Paths, o: &BuildOptions, log: Log<'_>) -> Result<BuildResult> {
    let cmd = if o.transcripts.is_some() { "export" } else { "build" };
    let sel = select_sessions(p, &o.filter, cmd, "先に atlas extract を実行してください。", log)?;
    let s: &SessionsFile = &sel.file;
    let sessions = sel.sessions();
    if sessions.is_empty() {
        log("build: 注意 条件に合うセッションが 0 件です(空のレポートを出します)");
    }

    // metrics.json が同じセッション集合のものなら使い、違えば(フィルタ違い・古い)作り直す
    let mut metrics: Option<Value> = None;
    if p.metrics.exists() {
        let m = read_json(&p.metrics)?;
        let fresh = match (date_ms(m.get("generatedAt")), jsdate::parse_ms(&s.generated_at)) {
            (Some(a), Some(b)) => a >= b,
            _ => false,
        };
        let overall = m.get("overall").and_then(|x| x.get("sessions")).and_then(Value::as_f64).unwrap_or(-1.0);
        let empty = m.get("emptySessions").and_then(Value::as_f64).unwrap_or(0.0);
        let same_set = m.get("schemaVersion").and_then(Value::as_f64) == Some(METRICS_SCHEMA_VERSION as f64) && overall + empty == sessions.len() as f64;
        if !has_filter(&o.filter) && fresh && same_set {
            metrics = Some(m);
        }
    }
    let metrics = match metrics {
        Some(m) => m,
        None => {
            if p.metrics.exists() {
                log("build: metrics.json がこの絞り込みと一致しないため、集計し直して埋め込みます");
            }
            serde_json::to_value(compute_metrics(&sessions, s.installed.as_ref()))?
        }
    };

    let judgments = if p.judgments.exists() {
        let j = parse_judgments(&read_json(&p.judgments)?)?;
        log(&format!("build: judgments {} 件を合成({})", j.by_session.len(), p.judgments.display()));
        Some(j)
    } else {
        None
    };
    let mut verdicts = None;
    if p.turn_judgments.exists() {
        match read_json(&p.turn_judgments) {
            Ok(v) => verdicts = parse_verdicts(&v),
            Err(e) => log(&format!("build: 注意 {} を読めないため、依頼ごとの判定は合成しません({e})", p.turn_judgments.display())),
        }
        if let Some(v) = &verdicts {
            log(&format!("build: 依頼ごとの判定 {} 件を合成({})", v.by_session.values().map(|m| m.len()).sum::<usize>(), p.turn_judgments.display()));
        }
    }

    let retention = read_vcs_retention(&p.vcs_retention);
    match &retention {
        Some(r) => log(&format!("build: VCS の照合 {} 件を合成({}、照合 {})", r.sessions.len(), p.vcs_retention.display(), r.generated_at)),
        None if p.vcs_retention.exists() => log(&format!("build: 注意 {} を読めないため、AI の変更の残存は出しません(atlas vcs で作り直せます)", p.vcs_retention.display())),
        None => {}
    }

    // 伏せ字版では表を書かない(依頼文とパスがそのまま入るため)。前に書いた表も消す
    let tables = p.out.join("tables");
    if !o.anonymize {
        write_tables(p, &sessions, cmd, log)?;
    } else if tables.exists() {
        atlas_core::fs_retry::remove_tree(&tables)?;
        log("build: 伏せ字版なので、依頼文の入った表(out/tables/)を消しました");
    }

    let unknown: i64 = s.warnings.unknown_event_types.values().sum();
    let layout = s.source.layout.map(|l| match l {
        atlas_core::types::UploadLayout::Flat => "flat",
        atlas_core::types::UploadLayout::Merged => "merged",
    });
    // 読むだけの画面にするか(送り先から集計した、または別のフォルダを開いた出力先。サーバと同じ判定)
    let read_only = crate::folders::is_read_only_view(&p.out.to_string_lossy(), layout);
    let (groups, memos, member_memos) = if read_only {
        let src: Vec<MemberSource<'_>> = s.sessions.iter().map(MemberSource::from).collect();
        (member_groups(&src), None, Some(p.snapshot.join("session-state")))
    } else {
        (sel.groups.groups.clone(), Some(memos_dir(&p.notes)), None)
    };
    let f = &o.filter;
    let r = build_report(BuildInput {
        sessions: sessions.clone(),
        metrics,
        installed: s.installed.as_ref(),
        installed_by_person: s.installed_by_person.as_ref().and_then(|x| x.as_ref()),
        total_sessions_in_source: s.sessions.len(),
        // アップロードしたフォルダを集計したとき(--home や atlas open)は、どのフォルダの集計かを画面に出す
        source: match (s.source.root.as_deref().filter(|x| !x.is_empty()), s.source.layout) {
            (Some(root), Some(layout)) => Some(ReportSource {
                name: if basename(root).is_empty() { root.to_string() } else { basename(root).to_string() },
                path: root.to_string(),
                layout,
                folders: s.source.folders.as_ref().map_or(1, Vec::len),
            }),
            _ => None,
        },
        warnings: BuildWarnings { unknown_event_types: unknown, bad_lines: s.warnings.bad_lines, notes: sel.groups.warnings.clone() },
        judgments: judgments.as_ref(),
        verdicts: verdicts.as_ref(),
        retention: retention.as_ref(),
        groups,
        memos_dir: memos,
        member_memos_dir: member_memos,
        read_only,
        atlas_local: Some(current_atlas_build(&REPO_ROOT, crate::version::CODE_STAMP)),
        // フォルダごとの、最後に送ったときの日時と版。絞り込んだときは、対象のセッションがあるフォルダだけ
        atlas_uploads: uploads_for(s.source.uploads.as_ref(), &sessions, has_filter(f)),
        out_dir: p.out.clone(),
        anonymize: o.anonymize,
        scope: BuildScope { since: f.since.clone(), project: f.project.clone(), client: f.client.clone(), model: f.model.clone(), branch: f.branch.clone() },
        template: template()?.to_string(),
        css: page_css(),
        code: crate::version::CODE_STAMP.to_string(),
        transcripts: o.transcripts.as_ref().map(|t| TranscriptSettings {
            tool_output: match t.tool_output {
                ToolOutput::Fail => ToolOutputMode::Fail,
                ToolOutput::All => ToolOutputMode::All,
                ToolOutput::None => ToolOutputMode::None,
            },
            max_text_chars: t.max_chars.map_or(DEFAULT_MAX_TEXT_CHARS, |n| n as usize),
            max_tool_chars: DEFAULT_MAX_TOOL_CHARS,
            gap_ms: DEFAULT_GAP_MS,
            snapshot_dir: p.snapshot.clone(),
        }),
        full: o.transcripts.as_ref().is_some_and(|t| t.full),
        library: None,
        desktop_meta: s.desktop.as_ref().and_then(|d| d.as_ref()),
    })?;
    if let Some(at) = &r.stale.full {
        log(&format!("build: 前回の --full の出力(out/full/ と coverage.json、生成 {at})が残っています。消すには --anonymize で作るか、フォルダを手で消してください"));
    }
    if let Some(at) = &r.stale.library {
        log(&format!(
            "build: 前回の export の閲覧ページ(instructions.html と library/、生成 {at})が残っています(前の版の atlas で作ったものなら、開くと「画面とサーバの版が違います」と出ます。atlas export か atlas all で作り直せます)"
        ));
    }
    if let Some(l) = &r.library {
        log(&format!("export: 指示文と skill の閲覧ページ {}({} 項目・{} 版、本文 {} ファイル {})", l.path.display(), l.groups, l.versions, l.files, mb(l.bytes)));
    }
    if let Some(fs) = &r.full {
        log(&format!(
            "export: 全文記録 {} 件(計 {}、イベント {} 件、画像など {} ファイル {}、除外 {} 箇所 {})→ {}",
            fs.files,
            mb(fs.bytes),
            fs.events,
            fs.assets.files,
            mb(fs.assets.bytes),
            fs.excluded.n,
            mb(fs.excluded.bytes),
            p.out.join("full").join("<id>.md").display()
        ));
        let uc = &fs.unclassified;
        log(&format!(
            "export: 網羅の検査 → {}。未分類のキー {} 件{}",
            fs.coverage_path.display(),
            uc.len(),
            if uc.is_empty() { String::new() } else { format!(": {}{}", uc.iter().take(10).cloned().collect::<Vec<_>>().join(", "), if uc.len() > 10 { " …" } else { "" }) }
        ));
        if fs.secret_hits > 0 {
            log(&format!("export: 注意 全文記録で API キーやトークンらしい文字列を {} 件伏せました", fs.secret_hits));
        }
        log("export: 注意 全文記録(out/full/)は原本の文字列をそのまま含みます。共有しないでください");
    }
    if let Some(t) = &r.transcripts {
        log(&format!(
            "export: セッション記録 {} 件(計 {})→ {}{}{}",
            t.files,
            mb(t.bytes),
            r.detail_dir.join("<id>.md").display(),
            if t.from_record_only > 0 { format!("、うちスナップショットに本文が無く抜粋のみ {} 件", t.from_record_only) } else { String::new() },
            if t.truncated > 0 { format!("、中略した本文 {} 件", t.truncated) } else { String::new() }
        ));
        if t.secret_hits > 0 {
            log(&format!("export: 注意 API キーやトークンらしい文字列を {} 件伏せました。本物なら元の記録にも残っているので鍵を作り直してください", t.secret_hits));
        }
        if o.anonymize {
            log("export: 注意 伏せ字モードの記録は自由記述を機械的に置き換えただけです。共有する前に中身を確認してください");
        }
    }
    log(&format!(
        "build: {}({}、うち埋め込みデータ {})、詳細ページ {} 件(計 {}){}、{}",
        r.html_path.display(),
        mb(r.html_bytes),
        mb_i(r.embedded_bytes),
        r.detail_pages,
        mb(r.detail_bytes),
        if o.anonymize { "、伏せ字モード" } else { "" },
        ms(secs(r.ms))
    ));
    if r.oversized {
        log(&format!("build: 注意 atlas.html が上限 {} 以上です({})。ブラウザで開くのが遅くなります。--since で期間を、--project などで対象を絞って作り直してください", mb(HTML_SIZE_LIMIT), mb(r.html_bytes)));
    }
    Ok(r)
}

/// 負になりうる大きさの mb()
fn mb_i(b: i64) -> String {
    format!("{} MB", atlas_core::jsnum::to_fixed(b as f64 / 1024.0 / 1024.0, 2))
}

/// TS 版の ms() と同じ書式で、計った時間を出す(all の完了の行)
pub(crate) fn elapsed(t: std::time::Instant) -> String {
    ms(t.elapsed())
}
