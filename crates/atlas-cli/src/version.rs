//! atlas 自身の版(build.rs がビルドのときに決める)。
//! 版は、ワークスペースの Cargo.toml の version(ビルドのときに環境変数 ATLAS_VERSION を渡せば、その版)。
//! scripts/ensure-atlas.ps1 は `atlas --version` に出る作ったときのコミットを、チェックアウトの HEAD と比べ、違えばビルドし直す
//! (git で取得したフォルダでなければ、版を Cargo.toml の version と比べる)。

/// 版(ATLAS_VERSION。無ければワークスペースの Cargo.toml の version。semver の形)
pub const VERSION: &str = env!("ATLAS_VERSION");
/// 作ったときの git のコミット(全桁。git が管理しているファイルを変えたまま作ったら、後ろに -dirty。分からなければ空)
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
    fn version_line_starts_with_the_version() {
        let l = version_line();
        assert!(l.starts_with(&format!("atlas {VERSION} (")), "{l}");
        assert!(crate::version_format::is_semver(VERSION), "{VERSION}");
        // ATLAS_VERSION を渡さずに作ったときは Cargo.toml の version
        if std::env::var_os("ATLAS_VERSION").is_none_or(|v| v.is_empty()) {
            assert_eq!(VERSION, env!("CARGO_PKG_VERSION"));
        }
        assert_eq!(CODE_STAMP.len(), 16);
        assert!(CODE_STAMP.bytes().all(|b| b.is_ascii_hexdigit()));
        // scripts/ensure-atlas.ps1 が読む形(全桁の 16 進と、変えたまま作ったときの -dirty)
        let hex = COMMIT.strip_suffix("-dirty").unwrap_or(COMMIT);
        assert!(COMMIT.is_empty() || (hex.len() >= 40 && hex.bytes().all(|b| b.is_ascii_hexdigit())), "{COMMIT}");
    }
}
