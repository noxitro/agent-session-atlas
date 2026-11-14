//! atlas-report: packages/report の Node 側と、build が使う lib/* の移植。移植の方針は docs/rust-migration.md。
//!
//! lib/* の移植(段 4-1): TS の lib/<名前>.ts を <名前>.rs に移す(exec-labels → exec_labels など)。
//! ブラウザだけが使う lib(compare・hints・job-log・model-value・scale)と、ページに JS として埋め込む
//! scroll-focus・code-check は移していない(後者は描画の移植で扱う)。

pub mod aggregate;
pub mod anonymize;
pub mod embed;
pub mod exec;
pub mod exec_labels;
pub mod filter;
pub mod format;
pub mod glossary;
pub mod groups;
pub mod groups_io;
pub mod highlights;
pub mod insights;
pub mod judgment_labels;
pub mod judgments;
pub mod memo;
pub mod pack;
pub mod retention;
pub mod summarize;
pub mod turns;
pub mod types;
pub mod verdicts;
