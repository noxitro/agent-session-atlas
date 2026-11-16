// テストの実行ファイルが標準出力に書いた、印つきの 1 行 JSON を、ツールの結果から拾う(条件別の効果測定)。
//
// - 印: 行頭(前の空白は可)の `ATLAS_TEST_RESULT`、空白、1 行の JSON オブジェクト。
//   例 `ATLAS_TEST_RESULT {"name":"描画","passed":false,"counts":{"assertFailures":2},"at":"2026-11-16T01:02:03.456Z"}`
// - 読む項目: `passed`(真偽。必須)・`name`(文字列)・`counts`(名前 → 数。件数でも割合でもよい)・`at`(テストを実行した時刻)。
//   ほかの項目は読み飛ばすので、項目を足しても古い atlas で読める。新しい数は `counts` に足す。
// - 読む場所: `tool.execution_complete` の結果(`result.detailedContent`、無ければ `result.content`、文字列の `result`)。
//   印の行が無ければ、失敗したツールのエラーの文(`error.message`)。同じ呼び出しの中で 2 か所から重ねて数えない。
// - 行頭に印がある行だけを読む(テストのソースを読んだ結果の `print("ATLAS_TEST_RESULT …")` や、行番号・ファイル名の付いた検索の結果は拾わない)。
// - 同じ行が 2 回出たとき(後から読む非同期のシェルや、保存したログを表示したとき): `at` のある行は 1 回だけ数え、重ねた数を残す。
//   `at` の無い行は、別の実行と見分けられないので重ねても数える。
// - 推移: 実行(結果を出したツールの呼び出し)ごとに、その時点までの実働と AI 使用量の累計、まだ通っていないテストの数(failing)を持つ。
//   「全部通った」は、これまでに出たテストの名前ごとのいちばん新しい結果が、すべて合格のこと(failing が 0)。
//   一部のテストだけを走らせ直した実行でも、前に通ったテストは通ったままとみなす(走らせていないテストの結果はログから分からない)。
//   名前の無い結果は、まとめて 1 つのテストとして扱う。
// - 値は元のログに書かれたものだけで決める(LLM は使わない)。
import type { SessionTests, TestResult, TestRun } from './types.ts';

/** 行頭の印 */
export const TEST_MARKER = 'ATLAS_TEST_RESULT';
/** 1 セッションで持つ結果の上限(超えた分は数だけ残す。sessions.json を大きくしすぎないため) */
export const MAX_TEST_RESULTS = 5000;
/** テスト名の長さの上限(UTF-16 の単位) */
export const MAX_TEST_NAME = 200;
/** 件数の名前の数と長さの上限 */
const MAX_COUNT_KEYS = 50;
const MAX_COUNT_KEY = 100;

/**
 * 印のある 1 行を読んだもの。result は読めた結果、key は重ねて数えないための鍵(`at` のある行だけ。JSON の本文)。
 * invalid は、印はあるが JSON のオブジェクトでないか `passed` が真偽でない行
 */
export type MarkerLine = { kind: 'result'; result: TestResult; key: string | null } | { kind: 'invalid' };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 前後の空白を落とし、制御文字を空白にする */
function cleanText(s: string): string {
  return s.trim().replace(/\p{Cc}/gu, ' ');
}

function parseObject(o: Record<string, unknown>): TestResult | null {
  if (typeof o.passed !== 'boolean') return null;
  const rawName = typeof o.name === 'string' ? cleanText(o.name) : '';
  const name = rawName !== '' ? rawName.slice(0, MAX_TEST_NAME) : null;
  // 名前をそろえた後に重なったものは後の値で上書きする(位置は最初のまま)。__proto__ も 1 つの名前として持つ
  const counts = new Map<string, number>();
  if (isObject(o.counts)) {
    for (const [k, v] of Object.entries(o.counts)) {
      if (counts.size >= MAX_COUNT_KEYS) break;
      const key = cleanText(k);
      if (key === '' || key.length > MAX_COUNT_KEY) continue;
      if (typeof v === 'number' && Number.isFinite(v)) counts.set(key, v);
    }
  }
  const atMs = typeof o.at === 'string' ? Date.parse(o.at) : NaN;
  const at = Number.isFinite(atMs) ? new Date(atMs).toISOString() : null;
  return { name, passed: o.passed, counts: Object.fromEntries(counts), ...(at != null ? { at } : {}) };
}

