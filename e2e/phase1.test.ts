// Phase 1 E2E(docs/PLAN.md「Phase 1: 骨組み + core」の 4 項目)
//  1. fixtures から sessions.json を生成し、件数がフィクスチャ内の手計算値と一致する
//  2. 実 ~/.copilot に対して snapshot → extract → metrics が完走し、セッション数が DB ∪ ディレクトリと一致する(ATLAS_LIVE=1 のときだけ)
//  3. 未知イベント種別が unknownEventTypes に計上され、落ちない
//  4. 元ディレクトリのファイルの mtime が実行前後で変わらない
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openReadOnly, runPipeline, type PipelineResult, type SessionRecord, type SessionsFile } from '../packages/core/src/index.ts';
import { buildFixtureHome, readFixtureStore, ROOT } from './fixture-home.ts';

const LIVE = process.env.ATLAS_LIVE === '1';
const WORK = join(ROOT, 'out', 'e2e-phase1');
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** dir 配下の全ファイルの mtime */
async function mtimes(dir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) {
      const p = join(e.parentPath, e.name);
      out.set(p, (await stat(p)).mtimeMs);
    }
  }
  return out;
}

// 期待値の根拠: scripts/naive-count.ts(core を使わずに JSONL を 1 行ずつ数える)が生成時に
// .fixtures/fixture-counts.json に書く値。fixture は scripts/synthetic-fixtures.ts と scripts/synthetic-base.ts が
// 架空の値だけで作るので、生成器を変えたらここも更新する。
const EXPECTED: Record<string, { toolTotal: number; tools: Record<string, number>; skills: number; agents: number; hooks: number; hookTypes: Record<string, number>; compactions: number; turns: number; aborts: number; askUser: number }> = {
  // old: 旧形式(usage 無し)。ツール 13 件のそれぞれに postToolUse、user.message 8 件のうち source 付き 2 件は依頼に数えない
  [id(1)]: { toolTotal: 13, tools: { web_fetch: 1, rg: 2, glob: 1, view: 8, store_memory: 1 }, skills: 0, agents: 0, hooks: 13, hookTypes: { postToolUse: 13 }, compactions: 1, turns: 6, aborts: 0, askUser: 0 },
  // new-events: usage_record のみ。preToolUse は 7 件中 5 件のツールにだけ付く
  [id(2)]: {
    toolTotal: 7,
    tools: { powershell: 3, view: 4 },
    skills: 0,
    agents: 0,
    hooks: 17,
    hookTypes: { sessionStart: 1, userPromptSubmitted: 1, userPromptTransformed: 1, preToolUse: 5, postToolUse: 7, agentStop: 1, sessionEnd: 1 },
    compactions: 1,
    turns: 1,
    aborts: 0,
    askUser: 0,
  },
  // new-db: usage_record + DB。サブエージェントの powershell も数える。サブエージェントへの指示(source 付き)は依頼に数えない
  [id(3)]: {
    toolTotal: 2,
    tools: { task: 1, powershell: 1 },
    skills: 0,
    agents: 1,
    hooks: 6,
    hookTypes: { sessionStart: 1, userPromptSubmitted: 2, subagentStop: 1, agentStop: 1, sessionEnd: 1 },
    compactions: 0,
    turns: 1,
    aborts: 0,
    askUser: 0,
  },
  // skill: toolName "skill" 1 件 + skill.invoked 1 件(同じ呼び出し → 1 件、via both)
  [id(4)]: { toolTotal: 6, tools: { skill: 1, view: 5 }, skills: 1, agents: 0, hooks: 0, hookTypes: {}, compactions: 0, turns: 1, aborts: 0, askUser: 0 },
  // agents: subagent.started 3 件(3 件目は完了前に記録が切れる)、abort 1、ask_user 1
  [id(5)]: {
    toolTotal: 22,
    tools: { view: 7, apply_patch: 3, rg: 1, store_memory: 1, powershell: 4, task: 3, grep: 2, ask_user: 1 },
    skills: 0,
    agents: 3,
    hooks: 0,
    hookTypes: {},
    compactions: 0,
    turns: 5,
    aborts: 1,
    askUser: 1,
  },
  // synthetic: 未知種別と壊れた行
  [id(99)]: { toolTotal: 1, tools: { view: 1 }, skills: 0, agents: 0, hooks: 0, hookTypes: {}, compactions: 0, turns: 1, aborts: 0, askUser: 0 },
  // Phase 5 で足した合成セッション(scripts/synthetic-fixtures.ts)。fixture-counts.json の素朴カウントから、
  // 内部ツール report_intent(008 に 2 件)と autopilot の自動継続(008 に 2 件)を除いた値
  [id(7)]: { toolTotal: 0, tools: {}, skills: 0, agents: 0, hooks: 0, hookTypes: {}, compactions: 0, turns: 0, aborts: 0, askUser: 0 },
  [id(8)]: { toolTotal: 5, tools: { edit: 1, create: 2, powershell: 1, apply_patch: 1 }, skills: 0, agents: 0, hooks: 0, hookTypes: {}, compactions: 0, turns: 1, aborts: 0, askUser: 0 },
  [id(9)]: { toolTotal: 1, tools: { view: 1 }, skills: 0, agents: 0, hooks: 0, hookTypes: {}, compactions: 0, turns: 1, aborts: 0, askUser: 0 },
  // Phase 6 で足した合成セッション(fixture-counts.json の素朴カウントと同じ。skill は tool + event の組 1 件 + event だけ 2 件)
  [id(11)]: {
    toolTotal: 10,
    tools: { 'github-mcp-server-search_code': 1, 'github-mcp-server-get_file_contents': 1, 'ide-get_diagnostics': 1, view: 3, edit: 1, create: 1, powershell: 1, skill: 1 },
    skills: 3,
    agents: 3,
    hooks: 3,
    hookTypes: { preToolUse: 2, postToolUse: 1 },
    compactions: 0,
    turns: 1,
    aborts: 0,
    askUser: 0,
  },
  [id(12)]: { toolTotal: 2, tools: { edit: 2 }, skills: 0, agents: 0, hooks: 0, hookTypes: {}, compactions: 0, turns: 1, aborts: 0, askUser: 0 },
  [id(13)]: { toolTotal: 0, tools: {}, skills: 0, agents: 0, hooks: 0, hookTypes: {}, compactions: 0, turns: 1, aborts: 0, askUser: 0 },
};

