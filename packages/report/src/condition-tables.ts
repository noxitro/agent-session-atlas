// 表(out/tables/ の conditions.csv・test-runs.csv・test-results.csv・test-counts.csv と、sessions.csv の列)。
// 課題 × 条件の行は、画面の「課題 × 条件」の節と同じ計算(lib/conditions.ts の conditionTable)で作る。
// 大文字小文字・全角半角だけが違う名前の知らせ(lookalikes)は画面だけのものなので、表には出さない。
import type { Cell, SessionRecord, Table } from '../../core/src/index.ts';
import { conditionTable, type ConditionCell, type ConditionGroup, type ConditionSession, type ConditionTable, type UntilPass } from './lib/conditions.ts';
import { testsSummary } from './lib/summarize.ts';
import type { SessionSummary } from './lib/types.ts';

/** 表に使うセッションの値(画面の ConditionSession のうち、計算に使うもの) */
export function conditionSessionOf(r: SessionRecord): ConditionSession {
  const tests = r.tests ? testsSummary(r.tests) : null;
  return {
    id: r.id,
    activeMs: r.activeMs,
    // 計算に使う項目だけを持つ(ほかの項目は読まない)
    tools: { total: r.tools.total } as SessionSummary['tools'],
    friction: { toolFailures: r.friction.toolFailures } as SessionSummary['friction'],
    tokens: { nanoAiu: r.tokens.nanoAiu } as SessionSummary['tokens'],
    ...(tests ? { tests } : {}),
    person: r.person || null,
  };
}

/** タスクタグ 1 つ。raw は名前の決まりを読む名前(送り先から集計したときは元のタグ、手元のタスクタグは名前) */
export interface CondGroup {
  raw: string;
  ids: readonly string[];
}

/** 課題 × 条件の表(空のセッションは呼ぶ側で除く) */
export function conditionTableOf(sessions: readonly SessionRecord[], groups: readonly CondGroup[]): ConditionTable {
  const g: ConditionGroup[] = groups.map((x) => ({ name: x.raw, presentIds: x.ids }));
  return conditionTable(sessions.map(conditionSessionOf), g);
}

/** 秒(整数に丸める。turns.csv の「実働(秒)」と同じ) */
const sec = (ms: number | null | undefined): Cell => (ms == null ? null : Math.round(ms / 1000));
/** nano AIU → AIU(小数 3 桁。sessions.csv の AIU と同じ) */
const aiuCell = (nano: number | null | undefined): Cell => (nano == null ? null : Math.round((nano / 1e9) * 1000) / 1000);
/** AIU の値(小数 3 桁) */
const aiu3 = (v: number): Cell => Math.round(v * 1000) / 1000;
/** 割合(小数 4 桁) */
const ratio = (v: number | null): Cell => (v == null ? null : Math.round(v * 10000) / 10000);
/**
 * 最初に全部通るまでの中央値のセル(数だけ。件数が足りないときと、通ったセッションが半分以下(未達)のときは空。
 * SQLite で文字と数が混ざって、平均や比較で文字が 0 などに読まれないようにする)
 */
const until = (u: UntilPass, f: (v: number) => Cell): Cell => (typeof u.value === 'number' ? f(u.value) : null);
/** 中央値が未達か(1 / 0。件数が足りなければ空) */
const untilUnreached = (u: UntilPass): Cell => (u.value == null ? null : u.value === 'unreached');

/** conditions.csv の見出し */
export const CONDITIONS_HEADER = [
  '行',
  '課題',
  '条件',
  '課題の数',
  '件数',
  'テストの記録なし',
  'テストの記録あり',
  '最後に全部通った',
  '通った後に不合格',
  '未達',
  '最後に全部通った割合',
  '通るまでの実行(中央値)',
  '通るまでの実行が未達',
  '通るまでの実行の母数',
  '通るまでの実働(秒、中央値)',
  '通るまでの実働が未達',
  '通るまでの実働の母数',
  '通るまでの AIU(中央値)',
  '通るまでの AIU が未達',
  '通るまでの AIU の母数',
  '実働(秒、中央値)',
  '実働の母数',
  'AIU(中央値)',
  'AIU の母数',
  'ツール呼び出し',
  'ツールの失敗・拒否',
  'ツールの失敗・拒否の割合',
];

