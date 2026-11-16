// 「課題 × 条件」の節の「利用の確認」: 条件が実際に効いたか(wiki あり の条件で wiki を使ったか、など)を確かめる。
// 条件ごとに、選んだもの(llm-wiki の参照・skill・MCP サーバー・ツール)を使ったセッションの数を並べ、
// 使うはずの条件で使わなかったセッションと、ほかの条件で使ったセッションを一覧にする。
// どの条件で使うはずかは読む人が画面で選ぶ(条件の名前からは推測しない)。LLM は使わない。DOM や node: に依存しない。
import { COMPARE_MIN_SESSIONS } from './compare.ts';
import { compareNames, type ConditionMember, type ConditionSession, type ConditionTable } from './conditions.ts';

export type UsageKind = 'wiki' | 'skill' | 'mcp' | 'tool';

/** 確かめるもの 1 つ。key は 'wiki'・'skill:<名前>'・'mcp:<サーバー>'・'tool:<名前>' */
export interface UsageItem {
  key: string;
  kind: UsageKind;
  name: string;
  /** 表の行に入ったセッションのうち、使ったものの数 */
  sessions: number;
}

/** llm-wiki の参照(いつも選べる。vault を指定していない集計では、どのセッションも 0) */
export const WIKI_ITEM = 'wiki';

const kindOf = (key: string): UsageKind | null => (key === WIKI_ITEM ? 'wiki' : key.startsWith('skill:') ? 'skill' : key.startsWith('mcp:') ? 'mcp' : key.startsWith('tool:') ? 'tool' : null);
const nameOf = (key: string): string => key.slice(key.indexOf(':') + 1);
const sum = (v: Record<string, number> | readonly number[] | undefined): number => Object.values(v ?? {}).reduce((a, b) => a + b, 0);

/** 名前で引く(constructor などの組み込みの名前を、記録と取り違えない) */
const own = <T>(o: Record<string, T> | undefined, name: string): T | undefined => (o && Object.hasOwn(o, name) ? o[name] : undefined);

/**
 * そのセッションで使った回数。wiki は参照(索引・個別ページを読んだ回数、wiki の skill の呼び出し、vault の検索・一覧などそのほかの呼び出し。
 * 書き込みだけは数えない)、skill は呼び出し、MCP サーバーはそのサーバーのツールの呼び出し、ツールは呼び出し
 */
export function usageCount(s: ConditionSession, key: string): number {
  const name = nameOf(key);
  switch (kindOf(key)) {
    case 'wiki': {
      const w = s.wiki;
      return w ? w.indexReads + w.pageReads + w.skillCalls + (w.otherCalls ?? 0) : 0;
    }
    case 'skill':
      return sum(own(s.skills, name));
    case 'mcp':
      return sum(own(s.tools.mcp, name));
    case 'tool':
      return own(s.tools.byName, name) ?? 0;
    default:
      return 0;
  }
}

/**
 * 選べるもの。llm-wiki の参照をいつも先頭に置き、続けて skill・MCP サーバー・ツールを、表の行に入ったセッションで使われたものだけ
 * (使ったセッションの多い順、同じなら名前の順)。MCP サーバーのツールは、サーバーとしてまとめて出すのでツールには並べない
 */
export function usageItems(members: readonly ConditionMember[]): UsageItem[] {
  const counts = new Map<string, number>();
  const mcpTools = new Set<string>();
  for (const { session: s } of members) {
    for (const tools of Object.values(s.tools.mcp ?? {})) for (const t of Object.keys(tools)) mcpTools.add(t);
  }
  for (const { session: s } of members) {
    const keys = new Set<string>();
    for (const [n, t] of Object.entries(s.skills ?? {})) if (sum(t) > 0) keys.add(`skill:${n}`);
    for (const [n, tools] of Object.entries(s.tools.mcp ?? {})) if (sum(tools) > 0) keys.add(`mcp:${n}`);
    for (const [n, c] of Object.entries(s.tools.byName ?? {})) if (c > 0 && !mcpTools.has(n)) keys.add(`tool:${n}`);
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const order: UsageKind[] = ['skill', 'mcp', 'tool'];
  const rest = [...counts]
    .map(([key, sessions]): UsageItem => ({ key, kind: kindOf(key)!, name: nameOf(key), sessions }))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.sessions - a.sessions || compareNames(a.name, b.name));
  const wiki = members.filter((m) => usageCount(m.session, WIKI_ITEM) > 0).length;
  return [{ key: WIKI_ITEM, kind: 'wiki', name: 'llm-wiki', sessions: wiki }, ...rest];
}

export interface UsageRow {
  condition: string;
  /** この条件のセッション(全部の課題) */
  sessions: number;
  /** そのうち使ったもの */
  used: number;
  /** 使った割合。セッションが足りなければ null(「—」) */
  share: number | null;
}

/** 条件ごと(表の条件の並び)の、使ったセッションの数 */
export function usageRows(table: Pick<ConditionTable, 'conditions' | 'members'>, key: string): UsageRow[] {
  return table.conditions.map((condition) => {
    const list = table.members.filter((m) => m.condition === condition);
    const used = list.filter((m) => usageCount(m.session, key) > 0).length;
    return { condition, sessions: list.length, used, share: list.length >= COMPARE_MIN_SESSIONS ? used / list.length : null };
  });
}

export interface UsageMismatch {
  member: ConditionMember;
  /** 使った回数 */
  count: number;
}

/**
 * 食い違ったセッション。missing は使うはずの条件(expected)で使わなかったもの、leaked はほかの条件で使ったもの。
 * 並びは条件・課題の名前の順(同じなら母集団の並び)
 */
export function usageMismatches(table: Pick<ConditionTable, 'members'>, key: string, expected: ReadonlySet<string>): { missing: UsageMismatch[]; leaked: UsageMismatch[] } {
  const missing: UsageMismatch[] = [];
  const leaked: UsageMismatch[] = [];
  for (const member of table.members) {
    const count = usageCount(member.session, key);
    if (expected.has(member.condition) ? count === 0 : count > 0) (expected.has(member.condition) ? missing : leaked).push({ member, count });
  }
  const order = (a: UsageMismatch, b: UsageMismatch): number => compareNames(a.member.condition, b.member.condition) || compareNames(a.member.task, b.member.task);
  return { missing: missing.sort(order), leaked: leaked.sort(order) };
}
