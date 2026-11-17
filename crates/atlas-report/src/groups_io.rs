//! atlas-notes/groups.json の読み書き(packages/report/src/groups-io.ts の移植)。読み取りは groups.rs の load_groups。
//! 書き込み(atlas group add / remove)は、壊れたファイルを上書きしない(直してもらう)。

pub use crate::groups::{load_groups, LoadedGroups};
use crate::groups::{serialize_groups, SessionGroup};
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// 読めない・形が違う箇所があるファイルは書き換えない(ユーザーの手書きを壊さない)
pub fn load_groups_for_write(path: &Path) -> Result<Vec<SessionGroup>> {
    let g = load_groups(path);
    if !g.warnings.is_empty() {
        bail!("{} に直す必要のある箇所があるため書き換えません:\n  {}", path.display(), g.warnings.join("\n  "));
    }
    Ok(g.groups)
}

static SEQ: AtomicU64 = AtomicU64::new(0);

/// 一時ファイルの名前(TS 版は randomUUID。同じ時に書く他のプロセス・スレッドと重ならなければよい)
fn tmp_path(path: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let mut s = path.as_os_str().to_owned();
    s.push(format!(".{}-{nanos:x}-{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    PathBuf::from(s)
}

/// 一時ファイルに書いてから rename する(途中で止まっても groups.json が欠けない。同時に読む側も書きかけを見ない)
pub fn save_groups(path: &Path, groups: &[SessionGroup]) -> Result<()> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("{} を作れません", dir.display()))?;
    }
    let tmp = tmp_path(path);
    std::fs::write(&tmp, serialize_groups(groups)).with_context(|| format!("{} に書けません", tmp.display()))?;
    if let Err(e) = atlas_core::fs_retry::rename_replacing(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("{} を置き換えられません", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_refuses_broken() {
        let dir = std::env::temp_dir().join(format!("atlas-groups-io-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = dir.join("notes").join(crate::groups::GROUPS_FILE_NAME);
        assert!(load_groups_for_write(&p).unwrap().is_empty());
        let g = vec![SessionGroup { name: "g".into(), note: "".into(), ids: vec!["a".into()] }];
        save_groups(&p, &g).unwrap();
        assert_eq!(load_groups_for_write(&p).unwrap(), g);
        assert_eq!(std::fs::read_dir(p.parent().unwrap()).unwrap().count(), 1);
        std::fs::write(&p, "{ broken").unwrap();
        assert!(load_groups_for_write(&p).unwrap_err().to_string().contains("書き換えません"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
