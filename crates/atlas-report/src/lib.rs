//! atlas-report: packages/report の Node 側と、build が使う lib/* の移植。移植の方針は docs/rust-migration.md。
//!
//! lib/* の移植(段 4-1): TS の lib/<名前>.ts を <名前>.rs に移す(exec-labels → exec_labels など)。
//! ブラウザだけが使う lib(compare・hints・job-log・model-value・scale)は移していない。ページに JS として埋め込む
//! scroll-focus・code-check の値は、TS の NAV_JS に埋め込まれた形のまま assets/nav.js に入っている(page_nav.rs)。
//!
//! ページの描画(段 4-2): build・detail・transcript・full・coverage・library・insights_page・glossary_page・page_nav・memo_render・
//! memo_io・memo_editor・session_tools・viewer。ページに埋め込む JS と CSS の文字列は assets/ にあり、そこを直接直す
//! (はじめは TS から書き出したものだが、TS の元はもう無い)。

pub mod aggregate;
pub mod build;
pub mod coverage;
pub mod detail;
pub mod embed;
pub mod exec;
pub mod exec_labels;
pub mod failure_stats;
pub mod failures_page;
pub mod filter;
pub mod format;
pub mod full;
pub mod glossary;
pub mod glossary_page;
pub mod highlights;
pub mod html;
pub mod ids;
pub mod insights;
pub mod insights_page;
pub mod jssort;
pub mod judgment_labels;
pub mod judgments;
pub mod library;
pub mod memo;
pub mod memo_editor;
pub mod memo_io;
pub mod memo_render;
pub mod pack;
pub mod page_nav;
pub mod project_label;
pub mod raw_events;
pub mod retention;
pub mod session_tools;
pub mod summarize;
pub mod tasks;
pub mod test_tables;
pub mod transcript;
pub mod turns;
pub mod types;
pub mod verdicts;
pub mod viewer;
