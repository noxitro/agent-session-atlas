// 埋め込むセッションの要約を小さくする(atlas.html の大きさの上限 5MB に収めるため)。
// 既定値(空のセッションと同じ値)と一致する項目を落として埋め込み、読むときに既定値で埋め戻す。
// 既定値と違う値は 0 も null もそのまま残すので、欠測(null)と 0 の区別は失わない。href は id から作れるので埋め込まない。
// 埋め戻しは atlas.html の読み込み(app/main.ts)と extractEmbedded(テスト・serve)の 2 か所で行う。
import { detailHref } from './summarize.ts';
import type { SessionSummary } from './types.ts';

type Plain = Record<string, unknown>;

/**
 * 項目ごとの既定値。入れ子のオブジェクトは項目ごとに比べる(一部だけ既定値と違えば、違う項目だけ残す)。
 * 中身の決まっていない辞書(byName など)は {} を既定値にし、空のときだけ落とす。
 * 省略可能な項目(turnRows・turnVerdicts・memo)は既定値を持たない(無いことに意味があるため)
 */
const DEFAULTS: Plain = {
  client: null,
  projectSource: 'path',
  branch: null,
  person: null,
  name: null,
  firstUserMessage: null,
  durationMs: 0,
  activeMs: null,
  turns: 0,
  autopilotContinuations: 0,
  empty: false,
  models: [],
  tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, premiumRequests: null, nanoAiu: null, requests: 0, source: 'none' },
  coverage: 'none',
  byModel: {},
  tools: { total: 0, byName: {}, internal: 0, mcp: {}, issues: {}, causes: {}, durations: {}, outliers: {} },
  exec: { modes: {}, modesInferred: 0, efforts: {}, initiators: {}, context: null, latency: {} },
  frictionDetail: { permissions: [0, 0, 0], errorTypes: {}, subagentFailures: {}, compaction: [0, 0, 0, 0, 0] },
  todos: null,
  skills: {},
  agents: { total: 0, failed: 0, byName: {} },
  hooks: { total: 0, byType: {} },
  instructions: {},
  lines: { added: 0, removed: 0, source: 'none' },
  wiki: { indexReads: 0, pageReads: 0, skillCalls: 0, writes: 0 },
  friction: { compactions: 0, aborts: 0, errors: 0, permissionRequests: 0, askUser: 0, modelChanges: 0, modeChanges: 0, toolFailures: 0, subagentFailures: 0 },
  skillChars: {},
  instructionVersions: [],
  analysis: { filesReedited: 0, extraEdits: 0, maxConsecutiveFailures: 0, turns: 0 },
  files: { changed: 0, created: 0, deleted: 0, sessionState: 0 },
  judgment: null,
};

const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);
/** 中身の決まった既定値(項目ごとに比べる)。{} は辞書の既定値なので項目ごとには比べない */
const structured = (d: unknown): d is Plain => isPlain(d) && Object.keys(d).length > 0;

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isPlain(a) && isPlain(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && same(a[k], b[k]));
  }
  return false;
}

function packObj(o: Plain, d: Plain): Plain {
  const r: Plain = {};
  for (const [k, v] of Object.entries(o)) {
    if (!(k in d)) r[k] = v;
    else if (same(v, d[k])) continue;
    else if (structured(d[k]) && isPlain(v)) r[k] = packObj(v, d[k]);
    else r[k] = v;
  }
  return r;
}

function unpackObj(o: Plain, d: Plain): Plain {
  const r: Plain = { ...o };
  for (const [k, dv] of Object.entries(d)) {
    if (!(k in r)) r[k] = structuredClone(dv);
    else if (structured(dv) && isPlain(r[k])) r[k] = unpackObj(r[k] as Plain, dv);
  }
  return r;
}

/** 埋め込む形にする(既定値と同じ項目と href を落とす) */
export function packSummary(s: SessionSummary): Plain {
  const { href: _href, ...rest } = s;
  return packObj(rest as unknown as Plain, DEFAULTS);
}

/** 埋め込んだ形から元の要約に戻す */
export function unpackSummary(p: Plain): SessionSummary {
  const s = unpackObj(p, DEFAULTS) as unknown as SessionSummary;
  return { ...s, href: detailHref(s.id) };
}

/** 埋め込みデータの sessions を元の形に戻す(sessions が無い・配列でないときはそのまま) */
export function unpackData<T>(data: T): T {
  if (!isPlain(data) || !Array.isArray(data.sessions)) return data;
  return { ...data, sessions: (data.sessions as Plain[]).map((x) => (isPlain(x) && typeof x.id === 'string' ? unpackSummary(x) : x)) };
}
