//! atlas group list / add / remove / export / upload(packages/cli/src/commands.ts の runGroup の移植)。
//! add の id は sessions.json があれば先頭一致で解決する(無ければそのまま書く)。壊れた groups.json は上書きしない(load_groups_for_write がエラーにする)。

use super::Log;
use crate::args::GroupCliOptions;
use crate::group_export::{export_group, GroupExportPaths};
use crate::jobs::acquire_out_lock;
use crate::paths::Paths;
use anyhow::{anyhow, bail, Result};
use atlas_report::groups::{resolve_id_prefixes, unique_ids, SessionGroup};
use atlas_report::groups_io::{load_groups, load_groups_for_write, save_groups};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

/// sessions.json のセッション id(TS 版の readJson の後の sessions.map(id))
pub(crate) fn session_ids(path: &Path) -> Result<Vec<String>> {
    if !path.exists() {
        bail!("{} がありません。", path.display());
    }
    let text = std::fs::read(path).map_err(|e| anyhow!("{} を読めません: {e}", path.display()))?;
    let v = atlas_core::js::parse_json(&String::from_utf8_lossy(&text)).map_err(|e| anyhow!("{} を読めません: {e}", path.display()))?;
    Ok(v.get("sessions").and_then(Value::as_array).map(|a| a.iter().filter_map(|s| s.get("id").and_then(Value::as_str)).map(str::to_string).collect()).unwrap_or_default())
}

pub fn run_group(p: &Paths, g: &GroupCliOptions, config: Option<&str>, log: Log<'_>) -> Result<()> {
    let name = g.name.clone().unwrap_or_default();
    match g.action.as_str() {
        "list" => {
            let loaded = load_groups(&p.groups);
            for w in &loaded.warnings {
                log(&format!("group: 注意 {w}"));
            }
            if !loaded.exists {
                log(&format!("group: {} はまだありません(atlas group add <名前> <id...> で作れます)", p.groups.display()));
                return Ok(());
            }
            let known: Option<HashSet<String>> = if p.sessions.exists() { Some(session_ids(&p.sessions)?.into_iter().collect()) } else { None };
            log(&format!("group: {} グループ({})", loaded.groups.len(), p.groups.display()));
            for x in &loaded.groups {
                let k = known.as_ref().map(|k| x.ids.iter().filter(|id| k.contains(*id)).count());
                log(&format!(
                    "  {}: {} 件{}{}",
                    x.name,
                    x.ids.len(),
                    match k {
                        Some(k) if k != x.ids.len() => format!("(うち記録にあるのは {k} 件)"),
                        _ => String::new(),
                    },
                    if x.note.is_empty() { String::new() } else { format!(" — {}", x.note) }
                ));
            }
            Ok(())
        }
        "upload" => crate::group_upload::run_group_upload(p, &name, g.to.as_deref(), g.force, config, log),
        "export" => {
            // 書き出しは out/ を読む(と out/groups/ に書く)ので、集計の途中と重ならないよう印を取る
            let lock = acquire_out_lock(&p.out, "group export", "cli")?;
            let r = export_group(&GroupExportPaths { out: &p.out, sessions: &p.sessions, judgments: &p.judgments, groups: &p.groups, turn_judgments: Some(&p.turn_judgments) }, &name, &|m| log(m));
            lock.release();
            r.map(|_| ())
        }
        "remove" => {
            let mut groups = load_groups_for_write(&p.groups)?;
            let Some(i) = groups.iter().position(|x| x.name == name) else {
                bail!(
                    "グループ「{name}」は {} にありません{}",
                    p.groups.display(),
                    if groups.is_empty() { String::new() } else { format!("(あるのは: {})", groups.iter().map(|x| x.name.as_str()).collect::<Vec<_>>().join(", ")) }
                );
            };
            groups.remove(i);
            save_groups(&p.groups, &groups)?;
            log(&format!("group: 「{name}」を削除しました → {}(残り {} グループ)", p.groups.display(), groups.len()));
            Ok(())
        }
        _ => {
            let mut groups = load_groups_for_write(&p.groups)?;
            let mut ids = unique_ids(g.ids.iter().map(String::as_str));
            if p.sessions.exists() {
                let known = session_ids(&p.sessions)?;
                ids = resolve_id_prefixes(&known.iter().map(String::as_str).collect::<Vec<_>>(), &ids)?;
            } else {
                log(&format!("group: 注意 {} が無いため id を先頭一致で解決せず、そのまま書きます", p.sessions.display()));
            }
            if let Some(cur) = groups.iter_mut().find(|x| x.name == name) {
                let before = cur.ids.len();
                cur.ids = unique_ids(cur.ids.iter().chain(ids.iter()).map(String::as_str));
                if let Some(n) = &g.note {
                    cur.note = n.clone();
                }
                let added = cur.ids.len() - before;
                let total = cur.ids.len();
                save_groups(&p.groups, &groups)?;
                log(&format!("group: 「{name}」に {added} 件を追記しました(重複 {} 件を除く、計 {total} 件)→ {}", ids.len() - added, p.groups.display()));
            } else {
                let n = ids.len();
                groups.push(SessionGroup { name: name.clone(), note: g.note.clone().unwrap_or_default(), ids });
                save_groups(&p.groups, &groups)?;
                log(&format!("group: 「{name}」を作りました({n} 件)→ {}", p.groups.display()));
            }
            Ok(())
        }
    }
}
