//! 判定バックエンド(packages/judge/src/backends/ の移植)。types.ts の共通の形はここに置く。

pub mod anthropic;
pub mod copilot_cli;
pub mod output;
pub mod proc;

use crate::schema::JudgmentItem;
use anyhow::{bail, Result};
use serde_json::Value;

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
