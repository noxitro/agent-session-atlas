// セッションの絞り込み(画面のフィルタ行と CLI の --project 等で共用する純関数)
import type { InputCoverage, SessionSummary } from './types.ts';
import { wikiReferenced } from './wiki.ts';

/** 絞り込みに使う最小限の形(SessionRecord と SessionSummary の両方が満たす) */
export interface Filterable {
  project: string;
  client: string | null;
  branch: string | null;
  models: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

export const ALL = '';
export const UNKNOWN = '(unknown)';

export interface FilterState {
  /** YYYY-MM-DD(ローカル日付、含む)。空なら制限なし */
  from: string;
  to: string;
  project: string;
  /** 人のフォルダの名前(送り先をまとめて集計したレポートだけ)。UNKNOWN は人のフォルダの下に無いセッション */
  person: string;
  client: string;
  model: string;
  branch: string;
  coverage: '' | InputCoverage;
  /** judgments の taskCategory。'(none)' は未判定 */
  taskCategory: string;
  /** '1' なら空のセッション(依頼 0・ツール 0・応答 0)も含める。既定('')は除外 */
  empty: '' | '1';
  /** そのツールを呼んだセッションだけ(ツール名、MCP サーバーは mcp:<サーバー>)。要点欄のリンクから設定する */
  tool: string;
  /** セッションの選択(id をカンマ区切り。'' は制限なし)。一覧のチェックからの「集計」で入る */
  ids: string;
  /** '1' ならメモのあるセッションだけ */
  memo: '' | '1';
  /** '1' なら llm-wiki を参照したセッションだけ(wikiReferenced。書き込みだけは入れない) */
  wiki: '' | '1';
}

export const NO_JUDGMENT = '(none)';

export function emptyFilter(): FilterState {
  return { from: '', to: '', project: ALL, person: ALL, client: ALL, model: ALL, branch: ALL, coverage: '', taskCategory: ALL, empty: '', tool: ALL, ids: '', memo: '', wiki: '' };
}

/** 一覧のチェックに写す選択: ids のうち記録にあるものだけ(共有された URL の未知の id は入れない) */
export function knownSelection(ids: string, known: Set<string>): Set<string> {
  return new Set(splitIds(ids).filter((id) => known.has(id)));
}

/** ids(カンマ区切り)を配列に(空要素と重複は除く) */
export function splitIds(ids: string): string[] {
  return [...new Set(ids.split(',').map((s) => s.trim()).filter(Boolean))];
}
export function joinIds(ids: Iterable<string>): string {
  return [...new Set([...ids].map((s) => s.trim()).filter(Boolean))].join(',');
}
/** 2 つの ids が同じ集合か(順序は無視) */
export function sameIds(a: string, b: string): boolean {
  const x = splitIds(a);
  const y = new Set(splitIds(b));
  return x.length === y.size && x.every((id) => y.has(id));
}

export function isEmptyFilter(f: FilterState): boolean {
  const e = emptyFilter();
  return (Object.keys(e) as (keyof FilterState)[]).every((k) => f[k] === e[k]);
}

/** セッションの基準時刻(作成日時、無ければ更新日時)。ミリ秒 */
/** セッションの最終更新の時刻(ミリ秒)。更新日時が無ければ開始日時、どちらも無ければ null。一覧の「最終更新」の並べ替えに使う */
export function sessionUpdated(s: Pick<Filterable, 'createdAt' | 'updatedAt'>): number | null {
  const t = s.updatedAt ?? s.createdAt;
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

export function sessionTime(s: Pick<Filterable, 'createdAt' | 'updatedAt'>): number | null {
  const t = s.createdAt ?? s.updatedAt;
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

/** YYYY-MM-DD をローカル日付の 0 時(ミリ秒)に。不正なら null */
export function localDayStart(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

const eqOrUnknown = (value: string | null, want: string): boolean => (want === UNKNOWN ? value == null || value === UNKNOWN : value === want);

/** 期間・プロジェクト・クライアント・モデル・ブランチの共通述語 */
export function matchesBase(s: Filterable, f: Pick<FilterState, 'from' | 'to' | 'project' | 'client' | 'model' | 'branch'>): boolean {
  if (f.project && s.project !== f.project) return false;
  if (f.client && !eqOrUnknown(s.client, f.client)) return false;
  if (f.branch && !eqOrUnknown(s.branch, f.branch)) return false;
  if (f.model) {
    if (f.model === UNKNOWN ? s.models.length > 0 : !s.models.includes(f.model)) return false;
  }
  if (f.from || f.to) {
    const t = sessionTime(s);
    if (t == null) return false; // 日時不明は期間指定時に除外
    const from = f.from ? localDayStart(f.from) : null;
    const to = f.to ? localDayStart(f.to) : null;
    if (from != null && t < from) return false;
    if (to != null && t >= to + 24 * 3600 * 1000) return false;
  }
  return true;
}

/** 空のセッションを除外するか(既定)。絞り込みの選択肢の件数もこの範囲で数える */
export function inScope(s: Pick<SessionSummary, 'empty'>, f: Pick<FilterState, 'empty'>): boolean {
  return f.empty === '1' || !s.empty;
}

/** そのツール(MCP サーバーは mcp:<サーバー>)を呼んだセッションか */
export function usedTool(s: Pick<SessionSummary, 'tools'>, tool: string): boolean {
  if (tool.startsWith('mcp:')) return Object.keys(s.tools.mcp[tool.slice(4)] ?? {}).length > 0;
  return (s.tools.byName[tool] ?? 0) > 0;
}

export function matches(s: SessionSummary, f: FilterState, ids: Set<string> | null = f.ids ? new Set(splitIds(f.ids)) : null): boolean {
  if (!inScope(s, f)) return false;
  if (ids && !ids.has(s.id)) return false;
  if (!matchesBase(s, f)) return false;
  if (f.person && !eqOrUnknown(s.person ?? null, f.person)) return false;
  if (f.tool && !usedTool(s, f.tool)) return false;
  if (f.coverage && s.coverage !== f.coverage) return false;
  if (f.memo && !s.memo) return false;
  if (f.wiki && !wikiReferenced(s.wiki)) return false;
  if (f.taskCategory) {
    const c = s.judgment?.taskCategory ?? NO_JUDGMENT;
    if (c !== f.taskCategory) return false;
  }
  return true;
}

export function applyFilter(sessions: SessionSummary[], f: FilterState): SessionSummary[] {
  const ids = f.ids ? new Set(splitIds(f.ids)) : null;
  return sessions.filter((s) => matches(s, f, ids));
}

export interface Option {
  value: string;
  label: string;
  count: number;
}

function countOptions(values: string[], label: (v: string) => string = (v) => v): Option[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, label: label(value), count }));
}

/** 人のフォルダの名前が 1 件でも付いているか(送り先をまとめて集計したレポートか) */
export function hasPeople(sessions: Pick<SessionSummary, 'person'>[]): boolean {
  return sessions.some((s) => s.person != null);
}

/** フィルタの選択肢(全セッションに対する件数付き)。person は、人のフォルダの名前が 1 件も無ければ空 */
export function filterOptions(sessions: SessionSummary[]): {
  project: Option[];
  person: Option[];
  client: Option[];
  model: Option[];
  branch: Option[];
  taskCategory: Option[];
} {
  const labels = new Map(sessions.map((s) => [s.project, s.projectLabel]));
  return {
    project: countOptions(
      sessions.map((s) => s.project),
      (v) => labels.get(v) ?? v,
    ),
    person: hasPeople(sessions) ? countOptions(sessions.map((s) => s.person ?? UNKNOWN)) : [],
    client: countOptions(sessions.map((s) => s.client ?? UNKNOWN)),
    model: countOptions(sessions.flatMap((s) => (s.models.length ? s.models : [UNKNOWN]))),
    branch: countOptions(sessions.map((s) => s.branch ?? UNKNOWN)),
    taskCategory: countOptions(sessions.map((s) => s.judgment?.taskCategory ?? NO_JUDGMENT)),
  };
}

/** 入力トークン記録の 3 区分 */
export function coverageOf(t: { input: number | null; output: number; source: string }): InputCoverage {
  if (t.input != null) return 'input';
  if (t.output > 0 || t.source === 'partial') return 'output-only';
  return 'none';
}

/** URL ハッシュ(#f=...)との相互変換。file:// でも状態を共有できるように */
export function encodeFilter(f: FilterState): string {
  const e = emptyFilter();
  const parts: string[] = [];
  // ids のカンマはハッシュの中でそのまま使える文字なので符号化しない(200 件で 7KB 程度に収める)
  for (const k of Object.keys(e) as (keyof FilterState)[]) if (f[k] !== e[k]) parts.push(`${k}=${k === 'ids' ? encodeURIComponent(f[k]).replace(/%2C/g, ',') : encodeURIComponent(f[k])}`);
  return parts.join('&');
}

/** URL ハッシュの表示の指定(view=unused-skills など。絞り込みとは別。無ければ null) */
export function decodeView(s: string): string | null {
  for (const part of s.replace(/^#/, '').split('&')) {
    if (!part.startsWith('view=')) continue;
    try {
      return decodeURIComponent(part.slice(5)) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * atlas.html の本文のタブ(概況・内訳・一覧)。URL ハッシュの tab=… に書く(既定の概況は書かない)。
 * 絞り込み(FilterState)とは別の部分で、絞り込みの条件の数にも「解除」にも入らない。id は URL に残るので変えない
 */
export const TABS = ['overview', 'breakdown', 'list'] as const;
export type TabId = (typeof TABS)[number];
export const DEFAULT_TAB: TabId = 'overview';

export function isTabId(s: string | null | undefined): s is TabId {
  return (TABS as readonly string[]).includes(s ?? '');
}

/** URL ハッシュのタブの指定(tab=breakdown など)。無いか、知らない値なら null(呼び元が既定の概況にする) */
export function decodeTab(s: string): TabId | null {
  for (const part of s.replace(/^#/, '').split('&')) {
    if (!part.startsWith('tab=')) continue;
    let v: string;
    try {
      v = decodeURIComponent(part.slice(4));
    } catch {
      return null;
    }
    return isTabId(v) ? v : null;
  }
  return null;
}

/** 絞り込みとタブの指定の URL ハッシュ(先頭の # なし。どちらも既定なら '')。絞り込みを変えたときに URL を書き換えるのに使う */
export function encodeState(f: FilterState, tab: TabId | null = null): string {
  return [encodeFilter(f), tab && tab !== DEFAULT_TAB ? `tab=${tab}` : ''].filter(Boolean).join('&');
}

/** 絞り込みと表示の指定(と、あればタブ)から URL ハッシュ(先頭の # 付き)を作る */
export function filterHref(f: FilterState, view: string | null = null, tab: TabId | null = null): string {
  const parts = [encodeState(f, tab), view ? `view=${encodeURIComponent(view)}` : ''].filter(Boolean);
  return `#${parts.join('&')}`;
}

/** ハッシュが絞り込みか表示・タブの指定を含むか(#overview のようなページ内リンクは含まない) */
export function isStateHash(s: string): boolean {
  return s.replace(/^#/, '').split('&').some((p) => p.indexOf('=') > 0);
}

export function decodeFilter(s: string): FilterState {
  const f = emptyFilter();
  for (const part of s.replace(/^#/, '').split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i) as keyof FilterState;
    if (!(k in f)) continue;
    let v: string;
    try {
      v = decodeURIComponent(part.slice(i + 1));
    } catch {
      continue;
    }
    if (k === 'coverage' && !['', 'input', 'output-only', 'none'].includes(v)) continue;
    if ((k === 'empty' || k === 'memo' || k === 'wiki') && !['', '1'].includes(v)) continue;
    if (k === 'ids') v = joinIds(splitIds(v));
    (f as unknown as Record<string, string>)[k] = v;
  }
  return f;
}
