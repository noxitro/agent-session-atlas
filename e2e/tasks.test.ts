// 管理ツールのタスク(設定の tasks)を、テスト用の XML(e2e/fixtures/tasks/。架空のタスクだけ)と架空の fixture で通しで確かめる。
//  a. 設定に tasks を書いて atlas all → XML を読んで tasks.json を作り、題名・依頼の文に名前が当たるセッションを機械で紐づける。
//     依頼に 2 つのタスクの ID を書いたセッションは、両方に紐づく(実働はタスクの数で等分)。
//     tasks.csv・sessions.csv のタスクの列・session-tasks.csv に出る
//  b. 後の書き出し(export-after.xml)に差し替えて tasks sync → 完了になったタスクに完了を確認した時刻(XML の更新時刻)が入る。
//     稼働時間帯の工数は、開始から完了を確認した時刻までのうち稼働時間帯に入る時間(時刻を決めて、時間の値まで確かめる)
//  c. 推定人手工数(judgments.json)を取り込むと、比べられるタスクと、外した理由が出る
//  d. tasks link --llm(偽の copilot)で、機械で決まらなかったセッションを LLM で紐づけ、レポートを作り直す
//  e. 属性と名前空間を使う XML も、読み方の設定(@ で属性)で読める
//  f. プロジェクトを送ると、atlas-session.json にタスクが添えられ、送り先から集計した読むだけの出力にもタスクの節が出る
// 時刻は UTC で動かす(稼働時間帯はこの PC の時刻で数えるので、どの PC でも同じ値になるように)
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, utimesSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionsFile } from '../packages/report/src/shared/types.ts';
import type { ReportData, TasksReport } from '../packages/report/src/lib/types.ts';
import { addPromptSession, buildFixtureHome, FIXTURE_CODE, FIXTURE_WIKIS, FIXTURES, ROOT, cliCommand, uploadDirName } from './fixture-home.ts';

const WORK = join(ROOT, 'out', 'e2e-tasks');
const XML_DIR = join(ROOT, 'e2e', 'fixtures', 'tasks');
const FAKE = join(FIXTURE_CODE, 'fake-copilot.mjs');
/** 機械で紐づくセッション(fixture の依頼の文がタスクの名前と同じ) */
const S_FIX = '00000000-0000-4000-8000-000000000008';
const S_IMPROVE = '00000000-0000-4000-8000-000000000011';
/** 依頼に 2 つのタスクの ID(DEMO-103 と DEMO-102-1)を書いたセッション(このテストで足す。S_FIX と同じプロジェクト。実働 60 分) */
const S_MULTI = '00000000-0000-4000-8000-000000000021';
/** 最初の書き出しの更新時刻と、後の書き出しの更新時刻(金曜の 12:00 UTC) */
const T_BEFORE = new Date('2026-10-14T00:00:00.000Z');
const T_AFTER = new Date('2026-10-23T12:00:00.000Z');

/** CSV を行と列に(引用符の中のカンマ・改行は fixture に無い。先頭の BOM は除く) */
function csv(text: string): Record<string, string>[] {
  const [head, ...rows] = text.replace(/^﻿/, '').trimEnd().split(/\r?\n/);
  const cols = head.split(',');
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])));
}

