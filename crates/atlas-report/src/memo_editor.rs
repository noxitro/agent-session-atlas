//! 詳細ページのメモの編集(packages/report/src/memo-editor.ts の移植)。atlas serve のときだけ GET /api/memo-editor.js で配る。
//! 静的ページには埋め込まない。中身は TS の MEMO_EDITOR_JS の値をそのまま書き出したもの(scripts/gen-report-assets.ts。ずれは cargo test が検出する)。

pub const MEMO_EDITOR_JS: &str = include_str!("../assets/memo-editor.js");
