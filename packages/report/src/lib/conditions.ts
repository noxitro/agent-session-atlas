// 「課題 × 条件」の節: 同じ課題を条件を変えて何度も実行したセッションを、タスクタグの名前(課題__条件、課題__条件__番号)で分けて並べる。
// 差は相関で、条件の違いが原因とは限らない。課題をまとめた行には、課題の難しさと件数の偏りが混ざる(同じ課題の行どうしで読む)。
// 画面はブラウザの中で計算する。表(out/tables/conditions.csv)を書く Node 側からも同じ計算を読み込めるよう、DOM や node: に依存しない。
import { COMPARE_MIN_SESSIONS, rate } from './compare.ts';
import { median } from './retention.ts';
import type { SessionSummary } from './types.ts';

/** タスクタグの名前の、課題・条件・番号の区切り */
export const CONDITION_SEP = '__';

export interface ConditionKey {
  task: string;
  condition: string;
  /** 番号(半角の数字)。付いていなければ null。集計には使わない(回数はセッションの数で数える) */
  rep: string | null;
}

/**
 * タスクタグの名前を、課題・条件(・番号)に分ける。決まりに合わなければ null。
 * 決まり: 「課題__条件」か「課題__条件__番号」。番号は半角の数字だけ。どの部分も空でなく、区切りの隣に _ が続かない
 * (「a___b」のように、どこで切るかが 1 つに決まらない名前を受けない)。前後の空白は落とす。大文字小文字・全角半角はそろえない
 */
export function parseConditionTag(raw: string): ConditionKey | null {
  const parts = raw.split(CONDITION_SEP).map((p) => p.trim());
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (parts.some((p) => p === '' || p.startsWith('_') || p.endsWith('_'))) return null;
  const [task, condition, rep] = parts;
  if (rep !== undefined && !/^[0-9]+$/.test(rep)) return null;
  return { task, condition, rep: rep ?? null };
}

export type ConditionSession = Pick<SessionSummary, 'id' | 'activeMs' | 'tools' | 'friction' | 'tokens' | 'tests' | 'person'> &
  // 利用の確認(condition-usage.ts)で使う。古い単体テストの作りかけの値では無いことがある
  Partial<Pick<SessionSummary, 'name' | 'firstUserMessage' | 'href' | 'wiki' | 'skills'>>;

/** 表の行に入ったセッション 1 つと、その課題・条件 */
export interface ConditionMember {
  session: ConditionSession;
  task: string;
  condition: string;
}

/** タスクタグ 1 つ。tag は送り先から集計したときの元のタグ(無ければ name がそのままタグ) */
export interface ConditionGroup {
  name: string;
  tag?: string;
  /** 記録にあるセッションの id */
  presentIds: readonly string[];
}

/** 中央値と、それを取ったセッションの数。value が null なら件数が足りない(「—」) */
export interface Median {
  value: number | null;
  n: number;
}

/**
 * 最初に全部通るまでの中央値。一度も全部通らなかった(未達の)セッションをどの値よりも後ろに並べて取るので、
 * 通ったセッションが半分以下なら 'unreached'。null は件数が足りない(「—」)
 */
export interface UntilPass {
  value: number | 'unreached' | null;
  n: number;
}

export interface ConditionCell {
  /** 課題。課題をまとめた行では null */
  task: string | null;
  condition: string;
  /** セッションの数(同じセッションは 1 回) */
  sessions: number;
  /** この条件のセッションがある課題の数(課題ごとの行では 0 か 1) */
  tasks: number;
  /** テストの記録がある(テストの実行が 1 回以上ある)セッション。テストの結果の分母 */
  withTests: number;
  /** 最後の実行の後に、通っていないテストが無い */
  passed: number;
  /** 一度は全部通ったが、最後の実行の後に通っていないテストがある */
  regressed: number;
  /** テストの実行はあるが、一度も全部通らなかった */
  unreached: number;
  /** 最後に全部通った割合(passed ÷ withTests)。withTests が足りなければ null */
  passRate: number | null;
  runsToPass: UntilPass;
  activeToPass: UntilPass;
  /**
   * 単位は AIU。そこまでの AI 使用量が分かるセッションだけを母数にする: 通ったセッションは最初に通った実行までの量があるもの、
   * 未達のセッションは最後の実行までの量がある(リクエストごとの記録がある)もの。量の分からないセッションは、通った側にも未達の側にも入れない
   */
  aiuToPass: UntilPass;
  /** セッション全体の実働(ミリ秒)の中央値 */
  active: Median;
  /** セッション全体の AI 使用量(AIU)の中央値 */
  aiu: Median;
  tools: number;
  toolFailures: number;
  /** ツールの失敗・拒否 ÷ ツール呼び出し(「比べる」と同じ式。セッションが足りなければ null) */
  failureRate: number | null;
}

