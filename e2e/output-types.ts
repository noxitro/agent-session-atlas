// テストが読む atlas の出力ファイルの形(テストが見るところだけ)。atlas の本体は Rust(crates/)で、
// sessions.json・metrics.json・画面のデータの形は packages/report/src/shared/types.ts と lib/types.ts にある。
// ここは、それ以外の出力(スナップショットの記録・coverage.json・atlas-session-store.json・vcs-retention.json)の形。
import type { DesktopSessionInfo } from '../packages/report/src/shared/desktop-types.ts';
import type { DbFileRow, DbSessionRow, DbTurnRow, DbUsageRow, InstalledInventory } from '../packages/report/src/shared/types.ts';
import type { FolderUpload } from '../packages/report/src/shared/atlas-version.ts';

/** out/snapshot/snapshot-manifest.json(crates/atlas-core/src/snapshot) */
export interface SnapshotManifest {
  createdAt: string;
  sourceRoot: string;
  layout?: 'copilot' | 'flat' | 'merged';
  merged?: { folders: string[]; duplicates: number; owners?: Record<string, string> };
  since: string | null;
  databases: Record<string, { copied: boolean; bytes: number; attempts: number; error?: string }>;
  sessions: { dirs: number; copiedFiles: number; reusedFiles: number; skippedBySince: number; bytes: number; dbCopied?: number; dbReused?: number };
  sessionDbErrors?: string[];
  installed?: InstalledInventory;
  installedByPerson?: Record<string, InstalledInventory>;
  uploads?: Record<string, FolderUpload>;
  /** 追加で写したもの(セッションフォルダの中身と ~/.copilot 直下)と、写さなかったもの */
  extras?: {
    all: boolean;
    sessionFiles: number;
    sessionBytes: number;
    topLevel: Record<string, { files: number; bytes: number }>;
    skipped: { path: string; bytes: number; reason: string }[];
    desktop: { written: boolean; sessions: number; warnings: string[] } | null;
    leftover: { path: string; mtime: string }[];
    recovered?: { id: string; path: string }[];
  };
}

export type Treatment = 'full' | 'ref' | 'excluded' | 'partial';

/** out/coverage.json(crates/atlas-report/src/coverage.rs) */
export interface CoverageFile {
  version: 1;
  generatedAt: string;
  sessions: number;
  events: number;
  types: Record<string, { n: number; bytes: number }>;
  keys: { type: string; key: string; n: number; bytes: number; treatment: Treatment | 'unclassified'; reason?: string; excludedN?: number; excludedBytes?: number }[];
  summary: Record<Treatment | 'unclassified', { keys: number; n: number; bytes: number }>;
  desktop: { columns: { table: string; column: string; treatment: Treatment | 'unclassified'; reason?: string }[]; unclassified: number } | null;
}

/** アップロードしたセッションのフォルダに添える atlas-session-store.json(crates/atlas-core/src/extract.rs) */
export interface SessionStoreJson {
  version: 1;
  schemaVersion: number | null;
  sessions: DbSessionRow[];
  turns: DbTurnRow[];
  usage: DbUsageRow[];
  files: DbFileRow[];
  desktop?: DesktopSessionInfo | null;
}

/** out/vcs-retention.json(crates/atlas-core/src/vcs_step.rs)。テストが見るところだけ */
export interface VcsRetentionFile {
  schemaVersion: number;
  generatedAt: string;
  computedOn: 'local' | 'sender';
  mode: string;
  summary: Record<string, unknown>;
  sessions: {
    sessionId: string;
    outcome: string;
    hunks: { status: string; lines: { kept: number; modified: number; missing: number; unattributable: number } }[];
    [key: string]: unknown;
  }[];
}
