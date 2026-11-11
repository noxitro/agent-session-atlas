// 段階 2: 依頼ごとの判定(turn-judgments.json)の検証・取り込み、判定に渡すファイルの塊と分割、copilot -p の応答の読み取りと実行
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeSession } from '../../core/src/normalize.ts';
import type { CopilotEvent, SessionRecord } from '../../core/src/types.ts';
import type { JudgeBackend } from '../src/backends/types.ts';
import { buildBundle } from '../src/bundle.ts';
import { buildTurnBundle, buildTurnPrompt, chunksOf, collectTurnTexts, DEFAULT_TURN_LIMITS } from '../src/turn-bundle.ts';
import { runTurnJudge, turnImportPhases, turnItemsFromTexts } from '../src/turn-run.ts';
import { importTurnJudgmentsText, readTurnJudgments, turnItemProblems } from '../src/turn-schema.ts';

const PHASES = ['要件定義', '設計', '実装', 'テスト'];
const T0 = Date.parse('2026-11-06T00:00:00.000Z');
const ev = (dt: number, type: string, data: Record<string, unknown>, extra: Partial<CopilotEvent> = {}): CopilotEvent => ({ type, data, timestamp: new Date(T0 + dt).toISOString(), ...extra });
const item = (turn: number, p: Record<string, unknown> = {}) => ({ sessionId: 's1', turn, kind: 'task', outcome: 'as_is', mismatch: null, phase: '実装', confidence: 0.8, note: '理由', ...p });

