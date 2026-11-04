// Phase 11: 全文記録(除外と網羅)、網羅の表、指示文・skill の閲覧ページ
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeSession } from '../../core/src/normalize.ts';
import type { CopilotEvent, SessionRecord } from '../../core/src/types.ts';
import { contentHash } from '../../core/src/instructions.ts';
import { COVERAGE_RULES, CoverageCounter, coverageFile, desktopCoverage, ruleFor } from '../src/coverage.ts';
import { createFileSink, looksOpaque, renderFull } from '../src/full.ts';
import { cleanHeading, LibraryCollector, lineDiff, renderInstructionsHtml, skillAnchor, writeLibrary } from '../src/library.ts';
import { seriesKey } from '../src/lib/insights.ts';
import { KNOWN_EVENT_TYPES } from '../../core/src/event-types.ts';

const T = '2026-10-01T00:00:00.000Z';
const OPAQUE = 'A'.repeat(60) + 'b'.repeat(60) + '==';
const SECRET = ['ghp', 'FULLFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE02'].join('_'); // トークンの形をソースに直書きしない
/** 100 字以上の英数字列(16 進ダンプのようなもの)。reasoningBlocks の外では除外しない */
const LONG_ALNUM = 'deadbeef0123456789'.repeat(8);
const ev = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): CopilotEvent => ({ type, data, timestamp: T, id: `id-${type}`, parentId: null, ...extra });
const EVENTS: CopilotEvent[] = [
  ev('session.start', { sessionId: 's', copilotVersion: '1.0.0', context: { cwd: 'X:\\p' } }),
  ev('system.message', { role: 'system', content: '<custom_instruction>\n# AGENTS.md\n\nルール 1\n</custom_instruction>' }),
  ev('user.message', { content: '依頼の本文 UNIQUE-REQUEST-TEXT', transformedContent: '依頼の本文 UNIQUE-REQUEST-TEXT', supportedNativeDocumentMimeTypes: ['a', 'b'] }),
  ev('assistant.message', { content: '応答の本文', reasoningText: '考えた内容 UNIQUE-REASONING', reasoningBlocks: [{ type: 'text', text: '読める推論' }, { type: 'enc', data: OPAQUE }], encryptedContent: OPAQUE, reasoningOpaque: OPAQUE, toolRequests: [{ toolCallId: 'c1', name: 'bash', arguments: { command: 'ls' } }], outputTokens: 10 }),
  ev('tool.execution_start', { toolName: 'bash', toolCallId: 'c1', arguments: { command: 'ls', hexdump: LONG_ALNUM } }),
  ev('tool.execution_complete', { toolCallId: 'c1', success: true, result: { content: `結果の本文 UNIQUE-RESULT ${SECRET}`, detailedContent: `詳細の本文 UNIQUE-DETAILED ${LONG_ALNUM}` }, toolTelemetry: { ms: 5 } }),
  ev('tool.execution_start', { toolName: 'view', toolCallId: 'c2', arguments: { path: 'x' } }),
  ev('tool.execution_complete', { toolCallId: 'c2', success: true, result: { content: '同じ本文 UNIQUE-SAME', detailedContent: '同じ本文 UNIQUE-SAME' } }),
  ev('assistant.message', { content: ['配列の content', { nested: 'UNIQUE-NONSTRING' }], reasoningText: 42, toolRequests: [] }),
  ev('hook.start', { hookType: 'postToolUse', hookInvocationId: 'h1', input: { sessionId: 's', toolName: 'bash', toolResult: { textResultForLlm: `結果の本文 UNIQUE-RESULT ${SECRET}`, resultType: 'text' } } }),
  ev('hook.end', { hookType: 'postToolUse', hookInvocationId: 'h1', success: true }),
  ev('skill.invoked', { name: 'my-skill', path: 'skills/my-skill/SKILL.md', content: '# my-skill\n\nskill の本文 UNIQUE-SKILL', trigger: 'user-invoked' }),
  ev('session.binary_asset', { assetId: 'asset-1', type: 'image', mimeType: 'image/png', byteLength: 8, data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'), description: '画像' }),
  ev('session.compaction_complete', { success: true, summaryContent: '要約 UNIQUE-SUMMARY', checkpointNumber: 1, checkpointPath: 'X:\\cp\\001.md' }),
  ev('session.shutdown', { shutdownType: 'exit', currentTokens: 1 }),
  ev('brand.new_type', { mystery: 'x' }),
];

describe('coverage', () => {
  it('既知の全イベント種別に扱いの表があり、トップレベルのキーと未知のキーの扱いが決まる', () => {
    for (const t of KNOWN_EVENT_TYPES) expect({ t, has: t in COVERAGE_RULES }).toEqual({ t, has: true });
    expect(ruleFor('assistant.message', 'encryptedContent')?.treatment).toBe('excluded');
    expect(ruleFor('assistant.message', 'reasoningBlocks')?.treatment).toBe('partial');
    expect(ruleFor('assistant.message', '^id')?.treatment).toBe('ref');
    expect(ruleFor('session.start', 'anything')?.treatment).toBe('full');
    expect(ruleFor('assistant.message', 'brandNewKey')).toBeNull();
    expect(ruleFor('brand.new_type', 'mystery')).toBeNull();
    const c = new CoverageCounter();
    for (const e of EVENTS) c.add(e as never);
    const f = coverageFile(c, 1, desktopCoverage({ tables: { sessions: { allowed: ['id'], unlisted: ['secret_col'], rows: 1 } }, forbidden: { accounts: 'token' }, otherTables: ['other'] }), T);
    expect(f.events).toBe(EVENTS.length);
    expect(f.keys.find((k) => k.type === 'assistant.message' && k.key === 'encryptedContent')).toMatchObject({ treatment: 'excluded', n: 1, bytes: OPAQUE.length + 2 });
    expect(c.unclassified().map((k) => `${k.type}|${k.key}`)).toEqual(['brand.new_type|mystery']);
    expect(f.summary.unclassified.keys).toBe(1);
    expect(f.desktop).toMatchObject({ unclassified: 1 });
    expect(f.desktop!.columns).toContainEqual({ table: 'accounts', column: '*', treatment: 'excluded', reason: 'token' });
  });
});

describe('renderFull', () => {
  let dir: string;
  let rec: SessionRecord;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-full-'));
    rec = await normalizeSession({ id: 'full-1', workspace: { cwd: 'X:\\p', created_at: T }, events: EVENTS });
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('本文・推論・引数・結果・hook・要約・skill を上限なしで出し、暗号化データと base64 本体だけ除外し、秘密情報は伏せ、未分類を末尾に出す', async () => {
    const c = new CoverageCounter();
    const r = await renderFull(rec, EVENTS, [], { generatedAt: T, assetsDir: join(dir, 'assets'), assetsHref: 'assets', sessionDir: null, sessionDirHref: null, coverage: c, walNote: 'WAL の注意' });
    const md = r.markdown;
    for (const s of ['UNIQUE-REQUEST-TEXT', '応答の本文', 'UNIQUE-REASONING', '読める推論', 'UNIQUE-RESULT', 'UNIQUE-SUMMARY', 'UNIQUE-SKILL', '"command": "ls"', 'postToolUse', 'brand.new_type']) expect(md).toContain(s);
    // 引数や結果の中の 100 字以上の英数字列は除外しない(不透明データの判定は reasoningBlocks の配下だけ)
    expect(md.split(LONG_ALNUM).length - 1).toBe(2);
    // result の content と detailedContent は両方出す(同じなら 1 回)
    expect(md).toContain('result.content:');
    expect(md).toContain('result.detailedContent:');
    expect(md).toContain('UNIQUE-DETAILED');
    expect(md).toContain('result(content と detailedContent は同一):');
    expect(md.split('UNIQUE-SAME').length - 1).toBe(1);
    // 文字列でない content / reasoningText も落とさない(JSON で出す)
    expect(md).toContain('UNIQUE-NONSTRING');
    expect(md).toContain('reasoningText:');
    // reasoningBlocks の不透明な値は coverage に「一部除外」として数える
    const rb = c.entries().find((k) => k.type === 'assistant.message' && k.key === 'reasoningBlocks')!;
    expect(rb.treatment).toBe('partial');
    expect(rb.excludedN).toBe(1);
    expect(rb.excludedBytes).toBe(OPAQUE.length);
    expect(md).not.toContain(OPAQUE);
    expect(md).toContain('除外: encryptedContent');
    expect(md).toContain('除外: reasoningOpaque');
    expect(md).toContain('不透明データ');
    expect(md).not.toContain(SECRET);
    expect(md).toContain('[伏せました: GitHub トークン]');
    expect(r.secretHits).toBe(1); // ツール結果で 1 回。hook の入力は同一なので参照に置き換わり、重ねて数えない
    expect(md).toContain('ツールの結果と同一');
    expect(md).toContain('transformedContent は content と同じ');
    expect(md).toContain('supportedNativeDocumentMimeTypes: 2 種');
    // 画像は assets に書き出してリンク
    expect(r.assets.files).toBe(1);
    expect(md).toContain('](assets/asset-1.png)');
    expect(await readFile(join(dir, 'assets', 'asset-1.png'))).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'));
    expect(r.unclassified).toEqual(['brand.new_type|mystery']);
    expect(md).toContain('`brand.new_type|mystery`');
    expect(r.excluded.n).toBeGreaterThanOrEqual(4);
    expect(looksOpaque(OPAQUE)).toBe(true);
    expect(looksOpaque('短い')).toBe(false);
  });
});

describe('createFileSink', () => {
  it('tmp に書いて finish で rename し、abort で tmp を消す。開けない場所では write が失敗して永久に待たない', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-sink-'));
    try {
      const path = join(dir, 'a.md');
      const s = createFileSink(path);
      // 64KB を超える書き込みで drain 待ちの経路を通す
      for (let i = 0; i < 40; i++) await s.write('x'.repeat(16 * 1024) + '\n');
      await s.finish();
      expect((await readFile(path, 'utf8')).length).toBe(40 * (16 * 1024 + 1));
      const { existsSync } = await import('node:fs');
      expect(existsSync(`${path}.tmp`)).toBe(false);
      // abort: tmp を消して本体を作らない
      const s2 = createFileSink(join(dir, 'b.md'));
      await s2.write('partial');
      await s2.abort();
      expect(existsSync(join(dir, 'b.md.tmp'))).toBe(false);
      expect(existsSync(join(dir, 'b.md'))).toBe(false);
      // 開けない場所(存在しないフォルダ): error を 1 回だけ受けて以後の write / finish が失敗する(待ち続けない)
      const s3 = createFileSink(join(dir, 'no-such-dir', 'c.md'));
      await expect(Promise.race([s3.finish(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))])).rejects.toThrow(/ENOENT/);
      await expect(s3.write('x')).rejects.toThrow(/ENOENT/);
      await s3.abort();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('library', () => {
  it('指示文は見出しごとに版を束ね、skill は名前ごと。本文を library/<hash>.md に書き、ページに差分とセッションを出す', async () => {
    const lib = new LibraryCollector();
    const v1 = '# AGENTS.md\n\nルール 1\n';
    const v2 = '# AGENTS.md\n\nルール 1\nルール 2\n';
    lib.addSystemMessage('s1', `<custom_instruction>\n${v1}</custom_instruction>`, '2026-10-01T00:00:00Z');
    lib.addSystemMessage('s2', `<custom_instruction>\n${v2}</custom_instruction>`, '2026-10-02T00:00:00Z');
    lib.addSystemMessage('s3', `<custom_instruction>\n${v2}</custom_instruction>`, '2026-10-03T00:00:00Z');
    lib.addSkill('s1', 'my-skill', '# my-skill\n\n本文', contentHash('# my-skill\n\n本文'), '2026-10-01T00:00:00Z', 'skills/my-skill/SKILL.md');
    const groups = lib.result();
    expect(groups.map((g) => [g.kind, g.key, g.versions.length])).toEqual([
      ['instruction', 'AGENTS.md', 2],
      ['skill', 'my-skill', 1],
    ]);
    const [ins] = groups;
    expect(ins.versions[0].sessions.size).toBe(1);
    expect(ins.versions[1].sessions.size).toBe(2);
    expect(ins.versions[1]).toMatchObject({ firstAt: '2026-10-02T00:00:00Z', lastAt: '2026-10-03T00:00:00Z', injections: 2 });
    const diff = lineDiff(v1, v2);
    expect(diff).toContain('+ルール 2');
    expect(diff.filter((l) => l.startsWith('-'))).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), 'atlas-lib-'));
    try {
      const w = await writeLibrary(dir, groups);
      expect(w.files).toBe(3);
      expect(await readFile(join(dir, `${ins.versions[1].hash}.md`), 'utf8')).toContain('ルール 2');
      const html = renderInstructionsHtml({ css: '', generatedAt: '2026-10-03T00:00:00Z', groups, sessionName: (id) => `name of ${id}` });
      expect(html).toContain(`id="v-${ins.versions[1].hash}"`);
      expect(html).toContain(`id="${skillAnchor('my-skill')}"`);
    expect(skillAnchor('日本語')).not.toBe(skillAnchor('日本語 2'));
      expect(html).toContain('<span class="add"><span class="sign">+</span>ルール 2</span>');
      expect(html).toContain('sessions/s2.html');
      expect(html).toContain('name of s3');
      // #session= の絞り込み: 版に使ったセッションの id、名前と詳細ページの表、絞り込みの帯と script
      expect(html).toContain(`id="v-${ins.versions[1].hash}" data-sessions="s2 s3" open data-latest`);
      expect(html).toContain(`id="v-${ins.versions[0].hash}" data-sessions="s1">`);
      expect(JSON.parse(/id="lib-sessions">([^<]*)<\/script>/.exec(html)![1])).toEqual({ s1: ['name of s1', 's1.html'], s2: ['name of s2', 's2.html'], s3: ['name of s3', 's3.html'] });
      expect(html).toContain('data-testid="lib-filter" hidden');
      expect(html).toContain("addEventListener('hashchange',apply)");
      expect(html).toContain('<nav class="toc"');
      expect(html).toContain('content="__ATLAS_TOKEN__"');
      expect(html).not.toMatch(/https?:\/\//);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('パス付きとパス無しの同じ見出しは 1 項目にまとめ、並行して使われた版・プロジェクトごとの最後の版・同じプロジェクトの差分を示す', () => {
    const lib = new LibraryCollector();
    const a1 = '# 共通ルール\n\nA の 1\n';
    const b1 = '# 共通ルール\n\nB の 1\n';
    const a2 = '# 共通ルール\n\nA の 1\nA の 2\n';
    // プロジェクト A: a1 → a2。プロジェクト B: b1 を a1 と同じ時期に並行して使い、b1 はパス付きの注入でも現れる
    lib.addSystemMessage('a-1', `<custom_instruction>\n${a1}</custom_instruction>`, '2026-10-01T00:00:00Z');
    lib.addSystemMessage('b-1', `<custom_instruction>\n${b1}</custom_instruction>`, '2026-10-02T00:00:00Z');
    lib.addSystemMessage('b-2', `<custom_instruction>\n<imported_custom_instruction source="X:\\b\\AGENTS.md">\n${b1}</imported_custom_instruction>\n</custom_instruction>`, '2026-10-06T00:00:00Z');
    lib.addSystemMessage('a-2', `<custom_instruction>\n${a1}</custom_instruction>`, '2026-10-03T00:00:00Z');
    lib.addSystemMessage('a-3', `<custom_instruction>\n${a2}</custom_instruction>`, '2026-10-05T00:00:00Z');
    const groups = lib.result();
    expect(groups.map((g) => [g.key, g.file, g.versions.length])).toEqual([['共通ルール', 'AGENTS.md', 3]]);
    expect(groups[0].versions[1].sourcePaths).toEqual(['X:\\b\\AGENTS.md']);
    const project = (id: string): string => (id.startsWith('a-') ? 'X:\\repo-a' : 'X:\\repo-b');
    const html = renderInstructionsHtml({ css: '', generatedAt: '2026-10-06T00:00:00Z', groups, sessionName: (id) => id, sessionProject: project });
    // 同じ版の id は 1 回だけ
    const ids = [...html.matchAll(/ id="(v-[0-9a-f]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
    // 版 1(A)と版 2(B)は期間が重なる。最後に使われたのは版 2(B、10/06)
    expect(html).toMatch(/<b>版 1<\/b> <span class="tag">版 2 と並行して使用<\/span>/);
    expect(html).toMatch(/<b>版 2<\/b> <span class="tag latest">最後に使われた版<\/span> <span class="tag">版 1・3 と並行して使用<\/span>/);
    const [v1, v2, v3] = groups[0].versions;
    expect(html).toContain(`プロジェクトごとの最後の版: <a href="#v-${v2.hash}">版 2</a> は <span title="X:\\repo-b">repo-b</span>、<a href="#v-${v3.hash}">版 3</a> は <span title="X:\\repo-a">repo-a</span>`);
    // 全プロジェクトで同じ版が最後なら 1 行
    const one = renderInstructionsHtml({ css: '', generatedAt: '2026-10-06T00:00:00Z', groups, sessionName: (id) => id, sessionProject: () => 'X:\\repo-a' });
    expect(one).toContain(`最後に使われた版: <a href="#v-${v2.hash}">版 2</a>`);
    expect(v1.sessions.size).toBe(2);
    // 版 3(A)の差分は、初回日の順で直前の版 2(B)ではなく、同じプロジェクトの版 1 と比べる
    expect(html).toContain('版 1 → 版 3 の差分(同じプロジェクトで前に使われた版との行の比較)');
    expect(html).not.toContain('版 2 → 版 3 の差分');
    // 版 2(B)は同じプロジェクトの前の版が無いので、1 つ前の版(A)と比べ、そう書く
    expect(html).toContain('版 1 → 版 2 の差分(初回日の順で 1 つ前の版との行の比較。同じプロジェクトで前に使われた版が無いので、別のプロジェクトの版と比べています)');
    expect(html).toContain('出所 <code>X:\\b\\AGENTS.md</code>');
    expect(html).toContain(`<span class="hash" title="内容のハッシュ">${groups[0].versions[0].hash}</span>`);
  });

  it('見出しの整形と系列の鍵: # や HTML コメントの印を外し、改善点と指示文のページで同じ鍵にする', () => {
    expect(cleanHeading('<!-- llm-wiki:begin -->')).toBe('llm-wiki:begin');
    expect(cleanHeading('## 共通ルール')).toBe('共通ルール');
    expect(seriesKey('<!-- llm-wiki:begin -->', 'unknown')).toBe(seriesKey('llm-wiki:begin', 'AGENTS.md'));
    expect(seriesKey('', 'CLAUDE.md')).toBe('(見出しなし: CLAUDE.md)');
    expect(seriesKey('x'.repeat(100), 'unknown')).toHaveLength(100);
  });
});
