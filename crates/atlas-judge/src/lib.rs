//! atlas-judge: packages/judge の移植(評価バンドル生成、judgments.json のスキーマと検証、判定バックエンド)。
//! 移植の方針は docs/rust-migration.md。

pub mod backends;
pub mod bundle;
pub mod judgments_io;
pub mod packet;
pub mod rubric;
pub mod run;
pub mod schema;
pub mod skill_draft;
pub mod turn_bundle;
pub mod turn_run;
pub mod turn_schema;
mod util;

pub use util::read_text;