describe('Phase 1 E2E: fixtures', () => {
  let result: PipelineResult;
  let close: () => Promise<void>;
  let home: string;
  let before: Map<string, number>;
  let after: Map<string, number>;

  beforeAll(async () => {
    ({ home, close } = await buildFixtureHome(join(WORK, 'home')));
    before = await mtimes(home);
    // 実環境と同じく、書き手が開いたまま(行は WAL にだけある)で走らせる
    result = await runPipeline(home, join(WORK, 'out'));
    after = await mtimes(home);
  });
  afterAll(async () => close?.());

  const rec = (n: number): SessionRecord => {
    const s = result.sessions.sessions.find((x) => x.id === id(n));
    if (!s) throw new Error(`fixture ${id(n)} が sessions.json に無い`);
    return s;
  };

  it('sessions.json / metrics.json がファイルとして書かれ、読み戻せる', async () => {
    const s = JSON.parse(await readFile(result.paths.sessions, 'utf8')) as SessionsFile;
    // Phase 5 でレコードの形(empty・tools.internal・files.deleted など)が変わったため 2、
    // Phase 6 で tools.mcp・results / skills[].trigger / lines / projectSource / installed を足したため 3、
    // Phase 7 で exec / tools.durations / frictionDetail / todos / agents[].error を足したため 4
    expect(s.schemaVersion).toBe(4);
    expect(s.sessions.length).toBe(result.sessions.sessions.length);
    const m = JSON.parse(await readFile(result.paths.metrics, 'utf8'));
    // Phase 5: metrics は空のセッションを除いた集計 + 空の件数(006 / 007 / 010 の 3 件)
    expect(m.overall.sessions + m.emptySessions).toBe(s.sessions.length);
    expect(m.emptySessions).toBe(3);
  });

  // Phase 5 で合成セッションを足した: ディレクトリ 007〜009、DB だけの 010 → ディレクトリ 9 + DB 6、重なり 4 → 11 件
  // Phase 6 でディレクトリ 011〜013 を足した → ディレクトリ 12 + DB 6、重なり 4 → 14 件
  it('索引は DB ∪ ディレクトリ(ディレクトリ 12 + DB 6、重なり 4 → 14 件)', async () => {
    const store = await readFixtureStore();
    const dbIds = new Set(store.sessions.map((r) => r.id as string));
    const dirIds = new Set(readdirSync(join(home, 'session-state')));
    const union = new Set([...dbIds, ...dirIds]);
    expect(dbIds.size).toBe(6);
    expect(dirIds.size).toBe(12);
    expect(result.sessions.counts).toEqual({ sessions: union.size, dbOnly: 2, dirOnly: 8, both: 4, empty: 3 });
    expect(union.size).toBe(14);
    expect(rec(6).sources).toEqual(['db']);
    expect(rec(2).sources).toEqual(['dir']);
    expect(rec(1).sources).toEqual(['db', 'dir']);
  });

  it('ツール別・skill・agent・hook・compaction の件数が手計算値と一致する', () => {
    for (const [sid, e] of Object.entries(EXPECTED)) {
      const s = result.sessions.sessions.find((x) => x.id === sid)!;
      expect({
        toolTotal: s.tools.total,
        tools: s.tools.byName,
        skills: s.skills.length,
        agents: s.agents.length,
        hooks: s.hooks.total,
        hookTypes: s.hooks.byType,
        compactions: s.friction.compactions,
        turns: s.turns,
        aborts: s.friction.aborts,
        askUser: s.friction.askUser,
      }).toEqual(e);
    }
    // Phase 6: skill.invoked の trigger(fixture 004 は agent-invoked)
    expect(rec(4).skills).toEqual([{ name: 'wiki-query', at: expect.any(String), via: 'both', trigger: 'agent' }]);
    // metrics の全体値は各セッションの和
    const sum = (f: (e: (typeof EXPECTED)[string]) => number): number => Object.values(EXPECTED).reduce((a, e) => a + f(e), 0);
    expect(result.metrics.overall.tools.total).toBe(sum((e) => e.toolTotal));
    expect(result.metrics.overall.hooks.total).toBe(sum((e) => e.hooks));
    expect(result.metrics.overall.friction.compactions).toBe(sum((e) => e.compactions));
    expect(result.metrics.overall.agents.total).toBe(sum((e) => e.agents));
  });

  it('トークン: DB 優先・usage_record 補完・重複除去・旧形式は入力 null', async () => {
    const store = await readFixtureStore();
    const dbSum = (sid: string, col: string): number =>
      store.assistant_usage_events.filter((r) => r.session_id === sid).reduce((a, r) => a + Number(r[col] ?? 0), 0);
    // new-db: DB 4 行と usage_record 4 件は同一リクエスト(model・input・output が同じで 0.4 秒差)→ DB の 4 行だけ
    expect(rec(3).tokens).toMatchObject({ source: 'db', records: { db: 4, events: 0, duplicatesRemoved: 4 }, input: dbSum(id(3), 'input_tokens'), output: dbSum(id(3), 'output_tokens') });
    expect(rec(3).tokens.input).toBe(33500); // 12000 + 4000 + 4500 + 13000(scripts/synthetic-base.ts の DB_REQS)
    // サブエージェントの行は DB の agent_id(= subagent.started の agentId)で agent 名に結び付く
    expect(Object.keys(rec(3).tokens.byAgent).sort()).toEqual(['explore', 'main']);
    expect(rec(3).tokens.byAgent.explore).toMatchObject({ input: 8500, requests: 2 });
    // DB の session_files にだけある変更ファイル(イベント側にファイル操作が無い)
    expect(rec(3).files.changed).toEqual(['X:\\synthetic-db\\work\\notes.md']);
    // skill: DB のみ(initiator の記録が無い 3 行。premium は shutdown の値で補う)
    expect(rec(4).tokens).toMatchObject({ source: 'db', records: { db: 3, events: 0, duplicatesRemoved: 0 }, input: dbSum(id(4), 'input_tokens'), premiumRequests: 0 });
    // new-events: usage_record 6 件(入力の合計 143000)
    expect(rec(2).tokens).toMatchObject({ source: 'events', records: { db: 0, events: 6, duplicatesRemoved: 0 }, input: 143000 });
    // 旧形式で shutdown も無い(途中で切れたログ): 入力トークン無し、出力は assistant.message の outputTokens の合計
    expect(rec(5).tokens).toMatchObject({ source: 'partial', input: null, output: 4600 });
    // Phase 5 で足した合成 008 が usage_record を持つため 4 → 5、Phase 6 の合成 011〜013 も持つため 5 → 8
    expect(result.metrics.overall.sessionsWithInputTokens).toBe(8);
  });

  it('トークン: DB も usage_record も無い旧形式は session.shutdown.modelMetrics で埋める(source shutdown)', () => {
    // 期待値の根拠: scripts/synthetic-base.ts の OLD_MODEL_METRICS(gpt-5.5-mini と gpt-5.5)の合計。
    // .fixtures/fixture-counts.json の 00…001.lastShutdown(素朴カウント)と同じ値
    const t = rec(1).tokens;
    expect(t).toMatchObject({
      source: 'shutdown',
      input: 250000, // 200000 + 50000
      output: 12000, // 8000 + 4000
      cacheRead: 170000, // 150000 + 20000
      cacheWrite: 0,
      reasoning: 6500, // 5000 + 1500
      requests: 13, // 10 + 3
      premiumRequests: 4.5, // totalPremiumRequests
      nanoAiu: 20000000000, // totalNanoAiu
      records: { db: 0, events: 0, duplicatesRemoved: 0 },
      byAgent: {},
    });
    expect(Object.keys(t.byModel).sort()).toEqual(['gpt-5.5', 'gpt-5.5-mini']);
    expect(t.byModel['gpt-5.5-mini']).toMatchObject({ input: 200000, requests: 10, premiumRequests: 1.5, nanoAiu: 8000000000 });
    expect(Object.values(t.byModel).reduce((a, m) => a + (m.input ?? 0), 0)).toBe(250000);
    expect(t.shutdown).toMatchObject({ input: 250000, output: 12000 }); // 参考値も残る
    // DB / events があるセッションは従来どおり(shutdown は参考値)
    expect(rec(3).tokens.source).toBe('db');
    expect(rec(2).tokens.source).toBe('events');
    // metrics にも shutdown 由来が入る
    expect(result.metrics.byModel['gpt-5.5'].input).toBeGreaterThan(0);
  });

  it('wiki: skill 呼び出しと index / ページ読みを分ける(fixture 004 の wiki 引数付きツール呼び出し 4 件)', () => {
    const w = rec(4).wiki;
    expect(w.skillCalls).toEqual(['wiki-query']);
    expect(w.indexReads + w.pageReads.length + w.writes + w.otherCalls).toBe(4);
    expect(w.indexReads).toBe(1);
    expect(w.pageReads.every((p) => p.startsWith('wiki/') && p.endsWith('.md'))).toBe(true);
    // index.md 1・wiki/ 配下のページ 2・log.md(その他)1
    expect(w.pageReads).toEqual(['wiki/topics/synthetic-page-a.md', 'wiki/topics/synthetic-page-b.md']);
    expect(w.otherCalls).toBe(1);
  });

  it('指示ファイル: system.message の <custom_instruction> を見出し・取り込み元・複数プロジェクト共通で特定する', () => {
    const files = (n: number): [string, string, string, number][] => rec(n).instructions.map((i) => [i.file, i.scope, i.method, i.injections]);
    // 001: 共通ブロックと imported の AGENTS.md は system.message 3 回に入る。applyTo は 1 回だけ
    expect(files(1)).toEqual([
      ['copilot-instructions.md', 'user', 'cross-project', 3],
      ['AGENTS.md', 'repo', 'imported-source', 3],
      ['.github/instructions', 'repo', 'apply-to', 1],
    ]);
    expect(rec(1).instructions[1].sourcePath).toBe('X:\\synthetic-old\\app\\AGENTS.md');
    // 002: 見出しの Copilot / 003: 見出しから決められない / 004: @ で始まる行だけの CLAUDE.md
    expect(files(2)).toEqual([['copilot-instructions.md', 'user', 'cross-project', 1], ['copilot-instructions.md', 'repo', 'heading-keyword', 1]]);
    expect(files(3)).toEqual([['copilot-instructions.md', 'user', 'cross-project', 1], ['unknown', 'unknown', 'unresolved', 1]]);
    expect(files(4)).toEqual([['copilot-instructions.md', 'user', 'cross-project', 1], ['CLAUDE.md', 'repo', 'import-stub', 1]]);
    // 005: system.message はあるが指示ファイルは無い
    expect(rec(5).instructions).toEqual([]);
    // metrics: ユーザー単位の共通ブロックは 4 セッション
    expect(result.metrics.overall.instructions.byFile['copilot-instructions.md (user)'].sessions).toBe(4);
  });

  it('所要時間: 5 分を超える間はアクティブ時間に入れない(001 は 10 分の間を含む)', () => {
    // イベント 89 件の間は 88 回。1 回だけ 1 秒 + 10 分、残り 87 回は 1 秒 → アクティブは 87 秒
    expect(rec(1).durationMs).toBe(88_000 + 600_000);
    expect(rec(1).activeMs).toBe(87_000);
  });

  it('未知イベント種別が unknownEventTypes に計上され、壊れた行は数えて飛ばす', () => {
    expect(rec(99).unknownEventTypes).toEqual({ 'future.event_kind': 2, 'another.unknown': 1 });
    expect(rec(99).events.badLines).toBe(1);
    expect(result.sessions.warnings.unknownEventTypes).toEqual({ 'future.event_kind': 2, 'another.unknown': 1 });
    expect(result.sessions.warnings.badLines).toBe(1);
    expect(result.sessions.warnings.messages.some((m) => m.includes('future.event_kind'))).toBe(true);
    // 既知の種別だけで作った合成セッションは未知種別を持たない
    for (const n of [1, 2, 3, 4, 5]) expect(rec(n).unknownEventTypes).toEqual({});
  });

  it('元ディレクトリ(-wal / -shm を含む)の mtime が実行前後で変わらない(書き手が落ちて WAL が残った状態)', () => {
    expect([...before.keys()].some((p) => p.endsWith('session-store.db-wal'))).toBe(true);
    expect([...before.keys()].some((p) => p.endsWith('session-store.db-shm'))).toBe(true);
    expect(after).toEqual(before);
  });

  it('書き手が開いたまま(Copilot 実行中)でも mtime が変わらず、WAL の行を取り込む', async () => {
    const alive = await buildFixtureHome(join(WORK, 'home-alive'), { writer: 'alive' });
    try {
      const b = await mtimes(alive.home);
      const r = await runPipeline(alive.home, join(WORK, 'out-alive'));
      expect(await mtimes(alive.home)).toEqual(b);
      expect(r.sessions.counts.sessions).toBe(result.sessions.counts.sessions);
      expect(r.sessions.sessions.find((x) => x.id === id(3))?.tokens.records.db).toBe(4);
    } finally {
      await alive.close();
    }
  });
});

