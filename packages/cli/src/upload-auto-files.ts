// 自動で送ったときに残すファイルの名前と、結果の形(upload-auto.ts が書き、upload-schedule.ts が読んで見せる)。
// upload-auto.ts は依存が欠けていても記録を残すため、ここには import を置かない(互いに読み合うと、起動したときに止まるため、両方からここを読む)
/** タスクが動かすもの(packages/cli/src/ の中) */
export const AUTO_ENTRY_NAME = 'upload-auto.ts';

/** 自動で送ったときの結果と記録(出力先 out/ の中。schedule-upload.bat が読んで見せる) */
export const AUTO_STATUS_FILE = 'auto-upload.json';
export const AUTO_LOG_FILE = 'auto-upload.log';
export const AUTO_AGGREGATE_LOG_FILE = 'auto-upload-aggregate.log';

/** 自動で送った結果(out/auto-upload.json) */
export interface AutoStatusFile {
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  /** 失敗したときの理由(送れたときは null) */
  error: string | null;
  /** 送ったプロジェクトと、送ったセッションの数(途中で失敗しても、送れた分は残す) */
  sent: { name: string; sessions: number; unchanged?: number }[];
  /** 送ったものにあった秘密らしい文字列の数 */
  secrets: number;
  root: string | null;
  /** 送る前に atlas 自身を新しい版にしたか(self-update.ts)。この版より前の記録には無い。更新しない設定なら null */
  update?: AutoUpdateResult | null;
}

/** 送る前に atlas 自身を新しい版にした結果(self-update.ts が作る) */
export interface AutoUpdateResult {
  /** updated: 新しい版にした / latest: もう最新だった / skipped: 条件に合わないので何もしなかった / failed: 途中で失敗した(前の版のまま) */
  outcome: 'updated' | 'latest' | 'skipped' | 'failed';
  /** 前と後の版(コミットの先頭 7 桁)。分からなければ null */
  from: string | null;
  to: string | null;
  /** 何をしたか・しなかった理由(1 文) */
  note: string;
}

/** タスクの引数に付けると、送る前に atlas を新しい版にしない(schedule-upload.bat の u で切り替える) */
export const NO_UPDATE_FLAG = '--no-update';
/** 新しい版にした後、新しいコードで動かし直すときに付ける印(環境変数)。中身は更新の結果(JSON) */
export const UPDATED_ENV = 'ATLAS_AUTO_UPDATED';
