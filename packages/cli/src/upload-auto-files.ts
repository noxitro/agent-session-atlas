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
  sent: { name: string; sessions: number }[];
  /** 送ったものにあった秘密らしい文字列の数 */
  secrets: number;
  root: string | null;
}
