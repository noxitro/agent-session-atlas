// 依頼単位の分析(段階 1。LLM を使わない規則)。
// - toolKind: ツール呼び出し 1 回の種類(読む・編集・検証・git・シェル・計画・Web・委任・その他)。シェルはコマンドの文字列で検証 / git / 読む に分ける
// - phaseOf: そのターンの工程(調査 / 計画 / 実装 / 検証 / 運用 / 回答のみ)。ツールの種類の回数から決める
// - requestKindOf: 依頼の種類(作業 / 質問 / 修正 / 差し戻し / 続行)。依頼文の語で粗く分ける(段階 2 で LLM が分け直す)
// - sessionTurns: セッションのターンを 1 行ずつにまとめる(CSV・集計・画面が同じものを使う)
import type { SessionRecord, ToolKind, TurnStats } from './types.ts';

export const PHASES = ['research', 'plan', 'implement', 'verify', 'ops', 'answer'] as const;
export type Phase = (typeof PHASES)[number];
export const PHASE_LABEL: Record<Phase, string> = { research: '調査', plan: '計画', implement: '実装', verify: '検証', ops: '運用', answer: '回答のみ' };

export const REQUEST_KINDS = ['task', 'question', 'fix', 'revert', 'continue'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const REQUEST_KIND_LABEL: Record<RequestKind, string> = { task: '作業', question: '質問', fix: '修正', revert: '差し戻し', continue: '続行' };

const READ_TOOLS = new Set(['view', 'rg', 'glob', 'grep', 'lsp', 'read', 'get_changes_overview', 'ide-get_diagnostics']);
const EDIT_TOOLS = new Set(['edit', 'create', 'str_replace_editor', 'apply_patch', 'write']);
const SHELL_TOOLS = new Set(['powershell', 'bash', 'shell', 'write_powershell', 'write_bash']);
/** 計画・確認(todo は session.db を sql ツールで書く) */
const PLAN_TOOLS = new Set(['ask_user', 'sql', 'update_todo', 'exit_plan_mode', 'todo_write']);
const WEB_TOOLS = new Set(['web_fetch', 'web_search', 'fetch_copilot_cli_documentation']);
const DELEGATE_TOOLS = new Set(['task', 'read_agent', 'list_agents', 'run_dynamic_workflow', 'dynamic_workflows_manage']);
/** 工程を決めるのに数えない(シェルの出力を読む・止める、セッションの名前、記憶、完了の報告) */
const NEUTRAL_TOOLS = new Set(['read_powershell', 'read_bash', 'stop_powershell', 'stop_bash', 'list_powershell', 'list_bash', 'rename_session', 'store_memory', 'vote_memory', 'task_complete', 'skill']);

/** テスト・ビルド・型検査・lint の実行 */
const VERIFY_COMMAND =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check|e2e|ui)\b|\bnpx\s+(?:vitest|jest|tsc|eslint|playwright)\b|\b(?:vitest|jest|pytest|tsc|eslint|ctest)\b|\bgo\s+(?:test|build|vet)\b|\bcargo\s+(?:test|build|check|clippy)\b|\bdotnet\s+(?:test|build)\b|\bgradlew?\b|\bmvn\b|\bmsbuild\b|\bmake\b/i;
/** 変更を残す・配る操作(git の書き込み、PR、デプロイ) */
const GIT_COMMAND = /\bgit\s+(?:commit|push|merge|rebase|tag|cherry-pick|reset|revert|checkout|switch|pull|stash|worktree)\b|\bgh\s+(?:pr|release|workflow)\b|\bdocker\s+(?:build|push|compose)\b|\bkubectl\b|\bdeploy\b/i;
/** 読むだけのシェル(git の参照、一覧・内容の表示、検索) */
const READ_COMMAND = /^\s*(?:git\s+(?:status|diff|log|show|blame|branch|remote)|gh\s+(?:run\s+(?:list|view)|pr\s+(?:view|list|checks))|ls|dir|cat|type|head|tail|Get-ChildItem|Get-Content|Select-String|rg|grep|find|tree|wc)\b/i;

