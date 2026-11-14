//! まとめたプロジェクトのキー(表示名を兼ねる。packages/core/src/project-keys.ts の移植)。
//! 定義は project.rs にある(段 1b で移したもの)。TS のモジュールと対応が取れるよう、ここから同じ名前で引けるようにする。

pub use crate::project::{ATLAS_JUDGE_PROJECT, GROUPED_PROJECTS, HOME_PROJECT, TEMP_PROJECT};
