import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../../core/src/metrics.ts';
import { normalizeSession } from '../../core/src/normalize.ts';
import type { SessionRecord } from '../../core/src/types.ts';
import { aggregate, coverageBreakdown, monthRange } from '../src/lib/aggregate.ts';
import { createAnonymizer, identityAnonymizer, shortProjectLabel } from '../src/lib/anonymize.ts';
import { embedData, extractEmbedded, serializeForScript } from '../src/lib/embed.ts';
import { applyFilter, sessionUpdated, currentGroupName, decodeFilter, effectiveIds, emptyFilter, encodeFilter, filterOptions, groupIds, hasPeople, isEmptyFilter, joinIds, knownSelection, NO_JUDGMENT, NO_SESSION, sameIds, splitIds, UNKNOWN } from '../src/lib/filter.ts';
import { addIds, memberGroups, parseGroups, removeIds, resolveIdPrefixes, serializeGroups } from '../src/lib/groups.ts';
import { parseJudgments } from '../src/lib/judgments.ts';
import { niceTicks } from '../src/lib/scale.ts';
import { modelLabel, sharedLeads, splitLead } from '../src/lib/format.ts';
import { summarize } from '../src/lib/summarize.ts';
import type { JudgmentSummary, SessionSummary } from '../src/lib/types.ts';

function judgment(p: Partial<JudgmentSummary>): JudgmentSummary {
  return {
    taskCategory: null,
    hours: null,
    low: null,
    high: null,
    confidence: null,
    taskSummary: null,
    completed: null,
    quality: null,
    rework: null,
    effects: { instructions: null, wiki: null, skillsAgents: null },
    rationale: '根拠',
    backend: 'external',
    ...p,
  };
}
import { esc, renderDetailHtml } from '../src/detail.ts';
import { GLOSSARY, GLOSSARY_GROUPS, termsByGroup } from '../src/lib/glossary.ts';
import { renderGlossaryHtml } from '../src/glossary-page.ts';

/** usage_record 付き(入力トークンあり) */
async function withInput(id: string, ws: Record<string, unknown>, model: string, input: number, output: number): Promise<SessionRecord> {
  return normalizeSession({
    id,
    workspace: ws,
    events: [
      { type: 'user.message', data: { content: `依頼 ${id} C:\\work\\secret-proj\\src を直して` }, timestamp: String(ws.created_at) },
      { type: 'tool.execution_start', data: { toolName: 'view' }, timestamp: String(ws.created_at) },
      { type: 'session.usage_record', data: { usage: { model, inputTokens: input, outputTokens: output, cost: 1, initiator: 'user' } }, timestamp: String(ws.created_at) },
    ],
  });
}

/** 出力トークンだけ(旧形式) */
async function outputOnly(id: string, ws: Record<string, unknown>, model: string, output: number): Promise<SessionRecord> {
  return normalizeSession({
    id,
    workspace: ws,
    events: [{ type: 'assistant.message', data: { model, outputTokens: output }, timestamp: String(ws.created_at) }],
  });
}

async function fixture(): Promise<SessionRecord[]> {
  return [
    await withInput('a', { client_name: 'github/cli', repository: 'quokka/secret-proj', cwd: 'C:\\work\\secret-proj', branch: 'feature/x1', created_at: '2026-07-10T03:00:00Z', name: 'secret-proj の修正' }, 'gpt-5.5', 100, 10),
    await withInput('b', { client_name: 'github/autopilot', cwd: '/home/me/.copilot/chats/c1', created_at: '2026-09-02T03:00:00Z' }, 'claude-sonnet-5', 50, 5),
    await outputOnly('c', { client_name: 'github/cli', repository: 'quokka/secret-proj', cwd: 'C:\\work\\secret-proj', branch: 'main', created_at: '2026-09-20T03:00:00Z' }, 'gpt-5.5', 7),
    // トークン記録なし(欠測)。Phase 5 で依頼 0・ツール 0・応答 0 は「空」として既定の集計から外すため、依頼を 1 件持たせて空でなくする
    await normalizeSession({
      id: 'd',
      workspace: { cwd: 'D:\\other', created_at: '2026-10-01T00:00:00Z' },
      events: [{ type: 'user.message', data: { content: 'x' }, timestamp: '2026-10-01T00:00:00Z' }],
    }),
  ];
}

const summaries = (rs: SessionRecord[]): SessionSummary[] => rs.map((r) => summarize(r, identityAnonymizer(), null));

/** 送り先(<人>/<プロジェクト>)をまとめて集計したときの形: a・c は person-a、b は person-b、d は人のフォルダの下に無い */
const PEOPLE: Record<string, string | null> = { a: 'person-a', b: 'person-b', c: 'person-a', d: null };
const withPeople = (rs: SessionRecord[]): SessionRecord[] => rs.map((r) => ({ ...r, person: PEOPLE[r.id] }));

