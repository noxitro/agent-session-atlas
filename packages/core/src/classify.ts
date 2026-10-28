// 実データの記録形式の揺れを吸収する小さな規則(Phase 5)。normalize と judge の packet で共用する。
import { posix, win32 } from 'node:path';

// ---------- モデル名 ----------

const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;
/** claude-<family>-<major>-<minor>(minor は 1 桁、末尾に日付などが続かない) */
const CLAUDE_DASHED_RE = /^(claude-[a-z]+)-(\d+)-(\d)$/;

/**
 * モデル名の表記揺れを 1 つにする。
 * - 先頭の「<UUID>/」(プロバイダ設定の ID)を外す。実データでは同じリクエストの usage_record が
 *   model: "claude-haiku-5-5" / modelDisplayName: "<UUID>/claude-haiku-5-5" と両方を持っており、同じモデルを指す。
 * - claude-haiku-5-5 → claude-haiku-5.5(assistant.message 側は claude-haiku-5.5 と書く)。
 *   claude-sonnet-4-5-20250929 のように日付が続くものは変えない。
 */
export function normalizeModel(name: string): string {
  const m = name.trim().replace(UUID_PREFIX_RE, '');
  const c = CLAUDE_DASHED_RE.exec(m);
  return c ? `${c[1]}-${c[2]}.${c[3]}` : m;
}

// ---------- ツール ----------

/**
 * エージェントの内部処理に使われ、作業としてのツール呼び出しに数えないツール。
 * report_intent は「今何をしているか」を UI に出すためのもので、実データで 2,683 件あった。
 */
export const INTERNAL_TOOLS: ReadonlySet<string> = new Set(['report_intent']);

export function isInternalTool(name: string): boolean {
  return INTERNAL_TOOLS.has(name);
}

// ---------- メッセージ ----------

/**
 * ユーザーの依頼(ターン)として数える user.message か。
 * source 付き(skill 本文・サブエージェントへの指示など)と、autopilot の自動継続
 * (isAutopilotContinuation: true。source が無いものもある)は数えない。
 */
export function isUserTurn(d: { source?: unknown; isAutopilotContinuation?: unknown } | null | undefined): boolean {
  return d?.source == null && d?.isAutopilotContinuation !== true;
}

export function isAutopilotContinuation(d: { isAutopilotContinuation?: unknown } | null | undefined): boolean {
  return d?.isAutopilotContinuation === true;
}

/**
 * 本体(親セッション)の応答として数える assistant.message か。
 * サブエージェントの応答は data.parentToolCallId を持つのが普通だが、
 * parentToolCallId が無くトップレベルの agentId だけを持つ形もある(実データ 2026-06 の 1 セッションで 34 件)。
 */
export function isMainAssistantMessage(e: { agentId?: unknown; data?: { parentToolCallId?: unknown } | null }): boolean {
  return !e.data?.parentToolCallId && !e.agentId;
}

// ---------- ファイルパス ----------

const WIN_ABS_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const POSIX_ABS_RE = /^\//;
/** ~/.copilot/session-state/ 配下(plan.md など、Copilot 自身のセッション用ファイル) */
const SESSION_STATE_RE = /[\\/]\.copilot[\\/]session-state(?:[\\/]|$)/i;

function looksWindows(p: string | null | undefined): boolean {
  return !!p && (WIN_ABS_RE.test(p) || (/\\/.test(p) && !p.includes('/')));
}

/**
 * パスを cwd 基準の絶対パスにそろえる。Windows のパスは \ 区切り・ドライブ文字は大文字に。
 * cwd が無い相対パスはそのまま(区切りだけ整える)。
 */
export function resolveFilePath(p: string, cwd: string | null | undefined): string {
  const raw = p.trim();
  const win = (s: string): string => {
    const out = /^[a-z]:/.test(s) ? s[0].toUpperCase() + s.slice(1) : s;
    // 末尾の区切りは落とす(ドライブ直下 C:\ と UNC の根は残す)
    return /^[A-Za-z]:\\$/.test(out) ? out : out.replace(/(?<=[^\\])\\+$/, '');
  };
  if (WIN_ABS_RE.test(raw)) return win(win32.normalize(raw));
  if (POSIX_ABS_RE.test(raw)) return posix.normalize(raw);
  // resolve は cwd が相対だと実行中のプロセスの作業ディレクトリを混ぜるので、その場合は join にする
  if (cwd) {
    if (looksWindows(cwd)) return win(WIN_ABS_RE.test(cwd) ? win32.resolve(cwd, raw) : win32.join(cwd, raw));
    return POSIX_ABS_RE.test(cwd) ? posix.resolve(cwd, raw) : posix.join(cwd, raw);
  }
  return looksWindows(raw) ? win(win32.normalize(raw)) : posix.normalize(raw);
}

/** 重複除去のキー。Windows のパスは大文字小文字を区別しない */
export function filePathKey(resolved: string): string {
  return looksWindows(resolved) ? resolved.toLowerCase() : resolved;
}

export function isSessionStatePath(p: string): boolean {
  return SESSION_STATE_RE.test(p);
}

export type FileOp = 'create' | 'edit' | 'delete';

/**
 * セッション中のファイル操作をパス単位にまとめる。
 * 最終状態: 最後の操作が delete → deleted / 最初の操作が create → created / それ以外 → changed。
 * ~/.copilot/session-state/ 配下は一覧から外し、件数(異なるパスの数)だけ数える。
 */
export class FileTracker {
  private readonly files = new Map<string, { path: string; first: FileOp; last: FileOp }>();
  private readonly sessionState = new Set<string>();

  add(op: FileOp, path: string, cwd: string | null | undefined): void {
    if (typeof path !== 'string' || path.trim() === '') return;
    const resolved = resolveFilePath(path, cwd);
    const key = filePathKey(resolved);
    if (isSessionStatePath(resolved)) {
      this.sessionState.add(key);
      return;
    }
    const f = this.files.get(key);
    if (f) f.last = op;
    else this.files.set(key, { path: resolved, first: op, last: op });
  }

  /**
   * 要約の記録(session.shutdown.codeChanges.filesModified)から足す。
   * 要約は操作の順序を持たないので、セッション中の操作で既に載っているパスは上書きしない
   * (途中で削除したファイルが filesModified に残っていても「削除」のまま。「変更」に戻さない)。
   */
  addSummary(path: string, cwd: string | null | undefined): void {
    if (typeof path !== 'string' || path.trim() === '') return;
    const key = filePathKey(resolveFilePath(path, cwd));
    if (this.files.has(key) || this.sessionState.has(key)) return;
    this.add('edit', path, cwd);
  }

  get size(): number {
    return this.files.size + this.sessionState.size;
  }

  result(): { changed: string[]; created: string[]; deleted: string[]; sessionState: number } {
    const changed: string[] = [];
    const created: string[] = [];
    const deleted: string[] = [];
    for (const f of this.files.values()) {
      if (f.last === 'delete') deleted.push(f.path);
      else if (f.first === 'create') created.push(f.path);
      else changed.push(f.path);
    }
    return { changed, created, deleted, sessionState: this.sessionState.size };
  }
}
