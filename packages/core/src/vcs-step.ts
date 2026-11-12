// 照合の段(atlas vcs)。スナップショットの各セッションから AI の変更を取り出し(ai-changes.ts)、
// 作業後の VCS と照合して(vcs-retention.ts)、out/vcs-retention.json にする。
//
// - この PC の記録を集計したとき: ログのパスのリポジトリを、この PC で読む(読むだけ。vcs.ts の許可リスト)
// - アップロード先から集計し直したとき: 送り先にはリポジトリが無いか、同じパスに別のものがあるので、ディスクは読まない。
//   送った側の PC が照合してセッションのフォルダに添えた結果(UPLOAD_VCS_META)を読む。無ければ「送った側で照合していない」
// - リポジトリを別の場所へ移したときは、設定の対応づけ(pathMap)でログのパスを今の場所に読み替えてから照合する
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractAiChanges, type AiChangeSet, type WorkspaceHints } from './ai-changes.ts';
import { readEvents } from './events.ts';
import { listSessionDirs, readWorkspaceYaml } from './extract.ts';
import { readSnapshotManifest, UPLOAD_VCS_META } from './snapshot.ts';
import { VCS_KINDS, type EvalMode, type VcsKind } from './vcs.ts';
import {
  measureRetention,
  RETENTION_STATUSES,
  summarizeRetention,
  UNATTRIBUTABLE_REASONS,
  type HunkRetention,
  type LineCounts,
  type RetentionOptions,
  type RetentionStatus,
  type RetentionSummary,
  type SessionRetention,
  type UnattributableReason,
} from './vcs-retention.ts';

export const VCS_RETENTION_FILE = 'vcs-retention.json';
export const VCS_RETENTION_SCHEMA_VERSION = 1;
/** 似た本文とみなす 2 字組の重なりの既定(vcs-retention.ts と同じ値) */
export const DEFAULT_SIMILARITY = 0.75;

/** ログに残るパス(from)を、今の場所(to)に読み替える。リポジトリを別のフォルダへ移したとき用 */
export interface PathMapping {
  from: string;
  to: string;
}

export interface VcsRetentionFile {
  schemaVersion: typeof VCS_RETENTION_SCHEMA_VERSION;
  generatedAt: string;
  /** local = この PC で照合した。sender = アップロード先から集計し、送った側の PC の結果を読んだ */
  computedOn: 'local' | 'sender';
  mode: EvalMode;
  similarity: number;
  /** 使ったパスの対応づけの数(0 なら読み替えていない) */
  pathMap: number;
  summary: RetentionSummary;
  sessions: SessionRetention[];
}

/** 送った側がセッションのフォルダに添える結果(UPLOAD_VCS_META) */
export interface SenderVcsFile {
  version: 1;
  sessionId: string;
  computedAt: string;
  mode: EvalMode;
  result: SessionRetention;
}

export interface VcsStepOptions extends RetentionOptions {
  pathMap?: readonly PathMapping[];
  /** 照合するセッション(無ければスナップショットの全部) */
  ids?: ReadonlySet<string> | null;
}

// --- パスの読み替え ---

const isWinPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
/** 比べるための形(区切りを / に、Windows のパスは大文字小文字を無視、末尾の区切りを落とす) */
const normForMatch = (p: string): string => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWinPath(p) ? s.toLowerCase() : s;
};

/** 1 つのパスを読み替える。どの from にも当たらなければ null。長い from を優先する */
export function mapPath(path: string, map: readonly PathMapping[]): string | null {
  const key = normForMatch(path);
  let best: PathMapping | null = null;
  let bestLen = -1;
  for (const m of map) {
    const from = normForMatch(m.from);
    if (!from) continue;
    if ((key === from || key.startsWith(`${from}/`)) && from.length > bestLen) {
      best = m;
      bestLen = from.length;
    }
  }
  if (!best) return null;
  // 残りの部分は元のパスから取る(大文字小文字を変えない)。区切りは読み替え先の形に揃える
  const rest = path.replace(/\\/g, '/').replace(/\/+$/, '').slice(bestLen).replace(/^\//, '');
  const sep = isWinPath(best.to) || best.to.includes('\\') ? '\\' : '/';
  const to = best.to.replace(/[\\/]+$/, '');
  return rest ? `${to}${sep}${rest.split('/').join(sep)}` : to;
}

/** セッションの作業フォルダとファイルのパスを読み替える。1 つでも読み替えたら mapped */
export function applyPathMap(set: AiChangeSet, map: readonly PathMapping[]): { set: AiChangeSet; mapped: boolean } {
  if (!map.length) return { set, mapped: false };
  let mapped = false;
  const m = (p: string | null): string | null => {
    if (p == null) return p;
    const r = mapPath(p, map);
    if (r == null) return p;
    mapped = true;
    return r;
  };
  const out: AiChangeSet = {
    ...set,
    context: { ...set.context, cwd: m(set.context.cwd), gitRoot: m(set.context.gitRoot) },
    files: set.files.map((f) => ({ ...f, path: m(f.path)! })),
    hunks: set.hunks.map((h) => ({ ...h, path: m(h.path)! })),
  };
  return { set: out, mapped };
}

// --- 送った側の結果を読む(共有フォルダに置かれたものなので、形を確かめ、決めた項目だけを作り直す) ---

const SENDER_HUNKS_MAX = 20_000;
const STR_MAX = 4096;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e9 ? v : null);
/** 制御文字と見えない書式の文字を含まない、長すぎない文字列 */
const safeStr = (v: unknown, max = STR_MAX): string | null => (typeof v === 'string' && v.length <= max && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v) ? v : null);
const isoOrNull = (v: unknown): string | null => {
  const s = safeStr(v, 64);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
};

