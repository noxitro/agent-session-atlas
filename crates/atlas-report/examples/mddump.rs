//! Markdown の描画の Rust 版の結果を JSON に書く(scripts/parity-markdown.ts の Rust 側)。
//!
//!   cargo run --release -p atlas-report --example mddump -- <cases.json> <out.json>
//!
//! cases.json は [{ mode: "memo" | "transcript" | "full", text, id? }]。memo は renderMemoHtml(画像は解決しない)、
//! transcript / full は renderViewDocument(全文記録の置き場は無し)と同じ呼び方。

use anyhow::Result;
use atlas_report::memo_render::render_memo_html;
use atlas_report::viewer::{render_view_document, ViewKind};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Case {
    mode: String,
    text: String,
    #[serde(default)]
    id: Option<String>,
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cases: Vec<Case> = atlas_core::js::parse_json_as(&std::fs::read_to_string(&args[0])?)?;
    let out: Vec<Value> = cases
        .iter()
        .map(|c| match c.mode.as_str() {
            "memo" => json!({ "html": render_memo_html(&c.text, &|_| None) }),
            kind => {
                let d = render_view_document(&c.text, ViewKind::parse(kind).unwrap_or(ViewKind::Transcript), c.id.as_deref().unwrap_or("s"), None);
                json!({ "html": d.html, "headings": d.headings, "title": d.title })
            }
        })
        .collect();
    std::fs::write(&args[1], atlas_core::json::to_js_string(&out)?)?;
    Ok(())
}
