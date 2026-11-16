// 失敗の台帳(analysis.failures)の集計(build 時。failures.html と failures.json に出す)。
//
// - 単位: ツール・MCP サーバー・エージェント・skill・指示文の版と、似たエラー文のまとまり(group)。
// - 対象は、空でなく台帳のあるセッションだけ。台帳の無い古い記録は「台帳なし」として別に数え、失敗 0 件とは扱わない
//   (分子と分母を同じセッションにそろえるため、分母にも入れない)。
// - 失敗と拒否の回数と、結果の記録がある呼び出しの数(率の分母)は tools.results から取る。台帳の行は 1 セッション
//   MAX_ROWS(failure-ledger.ts)件までなので、行から数えるのは要因・まとまり・その後の内訳だけにする。
// - ツールと MCP は、失敗がどの呼び出しのものか分かる。skill と指示文の版は、失敗をそれに結び付ける記録が無いので、
//   「それを使ったセッション」の単位で数える(相関まで)。skill は、最初に呼んだ後の失敗の行も数える。
// - 閾値は下の FAILURE_THRESHOLDS に定数で置く。件数で変わる判断(率を出すか)は、どの環境でも実行時にこの閾値で決める。
import type { SessionRecord, ToolFailure } from '../../core/src/types.ts';
import { THRESHOLDS as INSIGHT_THRESHOLDS } from './lib/insights.ts';

export const FAILURE_THRESHOLDS = {
  /** 率を出すのに要る、結果の記録がある呼び出しの数。これより少ないと 1 回の失敗で率が 5 ポイントを超えて動くので、率は出さず回数だけにする */
  MIN_CALLS: 20,
  /** セッションの単位で比べるもの(skill・指示文の版)に要るセッション数(改善点の分析の MIN_SESSIONS と同じ) */
  MIN_SESSIONS: INSIGHT_THRESHOLDS.MIN_SESSIONS,
  /** 「繰り返している失敗」に挙げる、同じまとまりの回数(改善点の分析の MIN_REPEAT と同じ。2 回は偶然の呼び直しでも起きる) */
  MIN_REPEAT: INSIGHT_THRESHOLDS.MIN_REPEAT,
  /** ページの 1 つの表に載せる行の数(ページを読める長さに保つ。載せなかった数は表の下に出し、全件は failures.json に書く) */
  TOP_ROWS: 50,
  /** 1 行に添える内訳(要因・まとまり・ツール)の数 */
  TOP_DETAILS: 3,
  /** まとまりに添える、例のセッションの数 */
  EXAMPLE_SESSIONS: 3,
} as const;
const T = FAILURE_THRESHOLDS;

/** 名前と回数(内訳の 1 項目) */
export interface Count {
  key: string;
  n: number;
}

/** 集計の対象と、載っていないもの */
export interface Coverage {
  /** 空でないセッション */
  sessions: number;
  /** うち失敗の台帳のあるセッション(集計の対象) */
  withLedger: number;
  /** うち台帳の無い古い記録(集計に入らない) */
  withoutLedger: number;
  /** 台帳の無い記録にある失敗と拒否の数(tools.results から。1 件ごとの中身は分からない) */
  withoutLedgerFailures: number;
  /** 対象のセッションの、結果の記録がある呼び出し */
  completed: number;
  failures: number;
  denied: number;
  /** 台帳の行の数 */
  rows: number;
  /** 行数の上限で台帳に残さなかった数 */
  dropped: number;
}

/** ツール・MCP サーバーごと */
export interface UnitStat {
  key: string;
  /** 結果の記録がある呼び出し(成功 + 失敗 + 拒否) */
  completed: number;
  failures: number;
  denied: number;
  /** (失敗 + 拒否) / completed。completed が MIN_CALLS 未満なら null */
  rate: number | null;
  /** 失敗か拒否のあったセッション */
  sessions: number;
  /** 失敗の要因(多い順。台帳の行から) */
  causes: Count[];
  /** 似たエラー文のまとまり(多い順。台帳の行から) */
  groups: Count[];
  /** 同じ引数で呼び直した回数と、そのうち成功した回数 */
  retries: number;
  retriesOk: number;
}

