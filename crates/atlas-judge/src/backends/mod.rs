//! skill-draft(SKILL.md の下書き)が LLM を呼ぶ経路(GitHub Copilot CLI の copilot -p と、任意の anthropic)。
//! 判定はこのツールの中では回さない(チャットに貼るか ZIP にまとめて、外部の LLM に頼む。docs/judge.md)。

// 従量課金の Anthropic API を直接呼ぶ経路(skill-draft の --backend anthropic)。機能 anthropic-backend を付けてビルドしたときだけ入る(Cargo.toml)
#[cfg(feature = "anthropic-backend")]
pub mod anthropic;
pub mod copilot_cli;
pub mod output;
pub mod proc;

use anyhow::{bail, Result};

/// このビルドに anthropic バックエンドが入っているか
pub const ANTHROPIC_BACKEND_BUILT: bool = cfg!(feature = "anthropic-backend");

/// anthropic を選んだのに、このビルドに入っていないときの文言(入れ方まで書く)
pub const ANTHROPIC_NOT_BUILT: &str = "anthropic バックエンド(skill-draft で Anthropic API を直接呼ぶ。従量課金)は、この atlas には入っていません(既定のビルドと、起動用の .bat がこの PC でする atlas.exe のビルドには入れていません)。使うときは、このリポジトリで npm run build:report の後に cargo build --release -p atlas-cli --features anthropic-backend を実行し、できた target/release/atlas(.exe)を使ってください(docs/development.md)。GitHub Copilot CLI で下書きするなら --backend を付けません(既定の copilot-cli)";

/// 選んだバックエンドがこのビルドで使えるか確かめる(使えなければ、入れ方を書いたエラー)。
/// 引数の解釈では anthropic の名前を受け付け、実行するときにここで止める(不明な名前とは別の、分かる文言にするため)
pub fn ensure_backend_built(name: &str) -> Result<()> {
    if name == "anthropic" && !ANTHROPIC_BACKEND_BUILT {
        bail!("{ANTHROPIC_NOT_BUILT}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_is_usable_only_when_built_with_the_feature() {
        assert!(ensure_backend_built("copilot-cli").is_ok());
        let r = ensure_backend_built("anthropic");
        if cfg!(feature = "anthropic-backend") {
            assert!(r.is_ok());
        } else {
            let e = r.unwrap_err().to_string();
            assert!(e.contains("この atlas には入っていません"), "{e}");
            assert!(e.contains("cargo build --release -p atlas-cli --features anthropic-backend"), "{e}");
        }
    }
}