/** 1 行を読む。印の行でなければ null */
export function parseTestLine(line: string): MarkerLine | null {
  const s = (line.endsWith('\r') ? line.slice(0, -1) : line).trim();
  if (!s.startsWith(TEST_MARKER)) return null;
  const rest = s.slice(TEST_MARKER.length);
  // ATLAS_TEST_RESULTS などの別の語は印にしない
  if (rest !== '' && !/^\s/.test(rest)) return null;
  const body = rest.trim();
  let parsed: TestResult | null = null;
  try {
    const v: unknown = JSON.parse(body);
    if (isObject(v)) parsed = parseObject(v);
  } catch {
    // 読めない JSON は印の行として数える(invalid)
  }
  if (!parsed) return { kind: 'invalid' };
  return { kind: 'result', result: parsed, key: parsed.at != null ? body : null };
}

/** 文の中の印の行を、出た順に */
export function scanTestLines(text: string): MarkerLine[] {
  if (!text.includes(TEST_MARKER)) return [];
  const out: MarkerLine[] = [];
  for (const l of text.split('\n')) {
    const m = parseTestLine(l);
    if (m) out.push(m);
  }
  return out;
}

/** ツールの結果から、印を探す文の候補(先のものから順に見て、印の行が見つかった最初の 1 つだけを使う) */
function candidates(result: unknown, error: unknown): string[] {
  const out: string[] = [];
  if (typeof result === 'string') out.push(result);
  else if (isObject(result)) {
    if (typeof result.detailedContent === 'string' && result.detailedContent !== '') out.push(result.detailedContent);
    if (typeof result.content === 'string') out.push(result.content);
  }
  if (typeof error === 'string') out.push(error);
  else if (isObject(error) && typeof error.message === 'string') out.push(error.message);
  return out;
}

/** 1 回のツールの完了の、どこから読んだかを除いた情報 */
export interface CompleteInfo {
  at: string | null;
  /** 依頼の番号(1 から)。最初の依頼より前と、記録する依頼の数を超えた後は null */
  turn: number | null;
  tool: string | null;
  toolCallId: string | null;
  subagent: boolean;
  /** ツールの完了の時刻(ミリ秒) */
  atMs: number | null;
  /** セッションの始まりからここまでの実働(ミリ秒) */
  activeMs: number;
}

/** セッションのテストの結果を集める */
export class TestCollector {
  private readonly runs: TestRun[] = [];
  /** runs と同じ並びの、完了の時刻(ミリ秒) */
  private readonly runMs: (number | null)[] = [];
  private invalid = 0;
  private duplicates = 0;
  private dropped = 0;
  private results = 0;
  private readonly seen = new Set<string>();

  /** tool.execution_complete の data の result と error から読む */
  addComplete(result: unknown, error: unknown, info: CompleteInfo): void {
    let lines: MarkerLine[] | undefined;
    for (const c of candidates(result, error)) {
      const l = scanTestLines(c);
      if (l.length) {
        lines = l;
        break;
      }
    }
    if (!lines) return;
    const results: TestResult[] = [];
    for (const l of lines) {
      if (l.kind === 'invalid') {
        this.invalid++;
        continue;
      }
      if (l.key != null) {
        if (this.seen.has(l.key)) {
          this.duplicates++;
          continue;
        }
        this.seen.add(l.key);
      }
      if (this.results >= MAX_TEST_RESULTS) {
        this.dropped++;
        continue;
      }
      this.results++;
      results.push(l.result);
    }
    if (!results.length) return;
    this.runMs.push(info.atMs);
    this.runs.push({
      at: info.at,
      turn: info.turn,
      tool: info.tool,
      toolCallId: info.toolCallId,
      ...(info.subagent ? { subagent: true as const } : {}),
      activeMs: info.activeMs,
      nanoAiu: null,
      failing: 0,
      results,
    });
  }

  /**
   * 印の行が 1 つも無ければ null(記録にキーを置かない)。
   * aiuUntil は、その時刻(ミリ秒)までに記録されたリクエストの nano AIU の累計(リクエストごとの記録が無ければ null)
   */
  finish(aiuUntil: (ms: number) => number | null): SessionTests | null {
    if (!this.runs.length && this.invalid === 0 && this.duplicates === 0 && this.dropped === 0) return null;
    // テストの名前 → いちばん新しい結果(名前の無い結果は 1 つのテスト)
    const latest = new Map<string, boolean>();
    let firstPass: number | null = null;
    this.runs.forEach((run, i) => {
      for (const r of run.results) latest.set(r.name ?? '', r.passed);
      run.failing = [...latest.values()].filter((p) => !p).length;
      if (run.failing === 0 && firstPass == null) firstPass = i + 1;
      const at = this.runMs[i];
      run.nanoAiu = at != null ? aiuUntil(at) : null;
    });
    return { runs: this.runs, invalid: this.invalid, duplicates: this.duplicates, dropped: this.dropped, firstPass };
  }
}
