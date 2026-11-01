// Phase 11 E2E(docs/PLAN.md「Phase 11: 解析用の完全出力」)
//  a. スナップショットの拡張: plan.md / checkpoints / files / policies を写し、rewind-snapshots と一覧に無いフォルダ・logs/・repos/ は既定で写さず manifest に名前と容量。
//     --snapshot-all で写す。chats/ は *.md だけ。~/.copilot(fixture の home)は書き換えない(mtime 不変、-shm を作らない)
//  b. data.db: 複製せず desktop.json に許可リストの列だけ。資格情報の合成値が out/ のどこにも出ない。sessions.json の desktop 欄と詳細ページに出る
//  c. export --full: 元データの文字列が全文記録に現れ、暗号化キーと base64 本体は出ない。coverage.json の未分類が 0。画像は assets に。--anonymize との併用はエラー
//  d. instructions.html と library/: 指示文の版と skill の本文。詳細ページからリンク。伏せ字版では作らない
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionsFile, SnapshotManifest } from '../packages/core/src/index.ts';
import type { CoverageFile } from '../packages/report/src/coverage.ts';
import { extractEmbedded, type ReportData } from '../packages/report/src/index.ts';
import { buildFixtureHome, FAKE_SECRETS, P11_SESSION, ROOT } from './fixture-home.ts';

const WORK = join(ROOT, 'out', 'e2e-phase11');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');

