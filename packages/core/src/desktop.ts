// デスクトップアプリの data.db(~/.copilot/data.db)を、資格情報に触れない形で読む(Phase 11)。
// - 複製しない。`file:///…?immutable=1` の読み取り専用で開く(-shm / -wal に触れない。代わりに -wal の未反映分は読めない)
// - 読むのは名前で固定した許可リストの列だけ。`select *` はしない。accounts / settings / app_state / model_providers / remote_environments は開かない
// - 許可リストに列が無くても落ちない(その列は null)。許可外の列は名前と件数だけ数える(値は読まない)
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadSqlite } from './sqlite.ts';
import type { DesktopData, DesktopRow, DesktopSessionInfo, DesktopTableCoverage } from './desktop-types.ts';

export type { DesktopData, DesktopRow, DesktopSessionInfo, DesktopTableCoverage } from './desktop-types.ts';

/** 開かない表(資格情報・設定)。許可リストに無い表はそもそも読まないが、ここは「理由付きで除外」として coverage に出す */
export const DESKTOP_FORBIDDEN_TABLES: Record<string, string> = {
  accounts: 'アクセストークンを含む',
  settings: 'github_access_token を含む',
  app_state: '任意の設定値(資格情報を含みうる)',
  model_providers: 'プロバイダの設定(キーを含みうる)',
  remote_environments: '接続先の URL と設定',
  plugin_marketplace_accounts: 'アカウントの対応',
};

/** 表 → 許可する列(値を読む)。ここに無い列は名前だけ数える */
export const DESKTOP_ALLOWLIST: Record<string, readonly string[]> = {
  sessions: [
    'id', 'title', 'session_type', 'mode', 'model', 'reasoning_effort', 'is_running', 'was_interrupted', 'interruption_reason',
    'created_at', 'updated_at', 'remote_control_enabled', 'auto_approve', 'enabled_experiments_json', 'forked_from_session_id',
    'fork_original_history_event_count', 'total_input_tokens', 'total_output_tokens', 'total_cached_tokens', 'total_reasoning_tokens',
    'total_nano_aiu', 'total_agent_merge_nano_aiu', 'context_current_tokens', 'context_input_token_limit', 'context_output_token_limit',
    'context_tier', 'context_system_tokens', 'context_conversation_tokens', 'context_tool_definitions_tokens', 'context_mcp_tools_tokens',
    'context_buffer_tokens', 'agent', 'provider_id', 'execution_location', 'title_source', 'archived_at', 'permission_mode',
    'sandbox_enabled', 'provisional', 'agent_scope',
  ],
  session_context_usage: ['id', 'session_id', 'ts_ms', 'current_tokens', 'token_limit'],
  session_checkpoints: ['session_id', 'event_id', 'commit_sha', 'created_at'],
  activity_items: ['id', 'workspace_id', 'session_id', 'activity_type', 'preview', 'is_read', 'created_at', 'updated_at'],
  projects: [
    'id', 'name', 'container_kind', 'main_repo_path', 'default_branch', 'github_owner', 'github_repo', 'created_at', 'last_opened_at',
    'auto_approve', 'sandbox_enabled', 'branch_prefix', 'show_in_sidebar', 'remote_default_branch',
  ],
  workspaces: [
    'id', 'project_id', 'worktree_id', 'workspace_type', 'branch', 'name', 'created_at', 'updated_at', 'session_id', 'archived_at',
    'created_pr_repo_full_name', 'created_pr_number', 'created_pr_html_url', 'created_pr_state', 'created_pr_merged_at',
    'source_pr_repo_full_name', 'source_pr_number', 'source_pr_state', 'source_pr_merged_at',
    'last_diff_files_changed', 'last_diff_insertions', 'last_diff_deletions', 'last_diff_updated_at',
    'total_input_tokens', 'total_output_tokens', 'total_cache_read_tokens', 'total_cache_write_tokens', 'total_reasoning_tokens',
  ],
};

const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** data.db を読む。無ければ null。読めなければ warnings に理由(落とさない) */
export async function readDesktopDb(path: string): Promise<DesktopData | null> {
  if (!existsSync(path)) return null;
  const readAt = new Date().toISOString();
  const out: DesktopData = { version: 1, readAt, path, wal: null, tables: {}, coverage: { tables: {}, forbidden: { ...DESKTOP_FORBIDDEN_TABLES }, otherTables: [] }, warnings: [] };
  const walPath = `${path}-wal`;
  const mainMtime = (await stat(path)).mtime.toISOString();
  if (existsSync(walPath)) {
    const w = await stat(walPath);
    out.wal = {
      bytes: w.size,
      mtime: w.mtime.toISOString(),
      mainMtime,
      note: w.size > 0 ? 'immutable で開くため -wal の未反映分は読めない。本体の更新より後に書かれた行(最近のセッションの更新)が欠ける可能性がある' : '-wal は空で、欠けは無い',
    };
  } else out.wal = { bytes: 0, mtime: null, mainMtime, note: '-wal は無く、欠けは無い' };

  const { DatabaseSync } = await loadSqlite();
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
  } catch (e) {
    out.warnings.push(`data.db を開けない (${(e as Error).message})`);
    return out;
  }
  try {
    let names: string[] = [];
    try {
      names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    } catch (e) {
      out.warnings.push(`data.db を読めない (${(e as Error).message})`);
    }
    for (const t of names) {
      if (t in DESKTOP_FORBIDDEN_TABLES) continue;
      const allow = DESKTOP_ALLOWLIST[t];
      if (!allow) {
        out.coverage.otherTables.push(t);
        continue;
      }
      const cols = (db.prepare(`PRAGMA table_info(${ident(t)})`).all() as { name: string }[]).map((c) => c.name);
      const present = allow.filter((c) => cols.includes(c));
      const unlisted = cols.filter((c) => !allow.includes(c));
      let rows: DesktopRow[] = [];
      try {
        const sql = `SELECT ${present.map(ident).join(', ')} FROM ${ident(t)}`;
        rows = (present.length ? (db.prepare(sql).all() as DesktopRow[]) : []).map((r) => {
          const o: DesktopRow = {};
          for (const c of allow) o[c] = c in r ? (r[c] as string | number | null) : null;
          return o;
        });
      } catch (e) {
        out.warnings.push(`${t} を読めない (${(e as Error).message})`);
      }
      out.tables[t] = rows;
      out.coverage.tables[t] = { allowed: present, unlisted, rows: rows.length };
    }
    for (const t of Object.keys(DESKTOP_FORBIDDEN_TABLES)) if (!names.includes(t)) delete out.coverage.forbidden[t];
  } finally {
    db.close();
  }
  return out;
}

export function desktopForSession(d: DesktopData, id: string): DesktopSessionInfo | null {
  const session = (d.tables.sessions ?? []).find((r) => r.id === id) ?? null;
  const contextUsage = (d.tables.session_context_usage ?? []).filter((r) => r.session_id === id);
  const checkpoints = (d.tables.session_checkpoints ?? []).filter((r) => r.session_id === id);
  const activity = (d.tables.activity_items ?? []).filter((r) => r.session_id === id);
  const workspace = (d.tables.workspaces ?? []).find((r) => r.session_id === id) ?? null;
  const project = workspace ? ((d.tables.projects ?? []).find((r) => r.id === workspace.project_id) ?? null) : null;
  if (!session && !contextUsage.length && !checkpoints.length && !activity.length && !workspace) return null;
  return { session, contextUsage, checkpoints, activity, workspace, project };
}
