// レポートの「AI の変更の残存」と「比べる」の集計(lib/retention.ts・lib/compare.ts)。値はすべて架空のもの
import { describe, expect, it } from 'vitest';
import { DEFAULT_LAG_DAYS as CORE_LAG_DAYS, RETENTION_STATUS_LABEL, RETENTION_STATUSES, UNATTRIBUTABLE_REASON_LABEL, UNATTRIBUTABLE_REASONS } from '../../core/src/vcs-retention.ts';
import { VCS_KINDS } from '../../core/src/vcs.ts';
import { aggregateRetention, DEFAULT_LAG_DAYS, median, phaseAt, REASON_LABEL, REASONS, retentionByPhase, retentionItem, shareOf, STATUS_LABEL, STATUSES, UNKNOWN_PHASE, VCS_LABEL, type RetentionItem } from '../src/lib/retention.ts';
import { comparePhaseRows, compareRows, compareSide, COMPARE_MIN_SESSIONS, defaultPeriods, inPeriod, type CompareSession } from '../src/lib/compare.ts';
import { PHASES } from '../../core/src/turns.ts';
import type { TurnTuple } from '../src/lib/turns.ts';

const item = (o: Partial<RetentionItem>): RetentionItem => ({ outcome: 'measured', reason: null, vcs: 'git', baseline: 'observed', on: 'local', mapped: false, hunks: [0, 0, 0, 0], lines: [0, 0, 0, 0], ...o });

describe('lib/retention', () => {
  it('状態・理由・VCS の並びと名前が core と同じ(ブラウザ側は core を読めないので写している)', () => {
    expect([...STATUSES]).toEqual([...RETENTION_STATUSES]);
    expect(STATUS_LABEL).toEqual(RETENTION_STATUS_LABEL);
    expect([...REASONS]).toEqual([...UNATTRIBUTABLE_REASONS]);
    expect(REASON_LABEL).toEqual(UNATTRIBUTABLE_REASON_LABEL);
    expect(Object.keys(VCS_LABEL).sort()).toEqual([...VCS_KINDS].sort());
    expect(DEFAULT_LAG_DAYS).toBe(CORE_LAG_DAYS);
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
      unattributable: { no_vcs: 1, read_error: 1 },
      unattributableTotal: 2,
      baseline: { observed: 2, estimated: 1 },
      byVcs: { git: 2, p4: 1 },
      sender: 1,
      mapped: 1,
      hunks: [4, 1, 3, 1],
      lines: [12, 2, 7, 4],
    });
    // 割合の分母は照合できたまとまり(照合不可を除く 8)
    expect(shareOf(a.hunks, 0)).toBe(4 / 8);
    expect(shareOf([0, 0, 0, 5], 0)).toBeNull();
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
    expect(r('retention-kept').a).toBe(5 / 6);
    expect(r('retention-missing').a).toBe(1 / 6);
    expect(r('retention-kept').b).toBeNull();
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
