// アップロード先のフォルダ(<基底>/<グループやプロジェクトの名前>/<セッション id>/ …)を --home にして集計し直すときの、読む側の守り。
//  - 出力先を別の元で使い回したら止める(前の元のセッションと混ざらないように)
//  - 置き換えの途中・消し残しのフォルダ(.<id>.uploading / .<id>.old)はセッションとして数えない
//  - 基底を指したら、0 件で終わらせずに指すフォルダを案内する
//  - リンクのファイルは辿らない(フォルダの外のファイルを写さない)
//  - 添えた行(atlas-session-store.json)の形が違っても止まらない
//  - プロジェクト名は送った側の記録(atlas-session.json)から取り、読む側の PC のディスクからは決めない
// 通しの確認は e2e/phase16.test.ts
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extract, listSessionDirs, loadStore, mergeSessionStoreJson, readSenderProject } from '../src/extract.ts';
import { isUploadWorkDir, snapshot, SNAPSHOT_MANIFEST, UPLOAD_INDEX, UPLOAD_SESSION_META, UPLOAD_WORK_REASON, uploadOldName, uploadTmpName } from '../src/snapshot.ts';

const EVENT = '{"type":"session.start","data":{"sessionId":"x","version":1},"id":"e1","timestamp":"2026-07-02T09:00:00.000Z","parentId":null}\n';

async function work(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'atlas-upread-'));
}

/** セッションのフォルダ(events.jsonl と、渡されたファイル)を作る */
async function session(dir: string, files: Record<string, string> = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'events.jsonl'), EVENT);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
}

/** リンクを作る。作れない環境(Windows で権限が無い)なら false */
async function link(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, 'file');
    return true;
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((e as NodeJS.ErrnoException).code ?? '')) return false;
    throw e;
  }
}

