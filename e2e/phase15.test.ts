// プロジェクトのアップロード(atlas upload-project。upload-project.bat と同じ入口): 集計のプロジェクトのセッションの生ログを
// <基底>/<プロジェクト名>/<セッション id>/ に写し、送った先で `--home <基底>` でそのまま集計し直せることを、架空の fixture で通しで確かめる。
//  a. 写したフォルダの形(生ログ + atlas-session-store.json。スナップショットの作業用ファイルは入れない)、
//     ほかの PC から写したフォルダには触れない、2 回目は中身の変わったセッションだけを置き換える
//  b. アップ先から集計し直すと、元から集計したのと同じトークン・依頼・モデル・ツールになる(DB の行も添えてあるため)。
//     デスクトップアプリのセッションの data.db の行(題名・モデル・トークン数など)も運ばれる(資格情報の表・許可外の列は入らない)
//  d. プロジェクトの説明とセッションの一覧が README.md に残る
//  e. 読みやすい記録(.md)は送らず、送った先で集計し直すと作れる
// 送り先のフォルダが無いときに止まること・メモと画像を添えることは、crates/atlas-cli/src/upload_copy/tests.rs が確かめる
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionRecord, SessionsFile } from '../packages/report/src/shared/types.ts';
import type { SessionStoreJson } from './output-types.ts';
import { hasUsageRows } from './sqlite.ts';
import { buildFixtureHome, FAKE_SECRETS, P11_SESSION, ROOT, UNLISTED_VALUES, cliCommand, uploadDirName, uploadProjects } from './fixture-home.ts';

const WORK = join(ROOT, 'out', 'e2e-phase15');

function atlas(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string; out: string } {
  const r = spawnSync(...cliCommand(args), { encoding: 'utf8', cwd: ROOT, timeout: 600_000, env: { ...process.env, ...env } });
  // ログは標準出力、エラーは標準エラー。どちらに出ても見られるよう out に両方を入れる
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
}

