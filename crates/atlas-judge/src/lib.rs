//! atlas-judge: packages/judge の移植(外部の LLM に渡す束の生成、返答の検証、judgments.json のスキーマ)。LLM を呼ぶのは skill-draft だけ。
//! 移植の方針は docs/rust-migration.md。

pub mod backends;
pub mod bundle;
pub mod judgments_io;
pub mod packet;
pub mod rejudge;
pub mod rubric;
pub mod schema;
pub mod skill_draft;
pub mod task_link;
pub mod turn_bundle;
pub mod turn_schema;
mod util;
pub mod zip;

pub use util::read_text;
