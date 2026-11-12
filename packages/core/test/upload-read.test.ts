// アップロード先のフォルダ(<基底>/<グループやプロジェクトの名前>/<セッション id>/ …)を --home にして集計し直すときの、読む側の守り。
//  - 出力先を別の元で使い回したら止める(前の元のセッションと混ざらないように)
//  - 置き換えの途中・消し残しのフォルダ(.<id>.uploading / .<id>.old)はセッションとして数えない。
//    本体が無いセッションは、写し終えていた .<id>.uploading からだけ写す(.<id>.old だけなら数えず、理由を残す)
//  - アップロードしたフォルダが並ぶ場所(人ごとのフォルダ)を指したら、下のフォルダをまとめて読む。もう 1 段上(全員の分)なら、2 段下のフォルダまでまとめて読む
//  - リンクのファイルは辿らない(フォルダの外のファイルを写さない)
//  - 添えた行(atlas-session-store.json)の形が違っても止まらない
//  - プロジェクト名は送った側の記録(atlas-session.json)から取り、読む側の PC のディスクからは決めない
// 通しの確認は e2e/phase16.test.ts
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extract, listSessionDirs, loadStore, mergeSessionStoreJson, readSenderProject } from '../src/extract.ts';
import { describeSource, DUPLICATE_REASON, isUploadWorkDir, personOfFolder, snapshot, SNAPSHOT_MANIFEST, SNAPSHOT_SOURCE, UPLOAD_INDEX, UPLOAD_OLD_ONLY_REASON, UPLOAD_SESSION_META, UPLOAD_WORK_REASON, uploadOldName, uploadTmpName, uploadWorkDirId } from '../src/snapshot.ts';

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
    // 止めるときの文は、消すファイル(マニフェストと、始めたときの印)を両方挙げる。片方だけ消しても止まる
    const err = await snapshot(b, dest).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain(`${join(dest, SNAPSHOT_MANIFEST)} と ${join(dest, SNAPSHOT_SOURCE)} を消してから`);
    await rm(join(dest, SNAPSHOT_MANIFEST));
    await expect(snapshot(b, dest)).rejects.toThrow(/別の場所/);
    // 両方を消せば(案内のとおり)、今の出力先を使い続けられる
    await rm(join(dest, SNAPSHOT_SOURCE));
    expect((await snapshot(b, dest)).sessions.dirs).toBe(1);
    // 読めないマニフェスト・印は無いものとして扱う(止めない)
    await writeFile(join(dest, SNAPSHOT_MANIFEST), '{broken');
    await writeFile(join(dest, SNAPSHOT_SOURCE), '[1]');
    expect((await snapshot(a, dest)).sessions.dirs).toBe(1);
  });

  it('前の集計が何も写していない出力先は、別の元でも使える(場所を間違えて 0 件だった後に、指定し直せる)', async () => {
    const base = await work();
    const empty = join(base, 'logs', 'empty');
    const a = join(base, 'logs', 'group-a');
    const b = join(base, 'logs', 'group-b');
    const dest = join(base, 'out', 'snapshot');
    await mkdir(empty, { recursive: true });
    await session(join(a, 'sa'));
    await session(join(b, 'sb'));
    expect((await snapshot(empty, dest)).sessions.dirs).toBe(0);
    expect(JSON.parse(await readFile(join(dest, SNAPSHOT_MANIFEST), 'utf8'))).toMatchObject({ sourceRoot: empty });
    // 0 件だった集計の印は消して、今の元のものに書き直す
    expect((await snapshot(a, dest)).sessions.dirs).toBe(1);
    expect(JSON.parse(await readFile(join(dest, SNAPSHOT_MANIFEST), 'utf8'))).toMatchObject({ sourceRoot: a });
    expect(JSON.parse(await readFile(join(dest, SNAPSHOT_SOURCE), 'utf8'))).toMatchObject({ sourceRoot: a });
    // 写したものがある出力先は、今までどおり止める
    await expect(snapshot(b, dest)).rejects.toThrow(/別の場所/);
    expect(existsSync(join(dest, 'session-state', 'sb'))).toBe(false);
    // 0 件のまま途中で止まった集計(印だけがある)の後も同じ
    const dest2 = join(base, 'out2', 'snapshot');
    await snapshot(empty, dest2);
    await rm(join(dest2, SNAPSHOT_MANIFEST));
    expect((await snapshot(b, dest2)).sessions.dirs).toBe(1);
    expect(JSON.parse(await readFile(join(dest2, SNAPSHOT_SOURCE), 'utf8'))).toMatchObject({ sourceRoot: b });
  });

  it('途中で止まった集計(マニフェストが無い)の後でも、別の元を足さない', async () => {
    const base = await work();
    const a = join(base, 'logs', 'group-a');
    const b = join(base, 'logs', 'group-b');
    const dest = join(base, 'out', 'snapshot');
    await session(join(a, 'sa'));
    await session(join(b, 'sb'));
    await snapshot(a, dest);
    // 最後まで終わらなかった集計: 写したセッションと、始めたときの印だけがある
    await rm(join(dest, SNAPSHOT_MANIFEST));
    expect(JSON.parse(await readFile(join(dest, SNAPSHOT_SOURCE), 'utf8'))).toMatchObject({ sourceRoot: a });
    await expect(snapshot(b, dest)).rejects.toThrow(/別の場所.*から集計したもの/s);
    expect(existsSync(join(dest, 'session-state', 'sb'))).toBe(false);
    // 同じ元なら続きから集計できる
    expect((await snapshot(a, dest)).sessions.dirs).toBe(1);
  });

  it('同じ場所を指す別のパス(ジャンクション・リンク)は同じ元として通す', async (ctx) => {
    const base = await work();
    const a = join(base, 'logs', 'group-a');
    const alias = join(base, 'alias');
    const dest = join(base, 'out', 'snapshot');
    await session(join(a, 'sa'));
    try {
      await symlink(a, alias, 'junction');
    } catch (e) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((e as NodeJS.ErrnoException).code ?? '')) return ctx.skip();
      throw e;
    }
    expect((await snapshot(a, dest)).sessions.dirs).toBe(1);
    expect((await snapshot(alias, dest)).sessions.dirs).toBe(1);
    expect((await snapshot(a, dest)).sessions.dirs).toBe(1);
    // 元が無くなった後は、書かれたパスのまま比べる(別のパスは別の元)
    const moved = join(base, 'logs', 'moved');
    await session(join(moved, 'sa'));
    await rm(alias, { recursive: true, force: true });
    await rm(a, { recursive: true, force: true });
    await expect(snapshot(moved, dest)).rejects.toThrow(/別の場所/);
  });

  it('置き換えの途中で止まって本体のフォルダが無いセッションは、写し終えていた作業用のフォルダから写す。退けた前のフォルダだけなら写さない', async () => {
    const base = await work();
    const src = join(base, 'logs', 'group');
    const dest = join(base, 'out', 'snapshot');
    const meta = (id: string): Record<string, string> => ({ [UPLOAD_SESSION_META]: JSON.stringify({ version: 1, id, project: 'zz-owner/zz-app', projectSource: 'git-remote' }) });
    await session(join(src, 'ok'));
    // s1: 前のフォルダを退けたところで止まった(新しいものは写し終えている) → 新しいものを使う
    await session(join(src, uploadOldName('s1')));
    await session(join(src, uploadTmpName('s1')), { ...meta('s1'), 'plan.md': '# 新しい\n' });
    // s2: 退けた前のフォルダだけが残った → 使わない(消し残しがあるセッションを共有から消したときと見分けられない)
    await session(join(src, uploadOldName('s2')), { ...meta('s2'), 'plan.md': '# 前の\n' });
    // s3: 初めて送っている途中(記録がまだ無い) → 使わない
    await session(join(src, uploadTmpName('s3')));
    const m = await snapshot(src, dest);
    expect(m.sessions.dirs).toBe(2);
    expect(m.extras?.recovered).toEqual([{ id: 's1', path: '.s1.uploading' }]);
    expect(m.extras?.skipped.filter((x) => x.reason === UPLOAD_WORK_REASON).map((x) => x.path).sort()).toEqual(['.s1.old', '.s3.uploading']);
    expect(m.extras?.skipped.filter((x) => x.reason === UPLOAD_OLD_ONLY_REASON).map((x) => x.path)).toEqual(['.s2.old']);
    expect(await listSessionDirs(join(dest, 'session-state'))).toEqual(['ok', 's1']);
    expect(await readFile(join(dest, 'session-state', 's1', 'plan.md'), 'utf8')).toBe('# 新しい\n');
    expect(existsSync(join(dest, 'session-state', 's2'))).toBe(false);
    const file = await extract(dest, { projects: { homes: [], temps: [], tempPatterns: false } });
    expect(file.sessions.map((s) => s.id).sort()).toEqual(['ok', 's1']);
    expect(file.sessions.find((s) => s.id === 's1')?.project).toBe('zz-owner/zz-app');
    const warned = file.warnings.messages.join('\n');
    expect(warned).toMatch(/置き換えが途中で止まっていたセッション 1 件は、写し終えていた作業用のフォルダから読んだ\(\.s1\.uploading\)/);
    // 数えなかったことと、どうすればよいか(消したのなら消す・消していなければ送り直す)を出す
    expect(warned).toMatch(/退けた前のフォルダだけが残っているセッション 1 件は、数えていない\(\.s2\.old\)。.*このフォルダも消す.*もう一度アップロード/);
    expect(warned).toMatch(/消し残しのフォルダ 2 件は、セッションとして数えていない/);
    // 本体のフォルダが戻れば(送り直した)、作業用のフォルダは数えないだけ
    await session(join(src, 's1'));
    await session(join(src, 's2'));
    const again = await snapshot(src, dest);
    expect(again.extras?.recovered).toBeUndefined();
    expect(again.extras?.skipped.filter((x) => x.reason === UPLOAD_OLD_ONLY_REASON)).toEqual([]);
    expect(again.sessions.dirs).toBe(3);
  });

  it('作業用のフォルダの名前から取った id が、写す先の名前に使えないものなら写さない(出力先のフォルダの外・別の名前のフォルダに書かない)', async () => {
    const base = await work();
    const src = join(base, 'logs', 'group');
    const dest = join(base, 'out', 'snapshot');
    const meta = (id: string): Record<string, string> => ({ [UPLOAD_SESSION_META]: JSON.stringify({ version: 1, id }), 'plan.md': '# 外に出さない\n' });
    await session(join(src, 's1'));
    // 写し終えた形(記録まである)の作業用のフォルダ。id は順に「..」「.」「.x.old」「x (空白で終わる)」「x.(点で終わる)」
    const bad = ['..', '.', '.x.old', 'x ', 'x.'];
    for (const id of bad) await session(join(src, uploadTmpName(id)), meta(id));
    const m = await snapshot(src, dest);
    expect(m.sessions.dirs).toBe(1);
    expect(m.extras?.recovered).toBeUndefined();
    expect(m.extras?.skipped.filter((x) => x.reason === UPLOAD_WORK_REASON).map((x) => x.path).sort()).toEqual(bad.map((id) => uploadTmpName(id)).sort());
    // 出力先の session-state には s1 だけがあり、その外(出力先の直下・1 つ上)には何も写っていない
    expect(await readdir(join(dest, 'session-state'))).toEqual(['s1']);
    for (const dir of [dest, join(dest, 'session-state'), join(dest, '..')]) for (const f of ['events.jsonl', 'plan.md', UPLOAD_SESSION_META]) expect(existsSync(join(dir, f)), join(dir, f)).toBe(false);
    expect(JSON.parse(await readFile(join(dest, SNAPSHOT_SOURCE), 'utf8'))).toMatchObject({ sourceRoot: src });
    expect(await readFile(join(dest, 'session-state', 's1', 'events.jsonl'), 'utf8')).toBe(EVENT);
  });

  it('作業用のフォルダから写したことは、写したときだけ残す(--since で写さなかったものは入れない)', async () => {
    const base = await work();
    const src = join(base, 'logs', 'group');
    const dest = join(base, 'out', 'snapshot');
    await session(join(src, uploadTmpName('s1')), { [UPLOAD_SESSION_META]: JSON.stringify({ version: 1, id: 's1' }) });
    const m = await snapshot(src, dest, { since: '2999-01-01T00:00:00Z' });
    expect(m.sessions).toMatchObject({ dirs: 0, skippedBySince: 1 });
    expect(m.extras?.recovered).toBeUndefined();
    expect(existsSync(join(dest, 'session-state', 's1'))).toBe(false);
    const file = await extract(dest, { projects: false });
    expect(file.warnings.messages.join('\n')).not.toMatch(/作業用のフォルダから読んだ/);
    // 期間に入っていれば写して、残す
    const all = await snapshot(src, dest);
    expect(all.sessions.dirs).toBe(1);
    expect(all.extras?.recovered).toEqual([{ id: 's1', path: '.s1.uploading' }]);
  });

  it('本体のフォルダがあれば、中がリンクだけでも作業用のフォルダからは写さない。別のフォルダから写し終えた複製は、リンクの片付けで消さない', async (ctx) => {
    const base = await work();
    const src = join(base, 'logs', 'group');
    const dest = join(base, 'out', 'snapshot');
    const meta = { [UPLOAD_SESSION_META]: JSON.stringify({ version: 1, id: 'abc' }) };
    await mkdir(join(src, 'abc'), { recursive: true });
    // 指す先の無いリンク(本体の events.jsonl)
    if (!(await link(join(base, 'gone.jsonl'), join(src, 'abc', 'events.jsonl')))) return ctx.skip();
    await session(join(src, uploadTmpName('abc')), meta);
    const m = await snapshot(src, dest);
    expect(m.sessions.dirs).toBe(0);
    expect(m.extras?.recovered).toBeUndefined();
    expect(m.extras?.skipped.filter((x) => x.reason === UPLOAD_WORK_REASON).map((x) => x.path)).toEqual(['.abc.uploading']);
    expect(m.extras?.skipped.filter((x) => /リンク/.test(x.reason)).map((x) => x.path)).toEqual(['abc/events.jsonl']);
    expect(existsSync(join(dest, 'session-state', 'abc'))).toBe(false);

    // まとめて読むとき: 先のフォルダの作業用のフォルダから写した後に、後のフォルダにリンクだけの本体があっても、写した複製は残る
    const root = join(base, 'logs2', 'person');
    const dest2 = join(base, 'out2', 'snapshot');
    for (const f of ['proj-a', 'proj-b']) {
      await mkdir(join(root, f), { recursive: true });
      await writeFile(join(root, f, UPLOAD_INDEX), '{}');
    }
    await session(join(root, 'proj-a', uploadTmpName('abc')), meta);
    await mkdir(join(root, 'proj-b', 'abc'));
    await link(join(base, 'gone.jsonl'), join(root, 'proj-b', 'abc', 'events.jsonl'));
    const mm = await snapshot(root, dest2);
    expect(mm.layout).toBe('merged');
    expect(mm.sessions.dirs).toBe(1);
    expect(mm.extras?.recovered).toEqual([{ id: 'abc', path: 'proj-a/.abc.uploading' }]);
    expect(await readFile(join(dest2, 'session-state', 'abc', 'events.jsonl'), 'utf8')).toBe(EVENT);
    expect(mm.extras?.skipped.filter((x) => /リンク/.test(x.reason)).map((x) => x.path)).toEqual(['proj-b/abc/events.jsonl']);
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
    // 出力先に残っている分は、数えていないことと場所を警告に出す(前の集計より件数が減った理由が分かるように)
    expect(file.warnings.messages.join('\n')).toMatch(/前の版が写した、アップロードの作業用のフォルダ 1 件が出力先に残っている.*\.s1\.old/);
  });

  it('作業用のフォルダの名前だけを見分ける', () => {
    expect(isUploadWorkDir(uploadOldName('abc-1'))).toBe(true);
    expect(isUploadWorkDir(uploadTmpName('abc-1'))).toBe(true);
    for (const n of ['abc.old', 'abc.uploading', '.old', '.uploading', '.git', 'abc', '.abc.older']) expect(isUploadWorkDir(n), n).toBe(false);
    // 作業用のフォルダの名前から、元のセッションの ID を取り出す(ID に点があっても)
    expect(uploadWorkDirId(uploadOldName('abc-1'))).toBe('abc-1');
    expect(uploadWorkDirId(uploadTmpName('a.b'))).toBe('a.b');
    for (const n of ['abc.old', '.old', '.uploading', 'abc']) expect(uploadWorkDirId(n), n).toBeNull();
  });

  it('アップロードしたフォルダが並ぶ場所を指したら、下のフォルダをまとめて読む(人ごとのフォルダ)', async () => {
    const base = await work();
    const root = join(base, 'logs', 'person-a');
    const dest = join(base, 'out', 'snapshot');
    await session(join(root, 'proj-b', 's1'), { [UPLOAD_SESSION_META]: JSON.stringify({ version: 1, id: 's1', project: 'zz-owner/zz-b', projectSource: 'git-remote' }) });
    await session(join(root, 'proj-b', 's2'));
    await session(join(root, 'proj-c', 's3'), { [UPLOAD_SESSION_META]: JSON.stringify({ version: 1, id: 's3', project: 'zz-owner/zz-c', projectSource: 'git-remote' }) });
    await mkdir(join(root, 'proj-a'), { recursive: true });
    await writeFile(join(root, 'proj-a', UPLOAD_INDEX), '{}'); // 索引だけがあるフォルダも、アップロードしたフォルダ
    await mkdir(join(root, 'other'));
    expect(await describeSource(root)).toEqual({ kind: 'merged', folders: ['proj-a', 'proj-b', 'proj-c'] });
    const m = await snapshot(root, dest);
    expect(m.layout).toBe('merged');
    expect(m.merged).toEqual({ folders: ['proj-a', 'proj-b', 'proj-c'], duplicates: 0, owners: { s1: 'proj-b', s2: 'proj-b', s3: 'proj-c' } });
    expect(m.sessions.dirs).toBe(3);
    expect((await readdir(join(dest, 'session-state'))).sort()).toEqual(['s1', 's2', 's3']);
    // 直下のフォルダ(セッションの入れ物)は、~/.copilot の直下のフォルダとしては写さない
    expect(m.extras?.topLevel).toEqual({});
    // プロジェクト名は、送った側が添えた記録から取る(読む側のディスクでは決めない)
    const x = await extract(dest, { projects: { homes: [], temps: [], tempPatterns: false } });
    expect(x.source).toMatchObject({ layout: 'merged', folders: ['proj-a', 'proj-b', 'proj-c'] });
    expect(Object.fromEntries(x.sessions.map((r) => [r.id, r.project]))).toMatchObject({ s1: 'zz-owner/zz-b', s3: 'zz-owner/zz-c' });
    // 人のフォルダ 1 つを指したときは、人ごとには分けない(全部その人の分)
    expect(x.sessions.map((r) => r.person)).toEqual([null, null, null]);
    // 2 度目も同じ(出力先は同じ元のもの)
    expect((await snapshot(root, dest)).sessions.dirs).toBe(3);
    // プロジェクトのフォルダ 1 つを指したときは、今までどおり直下を読む
    expect(await describeSource(join(root, 'proj-b'))).toEqual({ kind: 'flat' });
    // ~/.copilot の形は、下にたまたまセッションの形のフォルダがあっても、今までどおり
    const home = join(base, 'home');
    await session(join(home, 'session-state', 's1'));
    await session(join(home, 'backup', 's9'));
    expect(await describeSource(home)).toEqual({ kind: 'copilot' });
    const hm = await snapshot(home, join(base, 'out-home'));
    expect(hm.sessions.dirs).toBe(1);
    expect(hm.layout).toBe('copilot');
    expect(hm.merged).toBeUndefined();
  });

  it('まとめて読むとき、同じ id のセッションが複数のフォルダにあれば、events.jsonl が大きいほうだけ数える', async () => {
    const base = await work();
    const root = join(base, 'person-a');
    const dest = join(base, 'out', 'snapshot');
    await session(join(root, 'proj-a', 's1'));
    await session(join(root, 'proj-b', 's1'));
    await writeFile(join(root, 'proj-b', 's1', 'events.jsonl'), EVENT + EVENT); // 後から送ったほう(続きがある)
    await session(join(root, 'proj-b', 's2'));
    // 大きさが同じなら、名前の順で先のフォルダ
    await session(join(root, 'proj-a', 's4'), { 'plan.md': 'a' });
    await session(join(root, 'proj-b', 's4'), { 'plan.md': 'b' });
    // 本体が別のフォルダにあるセッションの消し残しは、作業用のフォルダから写さない
    await session(join(root, 'proj-a', uploadOldName('s2')));
    // 本体がどこにも無いセッションの、写し終えた作業用のフォルダが 2 つのフォルダにあれば、1 度だけ写す
    const done = { [UPLOAD_SESSION_META]: JSON.stringify({ version: 1, id: 's5' }) };
    await session(join(root, 'proj-a', uploadTmpName('s5')), done);
    await session(join(root, 'proj-b', uploadTmpName('s5')), done);
    // 退けた前のフォルダだけが 2 つのフォルダにあるものは、どちらも写さない
    await session(join(root, 'proj-a', uploadOldName('s6')));
    await session(join(root, 'proj-b', uploadOldName('s6')));
    const m = await snapshot(root, dest);
    expect(m.sessions.dirs).toBe(4);
    expect(m.merged?.duplicates).toBe(2);
    expect(await readFile(join(dest, 'session-state', 's1', 'events.jsonl'), 'utf8')).toBe(EVENT + EVENT);
    expect(await readFile(join(dest, 'session-state', 's4', 'plan.md'), 'utf8')).toBe('a');
    expect(m.extras?.skipped.filter((x) => x.reason === DUPLICATE_REASON).map((x) => x.path)).toEqual(['proj-a/s1', 'proj-b/s4']);
    expect(m.extras?.recovered).toEqual([{ id: 's5', path: `proj-a/${uploadTmpName('s5')}` }]);
    expect(m.extras?.skipped.filter((x) => x.reason === UPLOAD_OLD_ONLY_REASON).map((x) => x.path)).toEqual([`proj-a/${uploadOldName('s6')}`, `proj-b/${uploadOldName('s6')}`]);
    expect(existsSync(join(dest, 'session-state', 's6'))).toBe(false);
    // 警告は、フォルダの数ではなくセッションの数で出す
    expect((await extract(dest, { projects: false })).warnings.messages.join('\n')).toMatch(/退けた前のフォルダだけが残っているセッション 1 件は、数えていない/);
    expect(
      m.extras?.skipped
        .filter((x) => x.reason === UPLOAD_WORK_REASON)
        .map((x) => x.path)
        .sort(),
    ).toEqual([`proj-a/${uploadOldName('s2')}`, `proj-b/${uploadTmpName('s5')}`]);
    // 2 度目も、数えるほうは変わらない(数えなかったほうで上書きしない)
    await snapshot(root, dest);
    expect(await readFile(join(dest, 'session-state', 's1', 'events.jsonl'), 'utf8')).toBe(EVENT + EVENT);
    expect(await readFile(join(dest, 'session-state', 's4', 'plan.md'), 'utf8')).toBe('a');
  });

  it('もう 1 段上(人ごとのフォルダが並ぶ場所。全員の分)を指したら、2 段下のフォルダまでまとめて読む', async () => {
    const base = await work();
    const root = join(base, 'logs');
    const dest = join(base, 'out', 'snapshot');
    await session(join(root, 'person-a', 'proj-a', 's1'), {
      [UPLOAD_SESSION_META]: JSON.stringify({ version: 1, id: 's1', project: 'zz-owner/zz-a', projectSource: 'git-remote', tags: [' 武器 ', '武器', '', 'a\u202eb', 'x'.repeat(101), 3, 'UI'] }),
      'atlas-memo.md': '# 送った人のメモ\n\n![図](atlas-memo/p.png)',
    });
    await mkdir(join(root, 'person-a', 'proj-a', 's1', 'atlas-memo'));
    await writeFile(join(root, 'person-a', 'proj-a', 's1', 'atlas-memo', 'p.png'), 'png');
    await session(join(root, 'person-a', 'proj-b', 's2'));
    // 別のセッションの記録(id が違う)と、形の違う tags は使わない
    await session(join(root, 'person-b', 'proj-a', 's3'), { [UPLOAD_SESSION_META]: JSON.stringify({ version: 1, id: 'zz', tags: ['他人の'] }) });
    // 同じ id のセッションが 2 人のフォルダにあれば、1 度だけ数える
    await session(join(root, 'person-b', 'proj-a', 's1'));
    for (const d of ['person-a/proj-a', 'person-b/proj-a']) await writeFile(join(root, d, UPLOAD_INDEX), '{}');
    await mkdir(join(root, 'other'));
    expect(await describeSource(root)).toEqual({ kind: 'merged', folders: ['person-a/proj-a', 'person-a/proj-b', 'person-b/proj-a'] });
    const m = await snapshot(root, dest);
    expect(m.layout).toBe('merged');
    expect(m.merged).toEqual({
      folders: ['person-a/proj-a', 'person-a/proj-b', 'person-b/proj-a'],
      duplicates: 1,
      owners: { s1: 'person-a/proj-a', s2: 'person-a/proj-b', s3: 'person-b/proj-a' },
    });
    expect(m.sessions.dirs).toBe(3);
    expect((await readdir(join(dest, 'session-state'))).sort()).toEqual(['s1', 's2', 's3']);
    expect(m.extras?.skipped.filter((x) => x.reason === DUPLICATE_REASON).map((x) => x.path)).toEqual(['person-b/proj-a/s1']);
    expect(m.extras?.topLevel).toEqual({});
    const x = await extract(dest, { projects: { homes: [], temps: [], tempPatterns: false } });
    expect(x.source).toMatchObject({ layout: 'merged', folders: ['person-a/proj-a', 'person-a/proj-b', 'person-b/proj-a'] });
    expect(x.sessions.find((r) => r.id === 's1')?.project).toBe('zz-owner/zz-a');
    // 人のフォルダの名前を、セッションごとに持たせる(2 人のフォルダにある s1 は、数えたほうの人)
    expect(Object.fromEntries(x.sessions.map((r) => [r.id, r.person]))).toEqual({ s1: 'person-a', s2: 'person-a', s3: 'person-b' });
    // 送った人が付けていたタスクタグ(前後の空白を落とし、同じ名前・空・書式の文字・長すぎるもの・文字列以外は使わない)。記録が無い・別のセッションのものなら空
    expect(Object.fromEntries(x.sessions.map((r) => [r.id, r.uploadTags]))).toEqual({ s1: ['武器', 'UI'], s2: [], s3: [] });
    // 送った人のメモ(atlas-memo.md と画像の atlas-memo/)も写す(読むだけの画面で出す)
    expect(await readFile(join(dest, 'session-state', 's1', 'atlas-memo.md'), 'utf8')).toContain('送った人のメモ');
    expect(await readFile(join(dest, 'session-state', 's1', 'atlas-memo', 'p.png'), 'utf8')).toBe('png');
    expect(m.extras?.skipped.some((s) => s.path.includes('atlas-memo'))).toBe(false);
    // 人のフォルダ 1 つを指したときは、その人の分だけ
    expect(await describeSource(join(root, 'person-a'))).toEqual({ kind: 'merged', folders: ['proj-a', 'proj-b'] });
    expect((await snapshot(join(root, 'person-a'), join(base, 'out-a'))).sessions.dirs).toBe(2);
    // 直下にアップロードしたフォルダがあり、その横に人ごとのフォルダもあるときは、両方を読む
    await session(join(root, 'shared', 's4'));
    expect(await describeSource(root)).toEqual({ kind: 'merged', folders: ['person-a/proj-a', 'person-a/proj-b', 'person-b/proj-a', 'shared'] });
    expect((await snapshot(root, join(base, 'out-b'))).sessions.dirs).toBe(4);
    // どれでもないフォルダ・無いフォルダは none(今までどおり 0 件で終わる)
    expect(await describeSource(join(root, 'other'))).toEqual({ kind: 'none' });
    expect(await describeSource(join(root, 'nothing-here'))).toEqual({ kind: 'none' });
    expect((await snapshot(join(root, 'other'), join(base, 'out-other'))).sessions.dirs).toBe(0);
    // さらに 1 段上(全員の分が入ったフォルダが並ぶ場所)は読まない
    const top = join(base, 'top');
    await session(join(top, 'logs', 'person-a', 'proj-a', 's1'));
    await writeFile(join(top, 'logs', 'person-a', 'proj-a', UPLOAD_INDEX), '{}');
    expect(await describeSource(top)).toEqual({ kind: 'none' });
    // ~/.copilot の形のフォルダ(バックアップなど)が横にあっても、人ごとのフォルダとしては読まない
    await session(join(root, 'backup', 'session-state', 's9'));
    expect(await describeSource(root)).toEqual({ kind: 'merged', folders: ['person-a/proj-a', 'person-a/proj-b', 'person-b/proj-a', 'shared'] });
  });

  it('人のフォルダの名前は、数えたフォルダから決める(直下のフォルダ・作業用のフォルダから写したもの・元から消えたもの)', async () => {
    expect(personOfFolder('person-a/proj-a')).toBe('person-a');
    expect(personOfFolder('proj-a')).toBeNull();
    expect(personOfFolder('/proj-a')).toBeNull();
    expect(personOfFolder('')).toBeNull();
    expect(personOfFolder(undefined)).toBeNull();
    const base = await work();
    const root = join(base, 'logs');
    const dest = join(base, 'out', 'snapshot');
    await session(join(root, 'person-a', 'proj-a', 's1'));
    await session(join(root, 'person-b', 'proj-a', 's2'));
    // 人のフォルダの下に無いもの(送り先の直下のフォルダ)は、人が分からない
    await session(join(root, 'shared', 's3'));
    // 置き換えの途中で止まり、写し終えた作業用のフォルダだけが残ったセッションは、そのフォルダの人
    await session(join(root, 'person-b', 'proj-b', uploadTmpName('s4')), { [UPLOAD_SESSION_META]: JSON.stringify({ version: 1, id: 's4' }) });
    await writeFile(join(root, 'person-b', 'proj-b', UPLOAD_INDEX), '{}');
    const m = await snapshot(root, dest);
    expect(m.merged?.owners).toEqual({ s1: 'person-a/proj-a', s2: 'person-b/proj-a', s3: 'shared', s4: 'person-b/proj-b' });
    const people = async (): Promise<Record<string, string | null | undefined>> =>
      Object.fromEntries((await extract(dest, { projects: false })).sessions.map((r) => [r.id, r.person]));
    expect(await people()).toEqual({ s1: 'person-a', s2: 'person-b', s3: null, s4: 'person-b' });
    // 元から消えたセッションの複製は出力先に残る。前の集計で数えたフォルダを引き継ぐ(人ごとの内訳から外れない)
    await rm(join(root, 'person-b', 'proj-a', 's2'), { recursive: true });
    const again = await snapshot(root, dest);
    expect(existsSync(join(dest, 'session-state', 's2'))).toBe(true);
    expect(again.merged?.owners).toEqual({ s1: 'person-a/proj-a', s2: 'person-b/proj-a', s3: 'shared', s4: 'person-b/proj-b' });
    expect(await people()).toEqual({ s1: 'person-a', s2: 'person-b', s3: null, s4: 'person-b' });
    // 別の人のフォルダに移したら、今あるほうの人になる(前の値より、今の元を先に見る)
    await session(join(root, 'person-a', 'proj-a', 's2'));
    expect((await snapshot(root, dest)).merged?.owners?.s2).toBe('person-a/proj-a');
    // 古い manifest(owners が無い)から集計し直したものは、人が分からない(止まらない)
    const file = join(dest, SNAPSHOT_MANIFEST);
    const old = JSON.parse(await readFile(file, 'utf8')) as { merged: { owners?: unknown } };
    delete old.merged.owners;
    await writeFile(file, JSON.stringify(old));
    expect(Object.values(await people())).toEqual([null, null, null, null]);
  });

  it('2 段下まで読むかどうかは、索引と、人のフォルダごとに先頭の 3 個までで確かめる', async () => {
    const base = await work();
    const root = join(base, 'logs');
    // 索引の無いフォルダ(前の版が写した、手で写した)でも、人のフォルダの下の先頭の 3 個までにあれば読む
    await session(join(root, 'person-a', 'proj-a', 's1'));
    expect(await describeSource(root)).toEqual({ kind: 'merged', folders: ['person-a/proj-a'] });
    // 4 番目より後ろにしか無ければ、読まない(関係のないフォルダを 2 段下まで全部は見ない)
    const far = join(base, 'far');
    for (const d of ['d1', 'd2', 'd3']) await mkdir(join(far, 'person-a', d), { recursive: true });
    await session(join(far, 'person-a', 'proj-z', 's1'));
    expect(await describeSource(far)).toEqual({ kind: 'none' });
    expect((await snapshot(far, join(base, 'out-far'))).sessions.dirs).toBe(0);
    // どこか 1 つに索引があれば、索引の無いフォルダも読む
    await session(join(far, 'person-b', 'proj-b', 's2'));
    await writeFile(join(far, 'person-b', 'proj-b', UPLOAD_INDEX), '{}');
    expect(await describeSource(far)).toEqual({ kind: 'merged', folders: ['person-a/proj-z', 'person-b/proj-b'] });
  });

  it('まとめて読むかどうかを確かめるとき、索引の無いフォルダを中まで見るのは先頭の 20 個まで。読むと決めたら残りも読む', async () => {
    const base = await work();
    const root = join(base, 'big');
    // 索引の無いフォルダが 25 個。セッションの形のものは、名前の順で 21 番目より後ろにだけある
    for (let i = 0; i < 25; i++) await mkdir(join(root, `d${String(i).padStart(2, '0')}`), { recursive: true });
    await session(join(root, 'd22', 's1'));
    expect(await describeSource(root)).toEqual({ kind: 'none' });
    expect((await snapshot(root, join(base, 'out-a'))).sessions.dirs).toBe(0);
    // 索引のあるフォルダは、何番目にあっても見つける。まとめて読むと決めたら、索引の無い 21 番目より後ろのフォルダも読む
    await writeFile(join(root, 'd24', UPLOAD_INDEX), '{}');
    expect(await describeSource(root)).toEqual({ kind: 'merged', folders: ['d22', 'd24'] });
    expect((await snapshot(root, join(base, 'out-b'))).sessions.dirs).toBe(1);
    // 先頭の 20 個の中にあるセッションの形のフォルダは、索引が無くても見つける
    await rm(join(root, 'd24', UPLOAD_INDEX));
    await session(join(root, 'd03', 's2'));
    expect(await describeSource(root)).toEqual({ kind: 'merged', folders: ['d03', 'd22'] });
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

  it('送った側の記録はそのまま信じない(名前の空白と制御文字、名前と合わない決め方)', async () => {
    const base = await work();
    const f = join(base, UPLOAD_SESSION_META);
    const read = async (project: unknown, projectSource?: unknown) => {
      await writeFile(f, JSON.stringify({ version: 1, id: 's1', project, ...(projectSource === undefined ? {} : { projectSource }) }));
      return readSenderProject(f, 's1');
    };
    // 前後の空白は落とす。制御文字(改行・タブ・行の区切り)と、見えない文字・文字の向きを変える文字を含む名前は使わない
    expect(await read('  owner/app \n', 'git-remote')).toEqual({ project: 'owner/app', source: 'git-remote' });
    for (const bad of ['owner/app\nsecond', 'a\tb', 'a\u0000b', 'a\u2028b', 'a\u0085b', 'app\u202Egnp.exe', 'app\u200Bx', 'a\uFEFFb', 'a\u2066b', 'x'.repeat(1001)]) expect(await read(bad, 'path'), JSON.stringify(bad.slice(0, 12))).toBeNull();
    // まとめ用の名前は、その決め方に揃える(記録の決め方が違っても)
    expect(await read('(一時フォルダ)', 'git-remote')).toEqual({ project: '(一時フォルダ)', source: 'temp' });
    expect(await read('(一時フォルダ)')).toEqual({ project: '(一時フォルダ)', source: 'temp' });
    // ほかの名前にまとめ用の決め方が付いていたら、決め方は使わない(名前から推す側に回す)
    for (const s of ['temp', 'home', 'atlas-judge']) expect(await read('owner/app', s), s).toEqual({ project: 'owner/app', source: null });
    expect(await read('owner/app', 'unknown')).toEqual({ project: 'owner/app', source: 'unknown' });
  });
});
