// レポートの「AI の変更の残存」と「比べる」の集計(lib/retention.ts・lib/compare.ts)。値はすべて架空のもの
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregateRetention, baselineSourceOf, DEFAULT_LAG_DAYS, enoughMeasured, median, modeDiffer, modeMix, phaseAt, REASON_LABEL, REASONS, RETENTION_MIN_SESSIONS, RETENTION_MODES, retentionByPhase, retentionItem, shareOf, singleMode, STATUS_LABEL, STATUSES, unattributableByCount, UNKNOWN_PHASE, VCS_KINDS, VCS_LABEL, vcsKindsOf, type RetentionItem } from '../src/lib/retention.ts';
import { comparePhaseRows, compareRows, compareSide, COMPARE_MIN_SESSIONS, defaultPeriods, inPeriod, type CompareSession } from '../src/lib/compare.ts';
import { PHASES } from '../src/shared/turns.ts';
import type { TurnTuple } from '../src/lib/turns.ts';

// 照合の本体は Rust(crates/atlas-core/src/vcs_retention.rs・vcs.rs)。画面の lib はその並びと名前を写しているので、Rust のソースから読んで比べる
const CORE = join(import.meta.dirname, '..', '..', '..', 'crates', 'atlas-core', 'src');
// Windows の checkout(core.autocrlf)では CRLF になるので、改行をそろえてから読む
const readRs = (name: string): string => readFileSync(join(CORE, name), 'utf8').replace(/\r\n/g, '\n');
const RETENTION_RS = readRs('vcs_retention.rs');
const VCS_RS = readRs('vcs.rs');

/** `pub const NAME: [Enum; n] = [Enum::A, …];` の並び(列挙子の名前) */
function rustList(src: string, name: string, en: string): string[] {
  const m = new RegExp(String.raw`pub const ${name}: \[${en}; \d+\] = \[([\s\S]*?)\];`).exec(src);
  if (!m) throw new Error(`${name} が読めません`);
  return [...m[1].matchAll(new RegExp(String.raw`${en}::(\w+)`, 'g'))].map((x) => x[1]);
}

/** `impl Enum { … pub fn fname(self) … { match self { Enum::A => "…", … } }` の対応(列挙子の名前 → 文字列) */
function rustArms(src: string, en: string, fname: string): Record<string, string> {
  const impl = src.indexOf(`impl ${en} {`);
  const start = src.indexOf(`pub fn ${fname}(self)`, impl);
  if (impl < 0 || start < 0) throw new Error(`${en}::${fname} が読めません`);
  const end = src.indexOf('\n    }\n', start);
  return Object.fromEntries([...src.slice(start, end).matchAll(new RegExp(String.raw`${en}::(\w+) => "([^"]*)"`, 'g'))].map((x) => [x[1], x[2]]));
}

function rustNamed(src: string, list: string, en: string): { keys: string[]; labels: Record<string, string> } {
  const variants = rustList(src, list, en);
  const str = rustArms(src, en, 'as_str');
  const label = rustArms(src, en, 'label');
  return { keys: variants.map((v) => str[v]), labels: Object.fromEntries(variants.map((v) => [str[v], label[v]])) };
}

const item = (o: Partial<RetentionItem>): RetentionItem => ({ outcome: 'measured', reason: null, vcs: 'git', baseline: 'observed', on: 'local', mapped: false, hunks: [0, 0, 0, 0], lines: [0, 0, 0, 0], ...o });

