//! 判定バックエンド(packages/judge/src/backends/ の移植)。types.ts の共通の形はここに置く。

// 従量課金の Anthropic API を直接呼ぶバックエンド。機能 anthropic-backend を付けてビルドしたときだけ入る(Cargo.toml)
#[cfg(feature = "anthropic-backend")]
pub mod anthropic;
pub mod copilot_cli;
pub mod output;
pub mod proc;

use crate::schema::JudgmentItem;
use anyhow::{bail, Result};
use serde_json::Value;

/// このビルドに anthropic バックエンドが入っているか
pub const ANTHROPIC_BACKEND_BUILT: bool = cfg!(feature = "anthropic-backend");

/// anthropic を選んだのに、このビルドに入っていないときの文言(入れ方まで書く)
pub const ANTHROPIC_NOT_BUILT: &str = "anthropic バックエンド(Anthropic API を直接呼ぶ。従量課金)は、この atlas には入っていません(既定のビルドと、起動用の .bat がこの PC でする atlas.exe のビルドには入れていません)。使うときは、このリポジトリで npm run build:report の後に cargo build --release -p atlas-cli --features anthropic-backend を実行し、できた target/release/atlas(.exe)を使ってください(docs/judge.md)。GitHub Copilot CLI で判定するなら --backend を付けません(既定の copilot-cli)";

/// 選んだバックエンドがこのビルドで使えるか確かめる(使えなければ、入れ方を書いたエラー)。
/// 引数の解釈では anthropic の名前を受け付け、実行するときにここで止める(不明な名前とは別の、分かる文言にするため)
pub fn ensure_backend_built(name: &str) -> Result<()> {
    if name == "anthropic" && !ANTHROPIC_BACKEND_BUILT {
        bail!("{ANTHROPIC_NOT_BUILT}");
    }
    Ok(())
}

pub struct JudgePacket<'a> {
    pub session_id: &'a str,
    /// 評価パケット(Markdown)
    pub markdown: &'a str,
}

pub struct JudgeResult {
    /// 検証済みの項目(judge メタは run 側で付ける)
    pub item: JudgmentItem,
    /// バックエンドが返した判定自体の使用量(形は問わない)。取れなければ None
    pub usage: Option<Value>,
    /// 補足(usage が取れなかった理由など)
    pub notes: Vec<String>,
    /// llm-wiki のページごとの判定(wikiPages)の形が崩れていて、一部を捨てたときの知らせ(run は件数の 1 行にまとめて出す)
    pub wiki_notes: Vec<String>,
}

/// プロンプトを 1 回渡して返った本文(依頼ごとの判定など、セッションの判定以外に使う)
pub struct AskResult {
    /// assistant の本文(出現順)
    pub texts: Vec<String>,
    pub usage: Option<Value>,
    pub notes: Vec<String>,
}

pub trait JudgeBackend: Sync {
    fn name(&self) -> &str;
    fn model(&self) -> Option<&str>;
    fn judge(&self, packet: &JudgePacket<'_>) -> Result<JudgeResult>;
    /// ask を持つか(copilot-cli だけ)
    fn can_ask(&self) -> bool {
        false
    }
    /// プロンプトをそのまま渡す(label は生の出力を残すときのファイル名)
    fn ask(&self, _prompt: &str, _label: &str) -> Result<AskResult> {
        bail!("{} では ask を使えません", self.name())
    }
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