/** エージェントごと(本体は main: true) */
export interface AgentStat {
  name: string;
  main: boolean;
  /** サブエージェントの起動の回数(本体は null) */
  runs: number | null;
  /** 失敗か拒否のあった起動の回数(本体は null) */
  runsWithFailures: number | null;
  /** 失敗か拒否のあったセッション */
  sessions: number;
  /** 台帳の行から数えた失敗と拒否 */
  failures: number;
  denied: number;
  causes: Count[];
  groups: Count[];
  retries: number;
  retriesOk: number;
}

/** セッションの単位で数えるもの(skill・指示文の版) */
export interface SessionUnitStat {
  /** skill の名前か、指示文の版のハッシュ */
  key: string;
  /** それを使ったセッション(台帳のあるもの) */
  sessions: number;
  completed: number;
  /** 失敗 + 拒否 */
  failed: number;
  /** failed / completed。セッションが MIN_SESSIONS 未満か、completed が MIN_CALLS 未満なら null。otherRate が出せないときも null(比べるための率なので) */
  rate: number | null;
  /** それを使わなかったセッションと、その率(同じ条件で null) */
  otherSessions: number;
  otherRate: number | null;
  /** skill だけ: そのセッションで最初に呼んだ後の、台帳の行の数(時刻の無い行は数えない。呼んだ時刻がどのセッションでも分からなければ無い) */
  rowsAfter?: number;
  /** まとまり(多い順)。skill は最初に呼んだ後の行、指示文の版はそのセッションの行 */
  groups: Count[];
}

/** 似たエラー文のまとまり */
export interface GroupStat {
  group: string;
  n: number;
  sessions: number;
  /** うち拒否 */
  denied: number;
  /** 失敗の要因(多い順) */
  causes: Count[];
  tools: Count[];
  /** 最初に出た行のエラー文(記録のまま) */
  example: string;
  /** 例のセッション(出た順に EXAMPLE_SESSIONS 件まで) */
  exampleSessions: string[];
  retries: number;
  retriesOk: number;
}

/** 失敗の後に何をしたか(台帳の行の内訳) */
export interface NextStat {
  rows: number;
  /** 同じツールを同じ引数で呼び直した(と、そのうち成功) */
  retries: number;
  retriesOk: number;
  /** 別のツールか別の引数で続けた(と、そのうち次の呼び出しが成功) */
  movedOn: number;
  movedOnOk: number;
  /** 次の呼び出しより先に利用者の依頼が来た */
  user: number;
  /** 同じエージェントの呼び出しがその後に無い */
  end: number;
}

export interface FailureStats {
  coverage: Coverage;
  /** 回数が MIN_REPEAT 以上のまとまり(多い順)と、その数 */
  groups: GroupStat[];
  groupsTotal: number;
  /** 失敗か拒否のあったツール(多い順)と、その数 */
  tools: UnitStat[];
  toolsTotal: number;
  mcp: UnitStat[];
  mcpTotal: number;
  agents: AgentStat[];
  agentsTotal: number;
  /** 使ったセッションで失敗か拒否のあった skill(多い順) */
  skills: SessionUnitStat[];
  skillsTotal: number;
  instructions: SessionUnitStat[];
  instructionsTotal: number;
  next: NextStat;
}

/** 名前ごとの回数を、多い順(同じ回数は出た順)に n 件 */
class Tally {
  private m = new Map<string, number>();
  add(key: string): void {
    this.m.set(key, (this.m.get(key) ?? 0) + 1);
  }
  top(n: number): Count[] {
    return [...this.m]
      .map(([key, c]) => ({ key, n: c }))
      .sort((a, b) => b.n - a.n)
      .slice(0, n);
  }
}