describe('lib/retention', () => {
  it('状態・理由・VCS の並びと名前が Rust の本体と同じ(ブラウザ側は写している)', () => {
    const status = rustNamed(RETENTION_RS, 'RETENTION_STATUSES', 'RetentionStatus');
    expect([...STATUSES]).toEqual(status.keys);
    expect(STATUS_LABEL).toEqual(status.labels);
    const reason = rustNamed(RETENTION_RS, 'UNATTRIBUTABLE_REASONS', 'UnattributableReason');
    expect([...REASONS]).toEqual(reason.keys);
    expect(REASON_LABEL).toEqual(reason.labels);
    const vcs = rustArms(VCS_RS, 'VcsKind', 'as_str');
    expect(Object.keys(VCS_LABEL).sort()).toEqual(rustList(VCS_RS, 'VCS_KINDS', 'VcsKind').map((v) => vcs[v]).sort());
    expect(DEFAULT_LAG_DAYS).toBe(Number(/pub const DEFAULT_LAG_DAYS: i64 = (\d+);/.exec(RETENTION_RS)?.[1]));
  });

  it('retentionItem: 埋め込みの形にする(パスは持たない)', () => {
    const r = retentionItem({
      outcome: 'unattributable',
      reason: 'repo_not_found',
      vcs: null,
      baseline: null,
      counts: { kept: 0, modified: 0, missing: 0, unattributable: 2 },
      lines: { kept: 0, modified: 0, missing: 0, unattributable: 5 },
    });
    expect(r).toEqual({ outcome: 'unattributable', reason: 'repo_not_found', vcs: null, baseline: null, on: 'local', mapped: false, hunks: [0, 0, 0, 2], lines: [0, 0, 0, 5] });
    expect(retentionItem({ outcome: 'no_ai_changes', vcs: null, baseline: null, counts: { kept: 0, modified: 0, missing: 0, unattributable: 0 }, lines: { kept: 0, modified: 0, missing: 0, unattributable: 0 }, computedOn: 'sender', pathMapped: true }).outcome).toBe('none');
  });

  it('複数の VCS にまたがるセッション: 埋め込みに種類を持ち、VCS 別は種類ごとに 1 回ずつ、基準はどれかが推定なら推定に数える', () => {
    expect([...VCS_KINDS]).toEqual(rustList(VCS_RS, 'VCS_KINDS', 'VcsKind').map((v) => rustArms(VCS_RS, 'VcsKind', 'as_str')[v]));
    const zero = { kept: 0, modified: 0, missing: 0, unattributable: 0 };
    const base = { outcome: 'measured' as const, counts: { ...zero, kept: 1 }, lines: { ...zero, kept: 1 } };
    type Kind = 'git' | 'svn' | 'p4';
    const repo = (vcs: Kind, source: 'observed' | 'estimated') => ({ vcs, root: `r-${vcs}`, baseline: { source } });
    const hunk = (vcs: Kind, status: 'kept' | 'unattributable' = 'kept') => ({ status, vcs, root: `r-${vcs}` });
    const mixedLike = { ...base, vcs: null, baseline: { source: 'estimated' as const }, repos: [repo('p4', 'observed'), repo('svn', 'estimated')], hunks: [hunk('p4'), hunk('svn')] };
    const mixed = retentionItem(mixedLike);
    expect(mixed).toMatchObject({ vcs: null, vcsKinds: ['svn', 'p4'], baseline: 'estimated' });
    // キーの順は Rust の埋め込みと同じ(vcs の後に vcsKinds)
    expect(JSON.stringify(mixed)).toContain('"vcs":null,"vcsKinds":["svn","p4"],"baseline":"estimated"');
    // 照合不可のまとまりだけのリポジトリ(svn)と、どのまとまりも指していないリポジトリは数えない
    expect(retentionItem({ ...mixedLike, hunks: [hunk('p4'), hunk('svn', 'unattributable')] })).toMatchObject({ vcsKinds: ['p4'], baseline: 'observed' });
    expect(retentionItem({ ...mixedLike, hunks: [hunk('p4')] })).toMatchObject({ vcsKinds: ['p4'], baseline: 'observed' });
    // 種類と根が同じリポジトリが重なっていても、まとまりが指すのは最初の 1 つだけ(core の repo_of_hunk と同じ)
    expect(baselineSourceOf({ ...mixedLike, repos: [repo('p4', 'observed'), repo('p4', 'estimated')], hunks: [hunk('p4')] })).toBe('observed');
    // git で照合でき、p4 のまとまりはすべて読めなかった: VCS は git だけ、基準は記録(種類はセッションの vcs と同じなので持たない)
    const gitOnly = retentionItem({ ...base, vcs: 'git', baseline: { source: 'observed' }, repos: [repo('git', 'observed'), repo('p4', 'estimated')], hunks: [hunk('git'), hunk('p4', 'unattributable')] });
    expect(gitOnly.baseline).toBe('observed');
    expect(gitOnly.vcsKinds).toBeUndefined();
    // セッションの vcs だけと同じなら種類は持たない。repos が無い古い結果は今までどおり
    const single = retentionItem({ ...base, vcs: 'git', baseline: { source: 'estimated' }, repos: [repo('git', 'observed')], hunks: [hunk('git')] });
    expect(single.vcsKinds).toBeUndefined();
    expect(single.baseline).toBe('observed');
    expect(retentionItem({ ...base, vcs: 'svn', baseline: { source: 'estimated' } })).toMatchObject({ vcs: 'svn', baseline: 'estimated' });
    expect(vcsKindsOf({ vcs: 'svn' })).toEqual(['svn']);
    expect(baselineSourceOf({ baseline: { source: 'observed' }, repos: [{ vcs: 'svn', root: 'r-svn', baseline: null }] })).toBe('observed');
    const a = aggregateRetention([{ retention: mixed }, { retention: item({}) }, { retention: item({ vcs: 'p4' }) }, { retention: gitOnly }]);
    expect(a).toMatchObject({ measured: 4, byVcs: { svn: 1, p4: 2, git: 2 }, multiVcs: 1, baseline: { observed: 3, estimated: 1 } });
  });

  it('aggregateRetention: 照合できたセッションだけを分母にし、照合の範囲(照合していない・変更なし・照合不可の理由)を数える', () => {
    const a = aggregateRetention([
      { retention: item({ hunks: [3, 1, 1, 1], lines: [10, 2, 3, 4] }) },
      { retention: item({ baseline: 'estimated', vcs: 'p4', on: 'sender', hunks: [1, 0, 0, 0], lines: [2, 0, 0, 0] }) },
      { retention: item({ mapped: true, hunks: [0, 0, 2, 0], lines: [0, 0, 4, 0] }) },
      { retention: item({ outcome: 'unattributable', reason: 'no_vcs', hunks: [0, 0, 0, 3] }) },
      { retention: item({ outcome: 'unattributable', reason: null, hunks: [0, 0, 0, 1] }) },
      { retention: item({ outcome: 'none' }) },
      {},
      { retention: null },
    ]);
    expect(a).toMatchObject({
      sessions: 8,
      notChecked: 2,
      none: 1,
      withAi: 5,
      measured: 3,
      unattributable: { no_vcs: 1, unknown: 1 },
      unattributableTotal: 2,
      baseline: { observed: 2, estimated: 1 },
      byVcs: { git: 2, p4: 1 },
      sender: 1,
      mapped: 1,
      hunks: [4, 1, 3, 1],
      lines: [12, 2, 7, 4],
    });
    // 割合の分母は照合できたまとまり(照合不可を除く 8)
    expect(shareOf(a.hunks, 0, RETENTION_MIN_SESSIONS)).toBe(4 / 8);
    expect(shareOf([0, 0, 0, 5], 0, RETENTION_MIN_SESSIONS)).toBeNull();
    // 照合できたセッションが RETENTION_MIN_SESSIONS に届かなければ割合を出さない(ここは 3 件)
    expect(shareOf(a.hunks, 0, a.measured)).toBeNull();
    expect(shareOf(a.hunks, 0, RETENTION_MIN_SESSIONS - 1)).toBeNull();
    expect(enoughMeasured(RETENTION_MIN_SESSIONS)).toBe(true);
  });
});