function lineCounts(v: unknown): LineCounts | null {
  if (!isObj(v)) return null;
  const o = {} as LineCounts;
  for (const k of RETENTION_STATUSES) {
    const n = count(v[k]);
    if (n == null) return null;
    o[k] = n;
  }
  return o;
}

function hunkOf(v: unknown): HunkRetention | null {
  if (!isObj(v)) return null;
  const id = count(v.id);
  const path = safeStr(v.path);
  const status = typeof v.status === 'string' && (RETENTION_STATUSES as readonly string[]).includes(v.status) ? (v.status as RetentionStatus) : null;
  const lines = lineCounts(v.lines);
  if (id == null || path == null || !status || !lines) return null;
  const h: HunkRetention = { id, path, status, lines };
  if (status === 'unattributable') {
    const reason = typeof v.reason === 'string' && (UNATTRIBUTABLE_REASONS as readonly string[]).includes(v.reason) ? (v.reason as UnattributableReason) : 'read_error';
    h.reason = reason;
  }
  return h;
}

/**
 * 送った側の結果(UPLOAD_VCS_META の中身)を読む。形が違う・ほかのセッションのものなら null。
 * 件数は書いてある数を信じず、まとまりから数え直す(分母と内訳が食い違わないように)
 */
export function parseSenderVcs(json: unknown, id: string): SessionRetention | null {
  if (!isObj(json) || json.version !== 1 || json.sessionId !== id || !isObj(json.result)) return null;
  const r = json.result;
  if (r.sessionId !== id) return null;
  if (!Array.isArray(r.hunks) || r.hunks.length > SENDER_HUNKS_MAX) return null;
  const hunks: HunkRetention[] = [];
  for (const h of r.hunks) {
    const x = hunkOf(h);
    if (!x) return null;
    hunks.push(x);
  }
  const vcs = typeof r.vcs === 'string' && (VCS_KINDS as readonly string[]).includes(r.vcs) ? (r.vcs as VcsKind) : null;
  const b = isObj(r.baseline) ? r.baseline : null;
  const baseline = b && safeStr(b.rev, 200) && (b.source === 'observed' || b.source === 'estimated') ? { rev: b.rev as string, source: b.source as 'observed' | 'estimated' } : null;
  const e = isObj(r.evaluated) ? r.evaluated : null;
  const evaluated = e && (e.mode === 'worktree' || e.mode === 'committed') ? { mode: e.mode as EvalMode, rev: safeStr(e.rev, 200), at: isoOrNull(e.at) ?? '' } : null;
  const out: SessionRetention = {
    sessionId: id,
    outcome: 'no_ai_changes',
    vcs,
    root: safeStr(r.root),
    baseline,
    evaluated,
    hunks,
    excludedHunks: count(r.excludedHunks) ?? 0,
    counts: { kept: 0, modified: 0, missing: 0, unattributable: 0 },
    lines: { kept: 0, modified: 0, missing: 0, unattributable: 0 },
    provenance: { aiChanges: 'events', baseline: baseline?.source ?? null, context: {} },
    computedOn: 'sender',
    ...(r.pathMapped === true ? { pathMapped: true } : {}),
  };
  // 送った側で「照合不能」だったときの理由も、まとまりの理由から決め直す
  finishCounts(out);
  return out;
}

/** まとまりから件数・行数・結果を数え直す(measureRetention と同じ決め方) */
function finishCounts(r: SessionRetention): void {
  r.counts = { kept: 0, modified: 0, missing: 0, unattributable: 0 };
  r.lines = { kept: 0, modified: 0, missing: 0, unattributable: 0 };
  for (const h of r.hunks) {
    r.counts[h.status]++;
    for (const k of RETENTION_STATUSES) r.lines[k] += h.lines[k];
  }
  delete r.reason;
  if (r.counts.kept + r.counts.modified + r.counts.missing > 0) r.outcome = 'measured';
  else if (r.counts.unattributable > 0) {
    r.outcome = 'unattributable';
    const by = new Map<UnattributableReason, number>();
    for (const h of r.hunks) if (h.reason) by.set(h.reason, (by.get(h.reason) ?? 0) + 1);
    r.reason = [...by].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'read_error';
  } else r.outcome = 'no_ai_changes';
}

