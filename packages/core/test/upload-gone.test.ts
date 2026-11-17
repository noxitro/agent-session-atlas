// アップロード先を読むとき、元から無くなったセッションの複製を消す(snapshot.ts の removeGoneSessions)。
//  - 消すのは、前にあった場所を読み直して、無いと確かめられたものだけ(読めない・記録が無い・動かせないものは消さず、理由を extras.goneKept に残す)
//  - 消さなかった複製のフォルダの記録は、次の集計へ持ち越す(元の形が変わった回・セッションが見つからない回でも)
//  - ~/.copilot を読むときは消さない(Copilot が消したログの、最後の複製かもしれない)
// 通しの確認は e2e/phase16.test.ts
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extract } from '../src/extract.ts';
import {
  describeSource,
  KEPT_BUSY_REASON,
  KEPT_NO_SOURCE_REASON,
  KEPT_PRESENT_REASON,
  KEPT_UNKNOWN_REASON,
  KEPT_UNREADABLE_REASON,
  snapshot,
  SNAPSHOT_MANIFEST,
  SNAPSHOT_REMOVED_DIR,
  UPLOAD_INDEX,
  uploadOldName,
  uploadTmpName,
  type SnapshotManifest,
} from '../src/snapshot.ts';

const EVENT = '{"type":"session.start","data":{"sessionId":"x","version":1},"id":"e1","timestamp":"2026-07-02T09:00:00.000Z","parentId":null}\n';

async function work(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'atlas-gone-'));
}

/** セッションのフォルダ(events.jsonl)を作る */
async function session(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'events.jsonl'), EVENT);
}