describe('アップロード先から集計し直す: snapshot', () => {
  it('出力先が別の元から作ったものなら止め、前の複製には触れない。同じ元は書き方が違っても通す', async () => {
    const base = await work();
    const a = join(base, 'logs', 'group-a');
    const b = join(base, 'logs', 'group-b');
    const dest = join(base, 'out', 'snapshot');
    await session(join(a, 'sa'));
    await session(join(b, 'sb'));
    expect((await snapshot(a, dest)).sessions.dirs).toBe(1);
    await expect(snapshot(b, dest)).rejects.toThrow(/別の場所.*から集計したもの.*--out/s);
    expect(existsSync(join(dest, 'session-state', 'sa', 'events.jsonl'))).toBe(true);
    expect(existsSync(join(dest, 'session-state', 'sb'))).toBe(false);
    // 同じ場所(末尾の区切り・.. を含む書き方)は同じ元
    expect((await snapshot(a + sep, dest)).sessions.dirs).toBe(1);
    expect((await snapshot(join(a, '..', 'group-a'), dest)).sessions.dirs).toBe(1);
    // マニフェストを消せば(案内のとおり)、今の出力先を使い続けられる
    await rm(join(dest, SNAPSHOT_MANIFEST));
    expect((await snapshot(b, dest)).sessions.dirs).toBe(1);
    // 読めないマニフェストは無いものとして扱う(止めない)
    await writeFile(join(dest, SNAPSHOT_MANIFEST), '{broken');
    expect((await snapshot(b, dest)).sessions.dirs).toBe(1);
  });

  it('置き換えの途中・消し残しのフォルダは写さず、数えなかったことを manifest に残す', async () => {
    const base = await work();
    const src = join(base, 'logs', 'group');
    const dest = join(base, 'out', 'snapshot');
    await session(join(src, 's1'));
    await session(join(src, uploadOldName('s1')));
    await session(join(src, uploadTmpName('s1')));
    await mkdir(join(src, uploadOldName('s2'))); // 空のものは記録もしない
    const m = await snapshot(src, dest);
    expect(m.layout).toBe('flat');
    expect(m.sessions.dirs).toBe(1);
    expect(m.extras?.skipped.filter((x) => x.reason === UPLOAD_WORK_REASON).map((x) => x.path).sort()).toEqual(['.s1.old', '.s1.uploading']);
    expect(await listSessionDirs(join(dest, 'session-state'))).toEqual(['s1']);
    // 前の版が写してしまったスナップショットに残っていても、extract は数えない
    await session(join(dest, 'session-state', '.s1.old'));
    expect(await listSessionDirs(join(dest, 'session-state'))).toEqual(['s1']);
    const file = await extract(dest, { projects: false });
    expect(file.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(file.warnings.messages.join('\n')).toMatch(/消し残しのフォルダ 2 件は、セッションとして数えていない/);
  });

  it('作業用のフォルダの名前だけを見分ける', () => {
    expect(isUploadWorkDir(uploadOldName('abc-1'))).toBe(true);
    expect(isUploadWorkDir(uploadTmpName('abc-1'))).toBe(true);
    for (const n of ['abc.old', 'abc.uploading', '.old', '.uploading', '.git', 'abc', '.abc.older']) expect(isUploadWorkDir(n), n).toBe(false);
  });

  it('アップロード先の基底を指したら、何も写さずに、指すフォルダを案内して止まる', async () => {
    const base = await work();
    const root = join(base, 'logs');
    const dest = join(base, 'out', 'snapshot');
    await session(join(root, 'group-b', 's1'));
    await mkdir(join(root, 'group-a'), { recursive: true });
    await writeFile(join(root, 'group-a', UPLOAD_INDEX), '{}'); // 索引だけがあるフォルダも、アップロードしたフォルダ
    await mkdir(join(root, 'other'));
    const err = await snapshot(root, dest).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/アップロード先の基底/);
    expect(err?.message).toContain(`--home "${join(root, 'group-a')}"`);
    expect(err?.message).toContain('group-a、group-b');
    expect(existsSync(dest)).toBe(false);
    // ふつうのフォルダ(下にアップロードしたフォルダが無い)と ~/.copilot の形は、今までどおり
    const plain = join(base, 'plain');
    await mkdir(join(plain, 'sub'), { recursive: true });
    expect((await snapshot(plain, join(base, 'out-plain'))).sessions.dirs).toBe(0);
    const home = join(base, 'home');
    await session(join(home, 'session-state', 's1'));
    await session(join(home, 'backup', 's9')); // ~/.copilot の下に、たまたまセッションの形のフォルダがあっても基底とはみなさない
    expect((await snapshot(home, join(base, 'out-home'))).sessions.dirs).toBe(1);
  });

  it('リンクのファイルは辿らない(フォルダの外のファイルを写さない。前に写した分は消す)', async (ctx) => {
    const base = await work();
    const src = join(base, 'logs', 'group');
    const dest = join(base, 'out', 'snapshot');
    const outside = join(base, 'outside.txt');
    await writeFile(outside, 'OUTSIDE\n');
    await session(join(src, 's1'), { 'plan.md': '# 計画\n', 'workspace.yaml': 'id: s1\n' });
    await session(join(src, 's2'));
    await snapshot(src, dest);
    expect(await readFile(join(dest, 'session-state', 's1', 'plan.md'), 'utf8')).toBe('# 計画\n');
    // plan.md と workspace.yaml をリンクに差し替える。s2 は events.jsonl がリンク(ほかに何も無い)
    await rm(join(src, 's1', 'plan.md'));
    await rm(join(src, 's1', 'workspace.yaml'));
    await rm(join(src, 's2', 'events.jsonl'));
    if (!(await link(outside, join(src, 's1', 'plan.md')))) return ctx.skip();
    await link(outside, join(src, 's1', 'workspace.yaml'));
    await link(outside, join(src, 's2', 'events.jsonl'));
    const m = await snapshot(src, dest);
    expect(existsSync(join(dest, 'session-state', 's1', 'plan.md'))).toBe(false);
    expect(existsSync(join(dest, 'session-state', 's1', 'workspace.yaml'))).toBe(false);
    expect(existsSync(join(dest, 'session-state', 's1', 'events.jsonl'))).toBe(true);
    expect(existsSync(join(dest, 'session-state', 's2', 'events.jsonl'))).toBe(false);
    const linked = (m.extras?.skipped ?? []).filter((x) => /リンク/.test(x.reason)).map((x) => x.path).sort();
    expect(linked).toEqual(['s1/plan.md', 's1/workspace.yaml', 's2/events.jsonl']);
    expect(await readFile(outside, 'utf8')).toBe('OUTSIDE\n');
  });
});

