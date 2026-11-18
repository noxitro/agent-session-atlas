// セッションの中で AI が作った変更(ファイルと、変更のまとまりごとの追加行)を、ログのイベントから取り出す。
// VCS の差分と照合するための材料(vcs-retention.ts が使う)。LLM は使わない。
//
// 取り出し方:
// - 編集の完了イベント(tool.execution_complete)の result.detailedContent にある unified diff を一次の材料にする
//   (edit / create / apply_patch / str_replace_editor。2026-11 の手元のログで、diff --git 形式を確認)
// - diff が無い古い形式では、開始イベントの引数(old_str / new_str / file_text / apply_patch のパッチ本文)から作る
// - 失敗した編集(success:false)と、~/.copilot/session-state 配下(plan.md など)は数えない
// - 同じファイルで、AI が前に足した行を後の編集で消した(書き直した)ときは、前の行を数えない。AI が最後に残した形だけを数える(二重計上を防ぐ)
// - 空白だけの行は数えない
import type { CopilotEvent } from './types.ts';
import { filePathKey, isSessionStatePath, resolveFilePath } from './classify.ts';

/** 値の出所。events = events.jsonl(一次)、workspace = workspace.yaml(補完) */
export type ValueSource = 'events' | 'workspace';

/** AI の変更 1 まとまり(diff の連続した +/- の塊)のうち、セッションの終わりまで AI が残した追加行 */
export interface AiHunk {
  /** セッション内の通し番号 */
  id: number;
  /** 絶対パス(Windows は \ 区切り) */
  path: string;
  /** その編集の時刻(ISO) */
  at: string | null;
  toolCallId: string | null;
  /** 追加行(行末の空白と改行を除いた本文)。空白だけの行は含めない */
  lines: string[];
  /** 材料の種類。diff = 完了イベントの unified diff、args = 開始イベントの引数から作った */
  from: 'diff' | 'args';
}

export interface AiFileChange {
  path: string;
  /** AI がこのセッションで作ったファイルか */
  created: boolean;
  /** AI がこのセッションの最後に消したファイルか */
  deleted: boolean;
  /** 数えた編集の回数(失敗を除く) */
  edits: number;
}

/** VCS の照合に使うセッションの文脈。値ごとに出所を持つ */
export interface SessionVcsContext {
  /** 最初のイベントの時刻 */
  start: string | null;
  /** 最後のイベントの時刻 */
  end: string | null;
  cwd: string | null;
  gitRoot: string | null;
  branch: string | null;
  /** 開始時(最初に記録された)のコミット。git のときだけ記録される */
  headCommit: string | null;
  baseCommit: string | null;
  sources: Partial<Record<'cwd' | 'gitRoot' | 'branch' | 'headCommit', ValueSource>>;
}

export interface AiChangeSet {
  sessionId: string;
  context: SessionVcsContext;
  files: AiFileChange[];
  /** AI が残した追加行を 1 行以上持つまとまり */
  hunks: AiHunk[];
  /** 数えなかった編集(失敗・session-state 配下・材料なし) */
  skipped: { failed: number; sessionState: number; noMaterial: number };
}

/** workspace.yaml から補う値(イベントに無いときだけ使う) */
export interface WorkspaceHints {
  cwd?: string | null;
  git_root?: string | null;
  branch?: string | null;
}

const EDIT_TOOLS = new Set(['edit', 'create', 'str_replace_editor', 'apply_patch']);

/** 比べるときの行の本文(行末の空白と CR を落とす) */
export function lineText(s: string): string {
  return s.replace(/[\s\r]+$/, '');
}

const isBlank = (s: string): boolean => s.trim() === '';

// ---- unified diff の読み取り ----

export interface DiffFile {
  /** diff の見出しのパス(a/ b/ を外したもの)。消したファイルは oldPath だけ */
  oldPath: string | null;
  newPath: string | null;
  /** 連続した +/- の塊ごとの追加行と削除行 */
  blocks: { added: string[]; removed: string[] }[];
}

