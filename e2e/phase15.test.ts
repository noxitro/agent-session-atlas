// グループのアップロード(atlas group upload / 画面の「アップロード」): グループのセッションの生ログを <基底>/<グループ名>/<セッション id>/ に写し、
// 送った先で `--home <基底>/<グループ名>` でそのまま集計し直せることを、架空の fixture で通しで確かめる。
//  a. 写したフォルダの形(生ログ + atlas-session-store.json。スナップショットの作業用ファイルは入れない)、
//     前回の集計に無い id と外を指す id は写さない、ほかの PC から写したフォルダには触れない、2 回目は同じセッションを置き換える
//  b. アップ先から集計し直すと、元から集計したのと同じトークン・依頼・モデル・ツールになる(DB の行も添えてあるため)。
//     デスクトップアプリのセッションの data.db の行(題名・モデル・トークン数など)も運ばれる(資格情報の表・許可外の列は入らない)
//  c. アップロード先が無い・決まっていないときは何も写さずに止まる
//  d. グループの説明とセッションの一覧が README.md に、メモ(と画像)が各セッションのフォルダの atlas-memo.md に残る
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionStoreRows, type SessionRecord, type SessionsFile, type SessionStoreJson } from '../packages/core/src/index.ts';
import { buildFixtureHome, FAKE_SECRETS, P11_SESSION, ROOT, UNLISTED_VALUES } from './fixture-home.ts';

const WORK = join(ROOT, 'out', 'e2e-phase15');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const GROUP = 'Player-Weapon';

function atlas(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 600_000, env: { ...process.env, ...env } });
  // ログは標準出力、エラーは標準エラー。どちらに出ても見られるよう out に両方を入れる
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
}