/** 台帳の行から数える内訳 */
class Detail {
  causes = new Tally();
  groups = new Tally();
  retries = 0;
  retriesOk = 0;
  add(f: ToolFailure): void {
    if (f.cause) this.causes.add(f.cause);
    this.groups.add(f.group);
    if (isRetry(f)) {
      this.retries++;
      if (f.next.outcome === 'success') this.retriesOk++;
    }
  }
}

const isRetry = (f: ToolFailure): boolean => f.next.kind === 'tool' && f.next.retry === true;

function rate(failed: number, completed: number): number | null {
  return completed >= T.MIN_CALLS && completed > 0 ? failed / completed : null;
}

interface UnitAcc {
  completed: number;
  failures: number;
  denied: number;
  sessions: number;
  detail: Detail;
}
const unitAcc = (): UnitAcc => ({ completed: 0, failures: 0, denied: 0, sessions: 0, detail: new Detail() });

interface AgentAcc {
  runs: number;
  failedRuns: Set<string>;
  sessions: Set<number>;
  failures: number;
  denied: number;
  detail: Detail;
}
const agentAcc = (): AgentAcc => ({ runs: 0, failedRuns: new Set(), sessions: new Set(), failures: 0, denied: 0, detail: new Detail() });

interface SessionUnitAcc {
  sessions: number;
  completed: number;
  failed: number;
  rowsAfter: number;
  /** 最初に呼んだ時刻の分かったセッションの数(skill だけ) */
  timed: number;
  groups: Tally;
}
const sessionUnitAcc = (): SessionUnitAcc => ({ sessions: 0, completed: 0, failed: 0, rowsAfter: 0, timed: 0, groups: new Tally() });

interface GroupAcc {
  n: number;
  sessions: string[];
  denied: number;
  tools: Tally;
  example: string;
  detail: Detail;
}

function entry<K, V>(m: Map<K, V>, k: K, make: () => V): V {
  let v = m.get(k);
  if (v === undefined) {
    v = make();
    m.set(k, v);
  }
  return v;
}

const parseMs = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const v = Date.parse(s);
  return Number.isNaN(v) ? null : v;
};

/** 多い順(同じ数は名前の順)に並べ、数を返す。ここでは切らない(failures.json には全件を書き、ページが TOP_ROWS 件まで載せる) */
function topRows<R>(v: R[], weight: (r: R) => number, key: (r: R) => string): [R[], number] {
  v.sort((a, b) => weight(b) - weight(a) || key(a).localeCompare(key(b), 'ja'));
  return [v, v.length];
}

