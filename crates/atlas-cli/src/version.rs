//! atlas 自身の版(build.rs がビルドのときに決める)。
//! 配る版はワークスペースの Cargo.toml の version(リリースのタグは v<version>)。scripts/ensure-atlas.ps1 は
//! `atlas --version` の 1 語目の後ろの版と Cargo.toml の version を比べ、違えば実行ファイルを取り直すかビルドし直す。

/// 配る版(ワークスペースの Cargo.toml の version)
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// 作ったときの git のコミット(全桁。分からなければ空)
pub const COMMIT: &str = env!("ATLAS_BUILD_COMMIT");
/// 版の目印(画面とサーバの版のずれを見つけるのに使う。build.rs の説明を参照)
pub const CODE_STAMP: &str = env!("ATLAS_CODE_STAMP");

/// `atlas --version` の 1 行: `atlas 0.1.0 (commit <全桁>, code <目印>)`。コミットが分からなければ commit を省く
pub fn version_line() -> String {
    if COMMIT.is_empty() { format!("atlas {VERSION} (code {CODE_STAMP})") } else { format!("atlas {VERSION} (commit {COMMIT}, code {CODE_STAMP})") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_line_starts_with_the_cargo_version() {
        let l = version_line();
        assert!(l.starts_with(&format!("atlas {VERSION} (")), "{l}");
        assert_eq!(CODE_STAMP.len(), 16);
        assert!(CODE_STAMP.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(COMMIT.is_empty() || COMMIT.len() >= 40);
    }
}
