//! atlas snapshot(packages/cli/src/commands.ts の runSnapshot の移植)。ログの文言は TS 版と同じ(所要時間だけ違う)。

use super::{mb, ms, Log};
use crate::paths::Paths;
use anyhow::{Result, bail};
use atlas_core::snapshot::{self, SnapshotManifest, SnapshotOptions, SourceShape, UPLOAD_OLD_ONLY_REASON, UPLOAD_PROBE_HINT, describe_source, upload_work_dir_id};
use std::collections::HashSet;
use std::time::Instant;

/// path.basename(Windows では \ と / の両方で区切る)
fn basename(p: &str) -> &str {
    let seps: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
    p.trim_end_matches(seps).rsplit(seps).next().unwrap_or("")
}

pub fn run_snapshot(p: &Paths, since: Option<&str>, log: Log<'_>, all: bool, prune: bool) -> Result<SnapshotManifest> {
    if !p.home.exists() {
        bail!("Copilot のデータが見つかりません: {}(--home で場所を指定できます)", p.home.display());
    }
    let t = Instant::now();
    log(&format!("snapshot: {} → {}{}{}", p.home.display(), p.snapshot.display(), if all { "(--snapshot-all)" } else { "" }, if prune { "(--snapshot-prune)" } else { "" }));
    let m = snapshot::snapshot(&p.home, &p.snapshot, &SnapshotOptions { since: since.map(str::to_string), all, prune })?;
    let s = &m.sessions;
    log(&format!(
        "snapshot: セッションディレクトリ {}(複製 {} / 再利用 {} ファイル、{}、session.db 複製 {} / 再利用 {})、{}",
        s.dirs,
        s.copied_files,
        s.reused_files,
        mb(s.bytes),
        s.db_copied.unwrap_or(0),
        s.db_reused.unwrap_or(0),
        ms(t.elapsed())
    ));
    // 集計できる形のフォルダではなかったとき(0 件のまま黙って空のレポートを作らないように、指定のしかたを出す)
    if s.dirs == 0 && s.skipped_by_since == 0 && describe_source(&p.home) == SourceShape::None {
        log(&format!(
            "snapshot: 注意 {} には、集計できるセッションが見つかりません。--home には、Copilot のデータのフォルダ(.copilot)か、アップロード先のフォルダ・その下の人ごとのフォルダ・プロジェクトのフォルダを指定してください(読むのは 2 段下までです)。{}",
            p.home.display(),
            *UPLOAD_PROBE_HINT
        ));
    }
    for (name, d) in &m.databases {
        if let (false, Some(e)) = (d.copied, &d.error) {
            log(&format!("snapshot: 注意 {name} を今回は複製できませんでした({}): {e}", if d.bytes > 0 { "前回の複製を使います" } else { "前回の複製も無いので、このファイルの内容は使いません" }));
        }
    }
    if let Some(errs) = m.session_db_errors.as_ref().filter(|e| !e.is_empty()) {
        log(&format!("snapshot: 注意 session.db を複製できなかったセッション {} 件({})", errs.len(), errs.iter().take(3).cloned().collect::<Vec<_>>().join(" / ")));
    }
    if let Some(mg) = &m.merged {
        let names = &mg.folders;
        let more = if names.len() > 5 { format!(" ほか {} 件", names.len() - 5) } else { String::new() };
        log(&format!("snapshot: 下のフォルダ {} 件をまとめて読みました({}{more})", names.len(), names.iter().take(5).cloned().collect::<Vec<_>>().join("、")));
        if mg.duplicates > 0 {
            log(&format!(
                "snapshot: 注意 同じ id のセッションが複数のフォルダにあったので、events.jsonl が大きいほうだけ数えました(数えなかったもの {} 件。manifest の extras.skipped)",
                mg.duplicates
            ));
        }
    }
    if let Some(x) = &m.extras {
        if let Some(r) = x.recovered.as_ref().filter(|r| !r.is_empty()) {
            log(&format!(
                "snapshot: 注意 アップロードの置き換えが途中で止まっていたセッション {} 件は、写し終えていた作業用のフォルダから写しました({})",
                r.len(),
                r.iter().take(3).map(|x| x.path.clone()).collect::<Vec<_>>().join(" / ")
            ));
        }
        let old_only: Vec<&String> = x.skipped.iter().filter(|k| k.reason == UPLOAD_OLD_ONLY_REASON).map(|k| &k.path).collect();
        if !old_only.is_empty() {
            let ids: HashSet<Option<String>> = old_only.iter().map(|p| upload_work_dir_id(basename(p))).collect();
            log(&format!(
                "snapshot: 注意 本体のフォルダが無く、アップロードの置き換えで退けた前のフォルダだけが残っているセッション {} 件は、写していません({})。共有から消したセッションなら、このフォルダも消してください。消した覚えが無ければ、送った PC でもう一度アップロードすると戻ります",
                ids.len(),
                old_only.iter().take(3).map(|s| s.as_str()).collect::<Vec<_>>().join(" / ")
            ));
        }
        let top = x.top_level.iter().map(|(k, v)| format!("{k} {}", v.files)).collect::<Vec<_>>().join(" / ");
        log(&format!(
            "snapshot: 付随物 セッションフォルダ {} ファイル({}){}、写さなかったもの {} 件({}。manifest の extras.skipped)",
            x.session_files,
            mb(x.session_bytes),
            if top.is_empty() { String::new() } else { format!("、直下 {top}") },
            x.skipped.len(),
            mb(x.skipped.iter().map(|s| s.bytes).sum())
        ));
        if let Some(d) = &x.desktop {
            log(&format!(
                "snapshot: data.db → desktop.json(許可リストの列だけ、{} セッション{})",
                d.sessions,
                if d.warnings.is_empty() { String::new() } else { format!("、注意 {}", d.warnings.join(" / ")) }
            ));
        }
        if !x.leftover.is_empty() {
            let mut times: Vec<&str> = x.leftover.iter().map(|l| l.mtime.as_str()).collect();
            times.sort_by(|a, b| atlas_core::js::cmp_utf16(a, b));
            log(&format!(
                "snapshot: 前回 --snapshot-all で写したもの {} 件が残っています(最新 {}。消すには --snapshot-prune。manifest の extras.leftover)",
                x.leftover.len(),
                times.last().copied().unwrap_or("")
            ));
        }
    }
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn formats_like_ts() {
        assert_eq!(mb(131072), "0.13 MB");
        assert_eq!(mb(0), "0.00 MB");
        assert_eq!(ms(Duration::from_millis(13_750)), "13.8 秒");
        assert_eq!(basename("proj-a/.s6.old"), ".s6.old");
        assert_eq!(basename(".s6.old"), ".s6.old");
    }
}