describe('lib/compare', () => {
  const s = (id: string, o: Partial<CompareSession> = {}): CompareSession =>
    ({
      id,
      turns: 2,
      activeMs: 60_000,
      tools: { total: 10 },
      friction: { toolFailures: 1 },
      analysis: { filesReedited: 0, extraEdits: 0, maxConsecutiveFailures: 0, turns: 2 },
      tokens: { nanoAiu: 2e9 },
      createdAt: '2026-11-01T10:00:00.000Z',
      project: 'p',
      ...o,
    }) as unknown as CompareSession;

  it('compareSide / compareRows: 割合と平均は 5 セッション以上のときだけ。差は B − A', () => {
    const A = Array.from({ length: COMPARE_MIN_SESSIONS }, (_, i) => s(`a${i}`, i === 0 ? { analysis: { filesReedited: 1, extraEdits: 0, maxConsecutiveFailures: 0, turns: 2 } } : {}));
    const B = [s('b1'), s('b2')];
    const rows = compareRows(compareSide(A), compareSide(B));
    const r = (k: string) => rows.find((x) => x.key === k)!;
    expect(r('sessions')).toMatchObject({ a: 5, b: 2 });
    expect(r('turns')).toMatchObject({ a: 2, b: null });
    expect(r('failure')).toMatchObject({ a: 0.1, b: null });
    expect(r('rework')).toMatchObject({ a: 0.2, b: null });
    expect(r('aiu')).toMatchObject({ a: 2 });
    expect(r('active')).toMatchObject({ a: 60_000 });
    // 照合できたセッションが 5 未満なら残存の割合は出さない
    expect(r('retention-kept').a).toBeNull();
    const withRet = Array.from({ length: 5 }, (_, i) => s(`r${i}`, { retention: item({ hunks: [1, 1, 2, 9], lines: [1, 1, 2, 9] }) }));
    const rr = compareRows(compareSide(withRet), compareSide([]));
    expect(rr.find((x) => x.key === 'retention-kept')!.a).toBe(10 / 20);
    expect(rr.find((x) => x.key === 'retention-missing')!.a).toBe(10 / 20);
    expect(rr.find((x) => x.key === 'retention-measured')!.a).toBe(5);
  });

  it('残存の行: 開始時の基準の記録・推定、比べた版の内訳、照合不可の理由別(上位と、その他)を側ごとに並べる。版が混ざった側の割合は出さない', () => {
    const measured = (id: string, o: Partial<RetentionItem>) => s(id, { retention: item({ hunks: [2, 0, 1, 0], lines: [2, 0, 1, 0], lag: 3, ...o }) });
    const unattr = (id: string, reason: RetentionItem['reason']) => s(id, { retention: item({ outcome: 'unattributable', reason, hunks: [0, 0, 0, 1] }) });
    // A: すべて worktree(基準は記録 4・推定 1)。B: worktree 3・fixed 2(混ざっている)
    const A = [...Array.from({ length: 4 }, (_, i) => measured(`a${i}`, { mode: 'worktree' })), measured('a4', { mode: 'worktree', baseline: 'estimated' }), unattr('ax', 'no_vcs'), unattr('ay', 'no_vcs'), unattr('az', 'read_error')];
    const B = [...Array.from({ length: 3 }, (_, i) => measured(`b${i}`, { mode: 'worktree' })), ...Array.from({ length: 2 }, (_, i) => measured(`bf${i}`, { mode: 'fixed' })), unattr('bx', 'too_recent'), unattr('by', 'outside_repo')];
    const sa = compareSide(A);
    const sb = compareSide(B);
    expect(sa.retention.modes).toEqual({ worktree: 5 });
    expect(sb.retention.modes).toEqual({ worktree: 3, fixed: 2 });
    expect(modeMix(sa.retention)).toBeNull();
    expect(modeMix(sb.retention)).toBe('worktree 3・fixed 2');
    const rows = compareRows(sa, sb);
    const r = (k: string) => rows.find((x) => x.key === k);
    // A は割合を出し、B は版が混ざっているので出さない(照合できたセッションの数は両方とも出す)
    expect(r('retention-kept')).toMatchObject({ a: 2 / 3, b: null });
    expect(r('retention-missing')).toMatchObject({ a: 1 / 3, b: null });
    expect(r('retention-lag')).toMatchObject({ a: 3, b: null });
    expect(r('retention-measured')).toMatchObject({ a: 5, b: 5 });
    expect(r('retention-kept')!.note).toContain('単位はまとまり');
    expect(r('retention-baseline-observed')).toMatchObject({ a: 4, b: 5, unit: 'count' });
    expect(r('retention-baseline-estimated')).toMatchObject({ a: 1, b: 0 });
    expect(r('retention-mode-worktree')).toMatchObject({ a: 5, b: 3 });
    expect(r('retention-mode-fixed')).toMatchObject({ a: 0, b: 2 });
    // 両側で 0 の版は行にしない
    expect(r('retention-mode-committed')).toBeUndefined();
    expect(r('retention-unattributable')).toMatchObject({ a: 3, b: 2 });
    // 両側を合わせて多い順に 3 つ(no_vcs 2、同じ 1 件は REASONS の順)と、その他
    const reasonRows = rows.filter((x) => x.key.startsWith('retention-unattributable-')).map((x) => [x.key, x.a, x.b]);
    expect(reasonRows).toEqual([
      ['retention-unattributable-no_vcs', 2, 0],
      ['retention-unattributable-outside_repo', 0, 1],
      ['retention-unattributable-read_error', 1, 0],
      ['retention-unattributable-other', 0, 1],
    ]);
    expect(r('retention-unattributable-other')!.note).toContain(REASON_LABEL.too_recent);
    expect(unattributableByCount(sa.retention)).toEqual([['no_vcs', 2], ['read_error', 1]]);
    // 工程どうしは母集団で見る(混ざっていれば両側とも出さない)。まとまりはどれも調査の依頼のもの
    const research = PHASES.indexOf('research');
    const withPhase = (xs: CompareSession[]) => xs.map((x) => (x.retention?.outcome === 'measured' ? { ...x, retention: { ...x.retention, phases: [[research, 2, 0, 1, 0]] as RetentionItem['phases'] } } : x));
    expect(comparePhaseRows(withPhase(A), 'research', 'implement').find((x) => x.key === 'retention-kept')!.a).toBe(2 / 3);
    expect(comparePhaseRows(withPhase(B), 'research', 'implement').find((x) => x.key === 'retention-kept')).toMatchObject({ a: null, b: null });
  });

  it('A と B で比べる版が違う(それぞれは 1 つ)ときは、両側の残存の割合と日数を出さない。版の記録の無い側は違うとみなさない', () => {
    const measured = (id: string, o: Partial<RetentionItem>) => s(id, { retention: item({ hunks: [2, 0, 1, 0], lines: [2, 0, 1, 0], lag: 3, ...o }) });
    const A = Array.from({ length: 5 }, (_, i) => measured(`a${i}`, { mode: 'worktree' }));
    const B = Array.from({ length: 5 }, (_, i) => measured(`b${i}`, { mode: 'fixed', lag: 7 }));
    const sa = compareSide(A);
    const sb = compareSide(B);
    expect([singleMode(sa.retention), singleMode(sb.retention)]).toEqual(['worktree', 'fixed']);
    expect(modeDiffer(sa.retention, sb.retention)).toBe('A: worktree・B: fixed');
    const rows = compareRows(sa, sb);
    const r = (k: string) => rows.find((x) => x.key === k)!;
    expect(r('retention-kept')).toMatchObject({ a: null, b: null });
    expect(r('retention-missing')).toMatchObject({ a: null, b: null });
    expect(r('retention-lag')).toMatchObject({ a: null, b: null });
    // 件数の行(照合できたセッション・比べた版の内訳)はそのまま出す
    expect(r('retention-measured')).toMatchObject({ a: 5, b: 5 });
    expect(r('retention-mode-worktree')).toMatchObject({ a: 5, b: 0 });
    expect(r('retention-mode-fixed')).toMatchObject({ a: 0, b: 5 });
    // 同じ版なら出す
    const same = compareRows(sa, compareSide(Array.from({ length: 5 }, (_, i) => measured(`c${i}`, { mode: 'worktree' }))));
    expect(same.find((x) => x.key === 'retention-kept')).toMatchObject({ a: 2 / 3, b: 2 / 3 });
    // 版の記録が無い古い結果は、違うともみなさない(混ざっているともみなさない)
    const old = compareSide(Array.from({ length: 5 }, (_, i) => measured(`o${i}`, {})));
    expect(modeDiffer(sa.retention, old.retention)).toBeNull();
    expect(compareRows(sa, old).find((x) => x.key === 'retention-kept')).toMatchObject({ a: 2 / 3, b: 2 / 3 });
    // 側の中で混ざっているときは modeMix で見る(modeDiffer は null)
    const mixed = compareSide([...A.slice(0, 3), ...B.slice(0, 2)]);
    expect(modeDiffer(mixed.retention, sb.retention)).toBeNull();
  });

  it('工程どうし: 母集団の残存の内訳(基準・比べた版・照合不可の理由)と、工程ごとの日数を並べる。母集団の版が混ざれば日数も出さない', () => {
    const research = PHASES.indexOf('research');
    const implement = PHASES.indexOf('implement');
    const measured = (id: string, phase: number, o: Partial<RetentionItem>) => s(id, { retention: item({ hunks: [2, 0, 1, 0], lines: [2, 0, 1, 0], phases: [[phase, 2, 0, 1, 0]], ...o }) });
    const unattr = (id: string, reason: RetentionItem['reason']) => s(id, { retention: item({ outcome: 'unattributable', reason, hunks: [0, 0, 0, 1] }) });
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => measured(`r${i}`, research, { mode: 'fixed', lag: 7, baseline: i === 0 ? 'estimated' : 'observed' })),
      ...Array.from({ length: 5 }, (_, i) => measured(`i${i}`, implement, { mode: 'fixed', lag: 2 })),
      unattr('u1', 'no_vcs'),
      unattr('u2', 'too_recent'),
    ];
    const rows = comparePhaseRows(pool, 'research', 'implement');
    const r = (k: string) => rows.find((x) => x.key === k)!;
    expect(r('retention-lag')).toMatchObject({ a: 7, b: 2, unit: 'days' });
    // 内訳は母集団の数を A と B に同じ数で並べ、見出しに「母集団」と書く
    expect(r('retention-baseline-observed')).toMatchObject({ a: 9, b: 9, label: '開始時の基準: 記録(母集団)' });
    expect(r('retention-baseline-estimated')).toMatchObject({ a: 1, b: 1 });
    expect(r('retention-mode-fixed')).toMatchObject({ a: 10, b: 10 });
    expect(r('retention-unattributable')).toMatchObject({ a: 2, b: 2 });
    expect(r('retention-unattributable-no_vcs')).toMatchObject({ a: 1, b: 1 });
    expect(r('retention-unattributable-too_recent')).toMatchObject({ a: 1, b: 1 });
    expect(r('retention-mode-fixed').note).toContain('A と B に同じ数');
    // 母集団の版が混ざれば、割合も日数も出さない
    const mixed = comparePhaseRows([...pool.slice(0, 9), measured('w', implement, { mode: 'worktree', lag: 2 })], 'research', 'implement');
    const m = (k: string) => mixed.find((x) => x.key === k)!;
    expect(m('retention-lag')).toMatchObject({ a: null, b: null });
    expect(m('retention-kept')).toMatchObject({ a: null, b: null });
    expect(m('retention-mode-worktree')).toMatchObject({ a: 1, b: 1 });
    // その工程にまとまりのあるセッションが 5 件未満なら日数は出さない
    expect(comparePhaseRows(pool.slice(0, 4), 'research', 'implement').find((x) => x.key === 'retention-lag')).toMatchObject({ a: null, b: null });
  });

  it('retentionItem は比べた版の決め方(evaluated.mode)を持ち、無ければ書かない。並びは Rust の EVAL_MODES と同じ', () => {
    const like = { outcome: 'measured' as const, vcs: 'git' as const, baseline: { source: 'observed' as const }, counts: { kept: 1, modified: 0, missing: 0, unattributable: 0 }, lines: { kept: 1, modified: 0, missing: 0, unattributable: 0 } };
    expect(retentionItem({ ...like, evaluated: { at: '2026-11-02T00:00:00.000Z', mode: 'fixed' } }).mode).toBe('fixed');
    expect('mode' in retentionItem(like)).toBe(false);
    const str = rustArms(VCS_RS, 'EvalMode', 'as_str');
    expect(rustList(VCS_RS, 'EVAL_MODES', 'EvalMode').map((v) => str[v])).toEqual([...RETENTION_MODES]);
    // 照合不可・変更なしのセッションの版は数えない
    const a = aggregateRetention([{ retention: item({ mode: 'committed' }) }, { retention: item({ outcome: 'unattributable', mode: 'fixed' }) }, { retention: item({ outcome: 'none', mode: 'fixed' }) }]);
    expect(a.modes).toEqual({ committed: 1 });
  });

  it('平均は、実際に割る数(記録のあったセッション)が 5 未満なら出さない', () => {
    const many = Array.from({ length: 6 }, (_, i) => s(`m${i}`, i === 0 ? {} : { tokens: { nanoAiu: null }, activeMs: null } as Partial<CompareSession>));
    const rows = compareRows(compareSide(many), compareSide(many));
    expect(rows.find((x) => x.key === 'aiu')!.a).toBeNull();
    expect(rows.find((x) => x.key === 'active')!.a).toBeNull();
    expect(rows.find((x) => x.key === 'turns')!.a).toBe(2);
  });

  // 日付はローカルの日付(上の絞り込み・日付の入力欄と同じ)。時刻はローカルで作り、どの時間帯で走らせても同じ結果にする
  const local = (y: number, mo: number, d: number, h: number) => new Date(y, mo - 1, d, h).toISOString();
  it('inPeriod と defaultPeriods: ローカルの日付で両端を含む。既定は最後の日までの 30 日と、その前の 30 日', () => {
    expect(inPeriod({ createdAt: local(2026, 11, 1, 23), updatedAt: null }, '2026-11-01', '2026-11-01')).toBe(true);
    expect(inPeriod({ createdAt: local(2026, 11, 1, 0), updatedAt: null }, '2026-11-01', '2026-11-01')).toBe(true);
    expect(inPeriod({ createdAt: local(2026, 10, 31, 23), updatedAt: null }, '2026-11-01', '')).toBe(false);
    expect(inPeriod({ createdAt: local(2026, 11, 2, 0), updatedAt: null }, '', '2026-11-01')).toBe(false);
    // 作成日時が無ければ、上の絞り込みと同じく更新日時で決める
    expect(inPeriod({ createdAt: null, updatedAt: local(2026, 11, 1, 9) }, '2026-11-01', '2026-11-01')).toBe(true);
    expect(inPeriod({ createdAt: null, updatedAt: null }, '', '')).toBe(false);
    expect(defaultPeriods(local(2026, 11, 30, 23))).toEqual({ a: { from: '2026-10-02', to: '2026-10-31' }, b: { from: '2026-11-01', to: '2026-11-30' } });
    expect(defaultPeriods(local(2026, 11, 30, 0))).toEqual({ a: { from: '2026-10-02', to: '2026-10-31' }, b: { from: '2026-11-01', to: '2026-11-30' } });
  });
});

