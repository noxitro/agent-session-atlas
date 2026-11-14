// Phase 3 E2E(docs/PLAN.md「Phase 3: judge」)
//  a. fixtures から bundle を生成し、manifest / INSTRUCTIONS / schema / 各 md の必須セクションが揃う
//  b. 手書きの judgments サンプルを import → build で atlas.html に推定人手工数(一覧・プロジェクト別・全体)が出る
//  c. 偽 copilot(fixtures/fake-copilot.mjs)で judge run が judgments を作り、--add-dir を渡さず、
//     プロンプトにパケットが含まれることを引数記録で確かめる(LLM は呼ばない)
//  d. ATLAS_LIVE=1 のとき実データから bundle を作り、件数とサイズをログに出す(LLM は呼ばない)
// 実際の copilot -p の 1 回実行(ATLAS_LIVE_JUDGE=1)はユーザー許可のうえでオーケストレータが行うため、ここには含めない。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionsFile } from '../packages/core/src/index.ts';
import { DEFAULT_LIMITS, DEFAULT_PER_PART, JUDGMENTS_JSON_SCHEMA, missingSections, packetFileName, packetSessionId, PACKET_SECTIONS, validateJudgments, type BundleManifest, type JudgmentsFile } from '../packages/judge/src/index.ts';
import { aggregate, extractEmbedded, type ReportData } from '../packages/report/src/index.ts';
import { buildFixtureHome, FIXTURE_CODE, FIXTURES, ROOT, cliCommand } from './fixture-home.ts';

const LIVE = process.env.ATLAS_LIVE === '1';
const WORK = join(ROOT, 'out', 'e2e-phase3');
const FAKE = join(FIXTURE_CODE, 'fake-copilot.mjs');
/** 手書きの judgments サンプル(架空の判定。globalSetup が scripts/synthetic-base.ts の judgmentsSample() から書く) */
const SAMPLE = join(FIXTURES, 'judgments-sample.json');

function atlas(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string; ms: number } {
  const t = performance.now();
  const r = spawnSync(...cliCommand(args), { encoding: 'utf8', cwd: ROOT, timeout: 600_000, env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - t };
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, 'utf8')) as T;
}