describe('aggregate', () => {
  it('最終更新は、セッションの更新日時のいちばん後(更新日時の無いものは開始日時)。開始日時のいちばん後(lastAt)とは別に持つ', async () => {
    const base = summaries(await fixture())[0]!;
    const s = (id: string, project: string, createdAt: string | null, updatedAt: string | null): SessionSummary => ({ ...base, id, project, projectLabel: project, createdAt, updatedAt });
    const a = aggregate([
      s('a1', 'app', '2026-11-01T00:00:00.000Z', '2026-11-12T09:00:00.000Z'),
      s('a2', 'app', '2026-11-10T00:00:00.000Z', '2026-11-10T01:00:00.000Z'),
      // 更新日時の無いものは開始日時で数える
      s('b1', 'tool', '2026-11-05T00:00:00.000Z', null),
      // 日時の書き方が違っても(タイムゾーン付き)時刻で比べる
      s('c1', 'web', '2026-11-01T00:00:00.000Z', '2026-11-13T08:00:00+09:00'),
      s('c2', 'web', '2026-11-01T00:00:00.000Z', '2026-11-12T23:30:00.000Z'),
    ]);
    const by = Object.fromEntries(a.byProject.map((b) => [b.key, [b.updatedAt, b.lastAt]]));
    expect(by.app).toEqual(['2026-11-12T09:00:00.000Z', '2026-11-10T00:00:00.000Z']);
    expect(by.tool).toEqual(['2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z']);
    expect(by.web).toEqual(['2026-11-12T23:30:00.000Z', '2026-11-01T00:00:00.000Z']);
    expect(a.overall.updatedAt).toBe('2026-11-12T23:30:00.000Z');
    expect(sessionUpdated({ createdAt: '2026-11-01T00:00:00.000Z', updatedAt: null })).toBe(Date.parse('2026-11-01T00:00:00.000Z'));
    expect(sessionUpdated({ createdAt: null, updatedAt: null })).toBeNull();
  });

  it('全体・プロジェクト・月・モデルが core の computeMetrics と一致する', async () => {
    const rs = await fixture();
    const m = computeMetrics(rs);
    const a = aggregate(summaries(rs));
    expect(a.overall.sessions).toBe(m.overall.sessions);
    expect(a.overall.sessionsWithInput).toBe(m.overall.sessionsWithInputTokens);
    expect(a.overall.tokens).toEqual(m.overall.tokens);
    expect(a.overall.tools).toBe(m.overall.tools.total);
    expect(a.overall.turns).toBe(m.overall.turns);
    expect(Object.fromEntries(a.byProject.map((b) => [b.key, b.tokens.output]))).toEqual(Object.fromEntries(Object.entries(m.byProject).map(([k, b]) => [k, b.tokens.output])));
    // 記録の無い月(2026-08)も 0 として並ぶ
    expect(a.byMonth.map((b) => [b.key, b.sessions])).toEqual([
      ['2026-07', 1],
      ['2026-08', 0],
      ['2026-09', 2],
      ['2026-10', 1],
    ]);
    for (const b of a.byMonth) if (b.sessions) expect(b.sessions).toBe(m.byMonth[b.key].sessions);
    expect(Object.fromEntries(a.byModel.map((r) => [r.model, [r.sessions, r.input, r.output]]))).toEqual(
      Object.fromEntries(Object.entries(m.byModel).map(([k, r]) => [k, [r.sessions, r.input, r.output]])),
    );
  });

  it('人別: 人のフォルダの名前ごとにまとめ、人のフォルダの下に無いものは「不明」。人が 1 件も無ければ空', async () => {
    const rs = await fixture();
    expect(aggregate(summaries(rs)).byPerson).toEqual([]);
    const a = aggregate(summaries(withPeople(rs)));
    // 出力トークンの多い順(person-a: 10 + 7、person-b: 5、不明: 記録なし)
    expect(a.byPerson.map((b) => [b.key, b.label, b.sessions, b.tokens.output])).toEqual([
      ['person-a', 'person-a', 2, 17],
      ['person-b', 'person-b', 1, 5],
      [UNKNOWN, '不明', 1, 0],
    ]);
    // 人ごとの合計は全体と同じ(どのセッションも 1 行にだけ入る)
    expect(a.byPerson.reduce((n, b) => n + b.sessions, 0)).toBe(a.overall.sessions);
    // 「不明」だけに絞ると、渡したセッションには人が残らない。レポート全体に人の軸があると伝えれば、不明の行を出す
    const unknownOnly = applyFilter(summaries(withPeople(rs)), { ...emptyFilter(), person: UNKNOWN });
    expect(aggregate(unknownOnly).byPerson).toEqual([]);
    expect(aggregate(unknownOnly, true).byPerson.map((b) => [b.key, b.label, b.sessions])).toEqual([[UNKNOWN, '不明', 1]]);
    expect(aggregate(summaries(withPeople(rs)), false).byPerson).toEqual([]);
  });

  it('入力トークン記録の内訳を欠測込みで数える', async () => {
    const c = coverageBreakdown(summaries(await fixture()));
    expect(c).toEqual({ detailed: 2, shutdown: 0, outputOnly: 1, none: 1, empty: 0 });
  });

  it('monthRange は年をまたいで欠けなく並べる', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('filter', () => {
  it('プロジェクト・クライアント・モデル・ブランチ・期間・記録の有無で件数が変わる', async () => {
    const s = summaries(await fixture());
    const f = emptyFilter();
    expect(applyFilter(s, f)).toHaveLength(4);
    expect(applyFilter(s, { ...f, project: 'quokka/secret-proj' }).map((x) => x.id)).toEqual(['a', 'c']);
    expect(applyFilter(s, { ...f, client: 'github/cli' }).map((x) => x.id)).toEqual(['a', 'c']);
    expect(applyFilter(s, { ...f, client: UNKNOWN }).map((x) => x.id)).toEqual(['d']);
    expect(applyFilter(s, { ...f, model: 'gpt-5.5' }).map((x) => x.id)).toEqual(['a', 'c']);
    expect(applyFilter(s, { ...f, model: UNKNOWN }).map((x) => x.id)).toEqual(['d']);
    expect(applyFilter(s, { ...f, branch: 'main' }).map((x) => x.id)).toEqual(['c']);
    expect(applyFilter(s, { ...f, coverage: 'input' }).map((x) => x.id)).toEqual(['a', 'b']);
    expect(applyFilter(s, { ...f, coverage: 'output-only' }).map((x) => x.id)).toEqual(['c']);
    expect(applyFilter(s, { ...f, coverage: 'none' }).map((x) => x.id)).toEqual(['d']);
    expect(applyFilter(s, { ...f, from: '2026-09-01', to: '2026-09-30' }).map((x) => x.id)).toEqual(['b', 'c']);
    expect(applyFilter(s, { ...f, project: 'quokka/secret-proj', coverage: 'input' }).map((x) => x.id)).toEqual(['a']);
  });

  it('人(送り先の、人のフォルダの名前)で絞れる。人が 1 件も無いレポートでは選択肢を出さない', async () => {
    const rs = await fixture();
    const plain = summaries(rs);
    expect(hasPeople(plain)).toBe(false);
    expect(filterOptions(plain).person).toEqual([]);
    // 人の軸が無いレポートに #person= が付いていても、当たるものが無いだけ(落ちない)
    expect(applyFilter(plain, { ...emptyFilter(), person: 'person-a' })).toEqual([]);
    const s = summaries(withPeople(rs));
    const f = emptyFilter();
    expect(hasPeople(s)).toBe(true);
    expect(applyFilter(s, { ...f, person: 'person-a' }).map((x) => x.id)).toEqual(['a', 'c']);
    expect(applyFilter(s, { ...f, person: 'person-b' }).map((x) => x.id)).toEqual(['b']);
    expect(applyFilter(s, { ...f, person: UNKNOWN }).map((x) => x.id)).toEqual(['d']);
    // 他の軸と AND
    expect(applyFilter(s, { ...f, person: 'person-a', coverage: 'input' }).map((x) => x.id)).toEqual(['a']);
    expect(filterOptions(s).person).toEqual([
      { value: 'person-a', label: 'person-a', count: 2 },
      { value: UNKNOWN, label: UNKNOWN, count: 1 },
      { value: 'person-b', label: 'person-b', count: 1 },
    ]);
    // URL ハッシュと往復(和文の名前も)
    const g = { ...f, person: '架空 太郎', project: 'a/b' };
    expect(encodeFilter(g)).toContain('person=');
    expect(decodeFilter(`#${encodeFilter(g)}`)).toEqual(g);
    expect(isEmptyFilter({ ...f, person: 'person-a' })).toBe(false);
  });

  it('空のセッションは既定で除外し、「含める」(#empty=1)で含める。内訳では「空」として数える', async () => {
    const rs = [...(await fixture()), await normalizeSession({ id: 'z', workspace: { cwd: 'D:\\other', created_at: '2026-10-02T00:00:00Z' }, events: [] })];
    const s = summaries(rs);
    expect(s.find((x) => x.id === 'z')?.empty).toBe(true);
    expect(applyFilter(s, emptyFilter()).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    const inc = { ...emptyFilter(), empty: '1' as const };
    expect(applyFilter(s, inc)).toHaveLength(5);
    expect(encodeFilter(inc)).toBe('empty=1');
    expect(decodeFilter('#empty=1').empty).toBe('1');
    expect(decodeFilter('#empty=yes').empty).toBe('');
    expect(isEmptyFilter(inc)).toBe(false);
    const c = coverageBreakdown(applyFilter(s, inc));
    expect(c).toEqual({ detailed: 2, shutdown: 0, outputOnly: 1, none: 1, empty: 1 });
    // 既定の集計は core の metrics(空を除く)と一致する
    const m = computeMetrics(rs);
    expect(m.emptySessions).toBe(1);
    expect(aggregate(applyFilter(s, emptyFilter())).overall.sessions).toBe(m.overall.sessions);
    expect(aggregate(applyFilter(s, inc)).overall.emptySessions).toBe(1);
  });

  it('タスク分類は judgments の有無で絞れる(未判定は (none))', async () => {
    const rs = await fixture();
    const s = rs.map((r) => summarize(r, identityAnonymizer(), r.id === 'a' ? judgment({ taskCategory: 'bugfix', hours: 2, low: 1, high: 3, confidence: 0.5, taskSummary: '修正' }) : null));
    expect(applyFilter(s, { ...emptyFilter(), taskCategory: 'bugfix' }).map((x) => x.id)).toEqual(['a']);
    expect(applyFilter(s, { ...emptyFilter(), taskCategory: NO_JUDGMENT })).toHaveLength(3);
    const o = aggregate(s).overall;
    expect(o).toMatchObject({ judgedSessions: 1, humanHours: 2, humanLow: 1, humanHigh: 3, judgedConfidence: 0.5 });
    const a = s.find((x) => x.id === 'a')!;
    expect(o.judgedAi.output).toBe(a.tokens.output);
    expect(o.judgedAi.activeMs).toBe(a.activeMs ?? 0);
    // HTML 本体に埋め込む要約には根拠(自由記述)を入れない
    expect(a.judgment?.rationale).toBeNull();
  });

  it('選択肢は件数の多い順で、件数付き', async () => {
    const o = filterOptions(summaries(await fixture()));
    expect(o.project[0]).toEqual({ value: 'quokka/secret-proj', label: 'quokka/secret-proj', count: 2 });
    expect(o.client.map((x) => x.value)).toEqual(['github/cli', '(unknown)', 'github/autopilot']);
    expect(o.model.find((x) => x.value === 'gpt-5.5')?.count).toBe(2);
  });

  it('URL ハッシュと往復でき、不正な値は捨てる', () => {
    const f = { ...emptyFilter(), project: 'a/b c', coverage: 'none' as const, from: '2026-01-01' };
    expect(decodeFilter(`#${encodeFilter(f)}`)).toEqual(f);
    expect(isEmptyFilter(decodeFilter('#coverage=bogus&unknown=1&project=%E0%A4'))).toBe(true);
    expect(encodeFilter(emptyFilter())).toBe('');
  });

  it('Phase 10: セッションの選択(ids)は含まれるものだけにし、他の軸と AND。ハッシュではカンマをそのまま書き、往復で重複と空を落とす', async () => {
    const s = summaries(await fixture());
    const f = { ...emptyFilter(), ids: 'a,c,zzz' };
    expect(applyFilter(s, f).map((x) => x.id)).toEqual(['a', 'c']);
    expect(applyFilter(s, { ...f, coverage: 'input' }).map((x) => x.id)).toEqual(['a']);
    expect(applyFilter(s, { ...emptyFilter(), ids: 'zzz' })).toEqual([]);
    expect(isEmptyFilter(f)).toBe(false);
    expect(encodeFilter(f)).toBe('ids=a,c,zzz');
    expect(decodeFilter('#ids=a,c,zzz')).toEqual(f);
    expect(decodeFilter('#ids=c,%20a,,c&project=p').ids).toBe('c,a');
    expect(decodeFilter(`#${encodeFilter(f)}`)).toEqual(f);
    // 200 件の UUID でも 8KB 以内(file:// でも問題ない長さ)
    const many = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const h = encodeFilter({ ...emptyFilter(), ids: joinIds(many) });
    expect(h.length).toBeLessThan(8 * 1024);
    expect(splitIds(decodeFilter(`#${h}`).ids)).toEqual(many);
    expect(sameIds('a,b', 'b,a')).toBe(true);
    expect(sameIds('a,b', 'a')).toBe(false);
  });

  it('Phase 10 第 3 段: group(名前)は hash と往復し、名前が今のグループにあればその ids、無ければ ids に落ちる。0 件のグループは何にも当たらない', async () => {
    const s = summaries(await fixture());
    const known = new Set(s.map((x) => x.id));
    const f = { ...emptyFilter(), group: '調査 1', ids: 'a,b' };
    expect(encodeFilter(f)).toBe('ids=a,b&group=%E8%AA%BF%E6%9F%BB%201');
    expect(decodeFilter(`#${encodeFilter(f)}`)).toEqual(f);
    expect(decodeFilter('#group=%20x%20').group).toBe('x');
    const groups = [
      { name: '調査 1', ids: ['c', 'zzz'] },
      { name: '空', ids: [] },
      { name: '無い', ids: ['zzz'] },
    ];
    // 名前があれば今の ids(記録にあるもの)。hash の ids(a,b)は古い値として無視される
    expect(effectiveIds(f, groups, known)).toEqual({ group: groups[0], ids: 'c' });
    expect(applyFilter(s, { ...f, ids: effectiveIds(f, groups, known).ids }).map((x) => x.id)).toEqual(['c']);
    // 相手に無い名前は ids に落ちる(壊れない)
    expect(effectiveIds({ ...f, group: '相手に無い' }, groups, known)).toEqual({ group: null, ids: 'a,b' });
    expect(effectiveIds({ ids: '', group: '' }, groups, known)).toEqual({ group: null, ids: '' });
    // 0 件のグループ・記録に無い id だけのグループは「すべて」にならない
    expect(groupIds(groups[1], known)).toBe(NO_SESSION);
    expect(groupIds(groups[2], known)).toBe('zzz');
    expect(applyFilter(s, { ...emptyFilter(), ids: NO_SESSION })).toEqual([]);
    expect(applyFilter(s, { ...emptyFilter(), group: '空', ids: effectiveIds({ ids: '', group: '空' }, groups, known).ids })).toEqual([]);
  });

  it('Phase 10 第 3 段(見直し): 記号を含む名前の往復、NO_SESSION を含む ids、現在のグループ名の fallback、記録にある選択', async () => {
    const s = summaries(await fixture());
    const known = new Set(s.map((x) => x.id));
    for (const name of ['a&b', 'x=y', '100%', '#1', 'p,q', 'c+d', '& = % # , +']) {
      const f = { ...emptyFilter(), group: name, ids: 'a' };
      const h = encodeFilter(f);
      expect(decodeFilter(`#${h}`)).toEqual(f);
      // 他のキーを壊さない(& と = はエスケープされる)
      expect(decodeFilter(`#${h}&project=p`)).toEqual({ ...f, project: 'p' });
    }
    // 受け取った ids に NO_SESSION や未知の id が混じっても壊れず、一覧の選択には写さない
    expect(decodeFilter(`#ids=a,${NO_SESSION},zzz`).ids).toBe(`a,${NO_SESSION},zzz`);
    expect(applyFilter(s, { ...emptyFilter(), ids: `a,${NO_SESSION},zzz` }).map((x) => x.id)).toEqual(['a']);
    expect([...knownSelection(`a,${NO_SESSION},zzz,b`, known)]).toEqual(['a', 'b']);
    expect(knownSelection('', known).size).toBe(0);
    // 現在のグループ名: 名前 → ids の一致 → 0 件(NO_SESSION)や同じ集合が複数のときは null
    const groups = [
      { name: 'A', ids: [] },
      { name: 'B', ids: [] },
      { name: 'C', ids: ['a', 'b'] },
      { name: 'D', ids: ['b', 'a', 'zzz'] },
      { name: 'E', ids: ['c'] },
    ];
    expect(currentGroupName({ ids: 'c', group: 'E' }, groups, known)).toBe('E');
    expect(currentGroupName({ ids: 'c', group: '' }, groups, known)).toBe('E');
    expect(currentGroupName({ ids: 'c', group: '相手に無い' }, groups, known)).toBe('E');
    expect(currentGroupName({ ids: NO_SESSION, group: '' }, groups, known)).toBeNull();
    expect(currentGroupName({ ids: NO_SESSION, group: 'B' }, groups, known)).toBe('B');
    expect(currentGroupName({ ids: 'a,b', group: '' }, groups, known)).toBeNull();
    expect(currentGroupName({ ids: 'a,b', group: 'D' }, groups, known)).toBe('D');
    expect(currentGroupName({ ids: '', group: '' }, groups, known)).toBeNull();
  });
});

describe('groups: 追加と除外(純関数)', () => {
  it('addIds は重複を足さず順序を保ち、removeIds は 0 件になっても消さない', () => {
    const g = { name: 'g', note: '', ids: ['a', 'b'] };
    const r = addIds(g, ['b', 'c', 'c', ' ', 'a']);
    expect(r).toEqual({ group: { name: 'g', note: '', ids: ['a', 'b', 'c'] }, added: 1, dup: 2 });
    expect(g.ids).toEqual(['a', 'b']);
    expect(addIds(g, [])).toEqual({ group: { name: 'g', note: '', ids: ['a', 'b'] }, added: 0, dup: 0 });
    const d = removeIds(g, ['a', 'zzz']);
    expect(d).toEqual({ group: { name: 'g', note: '', ids: ['b'] }, removed: 1 });
    expect(removeIds(d.group, ['b'])).toEqual({ group: { name: 'g', note: '', ids: [] }, removed: 1 });
    expect(removeIds({ ...g, ids: [] }, ['a'])).toEqual({ group: { name: 'g', note: '', ids: [] }, removed: 0 });
  });
});

describe('groups(atlas-notes/groups.json)', () => {
  it('正常な形を読み、重複した id を除く。書き出しはキーの順を固定して雛形になる', () => {
    const r = parseGroups({ version: 1, groups: [{ name: ' 調査 ', note: 'x', ids: ['a', 'b', 'a', ' '] }, { name: '空', ids: [] }] });
    expect(r.warnings).toEqual([]);
    expect(r.groups).toEqual([
      { name: '調査', note: 'x', ids: ['a', 'b'] },
      { name: '空', note: '', ids: [] },
    ]);
    expect(serializeGroups(r.groups)).toBe(`${JSON.stringify({ version: 1, groups: r.groups }, null, 2)}\n`);
  });

  it('壊れた形はエラーにせず、読めた分だけ返して理由を残す(全体 / 1 件 / 重複名)', () => {
    expect(parseGroups(null).groups).toEqual([]);
    expect(parseGroups(null).warnings[0]).toMatch(/オブジェクトではない/);
    expect(parseGroups({ version: 2, groups: [] }).warnings[0]).toMatch(/version/);
    expect(parseGroups({ version: 1, groups: {} }).warnings[0]).toMatch(/配列ではない/);
    const r = parseGroups({
      version: 1,
      groups: [{ name: 'ok', ids: ['a'] }, 'junk', { name: '', ids: [] }, { name: 'bad', ids: 'a' }, { name: 'ok', ids: ['b'] }, { name: 'n', ids: ['c'], note: 3 }],
    });
    expect(r.groups.map((g) => g.name)).toEqual(['ok', 'n']);
    expect(r.groups[0].ids).toEqual(['a']);
    expect(r.groups[1].note).toBe('');
    expect(r.warnings).toHaveLength(5);
    expect(r.warnings.find((w) => w.includes('重複'))).toMatch(/「ok」/);
    expect(r.warnings.find((w) => w.includes('note'))).toMatch(/\(n\)/);
  });

  it('id の先頭一致: 完全一致を優先し、1 つに決まれば採り、曖昧・未知はエラー', () => {
    const known = ['abc-1', 'abc-2', 'abd-1', 'abc'];
    expect(resolveIdPrefixes(known, ['abc'])).toEqual(['abc']);
    expect(resolveIdPrefixes(known, ['abd', 'abc-2', 'abd'])).toEqual(['abd-1', 'abc-2']);
    expect(() => resolveIdPrefixes(known, ['abc-'])).toThrow(/曖昧/);
    expect(() => resolveIdPrefixes(known, ['zzz'])).toThrow(/記録にありません/);
  });
});

describe('anonymize', () => {
  it('プロジェクト・ブランチは辞書順で決定的な仮名、本文は出さない', async () => {
    const rs = await fixture();
    const anon = createAnonymizer(rs);
    const s = rs.map((r) => summarize(r, anon, null));
    // 辞書順: 'D:\other' < '/home/me/...' < 'quokka/secret-proj'(localeCompare)
    expect(s.map((x) => x.project)).toEqual(['project-03', 'project-02', 'project-03', 'project-01']);
    expect(s.map((x) => x.branch)).toEqual(['branch-01', null, 'branch-02', null]);
    expect(s.every((x) => x.name === null && x.firstUserMessage === null)).toBe(true);
    const json = JSON.stringify(s);
    for (const secret of ['secret-proj', 'quokka', 'feature/x1', 'C:\\\\work', '.copilot', 'D:\\\\other']) expect(json).not.toContain(secret);
    // 同じ入力からは同じ仮名
    expect(createAnonymizer(rs).project('quokka/secret-proj')).toBe('project-03');
  });

  it('人のフォルダの名前も辞書順の仮名(person-01…)にし、本文に出てきた名前も伏せる。人が無ければ null のまま', async () => {
    const rs = withPeople(await fixture());
    const anon = createAnonymizer(rs);
    expect(rs.map((r) => summarize(r, anon, null).person)).toEqual(['person-01', 'person-02', 'person-01', null]);
    const named = createAnonymizer([{ ...rs[0], person: 'zz-kakuu-taro' }, { ...rs[1], person: 'aa-kakuu-hanako' }]);
    expect(named.person('zz-kakuu-taro')).toBe('person-02');
    expect(named.person('aa-kakuu-hanako')).toBe('person-01');
    expect(named.person(null)).toBeNull();
    expect(named.scrub('reviewed by zz-kakuu-taro')).toBe('reviewed by person-02');
    // 伏せ字にしないときはそのまま。詳細ページにも人の札を出す(伏せ字では仮名)
    expect(identityAnonymizer().person('zz-kakuu-taro')).toBe('zz-kakuu-taro');
    const rec = { ...rs[0], person: 'zz-kakuu-taro' };
    const html = renderDetailHtml(rec, { anon: createAnonymizer([rec]), css: '', judgment: null, generatedAt: '2026-10-28T00:00:00Z' });
    expect(html).toContain('人: person-01');
    expect(html).not.toContain('zz-kakuu-taro');
    expect(renderDetailHtml(rec, { anon: identityAnonymizer(), css: '', judgment: null, generatedAt: '2026-10-28T00:00:00Z' })).toContain('人: zz-kakuu-taro');
    expect(renderDetailHtml(rs[3], { anon: identityAnonymizer(), css: '', judgment: null, generatedAt: '2026-10-28T00:00:00Z' })).not.toContain('人: ');
  });

  it('scrub はパスと既知の固有名を置き換える', async () => {
    const anon = createAnonymizer(await fixture());
    expect(anon.scrub('failed at C:\\work\\secret-proj\\src\\a.ts in secret-proj on feature/x1')).toBe('failed at <path> in project-03 on branch-01');
    expect(anon.scrub('domain main')).toBe('domain branch-02');
  });

  it('scrub: 空白を含むフォルダ名・大文字小文字の違い・~ や /root の下も伏せる', async () => {
    const cwd = 'E:\\Files\\Quokka Den';
    const anon = createAnonymizer([...(await fixture()), { project: 'quokka-den-app', cwd, gitRoot: null, repository: null, branch: null }]);
    expect(anon.scrub('read D:\\Profiles\\John Smith\\Cloud Sync - Quokka Den\\notes.txt failed')).toBe('read <path> failed');
    // 作業フォルダの最後の名前に空白があっても、その下を含めて伏せる(大文字小文字は問わない)
    expect(anon.scrub(`in ${cwd} now`)).toBe('in <path> now');
    expect(anon.scrub('in e:\\files\\quokka den\\src\\a.ts now')).toBe('in <path> now');
    const p = anon.project('quokka/secret-proj');
    expect(anon.scrub('Secret-Proj and SECRET-PROJ')).toBe(`${p} and ${p}`);
    for (const s of ['~/projects/secret-x/a.md', '/root/secret-x/a', '/workspaces/secret-x/a', 'C:/Profiles/John Smith/a.txt']) expect(anon.scrub(`at ${s} end`)).toBe('at <path> end');
    // \ のパスの後の文中の / は呑まない
    expect(anon.scrub('C:\\a\\b.ts on topic/x')).toBe('<path> on topic/x');
  });

  it('詳細ページの時系列: 伏せ字モードでは要約・中断理由・エラー本文・サブエージェント失敗の本文を出さず、種別名だけ出す', async () => {
    const t = '2026-10-01T00:00:00Z';
    const r = await normalizeSession({
      id: 'e',
      workspace: { cwd: 'C:\work\secret-proj', repository: 'quokka/secret-proj', created_at: t },
      events: [
        { type: 'user.message', data: { content: '依頼 e' }, timestamp: t },
        { type: 'subagent.started', data: { agentName: 'helper', toolCallId: 'c1' }, timestamp: t },
        { type: 'subagent.failed', data: { agentName: 'helper', toolCallId: 'c1', error: 'ENOENT: notes/todo.md が無い' }, timestamp: t },
        { type: 'session.task_complete', data: { summary: 'README.md と normalize.ts を更新した' }, timestamp: t },
        { type: 'abort', data: { reason: 'user stopped while editing secret-notes.md' }, timestamp: t },
        { type: 'session.error', data: { errorType: 'rate_limit' }, timestamp: t },
        { type: 'session.error', data: { message: 'failed to read secret-notes.md' }, timestamp: t },
      ],
    });
    const anon = createAnonymizer([...(await fixture()), r]);
    const html = renderDetailHtml(r, { anon, css: '', judgment: null, generatedAt: '2026-10-28T00:00:00Z' });
    for (const secret of ['README.md', 'normalize.ts', 'secret-notes.md', 'todo.md', 'user stopped', 'failed to read']) expect(html).not.toContain(secret);
    // 種別名(識別子)は出る
    expect(html).toContain('rate_limit');
    const plain = renderDetailHtml(r, { anon: identityAnonymizer(), css: '', judgment: null, generatedAt: '2026-10-28T00:00:00Z' });
    for (const text of ['README.md と normalize.ts を更新した', 'user stopped while editing secret-notes.md', 'failed to read secret-notes.md', 'notes/todo.md が無い']) expect(plain).toContain(text);
  });

  it('詳細ページも伏せ字(パス・本文・ブランチが出ない)', async () => {
    const rs = await fixture();
    const anon = createAnonymizer(rs);
    const html = renderDetailHtml(rs[0], { anon, css: '', judgment: null, generatedAt: '2026-10-28T00:00:00Z' });
    for (const secret of ['secret-proj', 'quokka', 'feature/x1', 'work\\', '依頼 a']) expect(html).not.toContain(secret);
    expect(html).toContain('project-03');
    const plain = renderDetailHtml(rs[0], { anon: identityAnonymizer(), css: '', judgment: null, generatedAt: '2026-10-28T00:00:00Z' });
    expect(plain).toContain('secret-proj');
  });

  it('詳細ページの「指示文と skill」: 使えた skill に呼んだ回数を添え(呼んだものが先)、一覧に無い呼び出しも出す。一覧が無い版はその旨。伏せ字では使えた skill の名前を出さない', async () => {
    const t = '2026-10-01T00:00:00Z';
    const sys = '<skill>\n<available_skills>\n<skill>\n<name>alpha</name>\n<location>user</location>\n</skill>\n<skill>\n<name>private-proj-skill</name>\n<location>project</location>\n</skill>\n</available_skills>\n</skill>';
    const r = await normalizeSession({
      id: 'sk',
      events: [
        { type: 'system.message', data: { role: 'system', content: sys }, timestamp: t },
        { type: 'skill.invoked', data: { name: 'alpha', content: 'a', trigger: 'agent-invoked' }, timestamp: t },
        { type: 'skill.invoked', data: { name: 'alpha', content: 'a', trigger: 'agent-invoked' }, timestamp: '2026-10-01T00:05:00Z' },
        { type: 'skill.invoked', data: { name: 'outside', content: 'o', trigger: 'user-invoked' }, timestamp: t },
      ],
    });
    const plain = renderDetailHtml(r, { anon: identityAnonymizer(), css: '', judgment: null, generatedAt: t, libraryHref: '../instructions.html' });
    const table = /data-testid="session-skills"[\s\S]*?<\/table>/.exec(plain)![0];
    const rows = [...table.matchAll(/<tr( class="called")?><td>(?:<a [^>]*>)?([^<]+)(?:<\/a>)?<\/td><td>([^<]+)<\/td><td class="num">([\s\S]*?)<\/td><\/tr>/g)].map((m) => [m[2], m[3], m[4].replace(/<[^>]+>/g, '')]);
    expect(rows).toEqual([
      ['alpha', 'ユーザー', '2'],
      ['outside', '一覧に無し', '1'],
      ['private-proj-skill', 'プロジェクト', '—'],
    ]);
    expect(plain).toContain('使えた skill 2 件(システムメッセージの一覧)、うち呼んだもの 1 件。一覧に無い skill を 1 件呼んでいます。');
    // このセッションの分だけを開くリンク(上部の帯・サイドバーの目次と、節の見出しの横)
    expect(plain.match(/\.\.\/instructions\.html#session=sk"/g)?.length).toBe(3);

    const old = await normalizeSession({ id: 'old', events: [{ type: 'skill.invoked', data: { name: 'alpha', content: 'a' }, timestamp: t }] });
    expect(old.availableSkills).toBeNull();
    expect(renderDetailHtml(old, { anon: identityAnonymizer(), css: '', judgment: null, generatedAt: t })).toContain('使えた skill の一覧はこのセッションの記録にありません');

    const anon = createAnonymizer([...(await fixture()), r]);
    const hidden = renderDetailHtml(r, { anon, css: '', judgment: null, generatedAt: t, libraryHref: '../instructions.html' });
    expect(hidden).not.toContain('private-proj-skill');
    expect(hidden).not.toContain('#session=');
    expect(hidden).toContain('使えた skill 2 件');
  });

  it('ホームディレクトリは ~ に短縮して表示する', () => {
    // Windows 形式(C:\Users\<name>)は実データの E2E(ATLAS_LIVE)で検証する。ここでは POSIX 形式で ~ 短縮を確かめる
    expect(shortProjectLabel('/home/me/.copilot/chats/c1')).toBe('~/.copilot/chats/c1');
    expect(shortProjectLabel('quokka/x')).toBe('quokka/x');
  });
});

describe('embed', () => {
  it('</script> や URL・fetch( を含む本文でも安全に埋め込み、往復できる', () => {
    const data = { t: '</script><!-- https://example.com fetch(x) \u2028 & >' };
    const tpl = '<script type="application/json" id="atlas-data">__ATLAS_DATA__</script>';
    const html = embedData(tpl, data);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('fetch(');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(extractEmbedded(html)).toEqual(data);
    expect(JSON.parse(serializeForScript(data))).toEqual(data);
    expect(() => embedData('<p></p>', data)).toThrow(/埋め込み位置/);
  });

  it('esc は HTML と URL の区切りをエスケープする', () => {
    expect(esc('<a href="https://x">fetch(1)</a>')).toBe('&lt;a href=&quot;https:&#47;&#47;x&quot;&gt;fetch&#40;1)&lt;/a&gt;');
  });
});

describe('judgments', () => {
  it('必要な項目だけ拾い、形が違えばエラーにする', () => {
    const j = parseJudgments({
      schemaVersion: 1,
      judge: { backend: 'external', model: 'm', ranAt: '2026-10-28T00:00:00Z' },
      items: [{ sessionId: 'a', taskCategory: 'docs', taskSummary: 's', humanEffort: { hours: 1.5, low: 1, high: 2, confidence: 0.7 } }],
    });
    expect(j.backend).toBe('external');
    expect(j.bySession.get('a')).toEqual({
      taskCategory: 'docs',
      hours: 1.5,
      low: 1,
      high: 2,
      confidence: 0.7,
      taskSummary: 's',
      completed: null,
      quality: null,
      rework: null,
      effects: { instructions: null, wiki: null, skillsAgents: null },
      rationale: null,
      backend: 'external',
    });
    expect(() => parseJudgments({ schemaVersion: 1, items: [{ sessionId: 'x', humanEffort: {} }] })).toThrow(/hours/);
    expect(() => parseJudgments({ schemaVersion: 2, items: [] })).toThrow(/schemaVersion/);
    expect(() => parseJudgments({ schemaVersion: 1, items: [{}] })).toThrow(/sessionId/);
  });
});

describe('glossary', () => {
  it('全用語が 5 分類のどれかに入り、空の分類が無く、id が重複しない', () => {
    const groupIds = new Set(GLOSSARY_GROUPS.map((g) => g.id));
    for (const t of GLOSSARY) expect(groupIds.has(t.group), t.id).toBe(true);
    for (const g of GLOSSARY_GROUPS) expect(termsByGroup(g.id).length, g.id).toBeGreaterThan(0);
    expect(new Set(GLOSSARY.map((t) => t.id)).size).toBe(GLOSSARY.length);
    expect(GLOSSARY_GROUPS.reduce((n, g) => n + termsByGroup(g.id).length, 0)).toBe(GLOSSARY.length);
  });

  it('用語ページは分類ごとの h2 と分類だけの目次を持ち、各用語の id(glossary.html#<id>)は変わらない', () => {
    const html = renderGlossaryHtml({ css: '', generatedAt: '2026-11-01T00:00:00Z' });
    for (const g of GLOSSARY_GROUPS) expect(html).toContain(`<h2 id="h-${g.id}">${g.title}</h2>`);
    for (const t of GLOSSARY) expect(html).toContain(`<dt id="${t.id}">`);
    // 語は自分へのリンクにしない(押しても同じ場所に留まるだけ)。語の欄(dt)の中にリンクを置かず、ページのどこからも語の #id を指さない
    const dts = html.match(/<dt\b[^>]*>[\s\S]*?<\/dt>/g) ?? [];
    expect(dts.length).toBe(GLOSSARY.length);
    for (const dt of dts) expect(dt).not.toMatch(/<a\b/);
    for (const t of GLOSSARY) expect(html).not.toMatch(new RegExp(`href="(?:glossary\\.html)?#${t.id}"`));
    // 代わりに、語ごとに「リンクをコピー」のボタンがあり、どの語のものか読み上げで分かる
    for (const t of GLOSSARY) expect(html).toContain(`data-copy-link="${t.id}" aria-label="「${t.term}」へのリンクをコピー"`);
    const toc = html.match(/<nav class="toc"[\s\S]*?<\/nav>/)?.[0] ?? '';
    expect(toc.match(/<li>/g)?.length).toBe(GLOSSARY_GROUPS.length);
    // 目次の帯は詳細ページと同じ作法(戻る → 目次 → 配色)で、上部の帯にも戻るがある
    expect(html).toContain('<a class="crumb rail-crumb" href="atlas.html">');
    expect(html).toContain('<header class="top">');
    expect(html.match(/<div class="seg" role="group" aria-label="配色" data-theme-seg>/g)?.length).toBe(2);
    // 欠測の語の凡例は「記録の由来と欠測」の冒頭にある
    expect(html.indexOf('<ul class="missing-legend"')).toBeGreaterThan(html.indexOf('id="g-records"'));
    expect(html.indexOf('<ul class="missing-legend"')).toBeLessThan(html.indexOf('id="g-mechanics"'));
  });
});

describe('niceTicks', () => {
  it('きりのよい目盛りで最大値を覆う', () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(95)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(1_234_567)).toEqual([0, 500_000, 1_000_000, 1_500_000]);
  });
});

describe('modelLabel', () => {
  it('プレフィックス付きのモデル ID は最後の / 以降で表示する', () => {
    expect(modelLabel('11111111-2222-4333-8444-555555555555/claude-haiku-5-5')).toBe('claude-haiku-5-5');
    expect(modelLabel('gpt-5.5')).toBe('gpt-5.5');
    expect(modelLabel('(unknown)')).toBe('不明');
    expect(modelLabel('odd/')).toBe('odd/');
  });
});

describe('一覧の題名の見分け(sharedLeads)', () => {
  it('20 字以上同じ書き出しは、直前の区切りから違いを見せる。まったく同じ題名は件数だけ', () => {
    const a = 'HARNESS.md の Phase 1 の節。実装役の報告: ビルド成功';
    const b = 'HARNESS.md の Phase 1 の節。実装役の報告は次のとおり';
    const r = sharedLeads([a, b, '短い依頼', 'OK と返して', 'OK と返して']);
    // 違いは「実装役の報告」の後から始まるが、直前の区切り(。)まで戻す
    expect([...a].slice(r[0].cut).join('')).toBe('実装役の報告: ビルド成功');
    expect([...b].slice(r[1].cut).join('')).toBe('実装役の報告は次のとおり');
    expect(r[2]).toEqual({ cut: 0, same: 1 });
    // 書き出しの一致が 20 字未満なら縮めない。まったく同じ題名は縮めず件数を返す
    expect(r[3]).toEqual({ cut: 0, same: 2 });
  });

  it('まったく同じ題名が複数あっても、別の題名との違いの位置で縮める', () => {
    const head = 'このフォルダは C++ のライブラリのソースです。';
    const r = sharedLeads([`${head}Reset を呼ぶ箇所`, `${head}Reset を呼ぶ箇所`, `${head}Read を呼ぶ箇所`]);
    expect([...`${head}Reset を呼ぶ箇所`].slice(r[0].cut).join('')).toBe('Reset を呼ぶ箇所');
    expect(r[0].same).toBe(2);
    expect(r[2]).toMatchObject({ same: 1 });
    expect(r[2].cut).toBe(r[0].cut);
  });

  it('違いの位置は英数の記号(:: や .)では切らず、和文の句読点か空白まで戻す。残す書き出しも区切りで切る', () => {
    const head = 'このフォルダは C++ のライブラリのソースです。';
    const a = `${head}\`lib::io::File::Read\` を呼ぶ箇所`;
    const b = `${head}\`lib::net::Socket::Open\` を呼ぶ箇所`;
    const [ra] = sharedLeads([a, b]);
    expect(splitLead(a, ra.cut, 70)).toEqual({ lead: 'このフォルダは…', rest: '`lib::io::File::Read` を呼ぶ箇所' });
  });

  it('空白の違いは同じとみなし、短い一致は縮めない', () => {
    const r = sharedLeads(['リポジトリの README を  更新して。章立ては変えない', 'リポジトリの README を 更新して。章立ては変える', 'リポジトリの別の話']);
    expect(r[0].cut).toBeGreaterThan(0);
    expect(r[2]).toEqual({ cut: 0, same: 1 });
  });
});

describe('memberGroups(送った人のタスクタグ)', () => {
  it('人ごとに分ける(同じ名前のタグでも別の人なら別のグループ)。名前は「人 / タグ」、人が無ければタグだけ。人・タグの順に並べる', () => {
    expect(
      memberGroups([
        { id: 's1', person: 'person-b', uploadTags: ['武器'] },
        { id: 's2', person: 'person-a', uploadTags: ['武器', 'UI'] },
        { id: 's3', person: 'person-a', uploadTags: ['武器'] },
        { id: 's4', person: null, uploadTags: ['共有'] },
        { id: 's5', person: 'person-a', uploadTags: [] },
        { id: 's6' },
      ]),
    ).toEqual([
      { name: '共有', note: '', ids: ['s4'] },
      { name: 'person-a / UI', note: '', ids: ['s2'] },
      { name: 'person-a / 武器', note: '', ids: ['s2', 's3'] },
      { name: 'person-b / 武器', note: '', ids: ['s1'] },
    ]);
    expect(memberGroups([])).toEqual([]);
  });

  it('人とタグの組で分ける。表示名が重なったら後のものに番号を付ける(名前はグループの鍵なので重ねない)', () => {
    const g = memberGroups([
      { id: 's1', person: 'a', uploadTags: ['b / c'] },
      { id: 's2', person: 'a / b', uploadTags: ['c'] },
      { id: 's3', person: 'a', uploadTags: ['b / c', 'b / c'] },
    ]);
    expect(g).toEqual([
      { name: 'a / b / c', note: '', ids: ['s1', 's3'] },
      { name: 'a / b / c (2)', note: '', ids: ['s2'] },
    ]);
    expect(new Set(g.map((x) => x.name)).size).toBe(g.length);
  });
});
