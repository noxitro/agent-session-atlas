//! atlas bundle(packages/cli/src/commands.ts の runBundle の移植)。ログの文言は TS 版と同じ。

use super::metrics::{select_sessions, SessionFilter};
use super::{mb, ms, Log};
use crate::paths::Paths;
use anyhow::Result;
use atlas_core::jsnum::to_fixed;
use atlas_judge::bundle::{build_bundle, BundleManifest, BundleOptions};
use atlas_judge::judgments_io::read_judgments;
use atlas_judge::zip::{write_bundle_zip, DosTime};
use indexmap::IndexMap;
use std::collections::HashSet;
use std::time::Instant;

/// 容量(TS 版の kb())
pub(crate) fn kb(b: i64) -> String {
    format!("{} KB", to_fixed(b as f64 / 1024.0, 1))
}

/// --zip の出力先(バンドルのフォルダの隣。out/bundle なら out/bundle.zip)
pub(crate) fn zip_path(bundle: &std::path::Path) -> std::path::PathBuf {
    let mut name = bundle.file_name().map(|n| n.to_os_string()).unwrap_or_else(|| "bundle".into());
    name.push(".zip");
    bundle.with_file_name(name)
}

pub struct BundleCliOptions {
    pub include_empty: bool,
    pub per_part: Option<u64>,
    pub unjudged: bool,
    /// バンドルを 1 つの ZIP にもまとめる(<bundle>.zip)
    pub zip: bool,
    /// 設定ファイル(--config。無ければ環境変数 ATLAS_CONFIG かリポジトリ直下の atlas.config.json)
    pub config: Option<String>,
}

/// llm-wiki の vault の指定を設定から読む(ページごとの判定の抜粋を、集計と同じ分類器で取るため)。
/// 読めない設定は、束を作るのを止めずに、指定なしとして続けてログに書く
fn wiki_specs(config: Option<&str>, log: Log<'_>) -> Vec<atlas_core::wiki::WikiSpec> {
    let explicit = config.is_some() || std::env::var_os("ATLAS_CONFIG").is_some();
    let path = match config {
        Some(c) => crate::paths::resolve(c).to_string_lossy().into_owned(),
        None => crate::config::default_config_path(),
    };
    match crate::config::load_config(&path, explicit) {
        Ok(c) => c.wikis.unwrap_or_default(),
        Err(e) => {
            log(&format!("bundle: 注意 設定を読めないので、llm-wiki のページの抜粋はページの名前で探します: {e}"));
            Vec::new()
        }
    }
}

pub fn run_bundle(p: &Paths, f: &SessionFilter, o: &BundleCliOptions, log: Log<'_>) -> Result<BundleManifest> {
    let sel = select_sessions(p, f, "bundle", "先に atlas extract(または atlas all)を実行してください。", log)?;
    let mut sessions = sel.sessions();
    if o.unjudged {
        let judged: HashSet<String> = read_judgments(&p.judgments)?.map(|j| j.items.into_iter().map(|i| i.session_id).collect()).unwrap_or_default();
        let before = sessions.len();
        sessions.retain(|s| !judged.contains(&s.id));
        log(&format!("bundle: 判定済みの {} 件を除きました(--unjudged)", before - sessions.len()));
    }
    let t = Instant::now();
    let nz = |v: &Option<String>| v.clone();
    let mut scope: IndexMap<String, Option<String>> = IndexMap::new();
    scope.insert("since".into(), nz(&f.since));
    scope.insert("project".into(), nz(&f.project));
    scope.insert("client".into(), nz(&f.client));
    scope.insert("model".into(), nz(&f.model));
    scope.insert("branch".into(), nz(&f.branch));
    scope.insert("session".into(), f.sessions.as_ref().filter(|s| !s.is_empty()).map(|s| s.join(",")));
    scope.insert("unjudged".into(), if o.unjudged { Some("yes".into()) } else { None });
    let m = build_bundle(
        &sessions,
        &BundleOptions {
            bundle_dir: p.bundle.clone(),
            snapshot_dir: Some(p.snapshot.clone()),
            limits: None,
            include_empty: o.include_empty,
            per_part: o.per_part.map(|n| n as usize),
            boundary: None,
            scope,
            log,
            now: None,
            // 選んだセッションだけでなく集計の全セッションで決める(書き込みだけのセッションが選ばれていなくても、vault を指定していたと分かる)
            wiki_state: atlas_core::wiki::wiki_state(sel.file.sessions.iter().map(|r| &r.wiki), sel.file.source.wikis),
            wiki_specs: wiki_specs(o.config.as_deref(), log),
        },
    )?;
    let excerpt = m.sessions.iter().filter(|e| e.text_source == atlas_judge::packet::TextSource::Excerpt).count();
    let truncated = m.sessions.iter().filter(|e| e.truncated > 0).count();
    log(&format!(
        "bundle: パケット {} 件(依頼の記録が無く対象外 {} 件)、合計 {}、最大 {}、本文を中略したもの {truncated} 件{} → {}、{}",
        m.count,
        m.skipped.len(),
        mb(m.total_bytes.max(0) as u64),
        kb(m.max_bytes),
        if excerpt > 0 { format!("、抜粋のみ {excerpt} 件") } else { String::new() },
        p.bundle.display(),
        ms(t.elapsed())
    ));
    if o.zip {
        let zip = zip_path(&p.bundle);
        let root = p.bundle.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "bundle".into());
        let z = write_bundle_zip(&p.bundle, &m, &zip, &root, DosTime::now())?;
        log(&format!("bundle: ZIP にまとめました({} ファイル、{}、無圧縮。parts/ は入れていません)→ {}", z.files, mb(z.bytes), zip.display()));
        log("bundle: フォルダやファイルを読めるエージェントに渡し、INSTRUCTIONS.md を最初に読ませてください。返ってきた JSON は atlas judge import <ファイル> で取り込みます");
    } else {
        // 前に作った ZIP は中身がこの束と合わなくなるので消す(古い材料を渡させない)。
        // 消すのは出力先の既定の場所(<out>/bundle.zip。画面が見るのもここ)だけ。--bundle で指した先の隣は、利用者が別に置いたファイルかもしれないので触らない
        let zip = zip_path(&p.bundle);
        if zip.is_file() {
            if p.bundle == p.out.join("bundle") {
                match std::fs::remove_file(&zip) {
                    Ok(()) => log(&format!("bundle: 前に作った ZIP は中身が古くなったので消しました({})", zip.display())),
                    Err(e) => log(&format!("bundle: 前に作った ZIP を消せませんでした(中身は前の束のままです。{}): {e}", zip.display())),
                }
            } else {
                log(&format!("bundle: 注意 {} は今の束より前のものです(--zip を付けて作り直すと作り直します。消していません)", zip.display()));
            }
        }
        log("bundle: 外部の LLM に渡すときは --zip を付けて作った ZIP(またはフォルダごと)を渡し、INSTRUCTIONS.md を最初に読ませてください");
    }
    if let Some(parts) = m.parts.as_ref().filter(|x| !x.is_empty()) {
        let max_part = parts.iter().map(|x| x.bytes).max().unwrap_or(0);
        log(&format!(
            "bundle: ZIP を渡せないときは parts/ の {} ファイル({} 件ずつ、最大 {})を 1 つずつ添付してください(指示と JSON Schema も中に入っています)",
            parts.len(),
            m.per_part.unwrap_or(0),
            kb(max_part)
        ));
    }
    Ok(m)
}
