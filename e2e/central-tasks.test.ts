// 本番の置き方(共有の場所に、送り先 SessionLog と設定のフォルダ AtlasSettings を並べる)で、集計する人がタスクを紐づける流れを、
// 架空の fixture とテスト用の XML(e2e/fixtures/tasks/。架空のタスクだけ)で通しで確かめる。
//  a. atlas open <SessionLog> は上へ探して AtlasSettings を見つけ、その設定で集計する。機械の紐づけは AtlasSettings の task-links.json に書き、
//     タスクの節(origin: local)と表紙のタスクの工数(summary)が出る。送った人が添えたタスクの記録(task)は使わない。
//     画面はメモについて読むだけのまま、タスクの紐づけは読むだけにしない(GET api/tasks の readOnly が false、上部に「設定: AtlasSettings」)
//  b. その画面のジョブで tasks bundle(束は開いたフォルダの出力先)→ 偽の返答を CLI の tasks import(--out に開いたフォルダの出力先)で取り込むと、
//     AtlasSettings の task-links.json に書かれ、レポートも作り直される
//  c. 設定のフォルダが無ければ今までどおり(送った人の記録から、読むだけ)
//  d. --settings で指せる。次に開くときは、前に使った設定のフォルダを使う
// 時刻は UTC で動かす(稼働時間帯はこの PC の時刻で数えるので、どの PC でも同じ値になるように)
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionsFile } from '../packages/report/src/shared/types.ts';
import type { ReportData, TasksReport } from '../packages/report/src/lib/types.ts';
import { addPromptSession, buildFixtureHome, FIXTURE_WIKIS, ROOT, cliCommand, uploadDirName } from './fixture-home.ts';
import { folderPaths, foldersRootOf } from './folders.ts';

const WORK = join(ROOT, 'out', 'e2e-central-tasks');
const XML_DIR = join(ROOT, 'e2e', 'fixtures', 'tasks');
/** 機械で DEMO-101 に紐づくセッション(依頼の文がタスクの名前と同じ)。送った人は手動で DEMO-103 に紐づけて送る */
const S_FIX = '00000000-0000-4000-8000-000000000008';
/** 機械で DEMO-102 に紐づくセッション(別のプロジェクト。もう 1 人の分として送る) */
const S_IMPROVE = '00000000-0000-4000-8000-000000000011';
/** 依頼に 2 つのタスクの ID を書いたセッション(S_FIX と同じプロジェクト) */
const S_MULTI = '00000000-0000-4000-8000-000000000021';
/** 機械では決まらないセッション(S_FIX と同じプロジェクト。LLM に頼む束に入る) */
const S_VAGUE = '00000000-0000-4000-8000-000000000022';
const T_XML = new Date('2026-10-23T12:00:00.000Z');

type Links = { version: number; links: Record<string, { taskIds: string[]; source: string; reason: string }> };