function diffPath(raw: string): string | null {
  let p = raw.trim();
  // タブ以降(時刻の注記)を落とす
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  if (p === '/dev/null' || p === 'a/dev/null' || p === 'b/dev/null' || p === 'dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** git 形式の unified diff(複数ファイル可)を読む。--- / +++ の無い節は飛ばす */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const out: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let block: { added: string[]; removed: string[] } | null = null;
  let inHunk = false;
  const flush = (): void => {
    if (cur && block && (block.added.length > 0 || block.removed.length > 0)) cur.blocks.push(block);
    block = null;
  };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      flush();
      cur = null;
      inHunk = false;
      continue;
    }
    // 見出しは塊の外で読む(塊の中の "--- x" は、"-- x" という行を消した印のことがある)。
    // diff --git の無い複数ファイルの diff では、塊の中でも、--- / +++ のすぐ後に @@ が続くものは次のファイルの見出しとして読む
    if (!inHunk || lines[i + 2]?.startsWith('@@')) {
      if (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
        flush();
        cur = { oldPath: diffPath(l.slice(4)), newPath: diffPath(lines[i + 1].slice(4)), blocks: [] };
        out.push(cur);
        i++;
        inHunk = false;
        continue;
      }
    }
    if (l.startsWith('@@')) {
      flush();
      inHunk = cur != null;
      continue;
    }
    if (!inHunk || !cur) continue;
    if (l.startsWith('+')) {
      block ??= { added: [], removed: [] };
      block.added.push(lineText(l.slice(1)));
    } else if (l.startsWith('-')) {
      block ??= { added: [], removed: [] };
      block.removed.push(lineText(l.slice(1)));
    } else if (l.startsWith('\\')) {
      // \ No newline at end of file
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** apply_patch の本文(*** Begin Patch 形式)を読む */
export function parseApplyPatch(text: string): { path: string; op: 'add' | 'update' | 'delete'; blocks: { added: string[]; removed: string[] }[] }[] {
  const out: { path: string; op: 'add' | 'update' | 'delete'; blocks: { added: string[]; removed: string[] }[] }[] = [];
  let cur: (typeof out)[number] | null = null;
  let block: { added: string[]; removed: string[] } | null = null;
  const flush = (): void => {
    if (cur && block && (block.added.length > 0 || block.removed.length > 0)) cur.blocks.push(block);
    block = null;
  };
  for (const l of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(l);
    if (m) {
      flush();
      cur = { path: m[2].trim(), op: m[1] === 'Add' ? 'add' : m[1] === 'Update' ? 'update' : 'delete', blocks: [] };
      out.push(cur);
      continue;
    }
    if (l.startsWith('*** ')) {
      flush();
      if (l.startsWith('*** Move to: ') && cur) cur.path = l.slice('*** Move to: '.length).trim();
      continue;
    }
    if (!cur) continue;
    if (l.startsWith('+')) {
      block ??= { added: [], removed: [] };
      block.added.push(lineText(l.slice(1)));
    } else if (l.startsWith('-')) {
      block ??= { added: [], removed: [] };
      block.removed.push(lineText(l.slice(1)));
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** 多重集合の差(a から b にある分を 1 つずつ除く)。順序は a のまま */
function minus(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

const splitLines = (s: unknown): string[] => (typeof s === 'string' ? s.replace(/\r\n/g, '\n').split('\n').map(lineText) : []);

/** 引数から変更を作る(diff が無いとき)。パスは未解決のまま返す */
function changesFromArgs(tool: string, args: any): { path: string; op: 'add' | 'update' | 'delete'; blocks: { added: string[]; removed: string[] }[] }[] {
  if (tool === 'apply_patch') {
    const text = typeof args === 'string' ? args : typeof args?.input === 'string' ? args.input : typeof args?.patch === 'string' ? args.patch : null;
    return text ? parseApplyPatch(text) : [];
  }
  if (!args || typeof args !== 'object' || typeof args.path !== 'string') return [];
  const cmd = typeof args.command === 'string' ? args.command : null;
  if (tool === 'create' || cmd === 'create') return [{ path: args.path, op: 'add', blocks: [{ added: splitLines(args.file_text), removed: [] }] }];
  if (tool === 'edit' || cmd === 'str_replace') {
    const oldL = splitLines(args.old_str);
    const newL = splitLines(args.new_str);
    return [{ path: args.path, op: 'update', blocks: [{ added: minus(newL, oldL), removed: minus(oldL, newL) }] }];
  }
  if (cmd === 'insert') return [{ path: args.path, op: 'update', blocks: [{ added: splitLines(args.new_str ?? args.insert_text), removed: [] }] }];
  return [];
}

// ---- 1 セッション分 ----

interface Entry {
  text: string;
  alive: boolean;
}

interface FileState {
  path: string;
  created: boolean;
  deleted: boolean;
  edits: number;
  /** 生きている追加行(新しい順に探すため、追加した順に並べる) */
  entries: Entry[];
}

/**
 * セッションのイベントから、AI が残した変更を取り出す。
 * workspace は events に cwd / gitRoot / branch が無いときの補完にだけ使う
 */
export function extractAiChanges(sessionId: string, events: readonly CopilotEvent[], workspace: WorkspaceHints | null = null): AiChangeSet {
  const ctx: SessionVcsContext = { start: null, end: null, cwd: null, gitRoot: null, branch: null, headCommit: null, baseCommit: null, sources: {} };
  let cwd: string | null = null;
  const starts = new Map<string, { tool: string; args: unknown; at: string | null }>();
  const files = new Map<string, FileState>();
  const hunkLines: { hunk: Omit<AiHunk, 'lines'>; entries: Entry[] }[] = [];
  const skipped = { failed: 0, sessionState: 0, noMaterial: 0 };
  let nextId = 1;

  const setCtx = (c: any): void => {
    if (!c || typeof c !== 'object') return;
    if (typeof c.cwd === 'string' && c.cwd) {
      cwd = c.cwd;
      if (ctx.cwd == null) ((ctx.cwd = c.cwd), (ctx.sources.cwd = 'events'));
    }
    if (ctx.gitRoot == null && typeof c.gitRoot === 'string' && c.gitRoot) ((ctx.gitRoot = c.gitRoot), (ctx.sources.gitRoot = 'events'));
    if (ctx.branch == null && typeof c.branch === 'string' && c.branch) ((ctx.branch = c.branch), (ctx.sources.branch = 'events'));
    // 開始時の基準は最初に記録されたものを使う(再開後のコミットには、前半の AI の変更が入っていることがあるため)
    if (ctx.headCommit == null && typeof c.headCommit === 'string' && c.headCommit) ((ctx.headCommit = c.headCommit), (ctx.sources.headCommit = 'events'));
    if (ctx.baseCommit == null && typeof c.baseCommit === 'string' && c.baseCommit) ctx.baseCommit = c.baseCommit;
  };

  const fileOf = (path: string): FileState => {
    const key = filePathKey(path);
    let f = files.get(key);
    if (!f) files.set(key, (f = { path, created: false, deleted: false, edits: 0, entries: [] }));
    return f;
  };

  const apply = (rawPath: string, op: 'add' | 'update' | 'delete', blocks: { added: string[]; removed: string[] }[], at: string | null, toolCallId: string | null, from: AiHunk['from']): void => {
    const path = resolveFilePath(rawPath, cwd);
    if (isSessionStatePath(path)) {
      skipped.sessionState++;
      return;
    }
    const f = fileOf(path);
    f.edits++;
    if (op === 'delete') {
      for (const e of f.entries) e.alive = false;
      f.deleted = true;
      return;
    }
    if (op === 'add' && f.edits === 1) f.created = true;
    // ファイルを作り直した(create で上書きした)なら、前の中身は残っていない。前に足した行は数えない
    if (op === 'add') for (const e of f.entries) e.alive = false;
    f.deleted = false;
    for (const b of blocks) {
      // AI が前に足した行を消したなら、その行は数えない(同じ本文のうち、いちばん新しい生きている行)
      for (const r of b.removed) {
        for (let i = f.entries.length - 1; i >= 0; i--) {
          const e = f.entries[i];
          if (e.alive && e.text === r) {
            e.alive = false;
            break;
          }
        }
      }
      const entries = b.added.filter((x) => !isBlank(x)).map((text) => ({ text, alive: true }));
      if (entries.length === 0) continue;
      f.entries.push(...entries);
      hunkLines.push({ hunk: { id: nextId++, path, at, toolCallId, from }, entries });
    }
  };

  for (const e of events) {
    const at = typeof e.timestamp === 'string' ? e.timestamp : null;
    if (at) {
      ctx.start ??= at;
      ctx.end = at;
    }
    const d = e.data ?? {};
    switch (e.type) {
      case 'session.start':
      case 'session.resume':
        setCtx(d.context);
        break;
      case 'session.context_changed':
        setCtx(d);
        break;
      case 'tool.execution_start':
        if (typeof d.toolCallId === 'string' && EDIT_TOOLS.has(d.toolName)) starts.set(d.toolCallId, { tool: d.toolName, args: d.arguments, at });
        break;
      case 'tool.execution_complete': {
        const s = typeof d.toolCallId === 'string' ? starts.get(d.toolCallId) : undefined;
        if (!s) break;
        starts.delete(d.toolCallId);
        if (d.success === false) {
          skipped.failed++;
          break;
        }
        const dc = d.result?.detailedContent;
        const diff = typeof dc === 'string' && dc.includes('@@') ? parseUnifiedDiff(dc) : [];
        if (diff.length > 0) {
          // パスは引数を優先する(diff の見出しは絶対パスの先頭の / が落ちることがあるため)。1 ファイルの編集だけ
          const argPath = s.tool !== 'apply_patch' && typeof (s.args as any)?.path === 'string' ? (s.args as any).path : null;
          for (const df of diff) {
            const raw = (diff.length === 1 && argPath) || df.newPath || df.oldPath;
            if (!raw) continue;
            const path = argPath && diff.length === 1 ? raw : headerPath(raw, cwd);
            const op = df.newPath == null ? 'delete' : df.oldPath == null ? 'add' : 'update';
            apply(path, op, df.blocks, at, d.toolCallId, 'diff');
          }
          break;
        }
        const fromArgs = changesFromArgs(s.tool, s.args);
        if (fromArgs.length === 0) {
          skipped.noMaterial++;
          break;
        }
        for (const c of fromArgs) apply(c.path, c.op, c.blocks, at, d.toolCallId, 'args');
        break;
      }
    }
  }

  if (workspace) {
    if (ctx.cwd == null && workspace.cwd) ((ctx.cwd = workspace.cwd), (ctx.sources.cwd = 'workspace'));
    if (ctx.gitRoot == null && workspace.git_root) ((ctx.gitRoot = workspace.git_root), (ctx.sources.gitRoot = 'workspace'));
    if (ctx.branch == null && workspace.branch) ((ctx.branch = workspace.branch), (ctx.sources.branch = 'workspace'));
  }

  const hunks: AiHunk[] = [];
  for (const h of hunkLines) {
    const lines = h.entries.filter((x) => x.alive).map((x) => x.text);
    if (lines.length > 0) hunks.push({ ...h.hunk, lines });
  }
  return {
    sessionId,
    context: ctx,
    files: [...files.values()].filter((f) => f.edits > 0).map(({ path, created, deleted, edits }) => ({ path, created, deleted, edits })),
    hunks,
    skipped,
  };
}

/** diff の見出しのパス(E:/x/y や home/u/x)を絶対パスに戻す */
function headerPath(p: string, cwd: string | null): string {
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')) return p;
  // git の a/ b/ を外すと posix の絶対パスは先頭の / が落ちる。cwd が posix で、cwd の先頭と同じなら / を戻す
  if (cwd && cwd.startsWith('/') && `/${p}`.startsWith(cwd.split('/').slice(0, 2).join('/') + '/')) return `/${p}`;
  return p;
}