/** 失敗の台帳を、単位ごとに集計する。records は絞り込みの後のセッション(空のセッションは数えない) */
export function failureStats(records: SessionRecord[]): FailureStats {
  const cov: Coverage = { sessions: 0, withLedger: 0, withoutLedger: 0, withoutLedgerFailures: 0, completed: 0, failures: 0, denied: 0, rows: 0, dropped: 0 };
  const tools = new Map<string, UnitAcc>();
  const mcp = new Map<string, UnitAcc>();
  const agents = new Map<string | null, AgentAcc>();
  const skills = new Map<string, SessionUnitAcc>();
  const instructions = new Map<string, SessionUnitAcc>();
  const groups = new Map<string, GroupAcc>();
  const next: NextStat = { rows: 0, retries: 0, retriesOk: 0, movedOn: 0, movedOnOk: 0, user: 0, end: 0 };

  records.forEach((r, si) => {
    if (r.empty) return;
    cov.sessions++;
    const results = Object.values(r.tools.results ?? {});
    const completed = results.reduce((a, x) => a + x.success + x.failure + x.denied, 0);
    const failures = results.reduce((a, x) => a + x.failure, 0);
    const denied = results.reduce((a, x) => a + x.denied, 0);
    const ledger = r.analysis?.failures;
    if (!ledger) {
      cov.withoutLedger++;
      cov.withoutLedgerFailures += failures + denied;
      return;
    }
    cov.withLedger++;
    cov.completed += completed;
    cov.failures += failures;
    cov.denied += denied;
    cov.rows += ledger.length;
    cov.dropped += r.analysis.failuresDropped ?? 0;

    // ツール: 回数は tools.results から
    for (const [tool, x] of Object.entries(r.tools.results ?? {})) {
      const a = entry(tools, tool, unitAcc);
      a.completed += x.success + x.failure + x.denied;
      a.failures += x.failure;
      a.denied += x.denied;
      if (x.failure + x.denied > 0) a.sessions++;
    }
    // MCP サーバー: そのサーバーのツールの結果を足す(結果はツール名だけが鍵なので、2 つのサーバーに同じ名前のツールがあると両方に入る)
    for (const [server, byTool] of Object.entries(r.tools.mcp ?? {})) {
      const a = entry(mcp, server, unitAcc);
      let failed = 0;
      for (const tool of Object.keys(byTool)) {
        const x = r.tools.results?.[tool];
        if (!x) continue;
        a.completed += x.success + x.failure + x.denied;
        a.failures += x.failure;
        a.denied += x.denied;
        failed += x.failure + x.denied;
      }
      if (failed > 0) a.sessions++;
    }
    // サブエージェントの起動の回数
    for (const a of r.agents) entry(agents, a.name, agentAcc).runs++;

    // 台帳の行: 要因・まとまり・その後
    for (const f of ledger) {
      entry(tools, f.tool, unitAcc).detail.add(f);
      if (f.mcpServer) entry(mcp, f.mcpServer, unitAcc).detail.add(f);
      const a = entry(agents, f.agent, agentAcc);
      a.sessions.add(si);
      if (f.kind === 'failure') a.failures++;
      else a.denied++;
      if (f.agentCall != null) a.failedRuns.add(`${si}:${f.agentCall}`);
      a.detail.add(f);

      const g = entry(groups, f.group, (): GroupAcc => ({ n: 0, sessions: [], denied: 0, tools: new Tally(), example: '', detail: new Detail() }));
      if (g.n === 0) g.example = f.error;
      g.n++;
      // セッションの順に回しているので、同じセッションは末尾にだけある
      if (g.sessions[g.sessions.length - 1] !== r.id) g.sessions.push(r.id);
      if (f.kind === 'denied') g.denied++;
      g.tools.add(f.tool);
      g.detail.add(f);

      next.rows++;
      if (f.next.kind === 'tool') {
        const ok = f.next.outcome === 'success';
        if (f.next.retry === true) {
          next.retries++;
          if (ok) next.retriesOk++;
        } else {
          next.movedOn++;
          if (ok) next.movedOnOk++;
        }
      } else if (f.next.kind === 'user') next.user++;
      else next.end++;
    }

    // skill: 使ったセッションの単位。最初に呼んだ後の行も数える
    const firstAt = new Map<string, number | null>();
    for (const s of r.skills) {
      const at = parseMs(s.at);
      if (!firstAt.has(s.name)) firstAt.set(s.name, at);
      else {
        const cur = firstAt.get(s.name)!;
        firstAt.set(s.name, cur != null && at != null ? Math.min(cur, at) : (cur ?? at));
      }
    }
    for (const [name, at] of firstAt) {
      const a = entry(skills, name, sessionUnitAcc);
      a.sessions++;
      a.completed += completed;
      a.failed += failures + denied;
      if (at == null) continue;
      a.timed++;
      for (const f of ledger) {
        const t = parseMs(f.startedAt);
        if (t != null && t >= at) {
          a.rowsAfter++;
          a.groups.add(f.group);
        }
      }
    }
    // 指示文の版: 読み込んだセッションの単位
    const seen = new Set<string>();
    for (const i of r.instructions) {
      const h = i.contentHash;
      if (seen.has(h)) continue;
      seen.add(h);
      const a = entry(instructions, h, sessionUnitAcc);
      a.sessions++;
      a.completed += completed;
      a.failed += failures + denied;
      for (const f of ledger) a.groups.add(f.group);
    }
  });

  const sessionUnit = (key: string, a: SessionUnitAcc, withRowsAfter: boolean): SessionUnitStat => {
    const otherSessions = cov.withLedger - a.sessions;
    const enough = (sessions: number): boolean => sessions >= T.MIN_SESSIONS;
    // 比べるための 2 つの率なので、片方が出せないときは両方出さない
    const mine = enough(a.sessions) ? rate(a.failed, a.completed) : null;
    const other = enough(otherSessions) ? rate(cov.failures + cov.denied - a.failed, cov.completed - a.completed) : null;
    const both = mine != null && other != null;
    return {
      key,
      sessions: a.sessions,
      completed: a.completed,
      failed: a.failed,
      rate: both ? mine : null,
      otherSessions,
      otherRate: both ? other : null,
      // 呼んだ時刻がどのセッションでも分からなければ、0 ではなく無し
      ...(withRowsAfter && a.timed > 0 ? { rowsAfter: a.rowsAfter } : {}),
      groups: a.groups.top(T.TOP_DETAILS),
    };
  };
  const unit = (m: Map<string, UnitAcc>): [UnitStat[], number] =>
    topRows(
      [...m]
        .filter(([, a]) => a.failures + a.denied > 0)
        .map(([key, a]) => ({
          key,
          completed: a.completed,
          failures: a.failures,
          denied: a.denied,
          rate: rate(a.failures + a.denied, a.completed),
          sessions: a.sessions,
          causes: a.detail.causes.top(T.TOP_DETAILS),
          groups: a.detail.groups.top(T.TOP_DETAILS),
          retries: a.detail.retries,
          retriesOk: a.detail.retriesOk,
        })),
      (u) => u.failures + u.denied,
      (u) => u.key,
    );

  const [groupList, groupsTotal] = topRows(
    [...groups]
      .filter(([, g]) => g.n >= T.MIN_REPEAT)
      .map(([group, g]) => ({
        group,
        n: g.n,
        sessions: g.sessions.length,
        denied: g.denied,
        causes: g.detail.causes.top(T.TOP_DETAILS),
        tools: g.tools.top(T.TOP_DETAILS),
        example: g.example,
        exampleSessions: g.sessions.slice(0, T.EXAMPLE_SESSIONS),
        retries: g.detail.retries,
        retriesOk: g.detail.retriesOk,
      })),
    (g) => g.n,
    (g) => g.group,
  );
  const [toolList, toolsTotal] = unit(tools);
  const [mcpList, mcpTotal] = unit(mcp);
  const [agentList, agentsTotal] = topRows(
    [...agents]
      .filter(([, a]) => a.failures + a.denied > 0)
      .map(([name, a]): AgentStat => {
        const main = name == null;
        return {
          name: name ?? '',
          main,
          // 起動のイベントが無く、親の呼び出しだけが分かる記録では、失敗のあった起動の方が多くなる。そのときは後者に合わせる
          runs: main ? null : Math.max(a.runs, a.failedRuns.size),
          runsWithFailures: main ? null : a.failedRuns.size,
          sessions: a.sessions.size,
          failures: a.failures,
          denied: a.denied,
          causes: a.detail.causes.top(T.TOP_DETAILS),
          groups: a.detail.groups.top(T.TOP_DETAILS),
          retries: a.detail.retries,
          retriesOk: a.detail.retriesOk,
        };
      }),
    (a) => a.failures + a.denied,
    (a) => a.name,
  );
  const [skillList, skillsTotal] = topRows(
    [...skills].filter(([, a]) => a.failed > 0).map(([k, a]) => sessionUnit(k, a, true)),
    (s) => s.failed,
    (s) => s.key,
  );
  const [instructionList, instructionsTotal] = topRows(
    [...instructions].filter(([, a]) => a.failed > 0).map(([k, a]) => sessionUnit(k, a, false)),
    (s) => s.failed,
    (s) => s.key,
  );

  return {
    coverage: cov,
    groups: groupList,
    groupsTotal,
    tools: toolList,
    toolsTotal,
    mcp: mcpList,
    mcpTotal,
    agents: agentList,
    agentsTotal,
    skills: skillList,
    skillsTotal,
    instructions: instructionList,
    instructionsTotal,
    next,
  };
}
