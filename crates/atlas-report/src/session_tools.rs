//! Phase 14: 詳細ページの「記録を読む」「全文を作って読む」と、このセッションだけの LLM 判定。
//! atlas serve のときだけ GET /api/session-tools.js で配る。中身は assets/session-tools.js(ここが元。TS の元は無い)。

pub const SESSION_TOOLS_JS: &str = include_str!("../assets/session-tools.js");
