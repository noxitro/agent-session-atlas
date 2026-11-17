// Phase 14 E2E(docs/PLAN.md「Phase 14: 画面からの操作」): 架空の fixture で atlas all → atlas serve(同じプロセス、port 0)を立て、
// 本物の子プロセス(main.ts all / judge-flow.ts)とサーバ内の全文の書き出しを API から動かす。LLM は呼ばない(偽 copilot)。
//  a. refresh: 集計し直すと atlas.html が作り直され(埋め込みの生成日時が変わる)、記録(.md)もある
//  b. full: out/full/<id>.md(と assets/)だけができ、atlas.html・詳細ページ・他のファイルは 1 バイトも変わらず、coverage.json も作らない。表示の API で描ける
//  c. judge: 件数の無い要求は 400(確認なしでは走らない)。偽 copilot で上限の件数だけ判定され、レポートに反映される
//  c2. チャットでの判定: 添付ファイルを未判定のセッションだけで作り(bundle --unjudged)、貼った返答を取り込み、export でレポートに反映する
//  d. cancel: 実行中の集計を止めると canceled になり、次の要求を受け付ける
//  e. ジョブの実行中は heartbeat が途切れてもサーバが止まらず、終わってから止まる(判定 1 件に 2.5 秒かかる偽 copilot で)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractEmbedded } from '../packages/report/src/lib/embed.ts';
import type { ReportData } from '../packages/report/src/lib/types.ts';
import type { SessionsFile } from '../packages/report/src/shared/types.ts';
import { buildFixtureHome, FIXTURE_CODE, P11_SESSION, ROOT, cliCommand, startServer, type ServeHandle } from './fixture-home.ts';
import { openReadOnly } from './sqlite.ts';

const WORK = join(ROOT, 'out', 'e2e-phase14');
const FAKE = join(FIXTURE_CODE, 'fake-copilot.mjs');

async function listFiles(dir: string, skip: (rel: string) => boolean): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p).replace(/\\/g, '/');
      if (skip(rel)) continue;
      if (e.isDirectory()) await walk(p);
      else {
        const st = await stat(p);
        out.set(rel, `${st.size}:${st.mtimeMs}:${createHash('sha1').update(await readFile(p)).digest('hex')}`);
      }
    }
  };
  await walk(dir);
  return out;
}

/** CSV を行と列に分ける(引用符の中の改行・カンマ・"" を読む。failures.csv はエラー文や引数に改行が入るので、行末では分けられない) */
function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && s[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell]);
  return rows;
}

