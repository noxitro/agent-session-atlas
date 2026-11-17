// data.db(デスクトップアプリ)の読み取り結果の型。node: に依存しない(ブラウザ側の型検査からも参照される)
export type DesktopRow = Record<string, string | number | null>;

export interface DesktopTableCoverage {
  /** 値を読んだ列 */
  allowed: string[];
  /** 名前だけ数えた列(値は読まない) */
  unlisted: string[];
  rows: number;
}

export interface DesktopData {
  version: 1;
  readAt: string;
  path: string;
  /** -wal の状態。immutable では未反映分を読めない */
  wal: { bytes: number; mtime: string | null; mainMtime: string | null; note: string } | null;
  tables: Record<string, DesktopRow[]>;
  /** 表ごとの許可 / 許可外の列(値は読まない)。開かない表は forbidden に理由 */
  coverage: { tables: Record<string, DesktopTableCoverage>; forbidden: Record<string, string>; otherTables: string[] };
  warnings: string[];
}

/** セッション id ごとに、desktop.json の sessions の行と関連表をまとめる(extract が使う) */
export interface DesktopSessionInfo {
  session: DesktopRow | null;
  contextUsage: DesktopRow[];
  checkpoints: DesktopRow[];
  activity: DesktopRow[];
  workspace: DesktopRow | null;
  project: DesktopRow | null;
}

