//! 自動で送ったときに残すファイルの名前と、結果の形(packages/cli/src/upload-auto-files.ts の移植)。
//! upload_auto.rs が書き、upload_schedule.rs が読んで見せる。

use serde::{Deserialize, Serialize};

/// 自動で送ったときの結果と記録(出力先 out/ の中。schedule-upload.bat が読んで見せる)
pub const AUTO_STATUS_FILE: &str = "auto-upload.json";
pub const AUTO_LOG_FILE: &str = "auto-upload.log";
pub const AUTO_AGGREGATE_LOG_FILE: &str = "auto-upload-aggregate.log";

/// 送ったプロジェクトと、送ったセッションの数
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SentProject {
    pub name: String,
    pub sessions: f64,
    /// 前に送ったときから変わっていないので送らなかった数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unchanged: Option<f64>,
}

/// 自動で送った結果(out/auto-upload.json)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStatusFile {
    pub started_at: String,
    pub finished_at: Option<String>,
    pub ok: bool,
    /// 失敗したときの理由(送れたときは null)
    pub error: Option<String>,
    /// 送ったプロジェクトと、送ったセッションの数(途中で失敗しても、送れた分は残す)
    pub sent: Vec<SentProject>,
    /// 送ったものにあった秘密らしい文字列の数
    pub secrets: f64,
    pub root: Option<String>,
    /// 送る前に atlas 自身を新しい版にしたか。この版より前の記録には無い(外の None)。更新しない設定なら null
    #[serde(default, skip_serializing_if = "Option::is_none", with = "atlas_core::js::double_option")]
    pub update: Option<Option<AutoUpdateResult>>,
}

/// 送る前に atlas 自身を新しい版にした結果(self_update.rs が作る)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpdateResult {
    /// updated: 新しい版にした / latest: もう最新だった / skipped: 条件に合わないので何もしなかった / failed: 途中で失敗した(前の版のまま)
    pub outcome: String,
    /// 前と後の版(コミットの先頭 7 桁)。分からなければ null
    pub from: Option<String>,
    pub to: Option<String>,
    /// 前と後の版(コミットの全桁)。この版より前の記録には無い
    #[serde(default, skip_serializing_if = "Option::is_none", with = "atlas_core::js::double_option")]
    pub from_sha: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "atlas_core::js::double_option")]
    pub to_sha: Option<Option<String>>,
    /// 何をしたか・しなかった理由と、どうすれば新しい版になるか(1 文)
    pub note: String,
}

impl AutoUpdateResult {
    pub fn from_sha(&self) -> Option<&str> {
        self.from_sha.as_ref().and_then(|s| s.as_deref())
    }
    pub fn to_sha(&self) -> Option<&str> {
        self.to_sha.as_ref().and_then(|s| s.as_deref())
    }
}

/// タスクの引数に付けると、送る前に atlas を新しい版にしない(schedule-upload.bat の u で切り替える)
pub const NO_UPDATE_FLAG: &str = "--no-update";
/// 新しい版にした後、新しいコードで動かし直すときに付ける印(環境変数)。中身は更新の結果(JSON)
pub const UPDATED_ENV: &str = "ATLAS_AUTO_UPDATED";
/// 動かし直した側に渡す、呼び出し元のプロセスの番号(環境変数)。呼び出し元が止められたら、動かし直した側も止まる
pub const PARENT_ENV: &str = "ATLAS_AUTO_PARENT_PID";
/// TS 版で登録したタスクから、互換の入口(packages/cli/src/upload-auto.ts)を通して動かしたときに付く
pub const TS_TASK_ENV: &str = "ATLAS_TS_TASK";
/// 新しい版がこの PC で動かなかったときに、その版を覚えておくファイル(出力先 out/ の中。もっと新しい版が出るまで使わない)
pub const AUTO_UPDATE_STATE_FILE: &str = "auto-update.json";
/// atlas の処理が出力先で動いているかを見る印のファイルの名前(jobs.rs の JOB_LOCK_FILE と serve の SERVE_STATE_FILE と同じ)
pub const JOB_LOCK_NAME: &str = ".job.json";
pub const SERVE_STATE_NAME: &str = ".serve.json";