describe('Phase 15 E2E: グループのアップロード', () => {
  let close: () => Promise<void>;
  const out1 = join(WORK, 'out-src');
  const out2 = join(WORK, 'out-uploaded');
  const notes = join(WORK, 'notes');
  const root = join(WORK, 'atlas-logs');
  const dest = join(root, GROUP);
  let original: SessionsFile;
  /** DB とフォルダの両方があり、トークンが記録されているセッション(写したものが DB の行も運べたかを見る) */
  let ids: string[];
  /** data.db にだけ題名・モデルなどがあるデスクトップアプリのセッション */
  const desk = P11_SESSION;

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    let home: string;
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
      const rows = await sessionStoreRows(join(out1, 'snapshot', 'session-store.db'), x.id);
      if (rows?.usage.length) ids.push(x.id);
    }
    expect(ids).toHaveLength(2);
    await mkdir(notes, { recursive: true });
    await writeFile(join(notes, 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: GROUP, note: 'プレイヤーの武器の当たり判定を直したタスク', ids: [...ids, desk, 'not-in-snapshot', '..'] }] }));
    // 1 件目にだけ画像付きのメモ
    await mkdir(join(notes, 'memos', ids[0]), { recursive: true });
    await writeFile(join(notes, 'memos', `${ids[0]}.md`), `# 結論\n\n判定の幅を直した。\n\n![画像](${ids[0]}/0123456789abcdef.png)\n`);
    await writeFile(join(notes, 'memos', ids[0], '0123456789abcdef.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    // ほかの PC から先に写してあったセッション(触れてはいけない)
    await mkdir(join(dest, 'someone-else'), { recursive: true });
    await writeFile(join(dest, 'someone-else', 'events.jsonl'), '');
  });
  afterAll(async () => close?.());

  it('a. 生ログと DB の行をセッションごとのフォルダに写し、同じセッションは置き換え、ほかには触れない', async () => {
    const r = atlas(['group', 'upload', GROUP, '--to', root, '--out', out1, '--notes-dir', notes]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toMatch(/3 セッション.置き換え 0 件./);
    expect(r.out).toMatch(/前回の集計に無い 2 件は写していません/);
    expect((await readdir(dest)).sort()).toEqual([...ids, desk, 'README.md', 'atlas-index.json', 'atlas-installed.json', 'someone-else'].sort());
    for (const id of ids) {
      const files = await readdir(join(dest, id));
      expect(files).toContain('events.jsonl');
      expect(files).toContain('atlas-session.json');
      expect(files).toContain('workspace.yaml');
      expect(files).not.toContain('.session.db.src');
      const rows = JSON.parse(await readFile(join(dest, id, 'atlas-session-store.json'), 'utf8')) as SessionStoreJson;
      expect(rows.version).toBe(1);
      expect(rows.sessions.map((s) => s.id)).toEqual([id]);
      expect(rows.usage.length).toBeGreaterThan(0);
      expect(new Set([...rows.turns, ...rows.usage, ...rows.files].map((x) => x.session_id))).toEqual(new Set([id]));
      // 元のイベントがそのまま写っている
      expect(await readFile(join(dest, id, 'events.jsonl'), 'utf8')).toBe(await readFile(join(out1, 'snapshot', 'session-state', id, 'events.jsonl'), 'utf8'));
    }
    // data.db の行は許可リストの列だけ(資格情報・許可外の列の値は入らない)
    const dj = await readFile(join(dest, desk, 'atlas-session-store.json'), 'utf8');
    expect((JSON.parse(dj) as SessionStoreJson).desktop?.session?.title).toBe('デスクトップのセッション');
    for (const v of [...Object.values(FAKE_SECRETS), ...Object.values(UNLISTED_VALUES)]) expect(dj).not.toContain(v);
    // 2 回目: 送り先で手を加えたフォルダは丸ごと置き換える(手で足したファイルは消える)。前に写したときのままのものは写し直さない。
    // ほかの PC から写したフォルダは残る
    await writeFile(join(dest, ids[0], 'stale.txt'), 'x');
    const r2 = atlas(['group', 'upload', GROUP, '--to', root, '--out', out1, '--notes-dir', notes]);
    expect(r2.status, r2.stderr).toBe(0);
    expect(r2.out).toMatch(/1 セッション.置き換え 1 件・メモ 1 件・前に送ったときのままの 2 件は写していません./);
    expect(existsSync(join(dest, ids[0], 'stale.txt'))).toBe(false);
    expect(existsSync(join(dest, 'someone-else', 'events.jsonl'))).toBe(true);
    expect((await readdir(dest)).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('b. アップ先のグループのフォルダを --home にすると、元と同じ集計になる', async () => {
    let log = '';
    for (const cmd of ['snapshot', 'extract']) {
      const r = atlas([cmd, '--home', dest, '--out', out2]);
      expect(r.status, r.stderr).toBe(0);
      log = r.out;
    }
    // 送った atlas の版(このチェックアウトで送り、このチェックアウトで集計したので、すべて最新)。ほかの PC から写したフォルダは記録なし
    expect(log).toMatch(/extract: 注意 送った atlas の版: \d+ 件のうち 版の記録なし 1 件/);
    const again = JSON.parse(await readFile(join(out2, 'sessions.json'), 'utf8')) as SessionsFile;
    const manifest = JSON.parse(await readFile(join(out2, 'snapshot', 'snapshot-manifest.json'), 'utf8')) as { layout?: string; extras?: { skipped: { path: string }[] } };
    expect(manifest.layout).toBe('flat');
    // アップロードで添えた atlas-session.json(プロジェクト名とタスクタグ。e2e/phase16.test.ts)とメモ(読むだけの画面で出す)は写して使う。どちらも「写さなかったもの」には数えない
    expect((manifest.extras?.skipped ?? []).filter((s) => /atlas-session\.json|atlas-memo/.test(s.path))).toEqual([]);
    // ほかの PC から写したフォルダ(中身が空)は記録の無いセッションとして入るだけ
    expect(again.sessions.map((s) => s.id).sort()).toEqual([...ids, desk, 'someone-else'].sort());
    // 指示ファイルの名前は、ほかのセッションと突き合わせて決めるので、一部のセッションだけを集計すると決まらないことがある。それ以外は全部同じ
    // 送り先から集計すると、送った人が付けていたタスクタグ(uploadTags)が付く。元の集計には無い
    // 写した atlas の版(uploadAtlas)も付く
    const pick = ({ instructions: _i, uploadTags: _t, uploadAtlas: _a, uploadFolder: _f, ...rest }: SessionRecord) => rest;
    for (const id of ids) expect(again.sessions.find((s) => s.id === id)!.uploadTags).toEqual(['Player-Weapon']);
    for (const id of ids) expect(again.sessions.find((s) => s.id === id)!.uploadAtlas?.code).toMatch(/^[0-9a-f]{16}$/);
    expect(again.sessions.find((s) => s.id === 'someone-else')!.uploadAtlas).toBeNull();
    expect(original.sessions.find((s) => s.id === desk)!.desktop).not.toBeNull();
    for (const id of [...ids, desk]) {
      const a = original.sessions.find((s) => s.id === id)!;
      const b = again.sessions.find((s) => s.id === id)!;
      expect(pick(b)).toEqual(pick(a));
    }
  });

  it('d. グループの説明とセッションの一覧が README.md に、メモと画像が各セッションのフォルダに残る', async () => {
    const readme = await readFile(join(dest, 'README.md'), 'utf8');
    expect(readme.startsWith(`# ${GROUP}\n\nプレイヤーの武器の当たり判定を直したタスク\n`)).toBe(true);
    expect(readme).toContain('セッション: 3 件(うちメモあり 1 件)');
    for (const id of [...ids, desk]) expect(readme).toContain(`| [${id}](${id}/) |`);
    // 題名は集計の記録から(デスクトップアプリのセッションも含む)
    const first = original.sessions.find((s) => s.id === ids[0])!;
    const title = (first.name || first.firstUserMessage || '').replace(/\s+/g, ' ').slice(0, 20);
    expect(title.length).toBeGreaterThan(0);
    expect(readme).toContain(title);
    // 名前が「New session」のままのセッションは、data.db の題名で呼ぶ(集計の記録の name も同じ)
    expect(original.sessions.find((s) => s.id === desk)!.name).toBe('デスクトップのセッション');
    expect(readme).toContain(`| [${desk}](${desk}/) | デスクトップのセッション |`);
    expect(readme).toContain(`| [あり](${ids[0]}/atlas-memo.md) |`);
    expect(readme).toContain('`not-in-snapshot`');
    // ほかの PC から写したフォルダは一覧に出さない(今回写したものだけ)
    expect(readme).not.toContain('someone-else');
    // メモの画像の参照は、添えた画像のフォルダを指す(Markdown のビューアでそのまま開ける)
    expect(await readFile(join(dest, ids[0], 'atlas-memo.md'), 'utf8')).toBe('# 結論\n\n判定の幅を直した。\n\n![画像](atlas-memo/0123456789abcdef.png)\n');
    expect(existsSync(join(dest, ids[0], 'atlas-memo', '0123456789abcdef.png'))).toBe(true);
    expect(existsSync(join(dest, ids[1], 'atlas-memo.md'))).toBe(false);
  });

  it('e. 読みやすい記録(.md)は送らず、送った先で集計し直すと各セッションの分ができる(README に作り方がある)', async () => {
    // 送ったフォルダには記録の .md を入れない(容量を使わないため。生ログから作れる)
    for (const id of [...ids, desk]) expect((await readdir(join(dest, id))).some((f) => f.endsWith('.md') && f !== 'atlas-memo.md' && f !== 'plan.md')).toBe(false);
    const readme = await readFile(join(dest, 'README.md'), 'utf8');
    expect(readme).toContain('sessions\\<セッション ID>.md');
    expect(readme).toContain(`npm run atlas -- all --home "${dest}" --out "<出力先>"`);
    // README のとおりに集計し直すと、送ったセッションごとに記録ができる
    const out3 = join(WORK, 'out-records');
    const r = atlas(['all', '--home', dest, '--out', out3]);
    expect(r.status, r.stderr).toBe(0);
    for (const id of [...ids, desk]) {
      const md = join(out3, 'sessions', `${id}.md`);
      expect(existsSync(md), md).toBe(true);
      expect((await readFile(md, 'utf8')).length).toBeGreaterThan(200);
    }
  });

  it('c. アップロード先が無い・決まっていないときは止まり、何も写さない', async () => {
    const missing = join(WORK, 'no-such-dir');
    const r = atlas(['group', 'upload', GROUP, '--to', missing, '--out', out1, '--notes-dir', notes]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/アップロード先のフォルダが見つかりません/);
    expect(existsSync(missing)).toBe(false);
    // 設定にも無い(空の設定ファイルを指す)
    const cfg = join(WORK, 'empty.config.json');
    await writeFile(cfg, '{}');
    const r2 = atlas(['group', 'upload', GROUP, '--out', out1, '--notes-dir', notes, '--config', cfg]);
    expect(r2.status).not.toBe(0);
    expect(r2.out).toMatch(/アップロード先が決まっていません/);
    const r3 = atlas(['group', 'upload', 'no-such-group', '--to', root, '--out', out1, '--notes-dir', notes]);
    expect(r3.status).not.toBe(0);
    expect(r3.out).toMatch(/タスクタグ「no-such-group」はありません/);
  });
});