function atlas(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 600_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
async function mtimes(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out[join(e.parentPath, e.name)] = (await stat(join(e.parentPath, e.name))).mtimeMs;
  return out;
}
async function allFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { withFileTypes: true, recursive: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

describe('Phase 11 E2E: fixtures', () => {
  let home: string;
  let close: () => Promise<void>;
  const out = join(WORK, 'out');
  let before: Record<string, number>;

  beforeAll(async () => {
    ({ home, close } = await buildFixtureHome(join(WORK, 'home'), { phase11: true }));
    before = await mtimes(home);
    const r = atlas(['all', '--home', home, '--out', out]);
    if (r.status !== 0) throw new Error(`atlas all が失敗: ${r.stderr}\n${r.stdout}`);
  });
  afterAll(async () => close?.());

  it('a. スナップショットの拡張: 付随物を写し、大きいもの・一覧に無いものは manifest に残す。--snapshot-all で写す。元は書き換えない', async () => {
    const m = JSON.parse(await readFile(join(out, 'snapshot', 'snapshot-manifest.json'), 'utf8')) as SnapshotManifest;
    const sdir = join(out, 'snapshot', 'session-state', P11_SESSION);
    for (const f of ['plan.md', join('checkpoints', 'index.md'), join('checkpoints', '001-first.md'), join('files', 'note.txt'), join('policies', 'p1.json')]) expect({ f, exists: existsSync(join(sdir, f)) }).toEqual({ f, exists: true });
    expect(existsSync(join(sdir, 'rewind-snapshots'))).toBe(false);
    expect(existsSync(join(sdir, 'fake-solution'))).toBe(false);
    expect(existsSync(join(sdir, 'inuse.1234.lock'))).toBe(false);
    expect(existsSync(join(out, 'snapshot', 'plans', 'plan-synthetic.md'))).toBe(true);
    expect(existsSync(join(out, 'snapshot', 'attachments', 'clip.png'))).toBe(true);
    expect(existsSync(join(out, 'snapshot', 'chats', '2026-10-01', 'x', 'copilot-session-x.md'))).toBe(true);
    expect(existsSync(join(out, 'snapshot', 'chats', '2026-10-01', 'x', 'junk.exe'))).toBe(false);
    expect(existsSync(join(out, 'snapshot', 'logs'))).toBe(false);
    expect(existsSync(join(out, 'snapshot', 'repos'))).toBe(false);
    expect(existsSync(join(out, 'snapshot', 'data.db'))).toBe(false);
    const x = m.extras!;
    expect(x.all).toBe(false);
    const skipped = Object.fromEntries(x.skipped.map((s) => [s.path, s]));
    expect(skipped[`session-state/${P11_SESSION}/rewind-snapshots`]).toMatchObject({ bytes: 64 * 1024 + 13 });
    expect(skipped[`session-state/${P11_SESSION}/fake-solution`]).toBeDefined();
    expect(skipped.logs).toBeDefined();
    expect(skipped.repos).toBeDefined();
    expect(skipped['chats(*.md 以外)']).toMatchObject({ bytes: 100 });
    expect(x.topLevel.plans.files).toBe(1);
    expect(x.desktop).toMatchObject({ written: true, sessions: 1, warnings: [] });
    // 元は書き換えない(mtime 不変、data.db の -shm / -wal を作らない)
    expect(await mtimes(home)).toEqual(before);
    expect(existsSync(join(home, 'data.db-shm'))).toBe(false);
    expect(existsSync(join(home, 'data.db-wal'))).toBe(false);
    // 2 回目は再利用(写さなかったものは同じ)
    const r2 = atlas(['snapshot', '--home', home, '--out', out]);
    expect(r2.status, r2.stderr).toBe(0);
    expect(r2.stdout).toMatch(/写さなかったもの 5 件/);
    // --snapshot-all で rewind-snapshots・fake-solution・logs/ を写す(repos は写さない)
    const ra = atlas(['snapshot', '--home', home, '--out', out, '--snapshot-all']);
    expect(ra.status, ra.stderr).toBe(0);
    expect(existsSync(join(sdir, 'rewind-snapshots', 'backups', 'big.bin'))).toBe(true);
    expect(existsSync(join(sdir, 'fake-solution', 'x.txt'))).toBe(true);
    expect(existsSync(join(out, 'snapshot', 'logs', 'github-app.1.log'))).toBe(true);
    expect(existsSync(join(out, 'snapshot', 'repos'))).toBe(false);
    const ma = JSON.parse(await readFile(join(out, 'snapshot', 'snapshot-manifest.json'), 'utf8')) as SnapshotManifest;
    expect(ma.extras!.all).toBe(true);
    expect(ma.extras!.skipped.map((s) => s.path).sort()).toEqual(['chats(*.md 以外)', 'repos']);
    expect(await mtimes(home)).toEqual(before);
    // 既定に戻す(logs/ の合成トークンが out/ に残らないよう消す)
    const { rm } = await import('node:fs/promises');
    await rm(join(out, 'snapshot', 'logs'), { recursive: true, force: true });
    await rm(join(sdir, 'rewind-snapshots'), { recursive: true, force: true });
    await rm(join(sdir, 'fake-solution'), { recursive: true, force: true });
  });

  it('b. data.db: 許可リストの列だけが desktop.json と sessions.json の desktop 欄に入り、資格情報の合成値は out/ のどこにも出ない', async () => {
    const d = JSON.parse(await readFile(join(out, 'snapshot', 'desktop.json'), 'utf8')) as { tables: Record<string, Record<string, unknown>[]>; coverage: { forbidden: Record<string, string>; tables: Record<string, { unlisted: string[] }> }; wal: { bytes: number } };
    expect(Object.keys(d.tables).sort()).toEqual(['activity_items', 'projects', 'session_checkpoints', 'session_context_usage', 'sessions', 'workspaces']);
    expect(d.tables.sessions[0]).toMatchObject({ id: P11_SESSION, title: 'デスクトップのセッション', model: 'claude-opus-5.5', permission_mode: 'auto', total_input_tokens: 1234 });
    expect(d.coverage.tables.sessions.unlisted).toEqual(['remote_connect_target', 'empty_execution_failure_event_json']);
    expect(Object.keys(d.coverage.forbidden).sort()).toEqual(['accounts', 'app_state', 'model_providers', 'settings']);
    expect(d.wal.bytes).toBe(0);
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as SessionsFile;
    const rec = s.sessions.find((x) => x.id === P11_SESSION)!;
    expect(rec.desktop?.session?.title).toBe('デスクトップのセッション');
    expect(rec.desktop?.contextUsage).toHaveLength(2);
    expect(rec.desktop?.checkpoints[0]?.commit_sha).toBe('abc123def456');
    expect(rec.desktop?.workspace?.branch).toBe('feature/p11');
    expect(s.desktop).toMatchObject({ sessions: 1 });
    expect(s.sessions.find((x) => x.id !== P11_SESSION)?.desktop).toBeNull();
    // 詳細ページに data.db の欄
    const page = await readFile(join(out, 'sessions', `${P11_SESSION}.html`), 'utf8');
    expect(page).toContain('デスクトップアプリの記録(data.db)');
    expect(page).toContain('feature/p11');
    // 資格情報の合成値は out/ のどこにも無い(snapshot・sessions.json・HTML・この後の全文記録も含めて c. の後にもう一度見る)
    for (const f of await allFiles(out)) {
      const t = await readFile(f, 'utf8').catch(() => '');
      for (const v of Object.values(FAKE_SECRETS)) expect({ f, v, leaked: t.includes(v) }).toEqual({ f, v, leaked: false });
    }
  });

  it('c. export --full: 元データの文字列が全文記録に現れ、除外キーは出ず、coverage の未分類が 0。画像は assets に。--anonymize とは併用できない', async () => {
    const bad = atlas(['export', '--home', home, '--out', out, '--full', '--anonymize']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/併用できません/);
    const r = atlas(['export', '--home', home, '--out', out, '--full']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/export: 全文記録 \d+ 件/);
    // fixture には「未知の種別」をわざと 1 件入れてある(future.event_kind)。それ以外の全キーが分類済み
    expect(r.stdout).toMatch(/未分類のキー 1 件: future\.event_kind\|anything/);
    const cov = JSON.parse(await readFile(join(out, 'coverage.json'), 'utf8')) as CoverageFile;
    expect(cov.keys.filter((k) => k.treatment === 'unclassified').map((k) => `${k.type}|${k.key}`)).toEqual(['future.event_kind|anything']);
    expect(cov.keys.find((k) => k.type === 'assistant.message' && k.key === 'encryptedContent')?.treatment).toBe('excluded');
    expect(cov.desktop).not.toBeNull();
    expect(cov.desktop!.columns.find((c) => c.table === 'accounts')?.treatment).toBe('excluded');
    expect(cov.desktop!.unclassified).toBeGreaterThan(0);
    const data = extractEmbedded<ReportData>(await readFile(join(out, 'atlas.html'), 'utf8'));
    expect(data.library).toBe(true);
    const fulls = (await readdir(join(out, 'full'))).filter((f) => f.endsWith('.md'));
    // 全セッション分(events.jsonl が無い DB だけのセッションも、概要と data.db の節だけの記録になる)
    expect(fulls.length).toBe(data.sessions.length);
    // 元データの文字列(依頼・ツールの引数・結果・system.message・hook の入力)が出る。暗号化キーと base64 の本体は出ない
    let encryptedSeen = 0;
    let assetSeen = 0;
    for (const f of fulls) {
      const id = f.replace(/\.md$/, '');
      const md = await readFile(join(out, 'full', f), 'utf8');
      const evPath = join(out, 'snapshot', 'session-state', id, 'events.jsonl');
      if (!existsSync(evPath)) continue;
      const lines = (await readFile(evPath, 'utf8')).split('\n').filter(Boolean);
      for (const line of lines) {
        let ev: { type: string; data?: Record<string, unknown> };
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const d = ev.data ?? {};
        if (ev.type === 'user.message' && typeof d.content === 'string' && d.content.length > 3) expect({ id, c: d.content.slice(0, 40), ok: md.includes(d.content.slice(0, 40)) }).toMatchObject({ ok: true });
        if (ev.type === 'tool.execution_start' && d.arguments && typeof d.arguments === 'object') {
          const a = d.arguments as Record<string, unknown>;
          const v = Object.values(a).find((x) => typeof x === 'string' && (x as string).length > 3 && !/[\\"\n]/.test(x as string)) as string | undefined;
          if (v) expect({ id, v, ok: md.includes(v) }).toMatchObject({ ok: true });
        }
        if (typeof d.encryptedContent === 'string') {
          encryptedSeen++;
          expect(md).not.toContain(d.encryptedContent.slice(0, 80));
        }
        if (ev.type === 'session.binary_asset' && typeof d.data === 'string' && d.data.length >= 8) {
          assetSeen++;
          expect(md).not.toContain(d.data.slice(0, 80));
          expect(md).toContain('assets/');
        }
      }
      expect(md).toContain('## 検査');
      expect(md).toMatch(/未分類のキー\(扱いの表に無く、そのまま全文に出したもの\): (無し|`future\.event_kind\|anything`)$/m);
    }
    expect(encryptedSeen).toBeGreaterThan(0);
    if (assetSeen) expect((await allFiles(join(out, 'full', 'assets'))).length).toBeGreaterThan(0);
    // P11 セッションの全文には plan / checkpoints / policies と data.db の節
    const p11 = await readFile(join(out, 'full', `${P11_SESSION}.md`), 'utf8');
    for (const s of ['## plan.md', '合成の plan.md', '## チェックポイント', '合成のチェックポイント本文', '## policies/', '"policy":"synthetic"', '## デスクトップアプリの記録', 'デスクトップのセッション']) expect({ s, ok: p11.includes(s) }).toEqual({ s, ok: true });
    // 詳細ページから全文記録へのリンク
    const page = await readFile(join(out, 'sessions', `${P11_SESSION}.html`), 'utf8');
    expect(page).toContain(`href="../full/${P11_SESSION}.md"`);
    // 資格情報の合成値は全文記録にも無い
    for (const f of await allFiles(out)) {
      const t = await readFile(f, 'utf8').catch(() => '');
      for (const v of Object.values(FAKE_SECRETS)) expect({ f, v, leaked: t.includes(v) }).toEqual({ f, v, leaked: false });
    }
    expect(await mtimes(home)).toEqual(before);
  });

  it('d. instructions.html と library/: 指示文の版と skill の本文。詳細ページからリンク。伏せ字版では作らない', async () => {
    const html = await readFile(join(out, 'instructions.html'), 'utf8');
    expect(html).toContain('指示文と skill');
    expect(html).toContain('<nav class="toc"');
    expect(html).not.toMatch(/https?:\/\//);
    const lib = (await readdir(join(out, 'library'))).filter((f) => f.endsWith('.md'));
    expect(lib.length).toBeGreaterThan(0);
    for (const f of lib) expect(html).toContain(`id="v-${f.replace(/\.md$/, '')}"`);
    // 指示文を持つセッションの詳細ページが見出しからリンクする
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as SessionsFile;
    const withInst = s.sessions.find((x) => x.instructions.length > 0)!;
    const page = await readFile(join(out, 'sessions', `${withInst.id}.html`), 'utf8');
    expect(page).toContain(`href="../instructions.html#v-${withInst.instructions[0].contentHash}"`);
    expect(page).toContain('href="../instructions.html"');
    // atlas.html のサイドバー(付録)にも入る
    const data = extractEmbedded<ReportData>(await readFile(join(out, 'atlas.html'), 'utf8'));
    expect(data.library).toBe(true);
    // 伏せ字版では作らない(素の build でも消える)
    const anonOut = join(WORK, 'out-anon');
    const r0 = atlas(['all', '--home', home, '--out', anonOut, '--anonymize']);
    expect(r0.status, r0.stderr).toBe(0);
    const ra = atlas(['export', '--home', home, '--out', anonOut, '--anonymize']);
    expect(ra.status, ra.stderr).toBe(0);
    expect(existsSync(join(anonOut, 'instructions.html'))).toBe(false);
    expect(existsSync(join(anonOut, 'library'))).toBe(false);
    expect(existsSync(join(anonOut, 'full'))).toBe(false);
    expect(extractEmbedded<ReportData>(await readFile(join(anonOut, 'atlas.html'), 'utf8')).library).toBe(false);
    const rb = atlas(['build', '--home', home, '--out', out]);
    expect(rb.status, rb.stderr).toBe(0);
    expect(existsSync(join(out, 'instructions.html'))).toBe(false);
    expect(existsSync(join(out, 'full'))).toBe(false);
  });
});