describe('アップロード先から集計し直す: extract', () => {
  it('添えた行の形が違えば使わず、理由を返す(止まらない)', async () => {
    const base = await work();
    const f = join(base, 'store.json');
    const ok = {
      version: 1,
      schemaVersion: 3,
      sessions: [{ id: 's1', cwd: 'C:\\w', repository: null, summary: 'x', created_at: '2026-07-01T00:00:00Z', updated_at: null }],
      turns: [{ session_id: 's1', turn_index: 0, user_message: 'q', assistant_response: null, timestamp: '2026-07-01T00:00:00Z' }],
      usage: [{ id: 1, session_id: 's1', turn_index: null, model: 'gpt-x', input_tokens: 10, output_tokens: 2, new_column: 'v', created_at: null }],
      files: [{ session_id: 's1', file_path: 'a.ts', tool_name: 'edit', turn_index: 0, first_seen_at: null }],
    };
    const bad: [string, unknown][] = [
      ['sessions に null', { ...ok, sessions: [null] }],
      ['turns に null', { ...ok, turns: [null] }],
      ['usage に null', { ...ok, usage: [null] }],
      ['files に配列', { ...ok, files: [[]] }],
      ['sessions の列が数値', { ...ok, sessions: [{ id: 's1', cwd: 123 }] }],
      ['sessions の列がオブジェクト', { ...ok, sessions: [{ id: 's1', summary: {} }] }],
      ['turns の番号が文字列', { ...ok, turns: [{ session_id: 's1', turn_index: 'x' }] }],
      ['turns の番号が無い', { ...ok, turns: [{ session_id: 's1', user_message: 'q' }] }],
      ['turns の本文がオブジェクト', { ...ok, turns: [{ session_id: 's1', turn_index: 0, user_message: {} }] }],
      ['usage の数が文字列', { ...ok, usage: [{ session_id: 's1', model: 'm', input_tokens: '10' }] }],
      ['usage のモデルが無い', { ...ok, usage: [{ session_id: 's1', input_tokens: 10 }] }],
      ['usage の知らない列がオブジェクト', { ...ok, usage: [{ session_id: 's1', model: 'm', extra: { a: 1 } }] }],
      ['files のパスが無い', { ...ok, files: [{ session_id: 's1' }] }],
      ['files のパスが数値', { ...ok, files: [{ session_id: 's1', file_path: 5 }] }],
      ['版が違う', { ...ok, version: 2 }],
      ['JSON でない', 'not json'],
    ];
    for (const [label, v] of bad) {
      await writeFile(f, typeof v === 'string' ? v : JSON.stringify(v));
      const store = await loadStore(join(base, 'no.db'));
      expect(await mergeSessionStoreJson(store, 's1', f), label).toMatch(/s1: atlas-session-store\.json を読めない/);
      expect([store.sessions.size, store.turns.size, store.usage.size, store.files.size], label).toEqual([0, 0, 0, 0]);
    }
    // 正しい形は使う(知らない列は値のまま)。ほかのセッションの行は、形を確かめるだけで使わない
    await writeFile(f, JSON.stringify({ ...ok, usage: [...ok.usage, { session_id: 'other', model: 5, input_tokens: 'x' }] }));
    const store = await loadStore(join(base, 'no.db'));
    expect(await mergeSessionStoreJson(store, 's1', f)).toBeNull();
    expect(store.sessions.get('s1')).toMatchObject({ id: 's1', cwd: 'C:\\w' });
    expect(store.turns.get('s1')).toHaveLength(1);
    expect(store.usage.get('s1')).toEqual([ok.usage[0]]);
    expect(store.files.get('s1')).toHaveLength(1);
  });

  it('プロジェクト名は送った側の記録から取り、読む側の PC のディスクからは決めない', async () => {
    const base = await work();
    // 読む側の PC に、ログと同じパスで別のリポジトリがある
    const repo = join(base, 'pc', 'my-app');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/zz-other/zz-on-disk.git\n');
    const yaml = `id: g1\ncwd: ${JSON.stringify(repo)}\ngit_root: ${JSON.stringify(repo)}\n`;
    const projects = { homes: [], temps: [], tempPatterns: false };
    const run = async (name: string, meta: string | null, layout: 'flat' | 'copilot' = 'flat') => {
      const src = join(base, name, 'src');
      const dir = layout === 'flat' ? join(src, 'g1') : join(src, 'session-state', 'g1');
      await session(dir, { 'workspace.yaml': yaml, ...(meta == null ? {} : { [UPLOAD_SESSION_META]: meta }) });
      const dest = join(base, name, 'snapshot');
      await snapshot(src, dest);
      const s = (await extract(dest, { projects })).sessions.find((x) => x.id === 'g1')!;
      return [s.project, s.projectSource];
    };
    // 対照: ~/.copilot の形(自分の PC のログ)なら、今までどおりディスクの .git/config から決まる
    expect(await run('home', null, 'copilot')).toEqual(['zz-other/zz-on-disk', 'git-remote']);
    // 送った側の記録があれば、名前も決め方もそのまま使う
    const meta = { version: 1, id: 'g1', title: null, project: 'zz-owner/zz-sent', projectSource: 'git-remote', tags: [], createdAt: null, updatedAt: null, memo: false };
    expect(await run('sent', JSON.stringify(meta))).toEqual(['zz-owner/zz-sent', 'git-remote']);
    expect(await run('sent-repo', JSON.stringify({ ...meta, projectSource: 'repository' }))).toEqual(['zz-owner/zz-sent', 'repository']);
    // 決め方の記録が無い(前の版が書いた)ものは、名前から推す
    const { projectSource: _s, ...old } = meta;
    expect(await run('old', JSON.stringify(old))).toEqual(['zz-owner/zz-sent', 'git-remote']);
    expect(await run('old-temp', JSON.stringify({ ...old, project: '(一時フォルダ)' }))).toEqual(['(一時フォルダ)', 'temp']);
    expect(await run('old-path', JSON.stringify({ ...old, project: 'd:/work/my-app' }))).toEqual(['d:/work/my-app', 'path']);
    expect(await run('odd-source', JSON.stringify({ ...meta, projectSource: 'made-up' }))).toEqual(['zz-owner/zz-sent', 'git-remote']);
    // 記録が無い・使えないときも、ディスクは読まない(パスから決める)
    const byPath = await run('none', null);
    expect(byPath[1]).toBe('path');
    expect(byPath[0]).not.toContain('zz-');
    for (const [name, text] of [
      ['other-id', JSON.stringify({ ...meta, id: 'someone' })],
      ['version', JSON.stringify({ ...meta, version: 2 })],
      ['no-project', JSON.stringify({ ...meta, project: null })],
      ['project-object', JSON.stringify({ ...meta, project: { a: 1 } })],
      ['empty', JSON.stringify({ ...meta, project: '  ' })],
      ['array', '[1]'],
      ['broken', '{'],
    ]) expect(await run(`bad-${name}`, text), name).toEqual(byPath);
  });

  it('送った側の記録を読む(このセッションのものだけ)', async () => {
    const base = await work();
    const f = join(base, UPLOAD_SESSION_META);
    expect(await readSenderProject(f, 's1')).toBeNull();
    await writeFile(f, JSON.stringify({ version: 1, id: 's1', project: 'owner/app', projectSource: 'repository' }));
    expect(await readSenderProject(f, 's1')).toEqual({ project: 'owner/app', source: 'repository' });
    expect(await readSenderProject(f, 's2')).toBeNull();
    await writeFile(f, JSON.stringify({ version: 1, id: 's1', project: 'owner/app' }));
    expect(await readSenderProject(f, 's1')).toEqual({ project: 'owner/app', source: null });
  });
});