describe('本番の置き方: 設定のフォルダ(AtlasSettings)を使い、集計する側でタスクを紐づける', () => {
  let close: () => Promise<void>;
  let home: string;
  /** 送る人の PC(メモの置き場は <repo>/atlas-notes) */
  const sender = join(WORK, 'sender');
  /** 集計する人の PC(ATLAS_REPO_ROOT。いつもの出力先とメモの置き場) */
  const collector = join(WORK, 'collector');
  const localOut = join(collector, 'out');
  const localNotes = join(collector, 'atlas-notes');
  /** 共有の場所(\\server\share の代わり) */
  const share = join(WORK, 'share');
  const sessionLog = join(share, 'SessionLog');
  const settings = join(share, 'AtlasSettings');
  /** 設定のフォルダが上に無い、同じ送り先の写し */
  const plainLog = join(WORK, 'plain', 'SessionLog');

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...process.env, TZ: 'UTC', ATLAS_REPO_ROOT: collector, ATLAS_COPILOT_HOME: home, ...extra });
  function atlas(args: string[], extra: NodeJS.ProcessEnv = {}): { status: number | null; out: string } {
    const r = spawnSync(...cliCommand(args), { encoding: 'utf8', cwd: ROOT, timeout: 600_000, env: env(extra) });
    return { status: r.status, out: r.stdout + r.stderr };
  }
  const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
  const embedded = async (out: string): Promise<ReportData> => {
    const html = await readFile(join(out, 'atlas.html'), 'utf8');
    const m = /<script type="application\/json" id="atlas-data">([\s\S]*?)<\/script>/.exec(html);
    return JSON.parse(m![1]) as ReportData;
  };

  /** atlas open を起動し、サーバが応え始めるまで待つ(e2e/phase16.test.ts と同じ形) */
  async function openUntilServing(args: string[]): Promise<{ url: string; token: string; output: () => string; stop: () => Promise<void> }> {
    const child = spawn(...cliCommand(['open', ...args, '--out', localOut, '--notes-dir', localNotes, '--no-open', '--port', '0']), { cwd: ROOT, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    const stop = async (): Promise<void> => {
      child.kill();
      if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
    };
    try {
      const url = await new Promise<string>((ok, ng) => {
        const t = setTimeout(() => ng(new Error(`open が起動しない: ${output}`)), 150_000);
        child.once('exit', (code) => {
          clearTimeout(t);
          ng(new Error(`open が終わった(${code}): ${output}`));
        });
        const tick = (): void => {
          const m = /serve: (http:\/\/127\.0\.0\.1:\d+\/atlas\.html)/.exec(output);
          if (m) {
            clearTimeout(t);
            ok(m[1]);
          } else setTimeout(tick, 100);
        };
        tick();
      });
      const token = /<meta name="atlas-token" content="([^"]+)"/.exec(await (await fetch(url)).text())![1];
      return { url, token, output: () => output, stop };
    } catch (e) {
      await stop();
      throw e;
    }
  }
  const api = async <T>(url: string, token: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const r = await fetch(new URL(path, url), { ...init, headers: { 'content-type': 'application/json', 'x-atlas-token': token, ...(init.headers ?? {}) } });
    return { status: r.status, body: (await r.json()) as T };
  };

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    await mkdir(sender, { recursive: true });
    await mkdir(collector, { recursive: true });
    ({ home, close } = await buildFixtureHome(join(WORK, 'home'), {}));
    await addPromptSession(home, { id: S_MULTI, cwd: 'X:\\synthetic-new', createdAt: '2026-10-16T00:00:00.000Z', prompt: 'DEMO-103 と DEMO-102-1 をまとめて直してください', activeMinutes: 60 });
    await addPromptSession(home, { id: S_VAGUE, cwd: 'X:\\synthetic-new', createdAt: '2026-10-17T00:00:00.000Z', prompt: '画面まわりを少し見直したい', activeMinutes: 30 });
    // 送る人: XML を読んで紐づけ、S_FIX だけは手動で DEMO-103 に紐づけてから、2 つのプロジェクトを送る
    const senderXml = join(sender, 'export.xml');
    copyFileSync(join(XML_DIR, 'export-before.xml'), senderXml);
    utimesSync(senderXml, T_XML, T_XML);
    const senderOut = join(sender, 'out');
    const senderCfg = join(sender, 'atlas.config.json');
    await writeFile(senderCfg, JSON.stringify({ wikis: FIXTURE_WIKIS, tasks: { file: senderXml } }));
    const first = atlas(['all', '--home', home, '--out', senderOut], { ATLAS_REPO_ROOT: sender, ATLAS_CONFIG: senderCfg });
    expect(first.status, first.out).toBe(0);
    const senderLinks = join(sender, 'atlas-notes', 'task-links.json');
    const l = await readJson<Links>(senderLinks);
    l.links[S_FIX] = { taskIds: ['DEMO-103'], source: 'manual', reason: '', confidence: null, at: '2026-10-24T00:00:00.000Z' } as Links['links'][string];
    await writeFile(senderLinks, JSON.stringify(l));
    const sessions = (await readJson<SessionsFile>(join(senderOut, 'sessions.json'))).sessions;
    const projectOf = (id: string): string => sessions.find((s) => s.id === id)!.project;
    expect(projectOf(S_FIX)).not.toBe(projectOf(S_IMPROVE));
    const alice = join(sessionLog, 'alice');
    await mkdir(alice, { recursive: true });
    await writeFile(senderCfg, JSON.stringify({ wikis: FIXTURE_WIKIS, tasks: { file: senderXml }, uploadRoot: alice, uploadProjects: [projectOf(S_FIX), projectOf(S_IMPROVE)] }));
    const up = spawnSync(...cliCommand([], 'upload-project'), { encoding: 'utf8', cwd: ROOT, timeout: 600_000, input: 'y\n', env: env({ ATLAS_REPO_ROOT: sender, ATLAS_OUT: senderOut, ATLAS_CONFIG: senderCfg }) });
    expect(up.status, up.stdout + up.stderr).toBe(0);
    // S_IMPROVE のプロジェクトは、もう 1 人(bob)が送ったものにする
    await mkdir(join(sessionLog, 'bob'), { recursive: true });
    await rename(join(alice, uploadDirName(projectOf(S_IMPROVE))), join(sessionLog, 'bob', uploadDirName(projectOf(S_IMPROVE))));
    const sent = await readJson<{ tasks?: { id: string; source: string }[] }>(join(alice, uploadDirName(projectOf(S_FIX)), S_FIX, 'atlas-session.json'));
    expect(sent.tasks?.map((t) => [t.id, t.source])).toEqual([['DEMO-103', 'manual']]);
    await cp(sessionLog, plainLog, { recursive: true });
    // 設定のフォルダ: 集計の設定と、管理ツールが書き出した XML(相対パスは設定ファイルのフォルダから)
    await mkdir(settings, { recursive: true });
    copyFileSync(join(XML_DIR, 'export-before.xml'), join(settings, 'export.xml'));
    utimesSync(join(settings, 'export.xml'), T_XML, T_XML);
    await writeFile(join(settings, 'atlas.config.json'), JSON.stringify({ wikis: FIXTURE_WIKIS, tasks: { file: 'export.xml', workHours: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '24:00' } } }));
  }, 600_000);
  afterAll(async () => close?.());

  it('a・b. 上へ探して設定のフォルダを見つけ、集計する側で紐づける(画面の束 → CLI の取り込み)', async () => {
    const fp = folderPaths(foldersRootOf(localOut), localNotes, sessionLog);
    const opened = await openUntilServing([sessionLog]);
    try {
      const out = opened.output();
      expect(out).toContain(`open: 設定のフォルダ ${settings}(開いたフォルダから上へ探して見つけたもの)`);
      expect(out).toContain('タスクの紐づけは、ここで集計する人が行い、設定のフォルダに書きます');
      expect(await readJson<{ settings?: string }>(fp.state)).toMatchObject({ path: sessionLog, settings });
      // 機械の紐づけは設定のフォルダに。送った人の手動の紐づけ(S_FIX → DEMO-103)は使わない
      const links = await readJson<Links>(join(settings, 'task-links.json'));
      expect([links.links[S_FIX]?.taskIds, links.links[S_FIX]?.source]).toEqual([['DEMO-101'], 'machine']);
      expect([links.links[S_IMPROVE]?.taskIds, links.links[S_IMPROVE]?.source]).toEqual([['DEMO-102'], 'machine']);
      expect(links.links[S_MULTI]?.taskIds).toEqual(['DEMO-102-1', 'DEMO-103']);
      expect(existsSync(join(settings, 'tasks.json'))).toBe(true);
      // 開いたフォルダのメモの置き場にも、集計する人のいつものメモの置き場にも、タスクを置かない
      expect(existsSync(join(fp.notes, 'task-links.json'))).toBe(false);
      expect(existsSync(join(localNotes, 'task-links.json'))).toBe(false);
      // レポート: タスクの節は設定のフォルダの記録から(origin: local)。表紙のタスクの工数も同じ summary から出る
      const data = await embedded(fp.out);
      const v = data.tasks as TasksReport;
      expect(v.origin).toBe('local');
      expect(v.links[S_FIX]).toMatchObject({ taskIds: ['DEMO-101'], source: 'machine' });
      expect(v.items.map((t) => t.id)).toEqual(['DEMO-101', 'DEMO-102', 'DEMO-102-1', 'DEMO-103', 'DEMO-104', 'DEMO-106']);
      // 表紙のタスクの工数(5 つ目の欄)は、この summary をそのまま出す(紐づいたタスクの数を数える)
      expect(v.summary.tasks).toBe(4);
      // 稼働時間帯は設定のフォルダの設定(毎日 0:00〜24:00)
      expect(v.workHours).toEqual({ days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '24:00' });
      expect(data.readOnly).toBe(true);
      // 画面: メモは読むだけ、タスクの紐づけは変えられる。上部に出す設定のフォルダ
      const { url, token } = opened;
      expect((await api<{ readOnly: boolean }>(url, token, 'api/state')).body.readOnly).toBe(true);
      const t = await api<{ readOnly: boolean; tasks: TasksReport }>(url, token, 'api/tasks');
      expect([t.body.readOnly, t.body.tasks.origin]).toEqual([false, 'local']);
      const folders = await api<{ current: { settings: { name: string; path: string } | null } }>(url, token, 'api/folders');
      expect(folders.body.current.settings).toMatchObject({ name: 'AtlasSettings', path: settings });
      const memo = await api<{ error: string }>(url, token, `api/memos/${S_FIX}`, { method: 'PUT', body: JSON.stringify({ text: 'x', rev: '' }) });
      expect(memo.status).toBe(403);

      // b. 画面の「判定する…」の「タスクの紐づけ」と同じジョブで束を作る(束は開いたフォルダの出力先に)
      const job = await api<{ id: string }>(url, token, 'api/jobs', { method: 'POST', body: JSON.stringify({ kind: 'task-bundle' }) });
      expect(job.status, JSON.stringify(job.body)).toBe(202);
      let cur: { id: string; state: string; log: string[] } | null = null;
      for (let i = 0; i < 600; i++) {
        cur = (await api<{ id: string; state: string; log: string[] }>(url, token, 'api/jobs/current')).body;
        if (cur.state !== 'running') break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(cur?.state, cur?.log.join('\n')).toBe('done');
      const raw = await readJson<{ sessions: { id: string }[] }>(join(fp.out, 'task-bundle', 'manifest.json'));
      const cands = await readJson<{ sessions: Record<string, string[]> }>(join(fp.out, 'task-bundle', 'candidates.json'));
      const m = { sessions: raw.sessions.map((e) => ({ id: e.id, candidates: cands.sessions[e.id] })) };
      expect(m.sessions.map((s) => s.id)).toContain(S_VAGUE);
      expect(m.sessions.map((s) => s.id)).not.toContain(S_FIX);
      // 偽の返答を CLI で取り込む(--out に開いたフォルダの出力先。設定のフォルダは開いたフォルダの記録から決まる)
      const pick = m.sessions[0];
      const reply = join(WORK, 'reply.md');
      await writeFile(reply, '```json\n' + JSON.stringify({ links: [{ sessionId: pick.id, taskIds: [pick.candidates[0]], confidence: 0.8, reason: '偽の返答' }] }) + '\n```\n');
      const imp = atlas(['tasks', 'import', reply, '--out', fp.out, '--notes-dir', fp.notes]);
      expect(imp.status, imp.out).toBe(0);
      expect(imp.out).toContain(`tasks import: 1 セッションの紐づけを取り込みました(出所 LLM)→ ${join(settings, 'task-links.json')}`);
      expect(imp.out).toMatch(/export: /);
      expect((await readJson<Links>(join(settings, 'task-links.json'))).links[pick.id]).toMatchObject({ taskIds: [pick.candidates[0]], source: 'llm', reason: '偽の返答' });
      expect(((await embedded(fp.out)).tasks as TasksReport).links[pick.id]).toMatchObject({ source: 'llm' });
      expect(existsSync(join(fp.notes, 'task-links.json'))).toBe(false);
    } finally {
      await opened.stop();
    }
  }, 600_000);

  it('c. 設定のフォルダが無ければ今までどおり(送った人の記録から、タスクも読むだけ)', async () => {
    const fp = folderPaths(foldersRootOf(localOut), localNotes, plainLog);
    const opened = await openUntilServing([plainLog]);
    try {
      expect(opened.output()).not.toContain('open: 設定のフォルダ');
      expect((await readJson<{ settings?: string }>(fp.state)).settings).toBeUndefined();
      const v = (await embedded(fp.out)).tasks as TasksReport;
      expect(v.origin).toBe('sender');
      expect(v.links[S_FIX]).toMatchObject({ taskIds: ['DEMO-103'], source: 'manual' });
      const t = await api<{ readOnly: boolean }>(opened.url, opened.token, 'api/tasks');
      expect(t.body.readOnly).toBe(true);
      const folders = await api<{ current: { settings: unknown } }>(opened.url, opened.token, 'api/folders');
      expect(folders.body.current.settings).toBeNull();
      // CLI でも、タスクの状態の無い出力先では束を作れない
      expect(atlas(['tasks', 'bundle', '--out', fp.out, '--notes-dir', fp.notes]).status).not.toBe(0);
    } finally {
      await opened.stop();
    }
  }, 600_000);

  it('d. --settings で指せる。次に開くときは、前に使った設定のフォルダを使う', async () => {
    const fp = folderPaths(foldersRootOf(localOut), localNotes, plainLog);
    const given = await openUntilServing([plainLog, '--settings', settings]);
    try {
      expect(given.output()).toContain(`open: 設定のフォルダ ${settings}(--settings で指したもの)`);
      const v = (await embedded(fp.out)).tasks as TasksReport;
      expect(v.origin).toBe('local');
      expect(v.links[S_FIX]).toMatchObject({ taskIds: ['DEMO-101'], source: 'machine' });
    } finally {
      await given.stop();
    }
    expect((await readJson<{ settings?: string }>(fp.state)).settings).toBe(settings);
    const again = await openUntilServing([plainLog]);
    try {
      expect(again.output()).toContain(`open: 設定のフォルダ ${settings}(前にこのフォルダを開いたときに使ったもの)`);
      expect(((await embedded(fp.out)).tasks as TasksReport).origin).toBe('local');
    } finally {
      await again.stop();
    }
  }, 600_000);

  /** 工数の判定の返答(画面に貼るもの) */
  const effortReply = (ids: string[], summary: string): string =>
    '```json\n' +
    JSON.stringify({
      items: ids.map((id) => ({
        sessionId: id,
        taskCategory: 'feature',
        taskSummary: summary,
        humanEffort: { hours: 3, low: 2, high: 5, confidence: 0.5, rationale: '根拠' },
        aiOutcome: { completed: true, quality: 4, rework: 0, rationale: '成果' },
        instructionsEffect: { score: 0, evidence: '参照なし' },
        wikiEffect: { score: 0, evidence: '参照なし' },
        skillsAgentsEffect: { score: 0, evidence: '参照なし' },
      })),
    }) +
    '\n```\n';
  type Judgments = { items: { sessionId: string; taskSummary: string }[] };

  it('e. 判定は設定のフォルダで共有する: 画面で取り込むと AtlasSettings に書かれ、2 回の取り込みが混ざり、人のフォルダで開いても使われる', async () => {
    const root = folderPaths(foldersRootOf(localOut), localNotes, sessionLog);
    const aliceDir = join(sessionLog, 'alice');
    const alice = folderPaths(foldersRootOf(localOut), localNotes, aliceDir);
    const shared = join(settings, 'judgments.json');
    const sharedTurns = join(settings, 'turn-judgments.json');
    const opened = await openUntilServing([sessionLog]);
    try {
      const { url, token } = opened;
      expect(opened.output()).toContain(`open: 工数と依頼ごとの判定は、設定のフォルダの ${shared} と ${sharedTurns} を使います`);
      const first = await api<{ imported: number; overwritten: number }>(url, token, 'api/judge/import', { method: 'POST', body: JSON.stringify({ text: effortReply([S_FIX], '1 回目') }) });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect((await readJson<Judgments>(shared)).items.map((i) => i.sessionId)).toEqual([S_FIX]);
      expect(existsSync(join(root.out, 'judgments.json'))).toBe(false);
      // 2 回目の取り込み(別のセッションと、同じセッションの判定し直し)は混ざる。同じセッションは後から取り込んだもの
      const second = await api<{ imported: number; overwritten: number; total: number }>(url, token, 'api/judge/import', { method: 'POST', body: JSON.stringify({ text: effortReply([S_IMPROVE, S_FIX], '2 回目') }) });
      expect(second.body).toMatchObject({ imported: 2, overwritten: 1, total: 2 });
      const both = await readJson<Judgments>(shared);
      expect(Object.fromEntries(both.items.map((i) => [i.sessionId, i.taskSummary]))).toEqual({ [S_FIX]: '2 回目', [S_IMPROVE]: '2 回目' });
      // 依頼ごとの判定も設定のフォルダに
      const turns = { items: [{ sessionId: S_FIX, turn: 1, kind: 'question', outcome: 'follow_up', mismatch: null, phase: '調査', confidence: 0.5, note: 'テスト用' }] };
      const t = await api<{ imported: number }>(url, token, 'api/judge/import?target=turns', { method: 'POST', body: JSON.stringify({ text: '```json\n' + JSON.stringify(turns) + '\n```' }) });
      expect(t.status, JSON.stringify(t.body)).toBe(200);
      expect(existsSync(sharedTurns)).toBe(true);
      expect(existsSync(join(root.out, 'turn-judgments.json'))).toBe(false);
      expect((await api<{ judged: number }>(url, token, 'api/jobs/judge-preview')).body.judged).toBe(2);
    } finally {
      await opened.stop();
    }
    // 人のフォルダ(別のパス)を開いても、同じ判定を使う。前にその出力先にあった判定は、共有の側を優先して混ぜて移す
    await mkdir(alice.out, { recursive: true });
    await writeFile(join(alice.out, 'judgments.json'), JSON.stringify({ schemaVersion: 1, judge: { backend: 'external', model: null, ranAt: '2026-10-01T00:00:00.000Z' }, items: JSON.parse(effortReply([S_FIX, S_MULTI], '前の出力先').split('\n')[1]).items }));
    const person = await openUntilServing([aliceDir]);
    try {
      const out = person.output();
      expect(out).toContain(`open: 設定のフォルダ ${settings}(開いたフォルダから上へ探して見つけたもの)`);
      expect(out).toContain(`settings: 出力先にあった工数の判定を、設定のフォルダの共有の置き場 ${shared} に移しました(足したセッション 1 件。`);
      // 前のファイルは、時刻を付けた名前に変えて残す(前に移したものを上書きしない)
      expect(readdirSync(alice.out).some((n) => /^judgments\.json\.moved-\d{8}T\d{6}/.test(n))).toBe(true);
      expect(existsSync(join(alice.out, 'judgments.json'))).toBe(false);
      const merged = Object.fromEntries((await readJson<Judgments>(shared)).items.map((i) => [i.sessionId, i.taskSummary]));
      expect(merged).toEqual({ [S_FIX]: '2 回目', [S_IMPROVE]: '2 回目', [S_MULTI]: '前の出力先' });
      const data = await embedded(alice.out);
      expect(data.judgments).toMatchObject({ available: true });
      expect(data.sessions.find((s) => s.id === S_FIX)?.judgment).toMatchObject({ taskSummary: '2 回目' });
      expect(data.turnJudgments).toMatchObject({ available: true, items: 1 });
      // 画面の判定済みの数も、共有の置き場から数える(人のフォルダにあるのは S_FIX・S_MULTI)
      expect((await api<{ judged: number }>(person.url, person.token, 'api/jobs/judge-preview')).body.judged).toBe(2);
    } finally {
      await person.stop();
    }
  }, 600_000);

  it('f. XML の完了日時(tasks.doneAt)があれば、それを完了の時刻(記録)にする', async () => {
    const share2 = join(WORK, 'share2');
    const log2 = join(share2, 'SessionLog');
    const settings2 = join(share2, 'AtlasSettings');
    await cp(plainLog, log2, { recursive: true });
    await mkdir(settings2, { recursive: true });
    // DEMO-101 は日付だけ(その日の稼働時間帯の終わり)、DEMO-104 は時差つきの日時、DEMO-103 は読めない値
    const xml = (await readFile(join(XML_DIR, 'export-before.xml'), 'utf8'))
      .replace('<Id>DEMO-101</Id>\n      <Name>fix the app</Name>\n      <Status>In Progress</Status>', '<Id>DEMO-101</Id>\n      <Name>fix the app</Name>\n      <Status>Done</Status>\n      <ClosedDate>2026/10/22</ClosedDate>')
      .replace('<Status>Done</Status>\n    </Task>', '<Status>Done</Status>\n      <ClosedDate>2026-10-20T12:00:00+09:00</ClosedDate>\n    </Task>')
      .replace('<Name>帳票の出力を速くする</Name>\n      <Status>Open</Status>', '<Name>帳票の出力を速くする</Name>\n      <Status>Done</Status>\n      <ClosedDate>先週</ClosedDate>');
    expect(xml.match(/<ClosedDate>/g)?.length).toBe(3);
    await writeFile(join(settings2, 'export.xml'), xml);
    utimesSync(join(settings2, 'export.xml'), T_XML, T_XML);
    await writeFile(join(settings2, 'atlas.config.json'), JSON.stringify({ wikis: FIXTURE_WIKIS, tasks: { file: 'export.xml', doneAt: 'ClosedDate', workHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' } } }));
    const out2 = join(WORK, 'out2');
    const r = atlas(['all', '--home', log2, '--out', out2, '--settings', settings2]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('完了日時(設定の tasks.doneAt)を読めない完了のタスク 1 件');
    type State = { tasks: Record<string, { doneAt: string | null; doneObserved: boolean; doneAtSource?: string; doneDateOnly?: boolean }> };
    const st = await readJson<State>(join(settings2, 'tasks.json'));
    // TZ=UTC: 日付だけは、その日の稼働時間帯の終わり(18:00)。日付だけだったことも残す(候補と「完了の後に始まった」はその日の終わりで見る)
    expect(st.tasks['DEMO-101']).toMatchObject({ doneAt: '2026-10-22T18:00:00.000Z', doneObserved: true, doneAtSource: 'recorded', doneDateOnly: true });
    expect(st.tasks['DEMO-104']).toMatchObject({ doneAt: '2026-10-20T03:00:00.000Z', doneObserved: true, doneAtSource: 'recorded' });
    expect(st.tasks['DEMO-104'].doneDateOnly).toBeUndefined();
    // 読めない値は観測(初めて見たときに完了なので、時刻は分からない)
    expect(st.tasks['DEMO-103']).toMatchObject({ doneAt: T_XML.toISOString(), doneObserved: false, doneAtSource: 'observed' });
    const v = (await embedded(out2)).tasks as TasksReport;
    expect(v.items.find((t) => t.id === 'DEMO-101')).toMatchObject({ doneAtSource: 'recorded', doneAt: '2026-10-22T18:00:00.000Z', doneDateOnly: true });
    expect(v.items.find((t) => t.id === 'DEMO-103')).toMatchObject({ doneAtSource: 'observed' });
    // セッションが紐づいた完了タスク: DEMO-101(記録)と DEMO-103(観測。S_MULTI が紐づく)
    expect(v.summary.doneSources).toEqual({ recorded: 1, observed: 1 });
    const csv = (await readFile(join(out2, 'tables', 'tasks.csv'), 'utf8')).replace(/^\uFEFF/, '').split('\r\n');
    const head = csv[0].split(',');
    const col = head.indexOf('完了時刻の出所');
    expect(col).toBeGreaterThan(0);
    const row101 = csv.find((l) => l.startsWith('DEMO-101,'))!.split(',');
    expect(row101[col]).toBe('記録(日付だけ)');
    // 設定のフォルダを使う回でも、CLI の judge import は取り込めたらレポートを作り直す(export。tasks import と同じ)
    const reply = join(WORK, 'reply-effort-settings2.md');
    await writeFile(reply, effortReply([S_FIX], 'CLI で取り込み'));
    const imp = atlas(['judge', 'import', reply, '--out', out2, '--settings', settings2]);
    expect(imp.status, imp.out).toBe(0);
    expect(imp.out).toContain(`judge import: 1 件を取り込みました(既存の上書き 0 件、取り込み元の重複 0 件)→ ${join(settings2, 'judgments.json')}`);
    expect(imp.out).toMatch(/export: /);
    expect((await embedded(out2)).sessions.find((s) => s.id === S_FIX)?.judgment).toMatchObject({ taskSummary: 'CLI で取り込み' });
  }, 600_000);

  it('g. 設定のフォルダが無ければ、判定は今までどおり出力先に置く', async () => {
    const out3 = join(WORK, 'out3');
    expect(atlas(['all', '--home', plainLog, '--out', out3]).status).toBe(0);
    const reply = join(WORK, 'reply-effort.md');
    await writeFile(reply, effortReply([S_FIX], 'ふだんの置き場'));
    const before = existsSync(join(settings, 'judgments.json')) ? await readFile(join(settings, 'judgments.json'), 'utf8') : null;
    const r = atlas(['judge', 'import', reply, '--out', out3]);
    expect(r.status, r.out).toBe(0);
    // 取り込めたらレポートを作り直す
    expect(r.out).toMatch(/export: /);
    expect((await embedded(out3)).sessions.find((s) => s.id === S_FIX)?.judgment).toMatchObject({ taskSummary: 'ふだんの置き場' });
    expect((await readJson<Judgments>(join(out3, 'judgments.json'))).items.map((i) => i.taskSummary)).toEqual(['ふだんの置き場']);
    expect(existsSync(join(settings, 'judgments.json')) ? await readFile(join(settings, 'judgments.json'), 'utf8') : null).toBe(before);
  }, 600_000);
});
