// Phase 6 E2E(docs/PLAN.md「改善フェーズ → Phase 6: 利用の内訳と成果量」)
// 合成 fixture(scripts/synthetic-fixtures.ts の 011〜013)と、このテストで作る git リポジトリ・インストール済みの skill で、
//  1. 利用ランキング(ツール / MCP / skill / agent / hook / 指示ファイル)が手計算と一致し、絞り込みに追従する
//  2. ツール別の成功・失敗・拒否と失敗率
//  3. 変更行数(shutdown を優先、無ければツール側の合計)と、途中で削除したファイルが「変更」に戻らないこと
//  4. インストール済みで未使用の skill(名前だけを snapshot で記録)
//  5. プロジェクトの統合(git の origin・worktree・cwd から上へ探す・ホーム・一時フォルダ・atlas の判定)
//  6. premium request と AIU の表示、HTML に欄が出る、--anonymize で固有名が出ない、HTML 5MB 未満
// ATLAS_LIVE=1 のときは実データで out/live を作り直し、プロジェクト数(統合前 → 後)・上位のツール / MCP / skill / agent・
// 未使用の skill・変更行数・ツール失敗率の上位・atlas.html のサイズをログに出す。
import { spawnSync } from 'node:child_process';
import { readFile, readdir, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ATLAS_JUDGE_PROJECT, HOME_PROJECT, projectKey, TEMP_PROJECT, type MetricsFile, type SessionRecord, type SessionsFile } from '../packages/core/src/index.ts';
import { aggregate, applyFilter, emptyFilter, extractEmbedded, type ReportData } from '../packages/report/src/index.ts';
import { failureRate, unusedSkills } from '../packages/report/src/lib/aggregate.ts';
import { buildFixtureHome, ROOT } from './fixture-home.ts';

const LIVE = process.env.ATLAS_LIVE === '1';
const WORK = join(ROOT, 'out', 'e2e-phase6');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const LIMIT = 5 * 1024 * 1024;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P6 = 'X:\\synthetic-p6';
/**
 * 合成 fixture 012 の一時フォルダ。--temp-dir で「一時フォルダ」をこれだけにする(既定のパターンを使わない)。
 * こうしないと、リポジトリ自体を %TEMP% 配下に置いて試したとき、このテストが作る合成リポジトリ(out/e2e-phase6/repos)
 * まで (一時フォルダ) と判定され、git の origin による統合の確認が落ちる。
 */
const TEMP_DIR = 'X:\\home\\someone\\AppData\\Local\\Temp';

/** git の設定ファイル(.git/config・worktree の .git・commondir)の内容と mtime(元のリポジトリを書き換えないことの確認用) */
async function gitFiles(repos: Record<string, string>): Promise<Record<string, { body: string; mtimeMs: number }>> {
  const files = [
    join(repos.alpha, '.git', 'config'),
    join(repos.alpha, '.git', 'worktrees', 'wt1', 'commondir'),
    join(repos.worktree, '.git'),
    join(repos.beta, '.git', 'config'),
    join(repos.local, '.git', 'config'),
  ];
  const out: Record<string, { body: string; mtimeMs: number }> = {};
  for (const f of files) out[f] = { body: await readFile(f, 'utf8'), mtimeMs: (await stat(f)).mtimeMs };
  return out;
}

function atlas(args: string[]): { status: number | null; stdout: string; stderr: string; ms: number } {
  const t = performance.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 600_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - t };
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, 'utf8')) as T;
}