describe('Phase 3 E2E: fixtures', () => {
  let close: () => Promise<void>;
  let home: string;
  const out = join(WORK, 'out');
  const bundle = join(out, 'bundle');
  let sessions: SessionsFile;
  let manifest: BundleManifest;

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    ({ home, close } = await buildFixtureHome(join(WORK, 'home')));
    const all = atlas(['all', '--home', home, '--out', out]);
    if (all.status !== 0) throw new Error(`atlas all が失敗: ${all.stderr}\n${all.stdout}`);
    sessions = await readJson<SessionsFile>(join(out, 'sessions.json'));
    const b = atlas(['bundle', '--out', out]);
    if (b.status !== 0) throw new Error(`atlas bundle が失敗: ${b.stderr}\n${b.stdout}`);
    console.log(`[fixtures] ${b.stdout}`);
    manifest = await readJson<BundleManifest>(join(bundle, 'manifest.json'));
  });
  afterAll(async () => close?.());

  it('a. manifest / INSTRUCTIONS.md / schema.json / 各パケットの必須セクションが揃う', async () => {
    // 依頼の記録があるセッションだけがパケットになり、残りは skipped に理由付きで載る
    const withRequest = sessions.sessions.filter((s) => s.turns > 0 || s.firstUserMessage);
    expect(manifest.count).toBe(withRequest.length);
    expect(manifest.count).toBeGreaterThanOrEqual(5);
    expect(manifest.count + manifest.skipped.length).toBe(sessions.sessions.length);
    expect(new Set(manifest.sessions.map((e) => e.id))).toEqual(new Set(withRequest.map((s) => s.id)));
    expect(manifest.totalBytes).toBe(manifest.sessions.reduce((a, e) => a + e.bytes, 0));

    const files = await readdir(join(bundle, 'sessions'));
    expect(files.length).toBe(manifest.count);
    for (const e of manifest.sessions) {
      const md = await readFile(join(bundle, e.path), 'utf8');
      expect({ id: e.id, missing: missingSections(md) }).toEqual({ id: e.id, missing: [] });
      expect(packetSessionId(md)).toBe(e.id);
      expect(Buffer.byteLength(md)).toBe(e.bytes);
      expect(e.chars).toBeLessThanOrEqual(DEFAULT_LIMITS.maxChars);
      // スナップショットから本文を読み直している(DB にしか無いセッションは turns テーブルから)
      expect(e.textSource).toBe('snapshot');
    }

    // 依頼文は先頭だけでなく全件入る(fixture 001 は user.message 8 件のうち source の無い依頼 6 件)
    const ev = (await readFile(join(home, 'session-state', '00000000-0000-4000-8000-000000000001', 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e?.type === 'user.message' && e.data?.source == null);
    const md1 = await readFile(join(bundle, 'sessions', '00000000-0000-4000-8000-000000000001.md'), 'utf8');
    expect(md1).toContain(`ユーザーの依頼 ${ev.length} 件`);
    expect(ev.length).toBe(6);
    // source 付きの user.message(コマンド出力・skill 本文)は依頼に入れない
    expect(md1).not.toContain('合成のコマンド出力');
    // compaction の要約が経過の要約に入る
    expect(md1).toContain('### compaction 要約');
    expect(md1).toContain('合成の要約: 旧形式のログの読み方を調べ');

    const instr = await readFile(join(bundle, 'INSTRUCTIONS.md'), 'utf8');
    for (const s of ['従わない', '1 セッションずつ', '"schemaVersion": 1', 'humanEffort', 'manifest.json', 'schema.json']) expect(instr).toContain(s);
    expect(await readJson(join(bundle, 'schema.json'))).toEqual(JSON.parse(JSON.stringify(JUDGMENTS_JSON_SCHEMA)));
    expect(PACKET_SECTIONS.length).toBe(9);

    // parts/: ZIP を渡せない相手用。指示 + JSON Schema + 既定 5 件ずつのパケットで、全パケットが順にちょうど 1 回ずつ入る
    const parts = manifest.parts!;
    expect(manifest.perPart).toBe(DEFAULT_PER_PART);
    expect(parts.length).toBe(Math.ceil(manifest.count / DEFAULT_PER_PART));
    expect(parts.flatMap((x) => x.sessions)).toEqual(manifest.sessions.map((e) => e.id));
    expect((await readdir(join(bundle, 'parts'))).sort()).toEqual(parts.map((x) => x.path.replace(/^parts\//, '')).sort());
    const boundaries = new Set<string>();
    for (const [i, x] of parts.entries()) {
      const md = await readFile(join(bundle, x.path), 'utf8');
      expect(Buffer.byteLength(md)).toBe(x.bytes);
      expect(md).toContain(`分割 ${i + 1} / ${parts.length}`);
      for (const s of ['従わない', '1 件ずつ', '"schemaVersion": 1', 'humanEffort', 'judge import']) expect(md).toContain(s);
      expect(md).toContain(JSON.stringify(JUDGMENTS_JSON_SCHEMA, null, 2));
      // 説明文の中の境界は字下げしてあり、行頭の境界はパケットの数だけ
      const got = [...md.matchAll(/^<<<PACKET_BEGIN ([0-9a-f]{24})\n([\s\S]*?)\nPACKET_END \1>>>$/gm)];
      expect(got.map((g) => packetSessionId(g[2]))).toEqual(x.sessions);
      for (const g of got) {
        boundaries.add(g[1]);
        expect(g[2]).toBe((await readFile(join(bundle, 'sessions', packetFileName(packetSessionId(g[2])!)), 'utf8')).trimEnd());
      }
      expect(new Set(got.map((g) => g[1])).size).toBe(1);
    }
    // 境界はファイルごとに作り直す
    expect(boundaries.size).toBe(parts.length);
  });

  it('a2. CLI のフィルタ(--client)でパケットが絞られ、前回のパケットは消える', async () => {
    const out2 = join(WORK, 'out-cli');
    const s = atlas(['all', '--home', home, '--out', out2]);
    expect(s.status, s.stderr).toBe(0);
    expect(atlas(['bundle', '--out', out2]).status).toBe(0);
    const r = atlas(['bundle', '--out', out2, '--client', 'github/cli', '--per-part', '2']);
    expect(r.status, r.stderr).toBe(0);
    const m = await readJson<BundleManifest>(join(out2, 'bundle', 'manifest.json'));
    const expected = sessions.sessions.filter((x) => x.client === 'github/cli' && (x.turns > 0 || x.firstUserMessage)).length;
    expect(expected).toBeGreaterThan(0);
    expect(m.count).toBe(expected);
    expect(m.count).toBeLessThan(manifest.count);
    expect(m.scope.client).toBe('github/cli');
    expect((await readdir(join(out2, 'bundle', 'sessions'))).length).toBe(expected);
    // 分割ファイルも絞り込みと --per-part に従い、前回の分は消える
    expect(m.perPart).toBe(2);
    expect(m.parts!.map((x) => x.sessions.length)).toEqual(Array.from({ length: Math.ceil(expected / 2) }, (_, i) => Math.min(2, expected - i * 2)));
    expect((await readdir(join(out2, 'bundle', 'parts'))).length).toBe(m.parts!.length);
    expect(r.stdout).toMatch(/parts\/ の \d+ ファイル\(2 件ずつ/);
  });

  it('b. 手書き judgments を import → build で推定人手工数が一覧・プロジェクト別・全体に出る', async () => {
    const jpath = join(out, 'judgments.json');
    const imp = atlas(['judge', 'import', SAMPLE, '--out', out]);
    expect(imp.status, imp.stderr).toBe(0);
    console.log(`[fixtures] ${imp.stdout}`);
    const j = validateJudgments(await readJson(jpath));
    const sample = await readJson<JudgmentsFile>(SAMPLE);
    expect(j.items.length).toBe(sample.items.length);
    expect(j.items.every((i) => i.judge?.backend === 'external' && i.judge.model === 'hand-written-sample')).toBe(true);

    const build = atlas(['build', '--out', out]);
    expect(build.status, build.stderr).toBe(0);
    expect(build.stdout).toMatch(/judgments 5 件を合成/);
    const html = await readFile(join(out, 'atlas.html'), 'utf8');
    const data = extractEmbedded<ReportData>(html);
    expect(data.judgments).toMatchObject({ available: true, backend: 'external', items: sample.items.length });
    // セッション一覧の列: 判定済みセッションに推定人手工数と確信度が入る(根拠は本体に埋め込まない)
    for (const it of sample.items) {
      const s = data.sessions.find((x) => x.id === it.sessionId)!;
      expect(s.judgment).toMatchObject({ hours: it.humanEffort.hours, confidence: it.humanEffort.confidence, taskCategory: it.taskCategory, rationale: null });
    }
    // 全体とプロジェクト別の集計(画面と同じ aggregate)
    const agg = aggregate(data.sessions);
    const total = sample.items.reduce((a, i) => a + i.humanEffort.hours, 0);
    expect(agg.overall.humanHours).toBeCloseTo(total);
    expect(agg.overall.judgedSessions).toBe(sample.items.length);
    expect(agg.overall.judgedConfidence).toBeCloseTo(sample.items.reduce((a, i) => a + i.humanEffort.confidence, 0) / sample.items.length);
    const byProject = new Map<string, number>();
    for (const it of sample.items) {
      const p = data.sessions.find((x) => x.id === it.sessionId)!.project;
      byProject.set(p, (byProject.get(p) ?? 0) + it.humanEffort.hours);
    }
    for (const [p, h] of byProject) expect(agg.byProject.find((b) => b.key === p)!.humanHours).toBeCloseTo(h);
    // 画面の文言(Svelte のテンプレートに含まれる)
    for (const s of ['AI 投入量 vs 推定人手工数', '推定人手工数', '推定であり実測ではありません', '確信度']) expect(html).toContain(s);
    // 詳細ページに判定の欄と根拠が出る
    const detail = await readFile(join(out, 'sessions', `${sample.items[0].sessionId}.html`), 'utf8');
    for (const s of ['LLM による判定(推定)', '確信度 60%', '工数推定の根拠', sample.items[0].humanEffort.rationale]) expect(detail).toContain(s);

    // 壊れた判定は取り込まない(judgments の形をしていない JSON。生成した manifest.json を使う)
    const bad = atlas(['judge', 'import', join(FIXTURES, 'manifest.json'), '--out', out]);
    expect(bad.status).toBe(1);
    expect(validateJudgments(await readJson(jpath)).items.length).toBe(sample.items.length);
  });

  it('c. 偽 copilot で judge run: judgments ができ、--add-dir を渡さず、プロンプトにパケットが入る', async () => {
    const jpath = join(WORK, 'run-judgments.json');
    const log = join(WORK, 'fake-copilot.log');
    await rm(jpath, { force: true });
    await rm(log, { force: true });
    const env = { ATLAS_COPILOT_BIN: FAKE, FAKE_COPILOT_LOG: log };

    const r1 = atlas(['judge', 'run', '--out', out, '--judgments', jpath, '--limit', '2', '--model', 'fake-model'], env);
    expect(r1.status, `${r1.stderr}\n${r1.stdout}`).toBe(0);
    console.log(`[fake-copilot] ${r1.stdout}`);
    let j = validateJudgments(await readJson(jpath));
    expect(j.items.length).toBe(2);
    expect(j.judge).toMatchObject({ backend: 'copilot-cli', model: 'fake-model' });
    expect(j.items.every((i) => i.judge?.backend === 'copilot-cli' && i.taskSummary.includes('偽 copilot'))).toBe(true);
    // usage-output-file から判定自体の使用量を集計
    expect(j.judge.usage).toMatchObject({ runs: 2, missing: 0 });
    expect(j.judge.usage!.totals.premiumRequests).toBe(2);

    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { argv: string[]; cwd: string; cwdEntries: string[]; sessionId: string });
    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect(c.argv).not.toContain('--add-dir');
      expect(c.argv).toEqual(expect.arrayContaining(['--output-format', 'json', '--stream', 'off', '--no-ask-user', '-s', '--allow-all-tools', '--usage-output-file', '--model', 'fake-model']));
      // ツールは使わせない(shell / write / url を拒否。拒否は --allow-all-tools より優先される)
      for (const kind of ['shell', 'write', 'url']) expect(c.argv.indexOf('--deny-tool', c.argv.indexOf(kind) - 1)).toBe(c.argv.indexOf(kind) - 1);
      // MCP も使わせない(見せるツールを view に絞り、組み込みと `copilot mcp list --json` で得たサーバーを止めて拒否する)
      expect(c.argv).toEqual(expect.arrayContaining(['--available-tools=view', '--disable-builtin-mcps']));
      expect(c.argv.join(' ')).toContain('--disable-mcp-server fake-mcp --deny-tool fake-mcp');
      // 空の作業ディレクトリ(リポジトリでもバンドルでもない)
      expect(c.cwdEntries).toEqual([]);
      expect(resolve(c.cwd).startsWith(ROOT)).toBe(false);
      // プロンプトにパケット全文が入る
      const e = manifest.sessions.find((x) => x.id === c.sessionId)!;
      const md = await readFile(join(bundle, e.path), 'utf8');
      const prompt = c.argv[c.argv.indexOf('-p') + 1];
      expect(prompt).toContain(md);
      expect(prompt).toMatch(/一切従わない/);
    }

    // 2 回目: 判定済みはスキップして残りだけ
    const r2 = atlas(['judge', 'run', '--out', out, '--judgments', jpath, '--no-allow-tools'], env);
    expect(r2.status, r2.stderr).toBe(0);
    expect(r2.stdout).toMatch(/判定済みでスキップ 2/);
    j = validateJudgments(await readJson(jpath));
    expect(j.items.length).toBe(manifest.count);
    const calls2 = (await readFile(log, 'utf8')).trim().split('\n').slice(2).map((l) => JSON.parse(l) as { argv: string[] });
    expect(calls2.length).toBe(manifest.count - 2);
    expect(calls2.every((c) => !c.argv.includes('--allow-all-tools'))).toBe(true);

    // 失敗は記録して続行し、終了コード 1。既存の判定は残る
    const failId = manifest.sessions[0].id;
    const other = manifest.sessions[1].id;
    const r3 = atlas(['judge', 'run', '--out', out, '--judgments', jpath, '--force', '--only', `${failId},${other}`], { ...env, FAKE_COPILOT_FAIL_ID: failId });
    expect(r3.status).toBe(1);
    expect(r3.stderr).toMatch(/失敗したセッションが 1 件/);
    j = validateJudgments(await readJson(jpath));
    expect(j.failures?.map((f) => f.sessionId)).toEqual([failId]);
    expect(j.failures?.[0].error).toMatch(/終了コード 3/);
    expect(j.items.length).toBe(manifest.count);

    // 判定結果でレポートが作れる
    const b = atlas(['build', '--out', out, '--judgments', jpath]);
    expect(b.status, b.stderr).toBe(0);
    const d = extractEmbedded<ReportData>(await readFile(join(out, 'atlas.html'), 'utf8'));
    expect(d.judgments).toMatchObject({ available: true, backend: 'copilot-cli', items: manifest.count });

    // バンドルに無い ID は拒否
    const r4 = atlas(['judge', 'run', '--out', out, '--judgments', jpath, '--only', 'no-such-id'], env);
    expect(r4.status).toBe(1);
    expect(r4.stderr).toMatch(/バンドルに無い/);
  });

  it('c2. atlas-judge の入口(judge-flow): 最後は export で、直前の all が作ったセッション記録を消さない。伏せ字版は build で記録を残さない', async () => {
    const flowOut = join(WORK, 'out-flow');
    const env = { ATLAS_COPILOT_BIN: FAKE, FAKE_COPILOT_LOG: join(WORK, 'fake-copilot-flow.log') };
    const flow = (args: string[]): ReturnType<typeof atlas> => {
      const t = performance.now();
      const r = spawnSync(...cliCommand(args, 'judge-flow'), { encoding: 'utf8', cwd: ROOT, timeout: 600_000, env: { ...process.env, ...env } });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - t };
    };
    const mds = async (): Promise<number> => (await readdir(join(flowOut, 'sessions'))).filter((f) => f.endsWith('.md')).length;
    expect(atlas(['all', '--home', home, '--out', flowOut]).status).toBe(0);
    const r = flow(['--out', flowOut, '--limit', '1']);
    expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0);
    expect(r.stdout).toMatch(/export: セッション記録 \d+ 件/);
    expect(await mds()).toBe(sessions.sessions.length);
    // 同じ out/ で伏せ字版: 生の記録が残らない
    const ra = flow(['--out', flowOut, '--limit', '0', '--anonymize']);
    expect(ra.status, `${ra.stderr}\n${ra.stdout}`).toBe(0);
    expect(await mds()).toBe(0);
  });
});