/** ツール呼び出し 1 回の種類。null は工程の判定に数えないもの */
export function toolKind(name: string, args: unknown): ToolKind | null {
  if (NEUTRAL_TOOLS.has(name)) return null;
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (READ_TOOLS.has(name)) return 'read';
  if (PLAN_TOOLS.has(name)) return 'plan';
  if (WEB_TOOLS.has(name)) return 'web';
  if (DELEGATE_TOOLS.has(name)) return 'delegate';
  if (SHELL_TOOLS.has(name)) {
    const a = args as { command?: unknown; input?: unknown } | string | null | undefined;
    const cmd = typeof a === 'string' ? a : typeof a?.command === 'string' ? a.command : typeof a?.input === 'string' ? a.input : '';
    if (VERIFY_COMMAND.test(cmd)) return 'verify';
    if (GIT_COMMAND.test(cmd)) return 'git';
    if (READ_COMMAND.test(cmd)) return 'read';
    return 'shell';
  }
  // MCP の読み取り(github-mcp-server-get_file_contents / search_code など)
  if (/(?:^|[-_])(?:get|search|list|read)[-_]/.test(name)) return 'read';
  return 'other';
}

/**
 * そのターンの工程。優先順: 編集があれば実装 → テスト・ビルドの実行があれば検証 → git の書き込みなどがあれば運用 →
 * 計画・確認だけなら計画 → 作業のツールが無ければ回答のみ → それ以外(読む・調べる・その他のシェル)は調査
 */
export function phaseOf(t: Pick<TurnStats, 'kinds'>): Phase {
  const k = t.kinds;
  const n = (x: ToolKind): number => k[x] ?? 0;
  const work = n('read') + n('edit') + n('verify') + n('git') + n('shell') + n('plan') + n('web') + n('delegate') + n('other');
  if (work === 0) return 'answer';
  if (n('edit') > 0) return 'implement';
  if (n('verify') > 0) return 'verify';
  if (n('git') > 0) return 'ops';
  if (n('plan') > 0 && n('plan') === work) return 'plan';
  return 'research';
}

const REVERT = /元に戻|戻して|もどして|取り消|取消し|やめて|中止して|revert|ロールバック|なかったことに|消して元/i;
const FIX = /違う|ちがう|直して|なおして|修正して|じゃなくて|ではなく|おかしい|間違|まちが|動かない|うまくいかない|エラーが出|失敗して|崩れ|足りない|抜けて|漏れて/;
const QUESTION = /[？?]\s*$|[？?]\s*\n|教えて|とは$|とは[？?]|なぜ|どうして|どうやって|どうすれば|ですか|ますか|でしょうか|わかる$/;
const CONTINUE = /^(?:はい|うん|ok|okay|yes|お願い(?:します)?|進めて|続けて|続き|それで|いいよ|いいです|やって|して|する|始める|go|lgtm|大丈夫|了解|[a-z0-9])[。.!！]?$/i;

/** 依頼の種類(依頼文の語による粗い分類) */
export function requestKindOf(text: string): RequestKind {
  const s = text.trim();
  if (s === '') return 'task';
  if (s.length <= 12 && CONTINUE.test(s)) return 'continue';
  if (REVERT.test(s)) return 'revert';
  if (FIX.test(s)) return 'fix';
  if (QUESTION.test(s)) return 'question';
  return 'task';
}

/** 1 ターン 1 行(CSV・集計・画面で使う)。text は依頼文の先頭(伏せ字版では使わない) */
export interface TurnRow extends TurnStats {
  sessionId: string;
  /** セッションの中の通し番号(1 から) */
  index: number;
  phase: Phase;
  kind: RequestKind;
  /** 次の依頼の種類(セッションの最後のターンは null) */
  nextKind: RequestKind | null;
  ms: number | null;
  activeMs: number | null;
  text: string;
}

/** セッションのターンを 1 行ずつにする。turnStats の無い古い記録や DB だけのセッションは空 */
export function sessionTurns(r: Pick<SessionRecord, 'id' | 'analysis'>): TurnRow[] {
  const a = r.analysis;
  const stats = a?.turnStats;
  if (!stats?.length) return [];
  const kinds = stats.map((_, i) => requestKindOf(a.requests[i] ?? ''));
  return stats.map((t, i) => ({
    ...t,
    sessionId: r.id,
    index: i + 1,
    phase: phaseOf(t),
    kind: kinds[i],
    nextKind: i + 1 < kinds.length ? kinds[i + 1] : null,
    ms: a.turnMs[i] ?? null,
    activeMs: a.turnActiveMs?.[i] ?? null,
    text: a.requests[i] ?? '',
  }));
}

/** 次の依頼が直しか差し戻しか(段階 1 の「手戻りの兆し」。採用の判定は段階 2) */
export const followedByFix = (t: Pick<TurnRow, 'nextKind'>): boolean => t.nextKind === 'fix' || t.nextKind === 'revert';