/** git の作業ツリー(テスト用。git コマンドは使わず .git/config だけ置く) */
async function makeRepos(root: string): Promise<Record<string, string>> {
  const repos = join(root, 'repos');
  const p = {
    alpha: join(repos, 'zz-alpha-repo'),
    deep: join(repos, 'zz-alpha-repo', 'pkg', 'deep'),
    worktree: join(repos, 'zz-alpha-wt'),
    beta: join(repos, 'zz-beta-repo'),
    local: join(repos, 'zz-local-repo'),
  };
  await mkdir(join(p.alpha, '.git', 'worktrees', 'wt1'), { recursive: true });
  await writeFile(join(p.alpha, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/zz-owner-qq/zz-alpha-repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  await mkdir(p.deep, { recursive: true });
  // worktree: .git ファイル → gitdir(本体の .git/worktrees/wt1)→ commondir(../..)→ 本体の config
  await mkdir(p.worktree, { recursive: true });
  await writeFile(join(p.worktree, '.git'), `gitdir: ${join(p.alpha, '.git', 'worktrees', 'wt1')}\n`);
  await writeFile(join(p.alpha, '.git', 'worktrees', 'wt1', 'commondir'), '../..\n');
  await mkdir(join(p.beta, '.git'), { recursive: true });
  await writeFile(join(p.beta, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:zz-owner-qq/zz-beta-repo.git\n');
  await mkdir(join(p.local, '.git'), { recursive: true });
  await writeFile(join(p.local, '.git', 'config'), '[core]\n\tbare = false\n');
  return p;
}

/** session-state/<id>/ に最小のセッション(依頼・応答・usage_record)を書く */
async function addSession(home: string, sid: string, cwd: string, gitRoot: string | null, at: string): Promise<void> {
  const dir = join(home, 'session-state', sid);
  await mkdir(dir, { recursive: true });
  const ws = [`id: ${sid}`, `cwd: '${cwd}'`, ...(gitRoot ? [`git_root: '${gitRoot}'`] : []), 'client_name: github/cli', `created_at: ${at}`, `updated_at: ${at}`].join('\n');
  await writeFile(join(dir, 'workspace.yaml'), `${ws}\n`);
  const t0 = Date.parse(at);
  const evs = [
    { type: 'session.start', data: { sessionId: sid, version: 1, copilotVersion: '1.0.103', context: { cwd, ...(gitRoot ? { gitRoot } : {}) } } },
    { type: 'user.message', data: { content: 'hello' } },
    { type: 'assistant.message', data: { messageId: 'm1', content: 'hi', model: 'gpt-5.5' } },
    { type: 'session.usage_record', data: { usage: { model: 'gpt-5.5', inputTokens: 10, outputTokens: 1, cost: 1, initiator: 'user' } } },
  ].map((e, i) => JSON.stringify({ ...e, id: `e${i}`, timestamp: new Date(t0 + i * 1000).toISOString(), parentId: null }));
  await writeFile(join(dir, 'events.jsonl'), `${evs.join('\n')}\n`);
}

describe('Phase 6 E2E: fixtures', () => {
  let close: () => Promise<void>;
  let home: string;
  let userHome: string;
  let repos: Record<string, string>;
  const out = join(WORK, 'out');
  let s: SessionsFile;
  let m: MetricsFile;
  let html: string;
  let data: ReportData;
  let gitBefore: Awaited<ReturnType<typeof gitFiles>>;
  const rec = (n: number): SessionRecord => {
    const r = s.sessions.find((x) => x.id === id(n));
    if (!r) throw new Error(`fixture ${id(n)} が sessions.json に無い`);
    return r;
  };

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    // ~/.copilot と同じ「<ホーム>/.copilot」の形に置く(<ホーム> そのもので開いたセッションを (ホーム) にまとめる確認用)
    userHome = join(WORK, 'zz-someone');
    ({ home, close } = await buildFixtureHome(join(userHome, '.copilot')));
    // インストール済みの skill / プラグイン(中身は読まれないので空のフォルダで足りる)と settings.json
    for (const k of ['wiki-query', 'impeccable', 'unused-a', 'Disabled-B']) await mkdir(join(home, 'skills', k), { recursive: true });
    await mkdir(join(home, 'installed-plugins', 'zz-market', 'zz-plug', 'skills', 'plug-skill'), { recursive: true });
    await writeFile(join(home, 'settings.json'), JSON.stringify({ model: 'gpt-5.5', disabledSkills: ['Disabled-B'] }));
    repos = await makeRepos(WORK);
    await addSession(home, id(101), repos.alpha, repos.alpha, '2026-10-25T00:00:00.000Z');
    await addSession(home, id(102), repos.deep, null, '2026-10-25T01:00:00.000Z');
    await addSession(home, id(103), repos.worktree, repos.worktree, '2026-10-25T02:00:00.000Z');
    await addSession(home, id(104), repos.beta, repos.beta, '2026-10-25T03:00:00.000Z');
    await addSession(home, id(105), repos.local, repos.local, '2026-10-25T04:00:00.000Z');
    await addSession(home, id(106), userHome, null, '2026-10-25T05:00:00.000Z');
    gitBefore = await gitFiles(repos);
    const r = atlas(['all', '--home', home, '--out', out, '--temp-dir', TEMP_DIR]);
    if (r.status !== 0) throw new Error(`atlas all が失敗: ${r.stderr}\n${r.stdout}`);
    console.log(`[fixtures] ${r.stdout}`);
    s = await readJson<SessionsFile>(join(out, 'sessions.json'));
    m = await readJson<MetricsFile>(join(out, 'metrics.json'));
    html = await readFile(join(out, 'atlas.html'), 'utf8');
    data = extractEmbedded<ReportData>(html);
  });
  afterAll(async () => close?.());

  it('1. 利用ランキング: 合成 011 のプロジェクトで絞ると、ツール・MCP・skill・agent・hook が手計算と一致する', () => {
    const only = aggregate(applyFilter(data.sessions, { ...emptyFilter(), project: P6 }));
    const u = only.usage;
    // MCP ツールはサーバーごとに 1 行。view は 3 回(成功 1・拒否 1・結果なし 1)
    expect(u.tools.map((t) => [t.key, t.calls, t.completed, t.success, t.failure, t.denied])).toEqual([
      ['view', 3, 2, 1, 0, 1],
      ['mcp:github-mcp-server', 2, 2, 1, 1, 0],
      ['create', 1, 1, 1, 0, 0],
      ['edit', 1, 1, 1, 0, 0],
      ['mcp:ide', 1, 1, 1, 0, 0],
      ['powershell', 1, 1, 1, 0, 0],
      ['skill', 1, 1, 1, 0, 0],
    ]);
    expect(u.mcp.map((x) => [x.server, x.calls, x.tools.map((t) => [t.name, t.calls])])).toEqual([
      ['github-mcp-server', 2, [['github-mcp-server-get_file_contents', 1], ['github-mcp-server-search_code', 1]]],
      ['ide', 1, [['ide-get_diagnostics', 1]]],
    ]);
    // skill の呼んだ側: wiki-query はツール + agent-invoked、impeccable は user-invoked、legacy-skill は trigger なし
    expect(u.skills.map((x) => [x.name, x.uses, x.user, x.agent, x.unknown])).toEqual([
      ['impeccable', 1, 1, 0, 0],
      ['legacy-skill', 1, 0, 0, 1],
      ['wiki-query', 1, 0, 1, 0],
    ]);
    expect(u.agents).toEqual([
      { name: 'explore', runs: 2, failed: 1, tokens: 1200, sessions: 1 },
      { name: 'task', runs: 1, failed: 0, tokens: 300, sessions: 1 },
    ]);
    expect(u.hooks).toEqual([
      { name: 'preToolUse', count: 2, sessions: 1 },
      { name: 'postToolUse', count: 1, sessions: 1 },
    ]);
    // 絞り込みを外すと他のセッションの分も入る(追従している)
    const all = aggregate(applyFilter(data.sessions, emptyFilter())).usage;
    const viewAll = all.tools.find((t) => t.key === 'view')!;
    expect(viewAll.calls).toBeGreaterThan(3);
    expect(viewAll.calls).toBe(m.overall.tools.byName.view);
    // 指示ファイルのランキングは metrics の byFile(セッション数)と一致する
    expect(Object.fromEntries(all.instructions.map((x) => [x.name, x.sessions]))).toEqual(Object.fromEntries(Object.entries(m.overall.instructions.byFile).map(([k, v]) => [k, v.sessions])));
    // metrics にも同じ内訳
    expect(m.byProject[P6].tools.mcp).toEqual({ 'github-mcp-server': 2, ide: 1 });
    expect(m.byProject[P6].skills.byTrigger).toEqual({ user: 1, agent: 1, unknown: 1 });
    expect(m.byProject[P6].agents.byNameDetail).toEqual({ explore: { runs: 2, failed: 1, tokens: 1200 }, task: { runs: 1, failed: 0, tokens: 300 } });
  });

  it('2. ツール別の成功・失敗・拒否と失敗率', () => {
    expect(rec(11).tools.results).toEqual({
      'github-mcp-server-search_code': { success: 1, failure: 0, denied: 0 },
      'github-mcp-server-get_file_contents': { success: 0, failure: 1, denied: 0 },
      'ide-get_diagnostics': { success: 1, failure: 0, denied: 0 },
      view: { success: 1, failure: 0, denied: 1 },
      edit: { success: 1, failure: 0, denied: 0 },
      create: { success: 1, failure: 0, denied: 0 },
      powershell: { success: 1, failure: 0, denied: 0 },
      skill: { success: 1, failure: 0, denied: 0 },
    });
    expect(rec(11).friction.toolFailures).toBe(2);
    const u = aggregate(applyFilter(data.sessions, { ...emptyFilter(), project: P6 })).usage;
    expect(failureRate(u.tools.find((t) => t.key === 'view')!)).toBe(0.5);
    expect(failureRate(u.tools.find((t) => t.key === 'mcp:github-mcp-server')!)).toBe(0.5);
    expect(failureRate(u.tools.find((t) => t.key === 'edit')!)).toBe(0);
    // metrics の結果はセッションの和
    const sum = s.sessions.filter((x) => !x.empty).reduce((a, x) => a + (x.tools.results.view?.denied ?? 0), 0);
    expect(m.overall.tools.results.view.denied).toBe(sum);
  });

  it('3. 変更行数: shutdown を優先し、無ければツール側の合計。全体・プロジェクト・セッションに出る', async () => {
    expect(rec(11).lines).toEqual({ added: 40, removed: 7, source: 'shutdown' }); // ツール側の 15 / 2 は使わない
    expect(rec(12).lines).toEqual({ added: 7, removed: 1, source: 'tools' });
    expect(rec(13).lines).toEqual({ added: 0, removed: 0, source: 'none' });
    expect(m.byProject[P6].lines).toEqual({ added: 40, removed: 7, sessionsWithRecord: 1, bySource: { shutdown: 1, tools: 0, none: 0 } });
    const nonEmpty = s.sessions.filter((x) => !x.empty);
    expect(m.overall.lines.added).toBe(nonEmpty.reduce((a, x) => a + x.lines.added, 0));
    expect(m.overall.lines.sessionsWithRecord).toBe(nonEmpty.filter((x) => x.lines.source !== 'none').length);
    const agg = aggregate(applyFilter(data.sessions, emptyFilter()));
    expect(agg.overall.linesAdded).toBe(m.overall.lines.added);
    expect(agg.overall.linesRemoved).toBe(m.overall.lines.removed);
    expect(agg.byProject.find((b) => b.key === P6)).toMatchObject({ linesAdded: 40, linesRemoved: 7, sessionsWithLines: 1 });
    expect(data.sessions.find((x) => x.id === id(12))?.lines).toEqual({ added: 7, removed: 1, source: 'tools' });
    // 途中で削除したファイル(gone.txt)が shutdown の filesModified に残っていても「削除」のまま
    expect(rec(11).files).toEqual({ changed: [`${P6}\\src\\main.ts`], created: [`${P6}\\src\\new.ts`], deleted: [`${P6}\\gone.txt`], sessionState: 0 });
    const detail = await readFile(join(out, 'sessions', `${id(11)}.html`), 'utf8');
    for (const t of ['変更行数', '+40 / −7', '終了時の累計(codeChanges)', 'MCP: github-mcp-server', '拒否', '利用者', '削除 1 件']) expect(detail).toContain(t);
  });

  it('4. インストール済みで未使用の skill(名前だけ記録。無効にしたものは印付き)', () => {
    expect(s.installed).toEqual({
      skills: ['Disabled-B', 'impeccable', 'unused-a', 'wiki-query'],
      plugins: [{ marketplace: 'zz-market', name: 'zz-plug', skills: ['plug-skill'] }],
      disabledSkills: ['Disabled-B'],
      warnings: [],
    });
    expect(m.installedSkills).toEqual({
      installed: ['Disabled-B', 'impeccable', 'plug-skill', 'unused-a', 'wiki-query'],
      disabled: ['Disabled-B'],
      unused: ['Disabled-B', 'plug-skill', 'unused-a'],
    });
    expect(data.installed).toEqual({ skills: ['Disabled-B', 'impeccable', 'plug-skill', 'unused-a', 'wiki-query'], disabled: ['Disabled-B'] });
    // 画面の未使用一覧は絞り込みに追従する(wiki-query だけを使った 004 のプロジェクトに絞ると impeccable も未使用)
    const p4 = s.sessions.find((x) => x.id === id(4))!.project;
    const used = aggregate(applyFilter(data.sessions, { ...emptyFilter(), project: p4 })).usage.skills.map((x) => x.name);
    expect(unusedSkills(data.installed!.skills, used)).toEqual(['Disabled-B', 'impeccable', 'plug-skill', 'unused-a']);
  });

  it('5. プロジェクトの統合: git の origin(worktree・上へ探す)・ホーム・一時フォルダ・atlas の判定', () => {
    const pj = (n: number): [string, string] => [rec(n).project, rec(n).projectSource];
    expect(pj(101)).toEqual(['zz-owner-qq/zz-alpha-repo', 'git-remote']);
    expect(pj(102)).toEqual(['zz-owner-qq/zz-alpha-repo', 'git-remote']); // gitRoot の記録なし → cwd から上へ
    expect(pj(103)).toEqual(['zz-owner-qq/zz-alpha-repo', 'git-remote']); // worktree
    expect(pj(104)).toEqual(['zz-owner-qq/zz-beta-repo', 'git-remote']); // scp 形式の URL
    expect(pj(105)).toEqual([projectKey(null, repos.local, repos.local), 'path']); // origin なし
    expect(pj(106)).toEqual([HOME_PROJECT, 'home']);
    expect(pj(12)).toEqual([TEMP_PROJECT, 'temp']);
    expect(pj(13)).toEqual([ATLAS_JUDGE_PROJECT, 'atlas-judge']);
    expect(pj(11)).toEqual([P6, 'path']);
    expect(pj(4)[1]).toBe('repository');
    expect(m.byProject['zz-owner-qq/zz-alpha-repo'].sessions).toBe(3);
    expect(Object.keys(m.byProject)).toEqual(expect.arrayContaining([HOME_PROJECT, TEMP_PROJECT, ATLAS_JUDGE_PROJECT]));
    // 元のリポジトリは書き換えない(.git/config・worktree の .git・commondir の内容と mtime がそのまま)
    return gitFiles(repos).then((after) => expect(after).toEqual(gitBefore));
  });

  it('6. 全体サマリと月別推移に premium request と AIU、HTML に新しい欄が出る、5MB 未満', () => {
    const agg = aggregate(applyFilter(data.sessions, emptyFilter()));
    expect(agg.overall.tokens.premiumRequests).toBe(m.overall.tokens.premiumRequests);
    expect(agg.overall.tokens.nanoAiu).toBe(m.overall.tokens.nanoAiu);
    const oct = agg.byMonth.find((b) => b.key === '2026-10')!;
    expect(oct.tokens.premiumRequests).toBe(m.byMonth['2026-10'].tokens.premiumRequests);
    expect(oct.sessionsWithPremium).toBeGreaterThan(0);
    for (const t of [
      '利用ランキング',
      '全件を表で見る',
      'MCP サーバー',
      'インストール済みで未使用の skill',
      '失敗率',
      '変更行数',
      'premium request',
      'AI 使用量(AIU)',
      'プロジェクトのまとめ方',
    ])
      expect(html).toContain(t);
    expect(Buffer.byteLength(html)).toBeLessThan(LIMIT);
  });

  it('--anonymize でリポジトリ名・パス・ファイル名が出ない(MCP サーバー名と skill 名は出してよい)', async () => {
    const anonOut = join(WORK, 'out-anon');
    const r = atlas(['all', '--home', home, '--out', anonOut, '--anonymize', '--temp-dir', TEMP_DIR]);
    expect(r.status, r.stderr).toBe(0);
    const files = [join(anonOut, 'atlas.html'), ...(await readdir(join(anonOut, 'sessions'))).map((f) => join(anonOut, 'sessions', f))];
    const secrets = ['zz-owner-qq', 'zz-alpha-repo', 'zz-beta-repo', 'zz-local-repo', 'zz-alpha-wt', 'zz-someone', 'synthetic-p6', 'gone.txt', 'main.ts', 'new.ts', 'secret.env', 'X--synthetic', 'atlas-judge-cwd-AbC123'];
    for (const f of files) {
      const h = await readFile(f, 'utf8');
      const leaked = secrets.filter((x) => h.includes(x));
      expect({ f, leaked }).toEqual({ f, leaked: [] });
    }
    const d = extractEmbedded<ReportData>(await readFile(files[0], 'utf8'));
    expect(d.sessions.find((x) => x.id === id(11))?.tools.mcp).toEqual({ 'github-mcp-server': { 'github-mcp-server-search_code': 1, 'github-mcp-server-get_file_contents': 1 }, ide: { 'ide-get_diagnostics': 1 } });
    expect(new Set(d.sessions.map((x) => x.project))).toEqual(new Set([...d.sessions.map((x) => x.project)].filter((p) => /^project-\d+$/.test(p) || p.startsWith('('))));
    expect(d.sessions.find((x) => x.id === id(12))?.project).toBe(TEMP_PROJECT);
  });
});

describe.skipIf(!LIVE)('Phase 6 E2E: 実データ(ATLAS_LIVE=1)', () => {
  const src = process.env.ATLAS_COPILOT_HOME ?? join(homedir(), '.copilot');
  const out = join(ROOT, 'out', 'live');
  let s: SessionsFile;
  let m: MetricsFile;
  let r: ReturnType<typeof atlas>;

  beforeAll(async () => {
    r = atlas(['all', '--home', src, '--out', out]);
    if (r.status !== 0) throw new Error(`atlas all が失敗: ${r.stderr}\n${r.stdout}`);
    s = await readJson<SessionsFile>(join(out, 'sessions.json'));
    m = await readJson<MetricsFile>(join(out, 'metrics.json'));
  });

  it('プロジェクト数(統合前 → 後)・上位のツール / MCP / skill / agent・未使用の skill・変更行数・失敗率・サイズをログに出す', async () => {
    const nonEmpty = s.sessions.filter((x) => !x.empty);
    const before = new Set(nonEmpty.map((x) => projectKey(x.repository, x.gitRoot, x.cwd)));
    const after = new Set(nonEmpty.map((x) => x.project));
    const bySource: Record<string, number> = {};
    for (const x of nonEmpty) bySource[x.projectSource] = (bySource[x.projectSource] ?? 0) + 1;
    const html = await readFile(join(out, 'atlas.html'), 'utf8');
    const data = extractEmbedded<ReportData>(html);
    const agg = aggregate(applyFilter(data.sessions, emptyFilter()));
    const u = agg.usage;
    const top = <T>(xs: T[], f: (x: T) => string, k = 10): string => xs.slice(0, k).map(f).join(', ');
    const rates = u.tools
      .filter((t) => t.completed >= 5 && (failureRate(t) ?? 0) > 0)
      .sort((a, b) => (failureRate(b) ?? 0) - (failureRate(a) ?? 0) || b.calls - a.calls)
      .slice(0, 8);
    const embedded = Buffer.byteLength(JSON.stringify(data));
    const grouped = [...after].filter((p) => p.startsWith('('));
    console.log(
      `[live] atlas all ${r.ms.toFixed(0)}ms, sessions=${s.sessions.length}, nonEmpty=${nonEmpty.length}\n` +
        `[live] プロジェクト数(非空): 統合前 ${before.size} → 統合後 ${after.size}、決め方=${JSON.stringify(bySource)}、まとめ=${grouped.map((g) => `${g} ${nonEmpty.filter((x) => x.project === g).length}`).join(' / ')}\n` +
        `[live] 上位のツール: ${top(u.tools, (t) => `${t.mcpServer ? '[MCP]' : ''}${t.label} ${t.calls}`)}\n` +
        `[live] MCP サーバー: ${top(u.mcp, (x) => `${x.server} ${x.calls}(${x.tools.length} 種)`)}\n` +
        `[live] skill: ${top(u.skills, (x) => `${x.name} ${x.uses}(利用者 ${x.user}/エージェント ${x.agent}/不明 ${x.unknown})`)}\n` +
        `[live] agent: ${top(u.agents, (x) => `${x.name} ${x.runs}(失敗 ${x.failed}、トークン ${x.tokens})`)}\n` +
        `[live] hook: ${top(u.hooks, (x) => `${x.name} ${x.count}`)}\n` +
        `[live] 指示ファイル: ${top(u.instructions, (x) => `${x.name} ${x.sessions}`)}\n` +
        `[live] インストール済み ${m.installedSkills?.installed.length ?? '記録なし'} 件、未使用 ${m.installedSkills?.unused.length ?? '-'} 件: ${m.installedSkills?.unused.join(', ')}(無効: ${m.installedSkills?.disabled.join(', ')})\n` +
        `[live] 変更行数: +${m.overall.lines.added} / -${m.overall.lines.removed}(記録あり ${m.overall.lines.sessionsWithRecord} / ${nonEmpty.length}、出所 ${JSON.stringify(m.overall.lines.bySource)})\n` +
        `[live] ツール失敗率の上位(結果 5 回以上): ${rates.map((t) => `${t.label} ${(((failureRate(t) ?? 0) * 100).toFixed(1))}%(失敗 ${t.failure}・拒否 ${t.denied} / ${t.completed})`).join(', ')}\n` +
        `[live] premium request ${m.overall.tokens.premiumRequests}(記録あり ${agg.overall.sessionsWithPremium} セッション)、AIU ${(m.overall.tokens.nanoAiu / 1e9).toFixed(2)}\n` +
        `[live] atlas.html ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)}MB(埋め込みデータ ${(embedded / 1024 / 1024).toFixed(2)}MB)`,
    );
    expect(Buffer.byteLength(html)).toBeLessThan(LIMIT);
    expect(after.size).toBeLessThanOrEqual(before.size);
    expect(m.overall.lines.added).toBe(nonEmpty.reduce((a, x) => a + x.lines.added, 0));
    expect(agg.overall.linesAdded).toBe(m.overall.lines.added);
    // atlas-judge-cwd-* は (atlas の判定) に、一時フォルダの probe は (一時フォルダ) にまとまる
    expect(nonEmpty.filter((x) => /atlas-judge-cwd-/.test(x.cwd ?? '') && x.project !== ATLAS_JUDGE_PROJECT)).toEqual([]);
    expect(nonEmpty.filter((x) => /[\\/]AppData[\\/]Local[\\/]Temp[\\/]claude[\\/]/i.test(x.cwd ?? '') && !x.repository && x.project !== TEMP_PROJECT).map((x) => x.cwd)).toEqual([]);
  });
});