describe('Phase 15 E2E: プロジェクトのアップロード', () => {
  let close: () => Promise<void>;
  let home: string;
  const out1 = join(WORK, 'out-src');
  const out2 = join(WORK, 'out-uploaded');
  const root = join(WORK, 'atlas-logs');
  const configPath = join(WORK, 'atlas.config.json');
  let original: SessionsFile;
  /** DB とフォルダの両方があり、トークンが記録されているセッション(写したものが DB の行も運べたかを見る) */
  let ids: string[];
  /** data.db にだけ題名・モデルなどがあるデスクトップアプリのセッション */
  const desk = P11_SESSION;
  /** 送ったセッション(ids と desk)と、そのプロジェクト・送り先のフォルダ */
  let sent: string[];
  const projectOf = (id: string): string => original.sessions.find((s) => s.id === id)!.project;
  const destOf = (id: string): string => join(root, uploadDirName(projectOf(id)));
  const upload = () => uploadProjects({ home, out: out1, root, projects: [...new Set(sent.map(projectOf))], configPath });

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    ({ home, close } = await buildFixtureHome(join(WORK, 'home'), { phase11: true }));
    // デスクトップアプリで作ったばかりのセッションは、workspace.yaml の名前が仮の「New session」のままで、題名は data.db にある
    const ws = join(home, 'session-state', desk, 'workspace.yaml');
    await writeFile(ws, (await readFile(ws, 'utf8')).replace(/^name: .*$/m, 'name: "New session"'));
    for (const cmd of ['snapshot', 'extract']) {
      const r = atlas([cmd, '--home', home, '--out', out1]);
      expect(r.status, r.stderr).toBe(0);
    }
    original = JSON.parse(await readFile(join(out1, 'sessions.json'), 'utf8')) as SessionsFile;
    // DB に使用量の行があるもの(添えた行で運べたかを見る)
    ids = [];
    for (const x of original.sessions) {
      if (ids.length === 2) break;
      if (x.sources.length !== 2 || !existsSync(join(out1, 'snapshot', 'session-state', x.id, 'events.jsonl'))) continue;
      if (await hasUsageRows(join(out1, 'snapshot', 'session-store.db'), x.id)) ids.push(x.id);
    }
    expect(ids).toHaveLength(2);
    sent = [...ids, desk];
    // この fixture では、送る 3 つのセッションはそれぞれ別のプロジェクトで、そのプロジェクトの送れるセッションはそれだけ
    expect(new Set(sent.map(projectOf)).size).toBe(3);
    for (const id of sent) expect(original.sessions.filter((s) => s.project === projectOf(id) && !s.empty).map((s) => s.id)).toEqual([id]);
    // ほかの PC から先に写してあったセッション(触れてはいけない)
    await mkdir(join(destOf(ids[0]), 'someone-else'), { recursive: true });
    await writeFile(join(destOf(ids[0]), 'someone-else', 'events.jsonl'), '');
  });
  afterAll(async () => close?.());

  it('a. 生ログと DB の行をセッションごとのフォルダに写し、変わったセッションだけ置き換え、ほかには触れない', async () => {
    const r = upload();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('3 プロジェクト・3 セッションを送りました。');
    for (const id of sent) {
      const dest = destOf(id);
      expect((await readdir(dest)).sort()).toEqual([id, 'README.md', 'atlas-index.json', 'atlas-installed.json', ...(id === ids[0] ? ['someone-else'] : [])].sort());
      const index = JSON.parse(await readFile(join(dest, 'atlas-index.json'), 'utf8')) as { kind: string; name: string; sessions: Record<string, unknown>[] };
      expect([index.kind, index.name]).toEqual(['project', projectOf(id)]);
      // タスクタグ(前の版の tags)はもう書かない
      expect(index.sessions.map((s) => [s.id, 'tags' in s])).toEqual([[id, false]]);
    }
    for (const id of ids) {
      const dest = destOf(id);
      const files = await readdir(join(dest, id));
      expect(files).toContain('events.jsonl');
      expect(files).toContain('atlas-session.json');
      expect(files).toContain('workspace.yaml');
      expect(files).not.toContain('.session.db.src');
      expect('tags' in JSON.parse(await readFile(join(dest, id, 'atlas-session.json'), 'utf8'))).toBe(false);
      const rows = JSON.parse(await readFile(join(dest, id, 'atlas-session-store.json'), 'utf8')) as SessionStoreJson;
      expect(rows.version).toBe(1);
      expect(rows.sessions.map((s) => s.id)).toEqual([id]);
      expect(rows.usage.length).toBeGreaterThan(0);
      expect(new Set([...rows.turns, ...rows.usage, ...rows.files].map((x) => x.session_id))).toEqual(new Set([id]));
      // 元のイベントがそのまま写っている
      expect(await readFile(join(dest, id, 'events.jsonl'), 'utf8')).toBe(await readFile(join(out1, 'snapshot', 'session-state', id, 'events.jsonl'), 'utf8'));
    }
    // data.db の行は許可リストの列だけ(資格情報・許可外の列の値は入らない)
    const dj = await readFile(join(destOf(desk), desk, 'atlas-session-store.json'), 'utf8');
    expect((JSON.parse(dj) as SessionStoreJson).desktop?.session?.title).toBe('デスクトップのセッション');
    for (const v of [...Object.values(FAKE_SECRETS), ...Object.values(UNLISTED_VALUES)]) expect(dj).not.toContain(v);
    // 2 回目: 送り先で手を加えたフォルダは丸ごと置き換える(手で足したファイルは消える)。前に写したときのままのものは写し直さない。
    // ほかの PC から写したフォルダは残る
    await writeFile(join(destOf(ids[0]), ids[0], 'stale.txt'), 'x');
    const r2 = upload();
    expect(r2.status, r2.out).toBe(0);
    expect(r2.out).toContain('3 プロジェクト・1 セッションを送りました(変わっていない 2 セッションはそのまま)。');
    expect(existsSync(join(destOf(ids[0]), ids[0], 'stale.txt'))).toBe(false);
    expect(existsSync(join(destOf(ids[0]), 'someone-else', 'events.jsonl'))).toBe(true);
    for (const id of sent) expect((await readdir(destOf(id))).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('b. 送り先の基底のフォルダを --home にすると、元と同じ集計になる', async () => {
    for (const cmd of ['snapshot', 'extract']) {
      const r = atlas([cmd, '--home', root, '--out', out2]);
      expect(r.status, r.stderr).toBe(0);
    }
    const again = JSON.parse(await readFile(join(out2, 'sessions.json'), 'utf8')) as SessionsFile;
    const manifest = JSON.parse(await readFile(join(out2, 'snapshot', 'snapshot-manifest.json'), 'utf8')) as { layout?: string; extras?: { skipped: { path: string }[] } };
    expect(manifest.layout).toBe('merged');
    // アップロードで添えた atlas-session.json(プロジェクト名など。e2e/phase16.test.ts)は写して使う。「写さなかったもの」には数えない
    expect((manifest.extras?.skipped ?? []).filter((s) => /atlas-session\.json|atlas-memo/.test(s.path))).toEqual([]);
    // ほかの PC から写したフォルダ(中身が空)は記録の無いセッションとして入るだけ
    expect(again.sessions.map((s) => s.id).sort()).toEqual([...sent, 'someone-else'].sort());
    // 指示ファイルの名前は、ほかのセッションと突き合わせて決めるので、一部のセッションだけを集計すると決まらないことがある。それ以外は全部同じ
    // 写した atlas の版(uploadAtlas)と、数えたフォルダ(uploadFolder)は、送り先から集計したときだけ付く
    const pick = ({ instructions: _i, uploadAtlas: _a, uploadFolder: _f, person: _p, ...rest }: SessionRecord) => rest;
    for (const id of sent) expect(again.sessions.find((s) => s.id === id)!.uploadAtlas?.code).toMatch(/^[0-9a-f]{16}$/);
    for (const s of again.sessions) expect('uploadTags' in s).toBe(false);
    expect(again.sessions.find((s) => s.id === 'someone-else')!.uploadAtlas).toBeNull();
    expect(original.sessions.find((s) => s.id === desk)!.desktop).not.toBeNull();
    for (const id of sent) {
      const a = original.sessions.find((s) => s.id === id)!;
      const b = again.sessions.find((s) => s.id === id)!;
      expect(pick(b)).toEqual(pick(a));
    }
  });

  it('d. プロジェクトの説明とセッションの一覧が README.md に残る', async () => {
    for (const id of sent) {
      const readme = await readFile(join(destOf(id), 'README.md'), 'utf8');
      expect(readme.startsWith(`# ${projectOf(id)}\n\n集計のプロジェクト「${projectOf(id)}」のセッション(`)).toBe(true);
      expect(readme).toContain('セッション: 1 件(うちメモあり 0 件)');
      expect(readme).toContain('| セッション ID | 題名 | タスク | 最終更新 | メモ |');
      expect(readme).toContain(`| [${id}](${id}/) |`);
      expect(readme).not.toContain('タスクタグ');
    }
    // 題名は集計の記録から(デスクトップアプリのセッションも含む)
    const first = original.sessions.find((s) => s.id === ids[0])!;
    const title = (first.name || first.firstUserMessage || '').replace(/\s+/g, ' ').slice(0, 20);
    expect(title.length).toBeGreaterThan(0);
    expect(await readFile(join(destOf(ids[0]), 'README.md'), 'utf8')).toContain(title);
    // 名前が「New session」のままのセッションは、data.db の題名で呼ぶ(集計の記録の name も同じ)
    expect(original.sessions.find((s) => s.id === desk)!.name).toBe('デスクトップのセッション');
    expect(await readFile(join(destOf(desk), 'README.md'), 'utf8')).toContain(`| [${desk}](${desk}/) | デスクトップのセッション |`);
    // ほかの PC から写したフォルダは一覧に出さない(今回写したものだけ)
    expect(await readFile(join(destOf(ids[0]), 'README.md'), 'utf8')).not.toContain('someone-else');
  });

  it('e. 読みやすい記録(.md)は送らず、送った先で集計し直すと各セッションの分ができる(README に作り方がある)', async () => {
    // 送ったフォルダには記録の .md を入れない(容量を使わないため。生ログから作れる)
    for (const id of sent) expect((await readdir(join(destOf(id), id))).some((f) => f.endsWith('.md') && f !== 'atlas-memo.md' && f !== 'plan.md')).toBe(false);
    const dest = destOf(ids[0]);
    const readme = await readFile(join(dest, 'README.md'), 'utf8');
    expect(readme).toContain('sessions\\<セッション ID>.md');
    expect(readme).toContain(`bin\\atlas.exe all --home "${dest}" --out "<出力先>"`);
    // README のとおりに集計し直すと、送ったセッションごとに記録ができる
    const out3 = join(WORK, 'out-records');
    const r = atlas(['all', '--home', dest, '--out', out3]);
    expect(r.status, r.stderr).toBe(0);
    const md = join(out3, 'sessions', `${ids[0]}.md`);
    expect(existsSync(md), md).toBe(true);
    expect((await readFile(md, 'utf8')).length).toBeGreaterThan(200);
  });
});