/** フォルダの中の名前(名前の順) */
async function names(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

/** 消さなかった複製(id と理由) */
const kept = (m: SnapshotManifest): [string, string][] => (m.extras?.goneKept ?? []).map((k) => [k.id, k.reason]);
/** 消さなかった複製が持ち越した、フォルダの記録(id と folder) */
const keptFolders = (m: SnapshotManifest): [string, string | undefined][] => (m.extras?.goneKept ?? []).map((k) => [k.id, k.folder]);

describe('アップロード先を読むとき、元から無くなったセッションの複製を消す', () => {
  it('直下にセッションが並ぶ形: 消したもの・退けた前のフォルダだけのものは消し、大文字小文字だけ変わったもの・写している途中のものは残す', async () => {
    const base = await work();
    const proj = join(base, 'logs', 'proj-a');
    const dest = join(base, 'out', 'snapshot');
    const state = join(dest, 'session-state');
    for (const id of ['s1', 's2', 's3', 's4', 's5']) await session(join(proj, id));
    const first = await snapshot(proj, dest);
    expect([first.sessions.removed, kept(first)]).toEqual([undefined, []]);
    expect(await names(state)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    // s2 は消した。s3 は本体が無く、置き換えで退けた前のフォルダだけが残っている(共有から消したセッションの消し残し。写さないので、複製も消す)。
    // s4 は名前の大文字小文字だけが変わった(Windows では同じフォルダなので、写したばかりの複製を消さない)。
    // s5 は本体が無く、写している途中の作業用のフォルダだけがある(送っている最中かもしれないので、複製を消さない)
    await rm(join(proj, 's2'), { recursive: true });
    await rename(join(proj, 's3'), join(proj, uploadOldName('s3')));
    await rename(join(proj, 's4'), join(proj, 'S4-tmp'));
    await rename(join(proj, 'S4-tmp'), join(proj, 'S4'));
    await rename(join(proj, 's5'), join(proj, uploadTmpName('s5')));
    // 複製先にある作業用のフォルダの名前のもの(前の版が写したもの)には触れない
    await session(join(state, uploadOldName('zz')));
    const m = await snapshot(proj, dest);
    expect([m.sessions.removed, kept(m)]).toEqual([2, []]);
    const left = (await names(state)).map((n) => n.toLowerCase());
    for (const id of ['s1', 's4', 's5']) expect(left, id).toContain(id);
    expect(existsSync(join(state, 's2')) || existsSync(join(state, 's3'))).toBe(false);
    expect(existsSync(join(state, 's5', 'events.jsonl'))).toBe(true);
    expect(existsSync(join(state, uploadOldName('zz'), 'events.jsonl'))).toBe(true);
    // 退けた場所は、消し終えたら残さない
    expect(existsSync(join(dest, SNAPSHOT_REMOVED_DIR))).toBe(false);
    // 前の集計で消し切れなかった分が退けた場所に残っていれば、消す分が無い回でも片付ける
    await session(join(dest, SNAPSHOT_REMOVED_DIR, '1', 'zz-left'));
    expect((await snapshot(proj, dest)).sessions.removed).toBeUndefined();
    expect(existsSync(join(dest, SNAPSHOT_REMOVED_DIR))).toBe(false);
  });

  it('最後のセッションを消しても(索引は残っている)、複製を消す', async () => {
    // 「1 件も読めなかったら消さない」という守りは置かない: 消すのは、前にあった場所を読み直して、無いと確かめられたものだけなので
    const base = await work();
    const people = join(base, 'people');
    const dest = join(base, 'out', 'snapshot');
    await session(join(people, 'person-a', 'proj-a', 't1'));
    await writeFile(join(people, 'person-a', 'proj-a', UPLOAD_INDEX), '{}');
    expect((await snapshot(people, dest)).sessions.dirs).toBe(1);
    await rm(join(people, 'person-a', 'proj-a', 't1'), { recursive: true });
    expect(await describeSource(people)).toEqual({ kind: 'merged', folders: ['person-a/proj-a'] });
    const m = await snapshot(people, dest);
    expect([m.sessions.dirs, m.sessions.removed, kept(m)]).toEqual([0, 1, []]);
    expect(existsSync(join(dest, 'session-state', 't1'))).toBe(false);
    expect(m.merged?.owners).toEqual({});
  });

  it('前にあった場所を読めないとき(アクセス権が無い・共有フォルダが切れた)は、複製も数えたフォルダの記録も残す', async () => {
    // 読めないフォルダの代わりに、同じ名前のファイルを置く(フォルダとして読めない)
    const base = await work();
    const root = join(base, 'logs');
    const dest = join(base, 'out', 'snapshot');
    await session(join(root, 'person-a', 'proj-a', 's1'));
    await session(join(root, 'person-b', 'proj-b', 's2'));
    await session(join(root, 'person-b', 'proj-b', 's3'));
    expect((await snapshot(root, dest)).merged?.owners).toEqual({ s1: 'person-a/proj-a', s2: 'person-b/proj-b', s3: 'person-b/proj-b' });
    const hidden = join(base, 'person-b-hidden');
    await rename(join(root, 'person-b'), hidden);
    await writeFile(join(root, 'person-b'), 'not a folder');
    const m = await snapshot(root, dest);
    expect(m.sessions.removed).toBeUndefined();
    expect(kept(m)).toEqual([
      ['s2', KEPT_UNREADABLE_REASON],
      ['s3', KEPT_UNREADABLE_REASON],
    ]);
    expect(keptFolders(m)).toEqual([
      ['s2', 'person-b/proj-b'],
      ['s3', 'person-b/proj-b'],
    ]);
    expect(await names(join(dest, 'session-state'))).toEqual(['s1', 's2', 's3']);
    // 数えたフォルダは前の集計から引き継ぐ(人ごとの内訳から外さない。次に確かめるときにも要る)
    expect(m.merged?.owners).toEqual({ s1: 'person-a/proj-a', s2: 'person-b/proj-b', s3: 'person-b/proj-b' });
    // セッションが並ぶフォルダ(プロジェクトのフォルダ)そのものを読めないときも同じ
    await rm(join(root, 'person-b'));
    await rename(hidden, join(root, 'person-b'));
    const hiddenProj = join(base, 'proj-b-hidden');
    await rename(join(root, 'person-b', 'proj-b'), hiddenProj);
    await writeFile(join(root, 'person-b', 'proj-b'), 'not a folder');
    const lower = await snapshot(root, dest);
    expect([lower.sessions.removed, kept(lower)]).toEqual([
      undefined,
      [
        ['s2', KEPT_UNREADABLE_REASON],
        ['s3', KEPT_UNREADABLE_REASON],
      ],
    ]);
    expect(await names(join(dest, 'session-state'))).toEqual(['s1', 's2', 's3']);
    // 読めるようになり、s2 だけが無くなっていた: s2 の複製だけを消す
    await rm(join(root, 'person-b', 'proj-b'));
    await rename(hiddenProj, join(root, 'person-b', 'proj-b'));
    await rm(join(root, 'person-b', 'proj-b', 's2'), { recursive: true });
    const back = await snapshot(root, dest);
    expect([back.sessions.removed, kept(back)]).toEqual([1, []]);
    expect(await names(join(dest, 'session-state'))).toEqual(['s1', 's3']);
    // 人のフォルダごと無くなった: その下のセッションの複製を消す
    await rm(join(root, 'person-b'), { recursive: true });
    const gone = await snapshot(root, dest);
    expect([gone.sessions.removed, kept(gone)]).toEqual([1, []]);
    expect(await names(join(dest, 'session-state'))).toEqual(['s1']);
  });

  it('前の集計に、どのフォルダのセッションかの記録が無い複製は消さない', async () => {
    const base = await work();
    // まとめて読む形: 前の版が写したもの・途中で止まった集計のもの
    const root = join(base, 'logs');
    const dest = join(base, 'out', 'snapshot');
    await session(join(root, 'person-a', 'proj-a', 's1'));
    await snapshot(root, dest);
    await session(join(dest, 'session-state', 'old9'));
    const m = await snapshot(root, dest);
    expect([m.sessions.removed, kept(m)]).toEqual([undefined, [['old9', KEPT_UNKNOWN_REASON]]]);
    expect(keptFolders(m)).toEqual([['old9', undefined]]);
    // 分からないフォルダは、項目ごと書かない
    expect(m.extras?.goneKept?.[0]).not.toHaveProperty('folder');
    expect(existsSync(join(dest, 'session-state', 'old9'))).toBe(true);
    // 直下にセッションが並ぶ形: 最後まで終わった集計の記録が無いうち(1 回目が途中で止まった)は消さず、記録ができた次の回に消す
    const proj = join(base, 'proj');
    const dest2 = join(base, 'out2', 'snapshot');
    await session(join(proj, 'p1'));
    await session(join(dest2, 'session-state', 'p0'));
    const first = await snapshot(proj, dest2);
    expect([first.sessions.removed, kept(first)]).toEqual([undefined, [['p0', KEPT_UNKNOWN_REASON]]]);
    const second = await snapshot(proj, dest2);
    expect([second.sessions.removed, kept(second)]).toEqual([1, []]);
    expect(await names(join(dest2, 'session-state'))).toEqual(['p1']);
  });

  it('人ごとのフォルダが並ぶ場所の直下にセッションのフォルダが紛れて形が変わっても、まだ元にあるセッションの複製は何回集計しても消さない', async () => {
    // 直下に並ぶ形の回の manifest には数えたフォルダの記録が無いので、消さなかった複製の記録として持ち越す
    const base = await work();
    const root = join(base, 'logs');
    const dest = join(base, 'out', 'snapshot');
    await session(join(root, 'person-a', 'proj-a', 's1'));
    await session(join(root, 'person-b', 'proj-b', 's2'));
    await snapshot(root, dest);
    await session(join(root, 'stray'));
    expect(await describeSource(root)).toEqual({ kind: 'flat' });
    for (const round of [1, 2, 3]) {
      const m = await snapshot(root, dest);
      expect(m.sessions.removed, `${round} 回目`).toBeUndefined();
      expect(kept(m), `${round} 回目`).toEqual([
        ['s1', KEPT_PRESENT_REASON],
        ['s2', KEPT_PRESENT_REASON],
      ]);
      expect(keptFolders(m), `${round} 回目`).toEqual([
        ['s1', 'person-a/proj-a'],
        ['s2', 'person-b/proj-b'],
      ]);
      expect(await names(join(dest, 'session-state')), `${round} 回目`).toEqual(['s1', 's2', 'stray']);
    }
    // 形が変わっている間に、元から本当に無くなったものは消す
    await rm(join(root, 'person-b', 'proj-b', 's2'), { recursive: true });
    const m = await snapshot(root, dest);
    expect([m.sessions.removed, kept(m)]).toEqual([1, [['s1', KEPT_PRESENT_REASON]]]);
    // 紛れたフォルダを除くと、元の形に戻る: 残した複製はそのまま数え、紛れたフォルダの複製は消す
    await rm(join(root, 'stray'), { recursive: true });
    const back = await snapshot(root, dest);
    expect([back.sessions.removed, kept(back)]).toEqual([1, []]);
    expect(back.merged?.owners).toEqual({ s1: 'person-a/proj-a' });
    expect(await names(join(dest, 'session-state'))).toEqual(['s1']);
  });

  it('集計できるセッションが 1 件も見つからない回は、何も消さず、複製ごとのフォルダの記録を持ち越す', async () => {
    // 次に読めたときに、無くなったものだけを消せる
    const base = await work();
    // まとめて読む形
    const root = join(base, 'logs');
    const dest = join(base, 'out', 'snapshot');
    await session(join(root, 'person-a', 'proj-a', 'a1'));
    await session(join(root, 'person-a', 'proj-a', 'a2'));
    await snapshot(root, dest);
    const away = join(base, 'person-a-away');
    await rename(join(root, 'person-a'), away);
    expect(await describeSource(root)).toEqual({ kind: 'none' });
    for (const round of [1, 2]) {
      const none = await snapshot(root, dest);
      expect(none.sessions.removed, `${round} 回目`).toBeUndefined();
      expect(kept(none), `${round} 回目`).toEqual([
        ['a1', KEPT_NO_SOURCE_REASON],
        ['a2', KEPT_NO_SOURCE_REASON],
      ]);
      expect(keptFolders(none), `${round} 回目`).toEqual([
        ['a1', 'person-a/proj-a'],
        ['a2', 'person-a/proj-a'],
      ]);
    }
    await rename(away, join(root, 'person-a'));
    await rm(join(root, 'person-a', 'proj-a', 'a2'), { recursive: true });
    const back = await snapshot(root, dest);
    expect([back.sessions.removed, kept(back)]).toEqual([1, []]);
    expect(await names(join(dest, 'session-state'))).toEqual(['a1']);
    expect(back.merged?.owners).toEqual({ a1: 'person-a/proj-a' });
    // 直下にセッションが並ぶ形
    const proj = join(base, 'proj');
    const dest2 = join(base, 'out2', 'snapshot');
    await session(join(proj, 'p1'));
    await session(join(proj, 'p2'));
    await snapshot(proj, dest2);
    const away2 = join(base, 'p-away');
    await mkdir(away2, { recursive: true });
    await rename(join(proj, 'p1'), join(away2, 'p1'));
    await rename(join(proj, 'p2'), join(away2, 'p2'));
    const none = await snapshot(proj, dest2);
    expect(keptFolders(none)).toEqual([
      ['p1', ''],
      ['p2', ''],
    ]);
    expect(await names(join(dest2, 'session-state'))).toEqual(['p1', 'p2']);
    await rename(join(away2, 'p1'), join(proj, 'p1'));
    const back2 = await snapshot(proj, dest2);
    expect([back2.sessions.removed, kept(back2)]).toEqual([1, []]);
    expect(await names(join(dest2, 'session-state'))).toEqual(['p1']);
  });

  it('消さなかった複製の記録に同じ id が 2 つあっても、先の記録の場所を確かめる', async () => {
    // atlas は書かないが、手で書き換えた manifest など
    const base = await work();
    const root = join(base, 'logs');
    const dest = join(base, 'out', 'snapshot');
    await session(join(root, 'person-a', 'proj-a', 's1'));
    await session(join(root, 'person-b', 'proj-b', 'd1'));
    await snapshot(root, dest);
    // 直下にフォルダが紛れて形が変わった回の manifest に、d1 の記録を 2 つ書く(先は今もある場所、後は無い場所)
    await session(join(root, 'stray'));
    await snapshot(root, dest);
    const file = join(dest, SNAPSHOT_MANIFEST);
    const m = JSON.parse(await readFile(file, 'utf8')) as SnapshotManifest;
    const list = m.extras!.goneKept!;
    expect(list.some((k) => k.id === 'd1' && k.folder === 'person-b/proj-b')).toBe(true);
    list.push({ id: 'd1', reason: KEPT_PRESENT_REASON, folder: 'person-a/proj-a' });
    await writeFile(file, JSON.stringify(m));
    const again = await snapshot(root, dest);
    expect(again.sessions.removed).toBeUndefined();
    expect(existsSync(join(dest, 'session-state', 'd1'))).toBe(true);
    expect(keptFolders(again)).toEqual([
      ['d1', 'person-b/proj-b'],
      ['s1', 'person-a/proj-a'],
    ]);
  });

  it('「元のルートにあった」という記録は、数えたフォルダ(merged.owners)には書かない', async () => {
    // 直下にセッションが並ぶ形だった場所が、人ごとのフォルダが並ぶ形に変わった。直下にフォルダだけが残ったセッション(中身は無い)の複製は、
    // 「元のルートにあった」という記録で持ち越す
    const base = await work();
    const root = join(base, 'logs');
    const dest = join(base, 'out', 'snapshot');
    await session(join(root, 'p8'));
    await session(join(root, 'p9'));
    expect(await describeSource(root)).toEqual({ kind: 'flat' });
    await snapshot(root, dest);
    await rm(join(root, 'p8'), { recursive: true });
    await rm(join(root, 'p9', 'events.jsonl'));
    await session(join(root, 'person-a', 'proj-a', 's1'));
    expect(await describeSource(root)).toEqual({ kind: 'merged', folders: ['person-a/proj-a'] });
    for (const round of [1, 2]) {
      const m = await snapshot(root, dest);
      expect(m.sessions.removed, `${round} 回目`).toBe(round === 1 ? 1 : undefined);
      expect(kept(m), `${round} 回目`).toEqual([['p9', KEPT_PRESENT_REASON]]);
      expect(keptFolders(m), `${round} 回目`).toEqual([['p9', '']]);
      expect(m.merged?.owners, `${round} 回目`).toEqual({ s1: 'person-a/proj-a' });
      expect(await names(join(dest, 'session-state')), `${round} 回目`).toEqual(['p9', 's1']);
    }
  });

  it.skipIf(process.platform === 'win32')('Linux・macOS では、中のファイルを開いている複製も、フォルダごと動かして消せる', async () => {
    const base = await work();
    const proj = join(base, 'proj');
    const dest = join(base, 'out', 'snapshot');
    const state = join(dest, 'session-state');
    for (const id of ['g1', 'keep']) await session(join(proj, id));
    await snapshot(proj, dest);
    await rm(join(proj, 'g1'), { recursive: true });
    const held = await open(join(state, 'g1', 'events.jsonl'), 'r');
    try {
      const m = await snapshot(proj, dest);
      expect([m.sessions.removed, kept(m)]).toEqual([1, []]);
      expect(await names(state)).toEqual(['keep']);
      // 開かれていても、退けた場所ごと消える
      expect(existsSync(join(dest, SNAPSHOT_REMOVED_DIR))).toBe(false);
    } finally {
      await held.close();
    }
  });

  it.runIf(process.platform === 'win32')('Windows で動かせない複製があっても集計は止まらず、丸ごと残して理由とフォルダを残す', async () => {
    const base = await work();
    const proj = join(base, 'proj');
    const dest = join(base, 'out', 'snapshot');
    const state = join(dest, 'session-state');
    for (const id of ['g1', 'g2', 'keep']) await session(join(proj, id));
    await snapshot(proj, dest);
    await rm(join(proj, 'g1'), { recursive: true });
    await rm(join(proj, 'g2'), { recursive: true });
    // g2 の複製のファイルを、ほかのプログラムが開いている
    const held = await open(join(state, 'g2', 'events.jsonl'), 'r');
    let m: SnapshotManifest;
    try {
      m = await snapshot(proj, dest);
    } finally {
      await held.close();
    }
    expect(existsSync(join(state, 'g1'))).toBe(false);
    // 動かせなかった複製は、丸ごと残して理由を残す(半分だけ消えた複製にしない)。動かせた環境では消えている
    if (existsSync(join(state, 'g2'))) {
      expect([m.sessions.removed, kept(m)]).toEqual([1, [['g2', KEPT_BUSY_REASON]]]);
      // 次の集計が確かめる場所(元のルート)を持ち越す
      expect(keptFolders(m)).toEqual([['g2', '']]);
      expect(existsSync(join(state, 'g2', 'events.jsonl'))).toBe(true);
    } else expect([m.sessions.removed, kept(m)]).toEqual([2, []]);
    // 開いていたプログラムが閉じた後の集計で消える
    const after = await snapshot(proj, dest);
    expect(kept(after)).toEqual([]);
    expect(await names(state)).toEqual(['keep']);
    expect(existsSync(join(dest, SNAPSHOT_REMOVED_DIR))).toBe(false);
  });

  it('~/.copilot を読むときは、元から消えたセッションの複製を残す(セッションが見つからない回も、アップロード先の決まりを掛けない)', async () => {
    // Copilot が消したログの、最後の複製かもしれない
    const base = await work();
    const home = join(base, 'home');
    const dest = join(base, 'out', 'snapshot');
    await session(join(home, 'session-state', 's1'));
    await session(join(home, 'session-state', 's2'));
    await snapshot(home, dest);
    await rm(join(home, 'session-state', 's2'), { recursive: true });
    const m = await snapshot(home, dest);
    expect([m.sessions.removed, kept(m)]).toEqual([undefined, []]);
    expect(await names(join(dest, 'session-state'))).toEqual(['s1', 's2']);
    // セッションが 1 件も見つからない回(session-state が一時的に無い)でも、記録の持ち越し・警告はしない
    await rename(join(home, 'session-state'), join(base, 'session-state-away'));
    expect(await describeSource(home)).toEqual({ kind: 'none' });
    const none = await snapshot(home, dest);
    expect([none.sessions.removed, kept(none)]).toEqual([undefined, []]);
    expect(await names(join(dest, 'session-state'))).toEqual(['s1', 's2']);
  });

  it('アップロード先として読んでいた場所が ~/.copilot の形として読まれた回は、「見つからなかった」という記録を複製に付けない', async () => {
    // 直下に session-state ができた。セッションが見つかっているので
    const base = await work();
    const proj = join(base, 'proj');
    const dest = join(base, 'out', 'snapshot');
    await session(join(proj, 'p1'));
    expect((await snapshot(proj, dest)).layout).toBe('flat');
    await session(join(proj, 'session-state', 'c1'));
    expect(await describeSource(proj)).toEqual({ kind: 'copilot' });
    const m = await snapshot(proj, dest);
    expect([m.layout, m.sessions.removed, kept(m)]).toEqual(['copilot', undefined, []]);
    expect(await names(join(dest, 'session-state'))).toEqual(['c1', 'p1']);
  });
});

describe('消さなかった複製の警告(extract)', () => {
  it('今回は元から読まなかったのに複製を消さなかったセッションは、前に写した複製で数えていることを、理由ごとに警告に出す', async () => {
    const base = await work();
    const snap = join(base, 'snap');
    for (const id of ['g1', 'g2', 'g3']) await session(join(snap, 'session-state', id));
    const manifest = (extras: Record<string, unknown> | undefined): Promise<void> =>
      writeFile(
        join(snap, SNAPSHOT_MANIFEST),
        JSON.stringify({
          createdAt: '2026-07-02T09:00:00.000Z',
          sourceRoot: join(base, 'src'),
          layout: 'flat',
          since: null,
          databases: {},
          sessions: { dirs: 3, copiedFiles: 3, reusedFiles: 0, skippedBySince: 0, bytes: 0 },
          ...(extras ? { extras } : {}),
        }),
      );
    await manifest({
      all: false,
      sessionFiles: 0,
      sessionBytes: 0,
      topLevel: {},
      skipped: [],
      desktop: null,
      leftover: [],
      goneKept: [
        { id: 'g2', reason: KEPT_BUSY_REASON },
        { id: 'g3', reason: KEPT_UNREADABLE_REASON },
        { id: 'not-copied', reason: KEPT_UNKNOWN_REASON },
      ],
    });
    const s = await extract(snap, { projects: false });
    expect(s.sessions).toHaveLength(3);
    const about = s.warnings.messages.filter((x) => x.includes('今回は元から読まなかったセッション'));
    // 複製が無いもの(not-copied)は数えていないので出さない。並びは理由の順(KEPT_REASONS)
    expect(about, s.warnings.messages.join('\n')).toHaveLength(2);
    expect(about[0]).toContain('1 件');
    expect(about[0]).toContain(KEPT_UNREADABLE_REASON);
    expect(about[0]).toContain('g3');
    expect(about[1]).toContain('1 件');
    expect(about[1]).toContain(KEPT_BUSY_REASON);
    expect(about[1]).toContain('g2');
    // 消さなかったものが無ければ出さない
    await manifest(undefined);
    expect((await extract(snap, { projects: false })).warnings.messages.every((x) => !x.includes('今回は元から読まなかった'))).toBe(true);
  });
});
