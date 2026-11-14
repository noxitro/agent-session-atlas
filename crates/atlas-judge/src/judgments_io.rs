//! judgments.json の読み取り(packages/judge/src/judgments-io.ts の readJudgments の移植)。
//! TODO(段 6): writeJudgments・importJudgments・importJudgmentsText は judge の移植で足す

use crate::schema::{validate_judgments, JudgmentsFile};
use anyhow::{anyhow, Result};
use std::path::Path;

/// judgments.json を読んで検証する。無ければ None。JSON として読めない・形が違うときはエラー
pub fn read_judgments(path: &Path) -> Result<Option<JudgmentsFile>> {
    if !path.exists() {
        return Ok(None);
    }
    let p = path.display();
    let bytes = std::fs::read(path).map_err(|e| anyhow!("{p} を JSON として読めません: {e}"))?;
    let raw = atlas_core::js::parse_json(&String::from_utf8_lossy(&bytes)).map_err(|e| anyhow!("{p} を JSON として読めません: {e}"))?;
    validate_judgments(&raw).map(Some).map_err(|e| anyhow!("{p}: {e}"))
}
