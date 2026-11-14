//! Phase 14: 詳細ページの「記録を読む」「全文を作って読む」とタスクタグ(packages/report/src/session-tools.ts の移植)。
//! atlas serve のときだけ GET /api/session-tools.js で配る。中身は TS の SESSION_TOOLS_JS の値をそのまま書き出したもの
//! (scripts/gen-report-assets.ts。ずれは cargo test が検出する)。

pub const SESSION_TOOLS_JS: &str = include_str!("../assets/session-tools.js");