export interface ConditionTable {
  tasks: string[];
  conditions: string[];
  /** 課題ごと(tasks の順)の、条件ごと(conditions の順)の行。その課題に無い条件はセッション 0 件の行 */
  rows: ConditionCell[][];
  /** 条件ごと(conditions の順)の、課題をまとめた行 */
  pooled: ConditionCell[];
  /** 名前の決まりに合い、セッションが 1 件以上あるタスクタグの数(節を出すかどうか) */
  matchedTags: number;
  /** 行に入ったセッションの数 */
  counted: number;
  /** 行に入ったセッション(母集団の並び) */
  members: ConditionMember[];
  /** 区切りを含むのに決まりに合わない、セッションのあるタスクタグの名前 */
  unmatched: string[];
  /** 課題か条件の違うタグが 2 つ以上付いていて、どの行にも入れなかったセッションの数 */
  ambiguous: number;
  /** 行に入ったセッションを送った人の数(送り先から集計したときだけ 1 以上) */
  people: number;
  /** 2 人以上のセッションが入っている、課題 × 条件の行の数(人をまたいでまとめた行) */
  sharedRows: number;
  /** 条件によってセッションの数が違う課題の数 */
  unevenTasks: number;
  /** 大文字小文字・全角半角だけが違う名前の組(別の課題・条件として数えている) */
  lookalikes: [string, string][];
  /** テストの記録があるセッションが 1 件でもあるか */
  hasTests: boolean;
}

const collator = new Intl.Collator('ja', { numeric: true });
/** 名前の順(数字は数として比べる)。同じとされたら符号単位の順で決める(実行する環境で並びが変わらないように) */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

const enough = (n: number): boolean => n >= COMPARE_MIN_SESSIONS;

/** 記録のある値の中央値(件数が足りなければ null) */
function medianOf(values: readonly number[]): Median {
  return { value: enough(values.length) ? median(values) : null, n: values.length };
}

/**
 * 最初に全部通るまでの中央値。reached は通ったセッションの値、total は母数(通ったセッション + 未達のセッション)。
 * 未達を最後に並べた total 件の中央値なので、真ん中の位置が通ったセッションに収まるときだけ数になる
 */
export function untilPass(reached: readonly number[], total: number): UntilPass {
  if (!enough(total)) return { value: null, n: total };
  if (reached.length * 2 <= total) return { value: 'unreached', n: total };
  const s = [...reached].sort((a, b) => a - b);
  return { value: (s[Math.floor((total - 1) / 2)] + s[Math.floor(total / 2)]) / 2, n: total };
}

/** セッションの集まり 1 つ分の行 */
export function conditionCell(task: string | null, condition: string, list: readonly ConditionSession[], tasks: number): ConditionCell {
  let withTests = 0;
  let passed = 0;
  let regressed = 0;
  let unreached = 0;
  let tools = 0;
  let toolFailures = 0;
  const runs: number[] = [];
  const passActive: number[] = [];
  let activeTotal = 0;
  const passAiu: number[] = [];
  let aiuTotal = 0;
  const active: number[] = [];
  const aiu: number[] = [];
  for (const s of list) {
    tools += s.tools.total;
    toolFailures += s.friction.toolFailures;
    if (s.activeMs != null) active.push(s.activeMs);
    if (s.tokens.nanoAiu != null) aiu.push(s.tokens.nanoAiu / 1e9);
    const t = s.tests;
    if (!t) continue;
    withTests++;
    if (t.firstPass == null) {
      unreached++;
      activeTotal++;
      // 未達のセッションは、AI 使用量の記録があるものだけを、通るまでの AIU の母数に入れる(記録が無ければ、通った側とも比べられない)
      if (t.lastNanoAiu != null) aiuTotal++;
      continue;
    }
    if (t.lastFailing === 0) passed++;
    else regressed++;
    runs.push(t.firstPass);
    if (t.passActiveMs != null) {
      passActive.push(t.passActiveMs);
      activeTotal++;
    }
    if (t.passNanoAiu != null) {
      passAiu.push(t.passNanoAiu / 1e9);
      aiuTotal++;
    }
  }
  return {
    task,
    condition,
    sessions: list.length,
    tasks,
    withTests,
    passed,
    regressed,
    unreached,
    passRate: enough(withTests) ? passed / withTests : null,
    runsToPass: untilPass(runs, withTests),
    activeToPass: untilPass(passActive, activeTotal),
    aiuToPass: untilPass(passAiu, aiuTotal),
    active: medianOf(active),
    aiu: medianOf(aiu),
    tools,
    toolFailures,
    failureRate: rate(toolFailures, tools, list.length),
  };
}

