// Phase 12 E2E(docs/PLAN.md「Phase 12: 改善点の分析」)
//  a. fixture で insights.html と insights.json ができ、atlas.html に改善点が埋め込まれる(5MB 未満、外部参照なし)
//  b. 伏せ字版では依頼文の本文と指示文の見出しが出ない(件数とスコアだけ)
//  c. skill-draft が偽の copilot で下書きを書く(本物は呼ばない)。伏せ字版の out では拒む
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionsFile } from '../packages/core/src/index.ts';
import { extractEmbedded, type ReportData } from '../packages/report/src/index.ts';
import { buildFixtureHome, FIXTURE_CODE, P12_SESSIONS, ROOT } from './fixture-home.ts';

const WORK = join(ROOT, 'out', 'e2e-phase12');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const LIMIT = 5 * 1024 * 1024;

function atlas(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 600_000, env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function externalRefs(html: string): string[] {
  const found: string[] = [];
  for (const needle of ['http://', 'https://']) if (html.includes(needle)) found.push(needle);
  for (const m of html.matchAll(/fetch\(/g)) if (!/^fetch\(\s*["'`](?:\.\.\/)?api\//.test(html.slice(m.index, m.index + 40))) found.push(`fetch( at ${m.index}`);
  return found;
}

describe('Phase 12 E2E: fixtures', () => {
  let home: string;
  let close: () => Promise<void>;
  const out = join(WORK, 'out');
  const outAnon = join(WORK, 'out-anon');
  let data: ReportData;

  beforeAll(async () => {
    ({ home, close } = await buildFixtureHome(join(WORK, 'home'), { phase12: true }));
    const r = atlas(['all', '--home', home, '--out', out]);
    if (r.status !== 0) throw new Error(`atlas all が失敗: ${r.stderr}\n${r.stdout}`);
    data = extractEmbedded<ReportData>(await readFile(join(out, 'atlas.html'), 'utf8'));
  });
  afterAll(async () => close?.());

  it('a. insights.html と insights.json ができ、atlas.html に改善点(候補・指示文の版の見出し)が埋め込まれる。5MB 未満・外部参照なし', async () => {
    const html = await readFile(join(out, 'insights.html'), 'utf8');
    expect(html).toContain('改善点');
    for (const id of ['i-instructions', 'i-skills', 'i-stuck', 'i-candidates']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('<nav class="toc"');
    expect(externalRefs(html)).toEqual([]);
    const j = JSON.parse(await readFile(join(out, 'insights.json'), 'utf8')) as { version: number; anonymized: boolean; sessions: number; candidates: { kind: string; count: number; sessions: string[]; representative: string | null }[] };
    expect(j).toMatchObject({ version: 1, anonymized: false, sessions: data.sessions.length });
    // 埋め込み: 候補(上位 30 件まで)と、指示文の版の見出し
    expect(data.insights.candidates.length).toBe(Math.min(30, j.candidates.length));
    expect(data.insights.computedOver).toBe(data.sessions.length);
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as SessionsFile;
    const hashes = new Set(s.sessions.flatMap((x) => x.instructions.map((i) => i.contentHash)));
    expect(Object.keys(data.insights.meta).sort()).toEqual([...hashes].sort());
    for (const m of Object.values(data.insights.meta)) expect(m.heading.length).toBeGreaterThan(0);
    // 候補は回数順(スコア順)で、各候補が MIN_REPEAT 以上・2 セッション以上
    for (const c of j.candidates) {
      expect(c.count).toBeGreaterThanOrEqual(3);
      expect(c.sessions.length).toBeGreaterThanOrEqual(2);
    }
    // sessions.json の analysis(手戻り・失敗の連続・ターンのツールの列・依頼文)
    const withTurns = s.sessions.find((x) => x.analysis.turnTools.length > 0)!;
    expect(withTurns.analysis.requests.length).toBe(withTurns.analysis.turnTools.length);
    expect(withTurns.analysis.turnMs.length).toBe(withTurns.analysis.turnTools.length);
    expect(withTurns.analysis.turnActiveMs.length).toBe(withTurns.analysis.turnTools.length);
    expect(s.schemaVersion).toBe(10);
    expect(data.version).toBe(9);
    expect(Buffer.byteLength(await readFile(join(out, 'atlas.html'), 'utf8'))).toBeLessThan(LIMIT);
    // 詳細ページから改善点のページへは不要(atlas.html の節から)。atlas.html の目次に「改善点」
    expect(await readFile(join(out, 'atlas.html'), 'utf8')).toMatch(/改善点/);
  });

  it('b. 伏せ字版では依頼文の本文と指示文の見出しを出さず、件数とスコアだけ', async () => {
    const r = atlas(['all', '--home', home, '--out', outAnon, '--anonymize']);
    expect(r.status, r.stderr).toBe(0);
    const d = extractEmbedded<ReportData>(await readFile(join(outAnon, 'atlas.html'), 'utf8'));
    expect(d.insights.meta).toEqual({});
    for (const c of d.insights.candidates) {
      expect(c.representative).toBeNull();
      expect(c.examples).toEqual([]);
      expect(c.count).toBeGreaterThanOrEqual(3);
    }
    const j = JSON.parse(await readFile(join(outAnon, 'insights.json'), 'utf8')) as { anonymized: boolean; candidates: { representative: string | null; examples: string[] }[] };
    expect(j.anonymized).toBe(true);
    for (const c of j.candidates) expect(c.representative).toBeNull();
    // 通常版の依頼文の候補の key(正規化した本文)が伏せ字版の埋め込みデータにも insights.json にも無く、key は不透明な値
    const plainKeys = (JSON.parse(await readFile(join(out, 'insights.json'), 'utf8')) as { candidates: { kind: string; key: string }[] }).candidates.filter((c) => c.kind === 'request').map((c) => c.key);
    expect(plainKeys.length).toBeGreaterThan(0);
    const anonAtlas = await readFile(join(outAnon, 'atlas.html'), 'utf8');
    const anonJson = await readFile(join(outAnon, 'insights.json'), 'utf8');
    for (const k of plainKeys) {
      expect(anonAtlas).not.toContain(k.slice(0, 20));
      expect(anonJson).not.toContain(k.slice(0, 20));
    }
    const anonReq = (JSON.parse(anonJson) as { candidates: { kind: string; key: string }[] }).candidates.filter((c) => c.kind === 'request');
    expect(anonReq.length).toBe(plainKeys.length);
    for (const c of anonReq) expect(c.key).toMatch(/^request-\d+$/);
    const html = await readFile(join(outAnon, 'insights.html'), 'utf8');
    expect(html).toContain('伏せ字版');
    // 通常版の候補の代表文が伏せ字版の出力に無い
    const plain = JSON.parse(await readFile(join(out, 'insights.json'), 'utf8')) as { candidates: { representative: string | null }[] };
    for (const c of plain.candidates) if (c.representative && c.representative.length > 10) expect(html).not.toContain(c.representative.slice(0, 30));
    expect(externalRefs(html)).toEqual([]);
  });

  it('c. skill-draft は偽の copilot で候補から下書きを書く(本物は呼ばない)。番号が無い・伏せ字版の out は拒む', async () => {
    const j = JSON.parse(await readFile(join(out, 'insights.json'), 'utf8')) as { candidates: { kind: string; key: string; count: number; sessions: string[]; representative: string | null }[] };
    // fixture の繰り返し: 依頼文(3 セッション × 1)と、ツールの並び(3 セッション × 2 ターン)
    const req = j.candidates.find((c) => c.kind === 'request')!;
    expect(req).toMatchObject({ count: 3, sessions: expect.arrayContaining(P12_SESSIONS) });
    expect(req.representative).toContain('README');
    const seq = j.candidates.find((c) => c.kind === 'tools' && c.key === 'view → apply_patch → powershell → apply_patch → powershell')!;
    expect(seq).toMatchObject({ count: 6 });
    expect(seq.sessions.sort()).toEqual([...P12_SESSIONS].sort());
    const log = join(WORK, 'fake-copilot.log');
    await rm(log, { force: true });
    const env = { ATLAS_COPILOT_BIN: join(FIXTURE_CODE, 'fake-copilot.mjs'), FAKE_COPILOT_LOG: log };
    const r = atlas(['skill-draft', '1', '--out', out], env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/skill-draft: .*skill-drafts/);
    const files = (await readdir(join(out, 'skill-drafts'))).filter((f) => f.startsWith('001-'));
    expect(files).toHaveLength(1);
    const md = await readFile(join(out, 'skill-drafts', files[0]), 'utf8');
    expect(md).toContain('atlas skill-draft: 候補 1');
    expect(md.length).toBeGreaterThan(100);
    // 偽の copilot に渡したプロンプトに候補の内容が入り、ツールは shell / write / url を拒否している
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
    expect(calls).toHaveLength(1);
    // 次回の extract で「(atlas の判定)」に分類される作業フォルダ
    expect(calls[0].cwd).toMatch(/atlas-judge-cwd-[^\\/]+$/);
    const argv = calls[0].argv;
    const prompt = argv[argv.indexOf('-p') + 1];
    expect(prompt).toContain('候補 1');
    expect(prompt).toContain(j.candidates[0].kind === 'tools' ? j.candidates[0].key : 'の繰り返し');
    expect(argv).toContain('--no-custom-instructions');
    for (const k of ['shell', 'write', 'url']) expect(argv.join(' ')).toContain(`--deny-tool ${k}`);
    expect(argv).toEqual(expect.arrayContaining(['--available-tools=view', '--disable-builtin-mcps']));
    expect(argv.join(' ')).toContain('--disable-mcp-server fake-mcp --deny-tool fake-mcp');
    // 番号が無い / 伏せ字版
    expect(atlas(['skill-draft', '999', '--out', out], env).stderr).toMatch(/候補 999 はありません/);
    expect(atlas(['skill-draft', '1', '--out', outAnon], env).stderr).toMatch(/伏せ字版/);
    expect(atlas(['skill-draft'], env).status).toBe(2);
    expect(atlas(['skill-draft', '1', '--backend', 'nope'], env).stderr).toMatch(/不明なバックエンド/);
    expect(existsSync(join(outAnon, 'skill-drafts'))).toBe(false);
  });
});