describe('工程ごと(まとまりを作った依頼の工程)', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 10, m)).toISOString();
  const research = PHASES.indexOf('research');
  const implement = PHASES.indexOf('implement');
  const turns = [
    { startedAt: at(0), phase: research },
    { startedAt: at(10), phase: implement },
  ];

  it('phaseAt: 開始が時刻以前の最後の依頼の工程。最初の依頼より前・時刻なしは不明', () => {
    expect(phaseAt(at(5), turns)).toBe(research);
    expect(phaseAt(at(10), turns)).toBe(implement);
    expect(phaseAt(at(30), turns)).toBe(implement);
    expect(phaseAt(new Date(Date.UTC(2026, 10, 1, 9)).toISOString(), turns)).toBe(UNKNOWN_PHASE);
    expect(phaseAt(undefined, turns)).toBe(UNKNOWN_PHASE);
  });

  it('phaseAt: 開始時刻の無い依頼をはさむと決めない。打ち切りの印(不明の依頼)より後は不明', () => {
    const withGap = [...turns, { startedAt: null, phase: research }, { startedAt: at(40), phase: research }];
    expect(phaseAt(at(30), withGap)).toBe(UNKNOWN_PHASE);
    expect(phaseAt(at(45), withGap)).toBe(research);
    expect(phaseAt(at(5), withGap)).toBe(research);
    const truncated = [...turns, { startedAt: at(20), phase: UNKNOWN_PHASE }];
    expect(phaseAt(at(15), truncated)).toBe(implement);
    expect(phaseAt(at(25), truncated)).toBe(UNKNOWN_PHASE);
  });

  it('retentionItem が工程ごとのまとまりを数え、retentionByPhase が照合できたセッションだけを足す', () => {
    const counts = { kept: 2, modified: 0, missing: 1, unattributable: 0 };
    const base = { outcome: 'measured' as const, vcs: 'git' as const, baseline: { source: 'observed' as const }, counts, lines: counts };
    const r = retentionItem({ ...base, hunks: [{ status: 'kept', at: at(1) }, { status: 'kept', at: at(12) }, { status: 'missing', at: at(13) }] }, turns);
    expect(r.phases).toEqual([
      [research, 1, 0, 0, 0],
      [implement, 1, 0, 1, 0],
    ]);
    // 依頼の記録が無ければ工程は持たない
    expect(retentionItem({ ...base, hunks: [{ status: 'kept', at: at(1) }] }).phases).toBeUndefined();
    const agg = retentionByPhase([{ retention: r }, { retention: r }, { retention: { ...r, outcome: 'unattributable' } }, { retention: { ...r, phases: undefined } }]);
    expect(agg.byPhase.get(implement)).toEqual([2, 0, 2, 0]);
    expect(agg.withoutPhases).toBe(1);
    // その工程に照合できたまとまりがあるセッションの数(照合不可のまとまりだけの工程は数えない)
    expect([agg.sessions.get(research), agg.sessions.get(implement)]).toEqual([2, 2]);
    const onlyUnattributable = { ...r, phases: [[implement, 0, 0, 0, 3]] as RetentionItem['phases'] };
    const mixed = retentionByPhase([{ retention: r }, { retention: onlyUnattributable }]);
    expect(mixed.byPhase.get(implement)).toEqual([1, 0, 1, 3]);
    expect(mixed.sessions.get(implement)).toBe(1);
  });

  it('comparePhaseRows: 工程どうしを依頼の単位で並べる(5 件未満の割合は —)', () => {
    // TurnTuple: [工程, 種類, 次の種類, 実働, ツール, 失敗, 拒否, 中断, エラー, 利用上限, 圧縮, 再編集, nanoAIU, サブエージェント失敗, 編集]
    const t = (phase: number, failures: number): TurnTuple => [phase, 0, 0, 60_000, 10, failures, 0, 0, 0, 0, 0, 0, 1e9, 0, 1];
    const sess = (rows: TurnTuple[], ret?: RetentionItem) => ({ id: 'x', turns: rows.length, turnRows: rows, retention: ret }) as unknown as CompareSession;
    const impl = Array.from({ length: 5 }, () => t(implement, 1));
    const ret = { outcome: 'measured', reason: null, vcs: 'git', baseline: 'observed', on: 'local', mapped: false, hunks: [0, 0, 0, 0], lines: [0, 0, 0, 0], phases: [[implement, 4, 1, 1, 0]] } as unknown as RetentionItem;
    const rows = comparePhaseRows([sess(impl, ret), sess([t(research, 0)])], 'implement', 'research');
    const r = (k: string) => rows.find((x) => x.key === k)!;
    expect(r('turns')).toMatchObject({ a: 5, b: 1 });
    expect(r('failure')).toMatchObject({ a: 0.1, b: null });
    expect(r('stuck')).toMatchObject({ a: 1, b: null });
    expect(r('retention-hunks')).toMatchObject({ a: 6, b: 0 });
    // まとまりが 5 つ以上あっても、照合できたセッションが 1 件なら残存の割合は出さない
    expect(r('retention-measured')).toMatchObject({ a: 1, b: 0 });
    expect(r('retention-kept').a).toBeNull();
    expect(r('retention-missing').a).toBeNull();
    // その工程にまとまりのあるセッションが 5 件あれば出す
    const five = comparePhaseRows([...Array.from({ length: RETENTION_MIN_SESSIONS }, () => sess(impl, ret)), sess([t(research, 0)])], 'implement', 'research');
    const f = (k: string) => five.find((x) => x.key === k)!;
    expect(f('retention-measured')).toMatchObject({ a: 5, b: 0 });
    expect(f('retention-hunks').a).toBe(30);
    expect(f('retention-kept').a).toBe(25 / 30);
    expect(f('retention-missing').a).toBe(5 / 30);
    expect(f('retention-kept').b).toBeNull();
  });
});

describe('照合までの日数と、取り出せなかった編集', () => {
  it('retentionItem が日数を求め、aggregateRetention が照合できたものの日数と、取り出せなかった編集を数える', () => {
    const counts = { kept: 1, modified: 0, missing: 0, unattributable: 0 };
    const base = { outcome: 'measured' as const, vcs: 'git' as const, baseline: { source: 'observed' as const }, counts, lines: counts };
    const r = retentionItem({ ...base, sessionEnd: '2026-11-01T00:00:00Z', evaluated: { at: '2026-11-04T12:00:00Z' }, unreadEdits: 2 });
    expect(r).toMatchObject({ lag: 3.5, unread: 2 });
    expect(retentionItem({ ...base, sessionEnd: null, evaluated: { at: '2026-11-04T12:00:00Z' } }).lag).toBeUndefined();
    const a = aggregateRetention([{ retention: r }, { retention: { ...r, lag: 1.5, unread: undefined } }, { retention: { ...r, outcome: 'unattributable', lag: 9 } }]);
    expect(a.lags).toEqual([3.5, 1.5]);
    expect(a).toMatchObject({ unread: 4, unreadSessions: 2 });
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