describe('管理ツールのタスク(XML の読み込み・紐づけ・工数)', () => {
  let close: () => Promise<void>;
  let home: string;
  /** ATLAS_REPO_ROOT にする場所(既定のメモの置き場 atlas-notes/ がこの下になる。プロジェクトを送る操作がここから読む) */
  const repo = join(WORK, 'repo');
  const out = join(WORK, 'out');
  const notes = join(repo, 'atlas-notes');
  const xml = join(WORK, 'export.xml');
  const configPath = join(WORK, 'atlas.config.json');
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, TZ: 'UTC', ATLAS_REPO_ROOT: repo, ATLAS_CONFIG: configPath, ATLAS_COPILOT_HOME: home, ATLAS_COPILOT_BIN: FAKE, FAKE_COPILOT_LOG: join(WORK, 'fake-copilot.log') });
  function atlas(args: string[], extra: NodeJS.ProcessEnv = {}): { status: number | null; out: string } {
    const r = spawnSync(...cliCommand(args), { encoding: 'utf8', cwd: ROOT, timeout: 600_000, env: { ...env(), ...extra } });
    return { status: r.status, out: r.stdout + r.stderr };
  }
  /** XML を置き換え、更新時刻(完了を確認した時刻になる)を決める */
  function putXml(name: string, at: Date, to = xml): void {
    copyFileSync(join(XML_DIR, name), to);
    utimesSync(to, at, at);
  }
  const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
  const tasksCsv = async (dir = out): Promise<Record<string, string>[]> => csv(await readFile(join(dir, 'tables', 'tasks.csv'), 'utf8'));
  const sessionsCsv = async (dir = out): Promise<Record<string, string>[]> => csv(await readFile(join(dir, 'tables', 'sessions.csv'), 'utf8'));
  const row = (rows: Record<string, string>[], id: string): Record<string, string> => {
    const r = rows.find((x) => x.taskId === id);
    if (!r) throw new Error(`tasks.csv に ${id} がありません`);
    return r;
  };
  /** atlas.html に埋め込んだタスクの節 */
  const embedded = async (dir = out): Promise<TasksReport | null | undefined> => {
    const html = await readFile(join(dir, 'atlas.html'), 'utf8');
    const m = /<script type="application\/json" id="atlas-data">([\s\S]*?)<\/script>/.exec(html);
    return (JSON.parse(m![1]) as ReportData).tasks;
  };

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    await mkdir(repo, { recursive: true });
    ({ home, close } = await buildFixtureHome(join(WORK, 'home'), {}));
    await addPromptSession(home, { id: S_MULTI, cwd: 'X:\\synthetic-new', createdAt: '2026-10-16T00:00:00.000Z', prompt: 'DEMO-103 と DEMO-102-1 をまとめて直してください', activeMinutes: 60 });
    putXml('export-before.xml', T_BEFORE);
    await writeFile(configPath, JSON.stringify({ wikis: FIXTURE_WIKIS, tasks: { file: xml } }));
  });
  afterAll(async () => close?.());

  it('a. atlas all で XML を読み、名前が当たるセッションを機械で紐づけ、tasks.csv と sessions.csv に出す', async () => {
    const r = atlas(['all', '--home', home, '--out', out]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('管理ツールのタスク タスク 6 件(新しく見た 6・完了になった 1・');
    const state = await readJson<{ tasks: Record<string, { done: boolean; doneAt: string | null; missing?: boolean }> }>(join(notes, 'tasks.json'));
    // 入れ子のタスク(DEMO-102-1)も 1 件のタスク。初めから完了のタスクは、最初に読んだ XML の更新時刻を完了を確認した時刻にする
    expect(Object.keys(state.tasks)).toEqual(['DEMO-101', 'DEMO-102', 'DEMO-102-1', 'DEMO-103', 'DEMO-104', 'DEMO-106']);
    expect(state.tasks['DEMO-104']).toMatchObject({ done: true, doneAt: T_BEFORE.toISOString() });
    expect(state.tasks['DEMO-101']).toMatchObject({ done: false, doneAt: null });
    const links = await readJson<{ version: number; links: Record<string, { taskIds: string[]; source: string; reason: string }> }>(join(notes, 'task-links.json'));
    expect(links.version).toBe(2);
    // 2 つの ID を書いたセッションは両方に(並びは XML の順)
    expect(Object.fromEntries(Object.entries(links.links).map(([k, v]) => [k, [v.taskIds, v.source]]))).toEqual({
      [S_FIX]: [['DEMO-101'], 'machine'],
      [S_IMPROVE]: [['DEMO-102'], 'machine'],
      [S_MULTI]: [['DEMO-102-1', 'DEMO-103'], 'machine'],
    });
    expect(links.links[S_MULTI].reason).toBe('ID が依頼にある');
    const t = await tasksCsv();
    expect(t.map((x) => x.taskId)).toEqual(['DEMO-101', 'DEMO-102', 'DEMO-102-1', 'DEMO-103', 'DEMO-104', 'DEMO-106']);
    expect(row(t, 'DEMO-101')).toMatchObject({ taskName: 'fix the app', status: 'In Progress', 完了: '0', 開始: '2026-10-15T00:00:00.000Z', 完了を確認した時刻: '', '稼働時間帯の工数(時間)': '', セッション数: '1', '紐づけ(機械)': '1', 比べない理由: '未完了' });
    expect(row(t, 'DEMO-104')).toMatchObject({ 完了: '1', 完了を確認した時刻: T_BEFORE.toISOString(), セッション数: '0', 比べない理由: '' });
    // 2 つのタスクに紐づいたセッションの実働(60 分)は等分して 30 分ずつ。セッション数は等分しない
    expect(row(t, 'DEMO-102-1')).toMatchObject({ セッション数: '1', 共有のセッション: '1', 'AI の実働(時間)': '0.5', 開始: '2026-10-16T00:00:00.000Z' });
    expect(row(t, 'DEMO-103')).toMatchObject({ セッション数: '1', 共有のセッション: '1', 'AI の実働(時間)': '0.5' });
    expect(row(t, 'DEMO-101')['共有のセッション']).toBe('0');
    const s = await sessionsCsv();
    const of = (id: string) => s.find((x) => x['セッションID'] === id)!;
    expect([of(S_FIX).taskId, of(S_FIX).taskName, of(S_FIX)['紐づけの出所'], of(S_FIX)['タスクの数']]).toEqual(['DEMO-101', 'fix the app', '機械', '1']);
    // いくつかのタスクは「; 」でつなぐ
    expect([of(S_MULTI).taskId, of(S_MULTI).taskName, of(S_MULTI)['紐づけの出所'], of(S_MULTI)['タスクの数']]).toEqual(['DEMO-102-1; DEMO-103', '入れ子のサブタスク; 帳票の出力を速くする', '機械', '2']);
    expect([of(S_IMPROVE).taskId, of(S_IMPROVE)['紐づけの出所']]).toEqual(['DEMO-102', '機械']);
    const other = of('00000000-0000-4000-8000-000000000009');
    expect([other.taskId, other.taskName, other['紐づけの出所'], other['タスクの数']]).toEqual(['', '', '', '']);
    // セッション × タスクの表(按分はタスクの数で等分した割合)
    const st = csv(await readFile(join(out, 'tables', 'session-tasks.csv'), 'utf8'));
    expect(st.filter((r) => r['セッションID'] === S_MULTI).map((r) => [r.taskId, r['紐づけの出所'], r['按分']])).toEqual([
      ['DEMO-102-1', '機械', '0.5'],
      ['DEMO-103', '機械', '0.5'],
    ]);
    expect(st.find((r) => r['セッションID'] === S_FIX)).toMatchObject({ taskId: 'DEMO-101', taskName: 'fix the app', 按分: '1' });
    expect(st).toHaveLength(4);
    // レポートにタスクの節を埋め込み、詳細ページに「タスク」の行を出す
    const v = await embedded();
    expect(v?.configured).toBe(true);
    expect(v?.origin).toBe('local');
    expect(v?.links[S_FIX]).toMatchObject({ taskIds: ['DEMO-101'], source: 'machine' });
    expect(v?.links[S_MULTI]?.taskIds).toEqual(['DEMO-102-1', 'DEMO-103']);
    expect(v?.summary.sharedSessions).toBe(1);
    const detail = await readFile(join(out, 'sessions', `${S_FIX}.html`), 'utf8');
    expect(detail).toContain('data-testid="detail-task"');
    expect(detail).toContain('fix the app<span class="id" translate="no">(DEMO-101)</span>');
    const multi = await readFile(join(out, 'sessions', `${S_MULTI}.html`), 'utf8');
    expect(multi.match(/data-testid="detail-task-item"/g)).toHaveLength(2);
    expect(multi).toContain('2 つのタスクに紐づいています。実働と推定人手工数は、2 つのタスクで等分して数えます');
    expect(detail).toContain('紐づけ: 機械(タスク名が依頼にある)');
    expect(await readFile(join(out, 'sessions', '00000000-0000-4000-8000-000000000009.html'), 'utf8')).toContain('紐づけなし');
  });

  it('b. 後の書き出しで tasks sync → 完了を確認した時刻が入り、稼働時間帯の工数が出る(--task で絞れる)', async () => {
    putXml('export-after.xml', T_AFTER);
    const r = atlas(['tasks', 'sync', '--out', out]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('タスク 6 件(新しく見た 1・完了になった 3・開き直された 0・XML から消えた 1・また出てきた 0)');
    const state = await readJson<{ tasks: Record<string, { done: boolean; doneAt: string | null; missing?: boolean }> }>(join(notes, 'tasks.json'));
    expect(state.tasks['DEMO-101']).toMatchObject({ done: true, doneAt: T_AFTER.toISOString() });
    expect(state.tasks['DEMO-102']).toMatchObject({ done: true, doneAt: T_AFTER.toISOString() });
    // 初めから完了のタスクは、最初に完了を見た時刻のまま
    expect(state.tasks['DEMO-104']).toMatchObject({ done: true, doneAt: T_BEFORE.toISOString() });
    expect(state.tasks['DEMO-106']).toMatchObject({ missing: true });
    // 同じ更新時刻の XML をもう一度読んでも変わらない
    const again = atlas(['tasks', 'sync', '--out', out]);
    expect(again.out).toContain('前に読んだときから XML は変わっていません');
    const b = atlas(['build', '--out', out]);
    expect(b.status, b.out).toBe(0);
    const t = await tasksCsv();
    // DEMO-101: 木 10/15 0:00 開始 → 金 10/23 12:00 完了を確認。平日 9:00〜18:00 は 木 9・金 9・月〜木 9×4・金 3 = 57 時間
    expect(row(t, 'DEMO-101')).toMatchObject({ 完了: '1', 完了を確認した時刻: T_AFTER.toISOString(), '稼働時間帯の工数(時間)': '57', 'AI の実働(時間)': '0.01', 判定なし: '1', 比べない理由: '判定なし' });
    // DEMO-102: 木 10/22 0:00 開始 → 金 10/23 12:00。木 9・金 3 = 12 時間
    expect(row(t, 'DEMO-102')['稼働時間帯の工数(時間)']).toBe('12');
    // XML から消えたタスクは、紐づいたセッションが無ければ出さない
    expect(t.map((x) => x.taskId)).not.toContain('DEMO-106');
    expect(t.map((x) => x.taskId)).toContain('DEMO-105');
    // --task でそのタスクのセッションだけに絞る
    const f = atlas(['metrics', '--out', out, '--task', 'DEMO-101']);
    expect(f.status, f.out).toBe(0);
    expect(f.out).toContain('task=DEMO-101(紐づいたセッション 1 件)');
  });

  it('c. 推定人手工数を取り込むと、比べられるタスクと外した理由が出る(確信度の低い推定は入れない)', async () => {
    const sample = await readJson<{ schemaVersion: number; judge: unknown; items: Record<string, unknown>[] }>(join(FIXTURES, 'judgments-sample.json'));
    const item = (sessionId: string, hours: number, confidence: number) => ({ ...sample.items[0], sessionId, humanEffort: { hours, low: hours / 2, high: hours * 2, confidence, rationale: 'テスト用の架空の推定' } });
    const file = join(WORK, 'judgments-tasks.json');
    await writeFile(file, JSON.stringify({ ...sample, items: [item(S_FIX, 40, 0.8), item(S_IMPROVE, 10, 0.2)] }));
    const imp = atlas(['judge', 'import', file, '--out', out]);
    expect(imp.status, imp.out).toBe(0);
    const b = atlas(['build', '--out', out]);
    expect(b.status, b.out).toBe(0);
    const t = await tasksCsv();
    expect(row(t, 'DEMO-101')).toMatchObject({ '推定人手工数(時間)': '40', 判定済み: '1', 確度が低い: '0', 比べられる: '1', 比べない理由: '' });
    expect(row(t, 'DEMO-102')).toMatchObject({ '推定人手工数(時間)': '0', 確度が低い: '1', 比べられる: '0', 比べない理由: '確度が低い' });
    const v = (await embedded())!;
    // DEMO-102-1(S_MULTI と共有。判定なし)と DEMO-103(未完了)は比べない
    expect(v.summary).toMatchObject({ tasks: 4, doneTasks: 3, included: 1, excluded: { notDone: 1, noStart: 0, unjudged: 1, lowConfidence: 1 }, workMs: 57 * 3_600_000, humanHours: 40, aiActiveMs: 25_000, ratio: null, sharedSessions: 1 });
    // 比を出す下限は、比べられるタスクの数(どの環境でも同じ表示の決まり)
    expect(v.summary.ratioMin).toBeGreaterThan(1);
  });

  it('d. tasks link --llm(偽の copilot)で、機械で決まらなかったセッションを LLM で紐づけ、レポートを作り直す', async () => {
    const before = await readJson<{ links: Record<string, unknown> }>(join(notes, 'task-links.json'));
    expect(Object.keys(before.links)).toHaveLength(3);
    const r = atlas(['tasks', 'link', '--llm', '--out', out]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/tasks link: LLM で紐づけます \d+ セッション/);
    const links = await readJson<{ links: Record<string, { taskIds: string[]; source: string; reason: string; confidence?: number }> }>(join(notes, 'task-links.json'));
    const llm = Object.entries(links.links).filter(([, l]) => l.source === 'llm');
    expect(llm.length).toBeGreaterThan(0);
    // 偽の copilot は候補の先頭を選ぶ。候補は未完了のタスクと、セッションの開始より後に完了したタスク
    for (const [, l] of llm) {
      expect(l.reason).toContain('偽 copilot');
      expect(l.confidence).toBe(0.7);
      expect(l.taskIds.length).toBeGreaterThan(0);
      for (const id of l.taskIds) expect(['DEMO-101', 'DEMO-102', 'DEMO-102-1', 'DEMO-103', 'DEMO-104', 'DEMO-105']).toContain(id);
    }
    // 機械の紐づけはそのまま
    expect(links.links[S_FIX]).toMatchObject({ taskIds: ['DEMO-101'], source: 'machine' });
    expect(links.links[S_MULTI]).toMatchObject({ taskIds: ['DEMO-102-1', 'DEMO-103'], source: 'machine' });
    // 作り直したレポートと表に出る
    const v = (await embedded())!;
    expect(Object.values(v.links).filter((l) => l.source === 'llm')).toHaveLength(llm.length);
    const t = await tasksCsv();
    // 紐づけ(LLM)は、LLM で紐づいたセッションをタスクごとに数えたもの
    expect(t.reduce((n, x) => n + Number(x['紐づけ(LLM)']), 0)).toBe(llm.reduce((n, [, l]) => n + l.taskIds.length, 0));
    // もう一度実行しても、LLM で決めたものは聞き直さない
    const again = atlas(['tasks', 'link', '--llm', '--out', out]);
    expect(again.status, again.out).toBe(0);
    expect(again.out).toContain('tasks link: LLM に聞くセッションはありません');
  });

  it('e. 属性と名前空間を使う XML を、読み方の設定(@ で属性)で読む', async () => {
    const dir = join(WORK, 'attributes');
    await mkdir(dir, { recursive: true });
    const x = join(dir, 'export.xml');
    putXml('export-attributes.xml', T_AFTER, x);
    const cfg = join(dir, 'atlas.config.json');
    await writeFile(cfg, JSON.stringify({ tasks: { file: 'export.xml', item: 'WorkItem', id: '@key', name: 'Title', status: 'State', doneStatus: ['Resolved', '完了'] } }));
    const n = join(dir, 'notes');
    const r = atlas(['tasks', 'sync', '--config', cfg, '--out', out, '--notes-dir', n]);
    expect(r.status, r.out).toBe(0);
    const state = await readJson<{ tasks: Record<string, { name: string; status: string; done: boolean }> }>(join(n, 'tasks.json'));
    expect(Object.fromEntries(Object.entries(state.tasks).map(([k, v]) => [k, [v.name, v.status, v.done]]))).toEqual({
      'DEMO-101': ['fix the app', 'Resolved', true],
      'DEMO-102': ['Improve the synthetic project', '完了', true],
      'DEMO-103': ['帳票の出力を速くする', 'Active', false],
      'DEMO-104': ['初めから完了していたタスク', 'Resolved', true],
      'DEMO-105': ['後から増えたタスク', 'New', false],
    });
    const list = atlas(['tasks', 'list', '--config', cfg, '--out', out, '--notes-dir', n]);
    expect(list.status, list.out).toBe(0);
    expect(list.out).toContain('DEMO-103');
  });

  it('f. プロジェクトを送るとタスクが添えられ、送り先から集計した読むだけの出力にもタスクの節が出る', async () => {
    const root = join(WORK, 'atlas-logs');
    await mkdir(root, { recursive: true });
    const sessions = (await readJson<SessionsFile>(join(out, 'sessions.json'))).sessions;
    const project = sessions.find((s) => s.id === S_FIX)!.project;
    const upCfg = join(WORK, 'atlas.config.upload.json');
    await writeFile(upCfg, JSON.stringify({ wikis: FIXTURE_WIKIS, tasks: { file: xml }, uploadRoot: root, uploadProjects: [project] }));
    const r = spawnSync(...cliCommand([], 'upload-project'), { encoding: 'utf8', cwd: ROOT, timeout: 600_000, input: 'y\n', env: { ...env(), ATLAS_OUT: out, ATLAS_CONFIG: upCfg } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const dest = join(root, uploadDirName(project));
    const meta = await readJson<{ task?: unknown; tasks?: Record<string, unknown>[] }>(join(dest, S_FIX, 'atlas-session.json'));
    expect(meta.tasks).toHaveLength(1);
    expect(meta.tasks?.[0]).toMatchObject({ id: 'DEMO-101', name: 'fix the app', done: true, doneAt: T_AFTER.toISOString(), source: 'machine' });
    // タスクが 1 つなら、前の版の形(task)にも同じものを添える
    expect(meta.task).toEqual(meta.tasks?.[0]);
    const index = await readJson<{ sessions: { id: string; tasks?: { id: string }[] }[] }>(join(dest, 'atlas-index.json'));
    expect(index.sessions.find((s) => s.id === S_FIX)?.tasks?.map((t) => t.id)).toEqual(['DEMO-101']);
    expect(index.sessions.find((s) => s.id === S_MULTI)?.tasks?.map((t) => t.id)).toEqual(['DEMO-102-1', 'DEMO-103']);
    const readme = await readFile(join(dest, 'README.md'), 'utf8');
    expect(readme).toContain('fix the app(DEMO-101)');
    expect(readme).toContain('入れ子のサブタスク(DEMO-102-1)、帳票の出力を速くする(DEMO-103)');
    // 送り先(XML の無い PC)で集計すると、送った人の記録からタスクの節を作る
    const out2 = join(WORK, 'out-received');
    const recvCfg = join(WORK, 'atlas.config.received.json');
    await writeFile(recvCfg, JSON.stringify({ wikis: FIXTURE_WIKIS }));
    const recv = atlas(['all', '--home', root, '--out', out2, '--notes-dir', join(WORK, 'notes-received')], { ATLAS_CONFIG: recvCfg });
    expect(recv.status, recv.out).toBe(0);
    const v = (await embedded(out2))!;
    expect(v.origin).toBe('sender');
    expect(v.items.map((t) => t.id).sort()).toEqual(['DEMO-101', 'DEMO-102-1', 'DEMO-103']);
    // 2 つのタスクに紐づいたセッションも、送った人の記録から両方に紐づく(等分も同じ)
    expect(v.links[S_MULTI]?.taskIds).toEqual(['DEMO-102-1', 'DEMO-103']);
    expect(v.items.find((t) => t.id === 'DEMO-103')).toMatchObject({ sessions: 1, sharedSessions: 1, aiActiveMs: 1_800_000 });
    expect(csv(await readFile(join(out2, 'tables', 'session-tasks.csv'), 'utf8')).filter((r) => r['セッションID'] === S_MULTI).map((r) => r['按分'])).toEqual(['0.5', '0.5']);
    expect(v.items.find((t) => t.id === 'DEMO-101')).toMatchObject({ done: true, doneAt: T_AFTER.toISOString(), start: '2026-10-15T00:00:00.000Z', workMs: 57 * 3_600_000, sessions: 1 });
    expect(row(await tasksCsv(out2), 'DEMO-101')['稼働時間帯の工数(時間)']).toBe('57');
    // 送り先ではタスクの状態を作らない(XML を読まない)
    expect(existsSync(join(WORK, 'notes-received', 'tasks.json'))).toBe(false);
    expect((await readdir(dest)).sort()).toContain(S_FIX);
  });

  it('g. 初めての集計でも all --task で絞れる(タスクの処理は metrics の前)。初めから完了のタスクは完了の時刻が分からないとして比べない', async () => {
    const out3 = join(WORK, 'out-first');
    const notes3 = join(WORK, 'notes-first');
    const r = atlas(['all', '--home', home, '--out', out3, '--notes-dir', notes3, '--task', 'DEMO-101']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('task=DEMO-101(紐づいたセッション 1 件)');
    const state = await readJson<{ tasks: Record<string, { done: boolean; doneObserved?: boolean }> }>(join(notes3, 'tasks.json'));
    expect(state.tasks['DEMO-101']).toMatchObject({ done: true, doneObserved: false });
    const t = row(await tasksCsv(out3), 'DEMO-101');
    expect(t).toMatchObject({ 完了: '1', '稼働時間帯の工数(時間)': '', 比べられる: '0', 比べない理由: '完了の時刻が分からない' });
    // 絞って作ったレポートは scoped(serve の画面は API の値で置き換えない)
    expect((await embedded(out3))?.scoped).toBe(true);
  });
});