function conditionRow(kind: string, c: ConditionCell): Cell[] {
  return [
    kind,
    c.task ?? '',
    c.condition,
    c.tasks,
    c.sessions,
    c.sessions - c.withTests,
    c.withTests,
    c.passed,
    c.regressed,
    c.unreached,
    ratio(c.passRate),
    until(c.runsToPass, (v) => v),
    untilUnreached(c.runsToPass),
    c.runsToPass.n,
    until(c.activeToPass, (v) => sec(v)),
    untilUnreached(c.activeToPass),
    c.activeToPass.n,
    until(c.aiuToPass, aiu3),
    untilUnreached(c.aiuToPass),
    c.aiuToPass.n,
    sec(c.active.value),
    c.active.n,
    c.aiu.value == null ? null : aiu3(c.aiu.value),
    c.aiu.n,
    c.tools,
    c.toolFailures,
    ratio(c.failureRate),
  ];
}

/**
 * 課題 × 条件の表(conditions.csv)。課題ごとの行(課題の名前の順、どの課題にも全部の条件)のあとに、条件ごとの(課題をまとめた)行。
 * 割合と中央値は、件数が足りなければ空(画面の「—」)。最初に全部通るまでの中央値が未達なら、中央値は空で「…が未達」が 1。
 * 母数の列で、何件から取ったかが分かる
 */
export function conditionsCsvTable(t: ConditionTable): Table {
  const rows = t.rows.flat().map((c) => conditionRow('課題ごと', c));
  for (const c of t.pooled) rows.push(conditionRow('条件ごと', c));
  return { header: [...CONDITIONS_HEADER], rows };
}

/** セッション id → [課題, 条件](表の行に入ったものだけ) */
export function conditionAssignments(t: ConditionTable): Map<string, [string, string]> {
  return new Map(t.members.map((m) => [m.session.id, [m.task, m.condition]]));
}

/** sessions.csv に足す列の見出し(最初の依頼の列の前に入れる) */
export const SESSION_CONDITION_COLUMNS = ['課題', '条件', 'テストの実行', '最初に全部通った実行', '最後に通っていないテスト', '通るまでの実働(秒)', '通るまでの AIU', '読めなかったテストの印の行', '上限で持たなかったテストの結果'];

/**
 * sessions.csv に足す列の値(課題・条件は表の行に入ったセッションだけ。テストの列は、テストの実行があるセッションだけ。
 * 読めなかった印の行と、1 セッションの上限で持たなかった結果は、印の行があったセッションだけ(test-*.csv に入っていないものがあると分かるように))
 */
export function sessionConditionCells(r: SessionRecord, assign: ReadonlyMap<string, [string, string]>): Cell[] {
  const [task, condition] = assign.get(r.id) ?? ['', ''];
  const t = r.tests ? testsSummary(r.tests) : null;
  return [
    task,
    condition,
    t ? t.runs : null,
    t ? t.firstPass : null,
    t ? t.lastFailing : null,
    sec(t?.passActiveMs),
    aiuCell(t?.passNanoAiu),
    r.tests ? r.tests.invalid : null,
    r.tests ? r.tests.dropped : null,
  ];
}

/** テストの実行・結果・件数の表(test-runs.csv・test-results.csv・test-counts.csv) */
export interface TestTables {
  runs: Table;
  results: Table;
  counts: Table;
}

/** テストの実行が 1 回もなければ null(見出しだけの表を書かない) */
export function testTables(sessions: readonly SessionRecord[], assign: ReadonlyMap<string, [string, string]>): TestTables | null {
  const runs: Table = { header: ['セッションID', 'セッション名', '課題', '条件', '実行', '完了', '依頼番号', 'ツール', 'サブエージェント', '結果', '合格', '通っていないテスト', '実働(秒)', 'AIU'], rows: [] };
  const results: Table = { header: ['セッションID', '実行', '結果', 'テスト名', '合否', '時刻'], rows: [] };
  const counts: Table = { header: ['セッションID', '実行', '結果', 'テスト名', '名前', '値'], rows: [] };
  for (const r of sessions) {
    const t = r.tests;
    if (!t) continue;
    const [task, condition] = assign.get(r.id) ?? ['', ''];
    t.runs.forEach((run, i) => {
      const n = i + 1;
      runs.rows.push([
        r.id,
        r.name ?? '',
        task,
        condition,
        n,
        run.at,
        run.turn,
        run.tool ?? '',
        !!run.subagent,
        run.results.length,
        run.results.filter((x) => x.passed).length,
        run.failing,
        sec(run.activeMs),
        aiuCell(run.nanoAiu),
      ]);
      run.results.forEach((x, j) => {
        const name = x.name ?? '';
        results.rows.push([r.id, n, j + 1, name, x.passed, x.at ?? null]);
        for (const [k, v] of Object.entries(x.counts)) counts.rows.push([r.id, n, j + 1, name, k, v]);
      });
    });
  }
  return runs.rows.length ? { runs, results, counts } : null;
}