/** 依頼(ターン)の集計 1 つ分(工程別・依頼の種類別に使う) */
export interface TurnBucket {
  turns: number;
  /** 実働の合計(ms。記録の無いターンは 0 として足す) */
  activeMs: number;
  tools: number;
  toolFailures: number;
  denied: number;
  aborts: number;
  errors: number;
  externalErrors: number;
  subagentFailures: number;
  compactions: number;
  edits: number;
  reEdits: number;
  askUser: number;
  input: number;
  output: number;
  nanoAiu: number;
  /** 詰まりのあったターン(失敗・拒否・中断・エラー・再編集・文脈圧縮のどれかがある) */
  stuck: number;
  /** 次の依頼が修正・差し戻しだったターン(セッションの最後のターンは数えない) */
  followedByFix: number;
  /** 次の依頼があったターン(followedByFix の分母) */
  withNext: number;
  /** 依頼の種類別のターン数 */
  kinds: Record<RequestKind, number>;
}

export interface TurnMetrics {
  turns: number;
  /** ターンの記録があるセッション */
  sessions: number;
  /** ターンの記録が無いセッション(古い sessions.json・DB だけのセッション) */
  sessionsWithoutTurns: number;
  /** 200 ターンを超えて、201 ターン目以降を分析しなかったセッション */
  truncatedSessions: number;
  byPhase: Record<Phase, TurnBucket>;
  byKind: Record<RequestKind, TurnBucket>;
}

export function emptyTurnBucket(): TurnBucket {
  return {
    turns: 0,
    activeMs: 0,
    tools: 0,
    toolFailures: 0,
    denied: 0,
    aborts: 0,
    errors: 0,
    externalErrors: 0,
    subagentFailures: 0,
    compactions: 0,
    edits: 0,
    reEdits: 0,
    askUser: 0,
    input: 0,
    output: 0,
    nanoAiu: 0,
    stuck: 0,
    followedByFix: 0,
    withNext: 0,
    kinds: Object.fromEntries(REQUEST_KINDS.map((k) => [k, 0])) as Record<RequestKind, number>,
  };
}

/** 詰まりのあったターンか */
export const isStuck = (t: Pick<TurnStats, 'toolFailures' | 'denied' | 'aborts' | 'errors' | 'reEdits' | 'compactions'>): boolean =>
  t.toolFailures + t.denied + t.aborts + t.errors + t.reEdits + t.compactions > 0;

/** 集計に使う項目(埋め込みから戻した行にも、時刻・依頼文・ツールの種類は無い) */
export type TurnFacts = Pick<
  TurnRow,
  'kind' | 'nextKind' | 'activeMs' | 'tools' | 'toolFailures' | 'denied' | 'aborts' | 'errors' | 'externalErrors' | 'subagentFailures' | 'compactions' | 'edits' | 'reEdits' | 'askUser' | 'input' | 'output' | 'nanoAiu'
>;

export function addTurn(b: TurnBucket, t: TurnFacts): void {
  b.turns++;
  b.activeMs += t.activeMs ?? 0;
  b.tools += t.tools;
  b.toolFailures += t.toolFailures;
  b.denied += t.denied;
  b.aborts += t.aborts;
  b.errors += t.errors;
  b.externalErrors += t.externalErrors;
  b.subagentFailures += t.subagentFailures;
  b.compactions += t.compactions;
  b.edits += t.edits;
  b.reEdits += t.reEdits;
  b.askUser += t.askUser;
  b.input += t.input ?? 0;
  b.output += t.output ?? 0;
  b.nanoAiu += t.nanoAiu ?? 0;
  if (isStuck(t)) b.stuck++;
  if (t.nextKind != null) {
    b.withNext++;
    if (followedByFix(t)) b.followedByFix++;
  }
  b.kinds[t.kind]++;
}

/** セッション群のターンを工程別・依頼の種類別に集計する */
export function turnMetrics(sessions: Pick<SessionRecord, 'id' | 'analysis' | 'turns'>[]): TurnMetrics {
  const byPhase = Object.fromEntries(PHASES.map((p) => [p, emptyTurnBucket()])) as Record<Phase, TurnBucket>;
  const byKind = Object.fromEntries(REQUEST_KINDS.map((k) => [k, emptyTurnBucket()])) as Record<RequestKind, TurnBucket>;
  let turns = 0;
  let withTurns = 0;
  let without = 0;
  let truncated = 0;
  for (const s of sessions) {
    const rows = sessionTurns(s);
    if (!rows.length) {
      if (s.turns > 0) without++;
      continue;
    }
    withTurns++;
    if (s.turns > rows.length) truncated++;
    for (const t of rows) {
      turns++;
      addTurn(byPhase[t.phase], t);
      addTurn(byKind[t.kind], t);
    }
  }
  return { turns, sessions: withTurns, sessionsWithoutTurns: without, truncatedSessions: truncated, byPhase, byKind };
}