describe.skipIf(!LIVE)('Phase 1 E2E: 実データ(ATLAS_LIVE=1)', () => {
  const src = process.env.ATLAS_COPILOT_HOME ?? join(homedir(), '.copilot');
  const out = join(ROOT, 'out', 'live');
  let result: PipelineResult;
  let startedAt: number;
  let preDirs: Set<string>;
  let before: Map<string, number>;
  let after: Map<string, number>;
  let wallMs: number;

  /** 読み取り対象(DB と各セッションの workspace.yaml / events.jsonl) */
  const watched = (): string[] => {
    const files = ['session-store.db', 'session-store.db-wal', 'session-store.db-shm', 'data.db', 'data.db-wal', 'data.db-shm'].map((f) => join(src, f));
    const state = join(src, 'session-state');
    for (const d of readdirSync(state)) for (const f of ['workspace.yaml', 'events.jsonl']) files.push(join(state, d, f));
    return files.filter((f) => existsSync(f));
  };
  const sessionDirsIn = (state: string): Set<string> =>
    new Set(
      readdirSync(state, { withFileTypes: true })
        .filter((e) => e.isDirectory() && (existsSync(join(state, e.name, 'workspace.yaml')) || existsSync(join(state, e.name, 'events.jsonl'))))
        .map((e) => e.name),
    );

  beforeAll(async () => {
    startedAt = Date.now();
    preDirs = sessionDirsIn(join(src, 'session-state'));
    before = new Map(watched().map((f) => [f, statSync(f).mtimeMs]));
    const t = performance.now();
    result = await runPipeline(src, out);
    wallMs = performance.now() - t;
    after = new Map([...before.keys()].map((f) => [f, statSync(f).mtimeMs]));
  });

  it('snapshot → extract → metrics が完走し、セッション数が DB ∪ ディレクトリと一致する', async () => {
    const db = await openReadOnly(join(result.paths.snapshot, 'session-store.db'));
    const dbIds = new Set((db.prepare('SELECT id FROM sessions').all() as { id: string }[]).map((r) => r.id));
    db.close();
    const snapDirs = sessionDirsIn(join(result.paths.snapshot, 'session-state'));
    // 実行中に増えたディレクトリは、開始後に作られたものに限る
    for (const d of snapDirs) if (!preDirs.has(d)) expect(statSync(join(src, 'session-state', d)).birthtimeMs).toBeGreaterThanOrEqual(startedAt - 1000);
    for (const d of preDirs) expect(snapDirs.has(d)).toBe(true);
    const union = new Set([...dbIds, ...snapDirs]);
    const s = result.sessions;
    const withInput = s.sessions.filter((x) => x.tokens.input != null).length;
    console.log(
      `[live] ${wallMs.toFixed(0)}ms (snapshot ${result.timingsMs.snapshot.toFixed(0)} / extract ${result.timingsMs.extract.toFixed(0)} / metrics ${result.timingsMs.metrics.toFixed(0)}) ` +
        `db=${dbIds.size} dirs=${snapDirs.size} union=${union.size} counts=${JSON.stringify(s.counts)} withInput=${withInput} bySource=${JSON.stringify(s.sessions.reduce<Record<string, number>>((a, x) => ((a[x.tokens.source] = (a[x.tokens.source] ?? 0) + 1), a), {}))} ` +
        `unknown=${JSON.stringify(s.warnings.unknownEventTypes)} badLines=${s.warnings.badLines}`,
    );
    expect(s.counts.sessions).toBe(union.size);
    expect(s.sessions.every((x) => union.has(x.id))).toBe(true);
    // Phase 5: metrics は空のセッションを除いた集計 + 空の件数
    expect(result.metrics.overall.sessions + result.metrics.emptySessions).toBe(union.size);
    expect(withInput).toBeGreaterThanOrEqual(120); // DB∪events 75 + shutdown 由来 53 前後
  });

  it('元ファイルの mtime が変わらない(実行中に Copilot 自身が書いたものは除く)', () => {
    // Copilot が動いていると -wal / 実行中セッションの events.jsonl は本人が更新する。
    // 開始の 10 分前より古い mtime を持っていたファイルは、こちらが触れていない限り変わらないはず。
    const quietBefore = startedAt - 10 * 60 * 1000;
    const changed = [...before].filter(([f, m]) => after.get(f) !== m);
    const changedQuiet = changed.filter(([, m]) => m < quietBefore).map(([f]) => f);
    console.log(
      `[live] watched=${before.size} changed=${changed.length} (直近に Copilot が書いていたもの: ${changed
        .slice(0, 5)
        .map(([f]) => f.slice(src.length + 1))
        .join(', ')}) changedQuiet=${changedQuiet.length}`,
    );
    expect(changedQuiet).toEqual([]);
  });
});