/** 大文字小文字・全角半角をそろえた形(同じになる名前を知らせるためだけに使う。集計ではそろえない) */
const folded = (s: string): string => s.normalize('NFKC').toLowerCase();

function lookalikePairs(names: readonly string[]): [string, string][] {
  const out: [string, string][] = [];
  const first = new Map<string, string>();
  for (const n of names) {
    const k = folded(n);
    const seen = first.get(k);
    if (seen === undefined) first.set(k, n);
    else out.push([seen, n]);
  }
  return out;
}

/**
 * 課題 × 条件の表。sessions は母集団(上の絞り込みには従わない)、groups はタスクタグ。
 * セッションは、付いているタグから決まる (課題, 条件) が 1 つのときだけ、その行に 1 回数える(番号だけ違うタグは同じ行)。
 * 2 つ以上に決まるセッションは、どの条件の結果か決められないので、どの行にも入れず件数だけ返す
 */
export function conditionTable(sessions: readonly ConditionSession[], groups: readonly ConditionGroup[]): ConditionTable {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  /** セッション id → (課題, 条件) の鍵(JSON の文字列)→ 鍵 */
  const keysOf = new Map<string, Map<string, ConditionKey>>();
  const unmatched: string[] = [];
  let matchedTags = 0;
  for (const g of groups) {
    const ids = g.presentIds.filter((id) => byId.has(id));
    if (!ids.length) continue;
    const raw = g.tag ?? g.name;
    const key = parseConditionTag(raw);
    if (!key) {
      if (raw.includes(CONDITION_SEP)) unmatched.push(raw);
      continue;
    }
    matchedTags++;
    const k = JSON.stringify([key.task, key.condition]);
    for (const id of ids) {
      let m = keysOf.get(id);
      if (!m) keysOf.set(id, (m = new Map()));
      m.set(k, key);
    }
  }
  /** 課題 → 条件 → セッション */
  const cells = new Map<string, Map<string, ConditionSession[]>>();
  const conditionSet = new Set<string>();
  const people = new Set<string>();
  let ambiguous = 0;
  const members: ConditionMember[] = [];
  // 母集団の並びのまま入れる(同じ入力なら同じ結果)
  for (const s of sessions) {
    const m = keysOf.get(s.id);
    if (!m) continue;
    if (m.size > 1) {
      ambiguous++;
      continue;
    }
    const [key] = m.values();
    let byCondition = cells.get(key.task);
    if (!byCondition) cells.set(key.task, (byCondition = new Map()));
    let list = byCondition.get(key.condition);
    if (!list) byCondition.set(key.condition, (list = []));
    list.push(s);
    conditionSet.add(key.condition);
    if (s.person) people.add(s.person);
    members.push({ session: s, task: key.task, condition: key.condition });
  }
  const tasks = [...cells.keys()].sort(compareNames);
  const conditions = [...conditionSet].sort(compareNames);
  const rows = tasks.map((t) => conditions.map((c) => {
    const list = cells.get(t)?.get(c) ?? [];
    return conditionCell(t, c, list, list.length ? 1 : 0);
  }));
  const pooled = conditions.map((c) => {
    const lists = tasks.map((t) => cells.get(t)?.get(c) ?? []);
    return conditionCell(null, c, lists.flat(), lists.filter((l) => l.length > 0).length);
  });
  return {
    tasks,
    conditions,
    rows,
    pooled,
    matchedTags,
    counted: members.length,
    members,
    unmatched: [...new Set(unmatched)].sort(compareNames),
    ambiguous,
    people: people.size,
    sharedRows: [...cells.values()].flatMap((m) => [...m.values()]).filter((list) => new Set(list.map((s) => s.person).filter(Boolean)).size > 1).length,
    unevenTasks: rows.filter((r) => new Set(r.map((c) => c.sessions)).size > 1).length,
    lookalikes: [...lookalikePairs(tasks), ...lookalikePairs(conditions)],
    hasTests: pooled.some((c) => c.withTests > 0),
  };
}
