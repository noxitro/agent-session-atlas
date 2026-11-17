//! 小さな共通の処理

use anyhow::{anyhow, Result};
use std::path::Path;

/// `readFile(path, 'utf8')`(無いときのエラーは Node と同じ文言にする。判定の失敗の記録に残るため)
pub fn read_text(path: &Path) -> Result<String> {
    match std::fs::read(path) {
        Ok(b) => Ok(String::from_utf8_lossy(&b).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(anyhow!("ENOENT: no such file or directory, open '{}'", path.display())),
        Err(e) => Err(anyhow!("{}: {e}", path.display())),
    }
}