describe('Phase 14 E2E: 画面からの操作(jobs)', () => {
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  let home: string;
  let close: () => Promise<void>;
  let h: ServeHandle;
  const fakeLog = join(WORK, 'fake-copilot.log');

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    ({ home, close } = await buildFixtureHome(join(WORK, 'home'), { phase11: true }));
    const r = spawnSync(...cliCommand(['all', '--home', home, '--out', out, '--notes-dir', notes]), { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
    if (r.status !== 0) throw new Error(`atlas all が失敗: ${r.stderr}\n${r.stdout}`);
    // 子プロセスの all は --home を付けない(atlas.bat の serve と同じ形)ので、fixture の場所は環境変数で渡す
    h = await startServer({
      outDir: out,
      notesDir: notes,
      groupsPath: join(notes, 'groups.json'),
      port: 0,
      open: false,
      idleMs: 600_000,
      firstHeartbeatMs: 600_000,
      jobs: { env: { ATLAS_COPILOT_HOME: home, ATLAS_COPILOT_BIN: FAKE, FAKE_COPILOT_LOG: fakeLog } },
    });
  });
  afterAll(async () => {
    await h?.close('テスト終了');
    await close?.();
  });

  const api = async (path: string, init: RequestInit = {}, server: ServeHandle = h): Promise<{ status: number; body: any }> => {
    const r = await fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-atlas-token': server.token, ...(init.headers ?? {}) } });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const startJob = (body: unknown, server: ServeHandle = h) => api('/api/jobs', { method: 'POST', body: JSON.stringify(body) }, server);
  const waitJob = async (server: ServeHandle = h, ms = 300_000): Promise<any> => {
    const t = Date.now();
    for (;;) {
      const j = (await api('/api/jobs/current', {}, server)).body;
      if (j && j.state !== 'running') return j;
      if (Date.now() - t > ms) throw new Error('ジョブが終わりませんでした');
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const embedded = async (): Promise<ReportData> => extractEmbedded<ReportData>(await readFile(join(out, 'atlas.html'), 'utf8'));

  it('0. atlas all は表計算ソフトで開く表(out/tables/ の turns.csv・sessions.csv)も書く', async () => {
    const lines = async (name: string): Promise<string[]> => (await readFile(join(out, 'tables', name), 'utf8')).trimEnd().split('\r\n');
    const m = JSON.parse(await readFile(join(out, 'metrics.json'), 'utf8')) as { overall: { sessions: number }; turns: { turns: number } };
    const turns = await lines('turns.csv');
    expect(turns[0].startsWith(`${String.fromCharCode(0xfeff)}セッションID,`)).toBe(true);
    expect(turns.length - 1).toBe(m.turns.turns);
    const sess = await lines('sessions.csv');
    expect(sess.length - 1).toBe(m.overall.sessions);
    // 本体のモデルと推論強度(サブエージェントを除いて決める)・利用者の列。00…003 の本体は gpt-5.5 の medium(サブエージェントは low)
    const header = sess[0].replace(/^﻿/, '').split(',');
    expect(header.slice(header.indexOf('モデル'), header.indexOf('モデル') + 3)).toEqual(['モデル', '本体のモデル', '本体の推論強度']);
    expect(header[header.indexOf('ブランチ') + 1]).toBe('利用者');
    const row3 = sess.find((l) => l.startsWith('00000000-0000-4000-8000-000000000003,'))!.split(',');
    expect([row3[header.indexOf('本体のモデル')], row3[header.indexOf('本体の推論強度')], row3[header.indexOf('利用者')]]).toEqual(['gpt-5.5', 'medium', '']);
    // 終了時の累計だけのセッション(00…001)は本体の記録なし
    const row1 = sess.find((l) => l.startsWith('00000000-0000-4000-8000-000000000001,'))!.split(',');
    expect(row1[header.indexOf('本体の推論強度')]).toBe('記録なし');
  });

  it('0b. ツールの失敗・拒否 1 件ごとの表(failures.csv と atlas.sqlite の failures)も書く。行の数はセッションごとに tools.results の失敗 + 拒否と同じ', async () => {
    const file = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as SessionsFile;
    // 表に載るのは空でないセッション。fixture には、行数の上限で台帳に残らなかった失敗(failuresDropped)は無い
    const listed = file.sessions.filter((s) => !s.empty);
    const want = new Map<string, number>();
    for (const s of listed) {
      expect(s.analysis.failuresDropped, s.id).toBe(0);
      const n = Object.values(s.tools.results).reduce((a, r) => a + r.failure + r.denied, 0);
      expect(s.analysis.failures, s.id).toHaveLength(n);
      if (n > 0) want.set(s.id, n);
    }
    expect(want.size).toBeGreaterThan(0);

    expect(existsSync(join(out, 'tables', 'failures.csv'))).toBe(true);
    const text = await readFile(join(out, 'tables', 'failures.csv'), 'utf8');
    expect(text.startsWith(`${String.fromCharCode(0xfeff)}セッションID,セッション名,プロジェクト,依頼番号,開始,種類,要因,ツール,`)).toBe(true);
    const [header, ...rows] = parseCsv(text);
    expect(header).toEqual([
      'セッションID',
      'セッション名',
      'プロジェクト',
      '依頼番号',
      '開始',
      '種類',
      '要因',
      'ツール',
      'MCP サーバー',
      'MCP のツール',
      'MCP の設定元',
      'モデル',
      'エージェント',
      'エージェントの呼び出し',
      'エージェントへの依頼',
      '所要(ミリ秒)',
      'エラー文',
      '引数',
      'その後',
      '次のツール',
      '次の結果',
      '呼び直し',
      'そろえたエラー文',
    ]);
    expect(rows.every((r) => r.length === header.length)).toBe(true);
    const col = (name: string): number => header.indexOf(name);
    const countBy = (ids: string[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
      return m;
    };
    expect(countBy(rows.map((r) => r[0]))).toEqual(want);
    // セッションの中は台帳の順。種類と、turns.csv の依頼番号に合わせた番号(台帳の turn は 0 から、表は 1 から。最初の依頼より前は空)
    for (const s of listed) {
      const mine = rows.filter((r) => r[0] === s.id);
      const ledger = s.analysis.failures ?? [];
      expect(mine.map((r) => r[col('種類')]), s.id).toEqual(ledger.map((f) => (f.kind === 'denied' ? '拒否' : '失敗')));
      expect(mine.map((r) => r[col('依頼番号')]), s.id).toEqual(ledger.map((f) => (f.turn === null ? '' : String(f.turn + 1))));
      expect(mine.map((r) => r[col('ツール')]), s.id).toEqual(ledger.map((f) => f.tool));
    }
    // synthetic-usage の MCP の失敗と、拒否
    const mcp = rows.find((r) => r[col('ツール')] === 'github-mcp-server-get_file_contents')!;
    expect([mcp[col('種類')], mcp[col('要因')], mcp[col('MCP サーバー')], mcp[col('MCP のツール')], mcp[col('エラー文')]]).toEqual(['失敗', '対象が見つからない', 'github-mcp-server', 'get_file_contents', 'failure: not found']);
    const denied = rows.find((r) => r[col('エラー文')] === 'denied: denied by user')!;
    expect([denied[col('種類')], denied[col('要因')], denied[col('ツール')]]).toEqual(['拒否', '', 'view']);

    // SQLite にも同じ行が入り、依頼番号で turns と結べる(turnStats に載っていない依頼の分を除く)
    const beyond = listed.flatMap((s) => (s.analysis.failures ?? []).filter((f) => f.turn !== null && f.turn >= (s.analysis.turnStats?.length ?? 0))).length;
    const db = await openReadOnly(join(out, 'tables', 'atlas.sqlite'));
    try {
      const got = new Map(db.prepare('select "セッションID" id, count(*) n from failures group by 1').all().map((x) => [String(x.id), Number(x.n)] as const));
      expect(got).toEqual(want);
      const unjoined = db
        .prepare('select count(*) n from failures f where f."依頼番号" is not null and not exists (select 1 from turns t where t."セッションID" = f."セッションID" and t."依頼番号" = f."依頼番号")')
        .get();
      expect(Number(unjoined?.n)).toBe(beyond);
    } finally {
      db.close();
    }
  });

  it('a. refresh: 集計し直すと atlas.html が作り直され、記録(.md)もある', async () => {
    const before = (await embedded()).generatedAt;
    const t = performance.now();
    const r = await startJob({ kind: 'refresh' });
    expect(r.status).toBe(202);
    const j = await waitJob();
    const ms = performance.now() - t;
    expect(j.state, j.log.join('\n')).toBe('done');
    expect(j.exitCode).toBe(0);
    expect(j.log.some((l: string) => /^all: 完了/.test(l))).toBe(true);
    const after = await embedded();
    expect(Date.parse(after.generatedAt)).toBeGreaterThan(Date.parse(before));
    expect(Date.parse(after.generatedAt)).toBeGreaterThanOrEqual(Date.parse(j.startedAt));
    const sessions = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as SessionsFile;
    expect((await readdir(join(out, 'sessions'))).filter((f) => f.endsWith('.md'))).toHaveLength(sessions.sessions.length);
    console.log(`[phase14] refresh(fixture ${sessions.sessions.length} セッション)${(ms / 1000).toFixed(1)} 秒`);
  });

  it('b. full: out/full/<id>.md だけができ、他のファイルは変わらず、coverage.json も作らない', async () => {
    await rm(join(out, 'full'), { recursive: true, force: true });
    const skip = (rel: string): boolean => rel === 'full' || rel.startsWith('full/') || rel === '.serve.json';
    const before = await listFiles(out, skip);
    const t = performance.now();
    expect((await startJob({ kind: 'full', id: P11_SESSION })).status).toBe(202);
    const j = await waitJob();
    const ms = performance.now() - t;
    expect(j.state, j.log.join('\n')).toBe('done');
    expect(await listFiles(out, skip)).toEqual(before);
    expect(existsSync(join(out, 'coverage.json'))).toBe(false);
    const made = [...(await listFiles(join(out, 'full'), () => false)).keys()];
    expect(made).toContain(`${P11_SESSION}.md`);
    expect(made.filter((f) => !f.startsWith(`assets/${P11_SESSION}/`))).toEqual([`${P11_SESSION}.md`]);
    const md = await readFile(join(out, 'full', `${P11_SESSION}.md`), 'utf8');
    expect(md).toContain(P11_SESSION);
    const v = await api(`/api/view/${P11_SESSION}?kind=full`);
    expect(v.status).toBe(200);
    expect(v.body.tooLarge).toBe(false);
    expect(v.body.html).not.toMatch(/<script/i);
    expect(v.body.headings.length).toBeGreaterThan(0);
    // 書き出した画像(binary_asset)へのリンクは、そのセッションの assets/ を指すものだけが通る
    expect(made.some((f) => f.startsWith(`assets/${P11_SESSION}/`))).toBe(true);
    expect(v.body.html).toContain(`href="../full/assets/${P11_SESSION}/`);
    console.log(`[phase14] full(${P11_SESSION})${(ms / 1000).toFixed(2)} 秒、${(Buffer.byteLength(md) / 1024).toFixed(1)} KB、assets ${made.length - 1} ファイル`);
  });

  it('c. judge: 件数の無い要求は受けず、偽 copilot で上限の件数だけ判定してレポートに反映する', async () => {
    await rm(join(out, 'judgments.json'), { force: true });
    expect((await startJob({ kind: 'judge', backend: 'copilot-cli' })).status).toBe(400);
    expect((await startJob({ kind: 'judge', limit: 2, backend: 'anthropic' })).status).toBe(400);
    expect(existsSync(fakeLog)).toBe(false);
    const preview = (await api('/api/jobs/judge-preview')).body;
    expect(preview.judged).toBe(0);
    expect(preview.pending).toBeGreaterThanOrEqual(2);
    expect((await startJob({ kind: 'judge', limit: 2, backend: 'copilot-cli' })).status).toBe(202);
    const j = await waitJob();
    expect(j.state, j.log.join('\n')).toBe('done');
    const judgments = JSON.parse(await readFile(join(out, 'judgments.json'), 'utf8')) as { items: { sessionId: string }[] };
    expect(judgments.items).toHaveLength(2);
    expect((await readFile(fakeLog, 'utf8')).trim().split('\n')).toHaveLength(2);
    expect((await embedded()).judgments).toMatchObject({ available: true, items: 2 });
    expect((await api('/api/jobs/judge-preview')).body).toMatchObject({ judged: 2, pending: preview.pending - 2 });
  });

  it('c2. チャットでの判定: 未判定だけの添付ファイル → 返答の取り込み → 反映', async () => {
    const before = (await api('/api/jobs/judge-preview')).body;
    expect(before.judged).toBe(2);
    expect((await startJob({ kind: 'bundle' })).status).toBe(202);
    const b = await waitJob();
    expect(b.state, b.log.join('\n')).toBe('done');
    const list = (await api('/api/judge/parts')).body;
    expect(list).toMatchObject({ exists: true, unjudgedOnly: true, count: before.pending });
    // 判定済みの 2 件は入らない
    const judged = new Set((JSON.parse(await readFile(join(out, 'judgments.json'), 'utf8')) as { items: { sessionId: string }[] }).items.map((i) => i.sessionId));
    const first = list.parts[0];
    expect(first).toMatchObject({ name: 'part-01.md', judged: 0 });
    const text = (await api(`/api/judge/parts/${first.name}`)).body.text as string;
    const ids = [...text.matchAll(/^# 評価パケット: セッション (\S+)$/gm)].map((m) => m[1]);
    expect(ids).toHaveLength(first.sessions);
    expect(ids.some((id) => judged.has(id))).toBe(false);

    // チャットの返答のつもりで、そのファイルの全セッションの判定を書いて貼る
    const item = (id: string) => ({
      sessionId: id,
      taskCategory: 'feature',
      taskSummary: 'チャットで判定',
      humanEffort: { hours: 3, low: 2, high: 5, confidence: 0.5, rationale: '根拠' },
      aiOutcome: { completed: true, quality: 4, rework: 0, rationale: '成果' },
      instructionsEffect: { score: 0, evidence: '参照なし' },
      wikiEffect: { score: 0, evidence: '参照なし' },
      skillsAgentsEffect: { score: 0, evidence: '参照なし' },
    });
    const reply = `判定結果です。\n\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, judge: { backend: 'external', model: 'm365-copilot', ranAt: null }, items: ids.map(item) })}\n\`\`\`\n`;
    const r = await api('/api/judge/import', { method: 'POST', body: JSON.stringify({ text: reply }) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ imported: ids.length, overwritten: 0, unknownIds: [] });
    expect(r.body.parts.parts[0]).toMatchObject({ name: 'part-01.md', judged: ids.length });

    expect((await startJob({ kind: 'export' })).status).toBe(202);
    const e = await waitJob();
    expect(e.state, e.log.join('\n')).toBe('done');
    expect((await embedded()).judgments).toMatchObject({ available: true, items: 2 + ids.length });
    // export なので記録(.md)は消えない
    expect(existsSync(join(out, 'sessions', `${ids[0]}.md`))).toBe(true);
  });

  it('c3. 依頼ごとの判定: GitHub Copilot CLI(偽)で判定してレポートに出し、チャットの返答も依頼単位で取り込める', async () => {
    const pre = (await api('/api/jobs/judge-preview?target=turns')).body;
    expect(pre.judged).toBe(0);
    expect(pre.pending).toBeGreaterThan(2);
    // copilot -p 以外・件数の無い要求は受けない
    expect((await startJob({ kind: 'turn-judge' })).status).toBe(400);
    expect((await startJob({ kind: 'turn-judge', limit: 3, backend: 'copilot-cli' })).status).toBe(400);
    expect((await startJob({ kind: 'turn-judge', limit: 3 })).status).toBe(202);
    const j = await waitJob();
    expect(j.state, j.log.join('\n')).toBe('done');
    const tj = JSON.parse(await readFile(join(out, 'turn-judgments.json'), 'utf8')) as { phases: string[]; items: { sessionId: string; turn: number; outcome: string }[] };
    expect(tj.phases).toContain('実装');
    expect(tj.items.length).toBeGreaterThanOrEqual(3);
    const e = await embedded();
    expect(e.turnJudgments).toMatchObject({ available: true, items: tj.items.length });
    expect(e.sessions.some((x) => (x.turnVerdicts?.length ?? 0) > 0)).toBe(true);
    // 表にも判定の列が付く
    expect((await readFile(join(out, 'tables', 'turns.csv'), 'utf8')).split('\r\n')[0]).toContain('判定:扱い');

    // チャット: 未判定の依頼だけで添付ファイルを作り、返答を依頼単位で取り込む
    expect((await startJob({ kind: 'turn-bundle' })).status).toBe(202);
    expect((await waitJob()).state).toBe('done');
    const parts = (await api('/api/judge/parts?target=turns')).body;
    expect(parts).toMatchObject({ exists: true, unjudgedOnly: true });
    const first = parts.parts[0];
    const text = (await api(`/api/judge/parts/${first.name}?target=turns`)).body.text as string;
    const want = [...text.matchAll(/^- セッション (\S+) の依頼 (\d+)(?:〜(\d+))?$/gm)].flatMap((m) => {
      const a = Number(m[2]);
      const b = m[3] ? Number(m[3]) : a;
      return Array.from({ length: b - a + 1 }, (_, i) => ({ sessionId: m[1], turn: a + i }));
    });
    expect(want.length).toBe(first.sessions);
    const items = want.map((w) => ({ ...w, kind: 'question', outcome: 'follow_up', mismatch: null, phase: '調査', confidence: 0.5, note: 'チャット(テスト用)' }));
    const bad = await api('/api/judge/import?target=turns', { method: 'POST', body: JSON.stringify({ text: '```json\n' + JSON.stringify({ items: [{ ...items[0], outcome: 'as_is' }] }) + '\n```' }) });
    expect(bad.status).toBe(400);
    expect(bad.body.problems.join()).toMatch(/kind が question のとき/);
    const ok = await api('/api/judge/import?target=turns', { method: 'POST', body: JSON.stringify({ text: '```json\n' + JSON.stringify({ items }) + '\n```' }) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ imported: items.length, overwritten: 0 });
    expect(ok.body.parts.parts[0]).toMatchObject({ name: first.name, judged: first.sessions });
    expect((await api('/api/jobs/judge-preview?target=turns')).body.judged).toBe(tj.items.length + items.length);
  });

  it('d. cancel: 実行中の集計を止めると canceled になり、次の要求を受け付ける', async () => {
    expect((await startJob({ kind: 'refresh' })).status).toBe(202);
    // 集計は fixture では 0.5 秒ほどで終わるので、待たずに止める
    expect((await api('/api/jobs/current/cancel', { method: 'POST' })).status).toBe(200);
    const j = await waitJob(h, 60_000);
    expect(j.state).toBe('canceled');
    // 止めた後は次を受け付ける(作り直して以降の検査の前提を戻す)
    expect((await startJob({ kind: 'refresh' })).status).toBe(202);
    expect((await waitJob()).state).toBe('done');
  });

  it('d2. cancel は子プロセス(と孫の copilot)を本当に止める: 1 件 30 秒かかる判定を止めると数秒で終わる', async () => {
    const h3 = await startServer({
      outDir: out,
      notesDir: notes,
      groupsPath: join(notes, 'groups.json'),
      port: 0,
      open: false,
      idleMs: 600_000,
      firstHeartbeatMs: 600_000,
      jobs: { env: { ATLAS_COPILOT_HOME: home, ATLAS_COPILOT_BIN: FAKE, FAKE_COPILOT_DELAY_MS: '30000' } },
    });
    try {
      const judged = existsSync(join(out, 'judgments.json')) ? (JSON.parse(await readFile(join(out, 'judgments.json'), 'utf8')) as { items: unknown[] }).items.length : 0;
      expect((await startJob({ kind: 'judge', limit: 3, backend: 'copilot-cli' }, h3)).status).toBe(202);
      // bundle が終わって判定(偽 copilot)が始まるまで待つ
      const t0 = Date.now();
      while (!(await api('/api/jobs/current', {}, h3)).body.log.some((l: string) => /^judge: バックエンド/.test(l))) {
        if (Date.now() - t0 > 60_000) throw new Error('判定が始まりませんでした');
        await new Promise((r) => setTimeout(r, 100));
      }
      const c = Date.now();
      expect((await api('/api/jobs/current/cancel', { method: 'POST' }, h3)).status).toBe(200);
      const j = await waitJob(h3, 60_000);
      // 止める処理が効かなければ、偽 copilot の 30 秒を待ってから終わる
      expect(j.state).toBe('canceled');
      expect(Date.now() - c).toBeLessThan(10_000);
      const after = existsSync(join(out, 'judgments.json')) ? (JSON.parse(await readFile(join(out, 'judgments.json'), 'utf8')) as { items: unknown[] }).items.length : 0;
      expect(after).toBe(judged);
    } finally {
      await h3.close('テスト終了');
    }
  });

  it('e. ジョブの実行中は heartbeat が途切れてもサーバが止まらず、終わってから止まる', async () => {
    const h2 = await startServer({
      outDir: out,
      notesDir: notes,
      groupsPath: join(notes, 'groups.json'),
      port: 0,
      open: false,
      idleMs: 300,
      firstHeartbeatMs: 300,
      // 判定 1 件に 2.5 秒かかる偽 copilot(猶予 300ms より十分長いジョブにする)
      jobs: { env: { ATLAS_COPILOT_HOME: home, ATLAS_COPILOT_BIN: FAKE, FAKE_COPILOT_DELAY_MS: '2500' } },
    });
    let ended = false;
    void h2.done.then(() => (ended = true));
    await fetch(`http://127.0.0.1:${h2.port}/api/heartbeat`, { method: 'POST', headers: { 'x-atlas-token': h2.token } });
    expect((await startJob({ kind: 'judge', limit: 1, backend: 'copilot-cli' }, h2)).status).toBe(202);
    // heartbeat を送らずに猶予(300ms)の数倍待つ
    await new Promise((r) => setTimeout(r, 1500));
    expect(ended).toBe(false);
    expect((await api('/api/jobs/current', {}, h2)).body.state).toBe('running');
    const j = await waitJob(h2);
    expect(j.state).toBe('done');
    expect(await h2.done).toMatch(/heartbeat が途切れた/);
  });
});