describe.skipIf(!LIVE)('Phase 3 E2E: 実データ(ATLAS_LIVE=1、LLM は呼ばない)', () => {
  const src = process.env.ATLAS_COPILOT_HOME ?? join(homedir(), '.copilot');
  const out = join(ROOT, 'out', 'live');

  beforeAll(() => {
    if (!existsSync(join(out, 'sessions.json')) || !existsSync(join(out, 'snapshot'))) {
      const r = atlas(['all', '--home', src, '--out', out]);
      if (r.status !== 0) throw new Error(`atlas all が失敗: ${r.stderr}\n${r.stdout}`);
    }
  });

  it('d. 実データから bundle を作り、件数・総サイズ・最大パケットサイズを出す', async () => {
    const r = atlas(['bundle', '--out', out]);
    expect(r.status, r.stderr).toBe(0);
    const m = await readJson<BundleManifest>(join(out, 'bundle', 'manifest.json'));
    const s = await readJson<SessionsFile>(join(out, 'sessions.json'));
    const maxChars = Math.max(...m.sessions.map((e) => e.chars));
    console.log(
      `[live] bundle ${r.ms.toFixed(0)}ms, packets=${m.count}, skipped(no request)=${m.skipped.length}, total=${(m.totalBytes / 1024 / 1024).toFixed(2)}MB, max=${(m.maxBytes / 1024).toFixed(1)}KB (${maxChars} chars), truncated=${m.sessions.filter((e) => e.truncated > 0).length}, excerptOnly=${m.sessions.filter((e) => e.textSource === 'excerpt').length}, sessions=${s.sessions.length}`,
    );
    expect(m.count).toBeGreaterThan(0);
    expect(m.count + m.skipped.length).toBe(s.sessions.length);
    expect(maxChars).toBeLessThanOrEqual(DEFAULT_LIMITS.maxChars);
    for (const e of m.sessions) {
      const md = await readFile(join(out, 'bundle', e.path), 'utf8');
      expect({ id: e.id, missing: missingSections(md) }).toEqual({ id: e.id, missing: [] });
    }
  });
});