/** AI の変更はあるが照合していない(送った側の結果が無い)セッションの結果 */
function notMeasured(set: AiChangeSet): SessionRetention {
  const r: SessionRetention = {
    sessionId: set.sessionId,
    outcome: 'no_ai_changes',
    vcs: null,
    root: null,
    baseline: null,
    evaluated: null,
    hunks: set.hunks.map((h) => ({ id: h.id, path: h.path, status: 'unattributable', reason: 'not_measured', lines: { kept: 0, modified: 0, missing: 0, unattributable: h.lines.length } })),
    excludedHunks: 0,
    counts: { kept: 0, modified: 0, missing: 0, unattributable: 0 },
    lines: { kept: 0, modified: 0, missing: 0, unattributable: 0 },
    provenance: { aiChanges: 'events', baseline: null, context: set.context.sources },
    computedOn: 'sender',
  };
  finishCounts(r);
  return r;
}

// --- 段の本体 ---

/** 1 つのセッションのフォルダから AI の変更を取り出す(events.jsonl が無ければ変更なし) */
export async function readAiChanges(dir: string, id: string): Promise<AiChangeSet> {
  const eventsPath = join(dir, 'events.jsonl');
  let ws: WorkspaceHints | null = null;
  try {
    ws = (await readWorkspaceYaml(join(dir, 'workspace.yaml'))) as WorkspaceHints | null;
  } catch {
    ws = null;
  }
  const events = existsSync(eventsPath) ? (await readEvents(eventsPath)).events : [];
  return extractAiChanges(id, events, ws);
}

/** スナップショット(out/snapshot)の全セッションを照合する */
export async function runVcsStep(snapshotDir: string, opts: VcsStepOptions = {}): Promise<VcsRetentionFile> {
  const manifest = await readSnapshotManifest(snapshotDir);
  const uploaded = manifest?.layout === 'flat' || manifest?.layout === 'merged';
  const stateDir = join(snapshotDir, 'session-state');
  const ids = (existsSync(stateDir) ? await listSessionDirs(stateDir) : []).filter((id) => !opts.ids || opts.ids.has(id));
  const mode = opts.mode ?? 'worktree';
  const similarity = opts.similarity ?? DEFAULT_SIMILARITY;
  const map = opts.pathMap ?? [];
  const results: SessionRetention[] = [];

  if (uploaded) {
    for (const id of ids) {
      const dir = join(stateDir, id);
      const metaPath = join(dir, UPLOAD_VCS_META);
      let sender: SessionRetention | null = null;
      if (existsSync(metaPath)) {
        try {
          sender = parseSenderVcs(JSON.parse(await readFile(metaPath, 'utf8')), id);
        } catch {
          sender = null;
        }
      }
      results.push(sender ?? notMeasured(await readAiChanges(dir, id)));
    }
  } else {
    const sets: AiChangeSet[] = [];
    const mappedIds = new Set<string>();
    for (const id of ids) {
      const { set, mapped } = applyPathMap(await readAiChanges(join(stateDir, id), id), map);
      if (mapped) mappedIds.add(id);
      sets.push(set);
    }
    const measured = await measureRetention(sets, { ...opts, mode, similarity });
    for (const r of measured) results.push({ ...r, computedOn: 'local', ...(mappedIds.has(r.sessionId) ? { pathMapped: true } : {}) });
  }
  results.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return {
    schemaVersion: VCS_RETENTION_SCHEMA_VERSION,
    generatedAt: (opts.now?.() ?? new Date()).toISOString(),
    computedOn: uploaded ? 'sender' : 'local',
    mode,
    similarity,
    pathMap: map.length,
    summary: summarizeRetention(results),
    sessions: results,
  };
}

/** out/vcs-retention.json を読む。無い・形が違う(版が違う)なら null */
export async function readVcsRetention(path: string): Promise<VcsRetentionFile | null> {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(await readFile(path, 'utf8')) as VcsRetentionFile;
    return j && j.schemaVersion === VCS_RETENTION_SCHEMA_VERSION && Array.isArray(j.sessions) ? j : null;
  } catch {
    return null;
  }
}

/** アップロードでセッションのフォルダに添える中身(送った側の PC の結果) */
export function senderVcsJson(r: SessionRetention, file: Pick<VcsRetentionFile, 'generatedAt' | 'mode'>): string {
  const body: SenderVcsFile = { version: 1, sessionId: r.sessionId, computedAt: file.generatedAt, mode: file.mode, result: r };
  return `${JSON.stringify(body, null, 2)}\n`;
}
