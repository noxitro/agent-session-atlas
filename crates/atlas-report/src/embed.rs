//! テンプレート(dist/template.html)へのデータ埋め込み(packages/report/src/lib/embed.ts の移植)。
//! <script type="application/json"> の中身として安全な JSON にする:
//! - </script> や <!-- で要素が閉じないよう < > & をエスケープ
//! - 本文中の URL や "fetch(" が静的検査(外部参照の不在)に引っかからないよう / と ( もエスケープ
//!
//! セッションの要約は既定値と同じ項目を落として埋め込むので(pack.rs)、取り出すときは埋め戻す

use crate::pack::unpack_data;
use anyhow::{anyhow, bail, Result};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::sync::LazyLock;

pub const DATA_PLACEHOLDER: &str = "__ATLAS_DATA__";
pub const DATA_ELEMENT_ID: &str = "atlas-data";

pub fn serialize_for_script<T: Serialize + ?Sized>(data: &T) -> Result<String> {
    let json = atlas_core::json::to_js_string(data)?;
    let mut out = String::with_capacity(json.len() + json.len() / 16);
    for c in json.chars() {
        match c {
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            '/' => out.push_str("\\/"),
            '(' => out.push_str("\\u0028"),
            _ => out.push(c),
        }
    }
    Ok(out)
}

pub fn embed_data<T: Serialize + ?Sized>(template: &str, data: &T) -> Result<String> {
    let Some(i) = template.find(DATA_PLACEHOLDER) else {
        bail!("テンプレートに埋め込み位置 {DATA_PLACEHOLDER} がありません(report のビルドが壊れています)");
    };
    if template[i + 1..].contains(DATA_PLACEHOLDER) {
        bail!("テンプレートに {DATA_PLACEHOLDER} が複数あります");
    }
    Ok(format!("{}{}{}", &template[..i], serialize_for_script(data)?, &template[i + DATA_PLACEHOLDER.len()..]))
}

static EMBEDDED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r#"<script type="application/json" id="{DATA_ELEMENT_ID}">((?s:.*?))</script>"#)).unwrap());

/// 生成済み HTML から埋め込みデータを取り出す(テスト・検証用)
pub fn extract_embedded(html: &str) -> Result<Value> {
    let m = EMBEDDED_RE.captures(html).ok_or_else(|| anyhow!("埋め込みデータが見つかりません"))?;
    let v = atlas_core::js::parse_json(&m[1])?;
    Ok(unpack_data(v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // report-lib.test.ts の「</script> や URL・fetch( を含む本文でも安全に埋め込み、往復できる」
    #[test]
    fn safe_round_trip() {
        let data = json!({ "t": "</script><!-- https://example.com fetch(x) \u{2028} & >" });
        let tpl = r#"<script type="application/json" id="atlas-data">__ATLAS_DATA__</script>"#;
        let html = embed_data(tpl, &data).unwrap();
        assert!(!Regex::new(r"https?://").unwrap().is_match(&html));
        assert!(!html.contains("fetch("));
        assert_eq!(html.matches("</script>").count(), 1);
        assert_eq!(extract_embedded(&html).unwrap(), data);
        assert_eq!(atlas_core::js::parse_json(&serialize_for_script(&data).unwrap()).unwrap(), data);
        assert!(embed_data("<p></p>", &data).unwrap_err().to_string().contains("埋め込み位置"));
    }
}
