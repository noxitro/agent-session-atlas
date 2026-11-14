//! atlas memo list / show / set / remove(packages/cli/src/commands.ts の runMemo の移植)。
//! id は sessions.json があれば先頭一致で解決する(無ければそのまま使う)。

use super::group::session_ids;
use super::Log;
use crate::args::MemoCliOptions;
use crate::paths::Paths;
use anyhow::{anyhow, bail, Result};
use atlas_report::groups::resolve_id_prefixes;
use atlas_report::memo::memo_summary;
use atlas_report::memo_io::{load_memo_index, memos_dir, read_memo, save_memo};
use indexmap::IndexSet;

pub fn run_memo(p: &Paths, m: &MemoCliOptions, log: Log<'_>) -> Result<()> {
    let dir = memos_dir(&p.notes);
    let known = if p.sessions.exists() { Some(session_ids(&p.sessions)?) } else { None };
    if m.action == "list" {
        let index = load_memo_index(&dir);
        log(&format!("memo: {} 件({})", index.len(), dir.display()));
        for (id, x) in &index {
            let s = memo_summary(&x.text, Some(&x.updated_at));
            log(&format!(
                "  {id}: {}{}{}",
                if s.excerpt.is_empty() { "(本文なし)" } else { &s.excerpt },
                if s.images > 0 { format!("(画像 {} 枚)", s.images) } else { String::new() },
                if known.as_ref().is_some_and(|k| !k.contains(id)) { "(記録に無いセッション)" } else { "" }
            ));
        }
        return Ok(());
    }
    let given = m.id.clone().unwrap_or_default();
    let id = match &known {
        Some(k) => {
            let all: IndexSet<String> = k.iter().cloned().chain(load_memo_index(&dir).into_keys()).collect();
            resolve_id_prefixes(&all.iter().map(String::as_str).collect::<Vec<_>>(), &[given])?.into_iter().next().unwrap_or_default()
        }
        None => given,
    };
    if m.action == "show" {
        let Some(x) = read_memo(&dir, &id)? else { bail!("セッション {id} のメモはありません") };
        log(&x.text);
        return Ok(());
    }
    if m.action == "remove" {
        if read_memo(&dir, &id)?.is_none() {
            bail!("セッション {id} のメモはありません");
        }
        save_memo(&dir, &id, "", None)?;
        log(&format!("memo: {id} のメモを削除しました(画像は {} に残ります)", dir.join(&id).display()));
        return Ok(());
    }
    let text = match &m.file {
        Some(f) => String::from_utf8_lossy(&std::fs::read(f).map_err(|e| anyhow!("{e}: {f}"))?).into_owned(),
        None => m.text.clone().unwrap_or_default(),
    };
    if atlas_core::js::trim(&text).is_empty() {
        bail!("本文が空です(削除は atlas memo remove で行います)");
    }
    let r = save_memo(&dir, &id, &text, None)?;
    let len = r.memo.as_ref().map_or(0, |x| atlas_core::js::utf16_len(&x.text));
    log(&format!("memo: {id} のメモを保存しました({len} 文字)→ {}", dir.join(format!("{id}.md")).display()));
    Ok(())
}