describe('依頼の判定の形', () => {
  it('種類と扱いの組み合わせ・合わなかった点の要否・工程名・確信度を確かめる', () => {
    expect(turnItemProblems(item(1), '1 件目', PHASES)).toEqual([]);
    expect(turnItemProblems(item(1, { kind: 'question', outcome: 'helpful' }), '1 件目', PHASES)).toEqual([]);
    expect(turnItemProblems(item(1, { outcome: 'fix_style', mismatch: 'quality' }), '1 件目', PHASES)).toEqual([]);
    // 質問に作業の扱い、作業に質問の扱いは不可
    expect(turnItemProblems(item(1, { kind: 'question', outcome: 'as_is' }), '1 件目', PHASES).join()).toMatch(/kind が question のとき helpful/);
    expect(turnItemProblems(item(1, { outcome: 'helpful' }), '1 件目', PHASES).join()).toMatch(/kind が task のとき as_is/);
    // 修正・不採用・的外れには合わなかった点が要り、それ以外には付けない
    expect(turnItemProblems(item(1, { outcome: 'rejected' }), '1 件目', PHASES).join()).toMatch(/mismatch は outcome が rejected のとき/);
    expect(turnItemProblems(item(1, { mismatch: 'defect' }), '1 件目', PHASES).join()).toMatch(/mismatch は outcome が as_is のときは null/);
    expect(turnItemProblems(item(1, { phase: '開発' }), '1 件目', PHASES).join()).toMatch(/phase は 要件定義 \/ 設計 \/ 実装 \/ テスト/);
    expect(turnItemProblems(item(0, { confidence: 2 }), '1 件目', PHASES)).toHaveLength(2);
    expect(turnItemProblems('x', '2 件目', PHASES)).toEqual(['2 件目が無いか、{ … } の形ではありません']);
  });

  it('返答の取り込み: 1 件でも合わなければ何も書かず、同じ依頼は上書き、集計に無い依頼は知らせる', async () => {
    const d = await mkdtemp(join(tmpdir(), 'atlas-turnj-'));
    try {
      const path = join(d, 'turn-judgments.json');
      const bad = '```json\n' + JSON.stringify({ items: [item(1), item(2, { outcome: 'rejected' })] }) + '\n```';
      await expect(importTurnJudgmentsText(bad, path, { phases: PHASES })).rejects.toThrow(/何も取り込んでいません/);
      await expect(importTurnJudgmentsText(bad, path, { phases: PHASES })).rejects.toMatchObject({ problems: [expect.stringMatching(/^2 件目\(セッション s1 の依頼 2\)の mismatch/)] });
      expect(await readTurnJudgments(path)).toBeNull();
      const ok = '判定しました\n```json\n' + JSON.stringify({ judge: { model: 'm365' }, items: [item(1), item(2, { outcome: 'fix_content', mismatch: 'requirement' }), item(9)] }) + '\n```';
      const r = await importTurnJudgmentsText(ok, path, { phases: PHASES, turnsBySession: new Map([['s1', 2]]) });
      expect(r).toMatchObject({ imported: 3, overwritten: 0, unknown: ['s1 の依頼 9'], total: 3 });
      const again = await importTurnJudgmentsText('```json\n' + JSON.stringify([item(2, { outcome: 'fix_style', mismatch: 'quality' })]) + '\n```', path, { phases: PHASES });
      expect(again).toMatchObject({ imported: 1, overwritten: 1, total: 3 });
      const j = (await readTurnJudgments(path))!;
      expect(j.items.find((i) => i.turn === 2)).toMatchObject({ outcome: 'fix_style', mismatch: 'quality', judge: { backend: 'external' } });
      expect(j.items.find((i) => i.turn === 1)?.judge?.model).toBe('m365');
      expect(j.phases).toEqual(PHASES);
      // 工程名の設定を変えて取り込んでも、前の名前の判定を読める(一覧は今の名前を先に、前の名前を後ろに残す)
      const next = ['調査', '開発', '検証'];
      await importTurnJudgmentsText('```json\n' + JSON.stringify([item(5, { phase: '開発' })]) + '\n```', path, { phases: next });
      const k = (await readTurnJudgments(path))!;
      expect(k.phases).toEqual(['調査', '開発', '検証', '要件定義', '設計', '実装', 'テスト']);
      expect(k.items.map((i) => i.phase)).toEqual(['実装', '実装', '開発', '実装']);
      // 返答の検証は今の一覧で
      await expect(importTurnJudgmentsText('```json\n' + JSON.stringify([item(6)]) + '\n```', path, { phases: next })).rejects.toThrow(/何も取り込んでいません/);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe('判定に渡すファイル', () => {
  let d: string;
  let s: SessionRecord;
  beforeEach(async () => {
    d = await mkdtemp(join(tmpdir(), 'atlas-turnb-'));
    const events: CopilotEvent[] = [ev(0, 'session.start', { context: { cwd: 'X:\\p' } })];
    for (let i = 1; i <= 8; i++) {
      events.push(ev(i * 1000, 'user.message', { content: `依頼 ${i} の本文` }));
      if (i === 3) events.push(ev(i * 1000 + 50, 'user.message', { content: '(自動継続)', isAutopilotContinuation: true }));
      events.push(ev(i * 1000 + 100, 'assistant.message', { content: `応答 ${i}` }));
      events.push(ev(i * 1000 + 200, 'assistant.message', { content: 'サブエージェントの発言', parentToolCallId: 'x' }));
    }
    s = await normalizeSession({ id: 's1', events });
    await mkdir(join(d, 'snapshot', 'session-state', 's1'), { recursive: true });
    await writeFile(join(d, 'snapshot', 'session-state', 's1', 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
  });
  afterEach(async () => {
    await rm(d, { recursive: true, force: true });
  });

  it('依頼の区切りは normalize と同じ(自動継続・サブエージェントの発言は数えない)。塊は 6 件まで、次の依頼の文を添える', async () => {
    const t = (await collectTurnTexts(join(d, 'snapshot'), 's1'))!;
    expect(t.requests).toHaveLength(8);
    expect(t.responses[0]).toBe('応答 1');
    expect(s.analysis.turnStats).toHaveLength(8);
    const chunks = chunksOf(s, t, null);
    expect(chunks.map((c) => c.turns)).toEqual([
      [1, 2, 3, 4, 5, 6],
      [7, 8],
    ]);
    expect(chunks[0].markdown).toContain('## 依頼 7(判定しない。依頼 6 の成果の扱いを読むための参考)');
    expect(chunks[1].markdown).toContain('次の依頼はありません(セッションの最後)。依頼 8 の outcome は unknown(判定不能)にしてください。');
    // 塊の先頭の依頼が何への反応かを読めるよう、前の依頼文を参考に添える
    expect(chunks[1].markdown).toContain('## 依頼 6(判定しない。依頼 7 が何への反応かを読むための参考)');
    expect(chunks[0].markdown).not.toContain('何への反応か');
    // 未判定だけ: 続いた番号ごとに区切る
    expect(chunksOf(s, t, new Set([2, 3, 6])).map((c) => c.turns)).toEqual([[2, 3], [6]]);
    // プロンプトに判定する依頼番号と sessionId を書く(偽 copilot もここを読む)
    expect(buildTurnPrompt(chunks[1], PHASES)).toContain('items には依頼 7, 8 の 2 件をすべて入れ、sessionId は "s1" にしてください');
  });

  it('依頼が上限(200 件)を超えるセッションは、200 件目に 201 件目の文を参考に添える(セッションの最後とは書かない)', async () => {
    const events: CopilotEvent[] = [ev(0, 'session.start', { context: { cwd: 'X:\\p' } })];
    for (let i = 1; i <= 203; i++) {
      events.push(ev(i * 1000, 'user.message', { content: `依頼 ${i} の本文` }));
      events.push(ev(i * 1000 + 100, 'assistant.message', { content: `応答 ${i}` }));
    }
    const big = await normalizeSession({ id: 's2', events });
    await mkdir(join(d, 'snapshot', 'session-state', 's2'), { recursive: true });
    await writeFile(join(d, 'snapshot', 'session-state', 's2', 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
    const t = (await collectTurnTexts(join(d, 'snapshot'), 's2'))!;
    expect(t.requests).toHaveLength(201);
    expect(t.responses[200]).toBeNull();
    const chunks = chunksOf(big, t, null);
    expect(chunks.flatMap((c) => c.turns)).toHaveLength(200);
    const last = chunks[chunks.length - 1].markdown;
    expect(last).toContain('## 依頼 201(判定しない。依頼 200 の成果の扱いを読むための参考)');
    expect(last).not.toContain('次の依頼はありません');
  });

  it('返答の取り込みでは、添付を作ったときの工程名と今の設定の工程名の両方を認める', async () => {
    await buildTurnBundle([s], { bundleDir: join(d, 'tb'), snapshotDir: join(d, 'snapshot'), phases: PHASES });
    expect(await turnImportPhases(join(d, 'tb'), ['調査', '実装'])).toEqual([...PHASES, '調査']);
    expect(await turnImportPhases(join(d, 'none'), ['調査', '実装'])).toEqual(['調査', '実装']);
  });

  it('分割ファイルと塊を書き、判定済みを除ける', async () => {
    const m = await buildTurnBundle([s], { bundleDir: join(d, 'tb'), snapshotDir: join(d, 'snapshot'), phases: PHASES, judged: new Map([['s1', new Set([1, 2])]]), limits: { ...DEFAULT_TURN_LIMITS, partTurns: 4 } });
    expect(m).toMatchObject({ count: 6, unjudgedOnly: true, skipped: [] });
    expect(m.chunks.map((c) => c.turns)).toEqual([
      [3, 4, 5, 6, 7, 8],
    ]);
    expect(m.parts).toHaveLength(1);
    const part = await readFile(join(d, 'tb', m.parts[0].path), 'utf8');
    expect(part).toContain('# Copilot の依頼ごとの判定の指示(分割 1 / 1)');
    expect(part).toContain('`要件定義` / `設計` / `実装` / `テスト`');
    expect(await readdir(join(d, 'tb', 'chunks'))).toEqual(['0001.md']);
  });

  it('作り直しが途中で止まったら、前の一覧(manifest.json)を残さない(消した後のファイルを指す「作成済み」にしない)', async () => {
    // 依頼ごとの判定
    await buildTurnBundle([s], { bundleDir: join(d, 'tb'), snapshotDir: join(d, 'snapshot'), phases: PHASES });
    expect(existsSync(join(d, 'tb', 'manifest.json'))).toBe(true);
    const stop = (): string => {
      throw new Error('途中で止まった');
    };
    await expect(buildTurnBundle([s], { bundleDir: join(d, 'tb'), snapshotDir: join(d, 'snapshot'), phases: PHASES, boundary: stop })).rejects.toThrow('途中で止まった');
    expect(existsSync(join(d, 'tb', 'manifest.json'))).toBe(false);
    // 工数の判定
    await buildBundle([s], { bundleDir: join(d, 'b'), snapshotDir: join(d, 'snapshot') });
    expect(existsSync(join(d, 'b', 'manifest.json'))).toBe(true);
    await expect(buildBundle([s], { bundleDir: join(d, 'b'), snapshotDir: join(d, 'snapshot'), perPart: 0 })).rejects.toThrow(/perPart/);
    expect(existsSync(join(d, 'b', 'manifest.json'))).toBe(false);
    // もう一度作れば元に戻る
    await buildBundle([s], { bundleDir: join(d, 'b'), snapshotDir: join(d, 'snapshot') });
    expect(existsSync(join(d, 'b', 'manifest.json'))).toBe(true);
  });

  it('copilot -p で塊ごとに判定し、1 塊ずつ確定する。応答が欠けた塊は failures に残して次へ進む', async () => {
    await buildTurnBundle([s], { bundleDir: join(d, 'tb'), snapshotDir: join(d, 'snapshot'), phases: PHASES });
    const prompts: string[] = [];
    const backend: JudgeBackend = {
      name: 'copilot-cli',
      model: 'm',
      judge: async () => {
        throw new Error('使わない');
      },
      ask: async (prompt) => {
        prompts.push(prompt);
        const turns = /items には依頼 ([\d, ]+) の/.exec(prompt)![1].split(',').map((x) => Number(x.trim()));
        // 2 回目の塊(依頼 7, 8)は依頼 8 を返さない
        const items = turns.filter((t) => t !== 8).map((t) => item(t));
        return { texts: ['```json\n' + JSON.stringify({ items }) + '\n```'], usage: null, notes: [] };
      },
    };
    const path = join(d, 'turn-judgments.json');
    const r = await runTurnJudge({ bundleDir: join(d, 'tb'), path, backend });
    expect(r).toMatchObject({ chunks: 2, attempted: 2, succeeded: 1, turns: 6 });
    expect(r.failed[0]).toMatchObject({ sessionId: 's1', turns: [7, 8], error: expect.stringMatching(/依頼 8 の判定がありません/) });
    const j = (await readTurnJudgments(path))!;
    expect(j.items.map((i) => i.turn)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(j.failures).toHaveLength(1);
    // 上限: 判定済みの塊は飛ばし、残りだけ
    const again = await runTurnJudge({ bundleDir: join(d, 'tb'), path, backend, limit: 1 });
    expect(again.attempted).toBe(1);
    expect(prompts).toHaveLength(3);

    // 塊の中で判定済みの依頼は判定し直さない: 依頼 1 の判定を書き換えておき、塊 1〜6 を判定し直させても残る
    const j2 = (await readTurnJudgments(path))!;
    j2.items[0] = { ...j2.items[0], note: '前の判定' };
    j2.items.splice(5, 1); // 依頼 6 を未判定に戻す → 塊 1〜6 がもう一度対象になる
    await writeFile(path, JSON.stringify(j2));
    const third = await runTurnJudge({ bundleDir: join(d, 'tb'), path, backend, limit: 1 });
    expect(third.turns).toBe(1);
    const j3 = (await readTurnJudgments(path))!;
    expect(j3.items.find((i) => i.turn === 1)?.note).toBe('前の判定');
    expect(j3.items.find((i) => i.turn === 6)).toBeDefined();
  });

  it('応答の読み取り: sessionId は補い、別のセッションや欠けは理由を出す', () => {
    expect(turnItemsFromTexts(['```json\n{"items":[{"turn":1,"kind":"task","outcome":"as_is","mismatch":null,"phase":"実装","confidence":0.5,"note":""}]}\n```'], 's1', [1], PHASES)).toHaveLength(1);
    expect(() => turnItemsFromTexts(['{"items":[{"sessionId":"x","turn":1,"kind":"task","outcome":"as_is","mismatch":null,"phase":"実装","confidence":0.5,"note":""}]}'], 's1', [1], PHASES)).toThrow(/sessionId が違う/);
    expect(() => turnItemsFromTexts(['説明だけ'], 's1', [1], PHASES)).toThrow(/JSON を取り出せません/);
  });
});
