// 自動で送る前に atlas を新しい版にして、新しいコードで動かし直す流れ(upload-auto.ts の runUpdateFlow)と、
// atlas の処理が動いているかの判定・この PC で動かなかった版の覚え方。動かし直す口は偽物に替える
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOB_LOCK_FILE } from '../src/jobs.ts';
import { SERVE_STATE_FILE } from '../src/serve.ts';
import { atlasRunning, readAvoid, runUpdateFlow, writeAvoid, type UpdateFlowDeps } from '../src/upload-auto.ts';
import { JOB_LOCK_NAME, NO_UPDATE_FLAG, PARENT_ENV, SERVE_STATE_NAME, UPDATED_ENV, type AutoStatusFile, type AutoUpdateResult } from '../src/upload-auto-files.ts';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-auto-update-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const STARTED = '2026-11-13T09:00:00.000Z';
const UPDATED: AutoUpdateResult = { outcome: 'updated', from: 'aaaaaaa', to: 'bbbbbbb', fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40), note: 'aaaaaaa から bbbbbbb に更新しました' };
const finished = (o: Partial<AutoStatusFile> = {}): AutoStatusFile => ({
  startedAt: '2026-11-13T09:00:05.000Z',
  finishedAt: '2026-11-13T09:01:00.000Z',
  ok: true,
  error: null,
  sent: [],
  secrets: 0,
  root: null,
  ...o,
});

/** 偽の口。relaunches は動かし直したときの環境変数、children は動かし直した側が書く結果(null なら何も書かずに落ちる) */
function flow(o: { update?: AutoUpdateResult; children?: (AutoStatusFile | null)[]; rollbackOk?: boolean; env?: Record<string, string>; argv?: string[] } = {}) {
  const logs: string[] = [];
  const relaunches: Record<string, string>[] = [];
  const written: AutoStatusFile[] = [];
  const notes: string[] = [];
  const avoided: string[] = [];
  const rolledBack: string[] = [];
  let status: AutoStatusFile | null = finished({ startedAt: '2026-11-12T09:00:00.000Z' }); // 前の回の結果
  const children = [...(o.children ?? [])];
  const d: UpdateFlowDeps = {
    env: o.env ?? {},
    argv: o.argv ?? ['node', 'upload-auto.ts'],
    log: (l) => logs.push(l),
    startedAt: STARTED,
    update: () => o.update ?? UPDATED,
    relaunch: (env) => {
      relaunches.push(env);
      const next = children.shift();
      if (next) status = next;
      return next ? { code: next.ok ? 0 : 1, stderr: '' } : { code: 1, stderr: 'SyntaxError: 新しい版が読めない\n    at 1:1' };
    },
    readStatus: () => status,
    writeStatus: (s) => {
      written.push(s);
      status = s;
    },
    rollback: (sha) => (rolledBack.push(sha), o.rollbackOk === false ? { ok: false, note: '前の版(aaaaaaa)に戻せませんでした(x)' } : { ok: true, note: '前の版(aaaaaaa)に戻しました' }),
    avoid: (sha) => avoided.push(sha),
    notify: async (title, body) => void notes.push(`${title}|${body}`),
    now: () => new Date('2026-11-13T09:02:00.000Z'),
  };
  return { d, logs, relaunches, written, notes, avoided, rolledBack };
}

describe('runUpdateFlow: 新しい版にして動かし直す', () => {
  it('動かし直した側は更新せず、渡された結果を使う。--no-update なら更新しない', async () => {
    const a = flow({ env: { [UPDATED_ENV]: JSON.stringify(UPDATED) } });
    expect(await runUpdateFlow(a.d)).toEqual({ update: UPDATED, exitCode: null });
    expect(a.relaunches).toEqual([]);
    const b = flow({ argv: ['node', 'upload-auto.ts', NO_UPDATE_FLAG] });
    expect(await runUpdateFlow(b.d)).toEqual({ update: null, exitCode: null });
    expect(b.logs.join('\n')).toContain('しない設定です');
  });

  it('新しい版にならなければ、動かし直さずにこのまま送る', async () => {
    const latest: AutoUpdateResult = { outcome: 'latest', from: 'aaaaaaa', to: 'aaaaaaa', note: '最新です(aaaaaaa)' };
    const a = flow({ update: latest });
    expect(await runUpdateFlow(a.d)).toEqual({ update: latest, exitCode: null });
    expect(a.relaunches).toEqual([]);
  });

  it('新しい版にしたら、新しいコードで動かし直し、その終了コードを返す(更新の結果と、呼び出し元のプロセスを渡す)', async () => {
    const a = flow({ children: [finished()] });
    expect(await runUpdateFlow(a.d)).toEqual({ update: UPDATED, exitCode: 0 });
    expect(a.relaunches).toHaveLength(1);
    expect(JSON.parse(a.relaunches[0]![UPDATED_ENV]!)).toEqual(UPDATED);
    expect(a.relaunches[0]![PARENT_ENV]).toBe(String(process.pid));
    expect(a.avoided).toEqual([]);
    expect(a.written).toEqual([]);
  });

  it('動かし直した側が結果を残さずに落ちたら、その版を覚えて前の版に戻し、前の版で動かし直して送る', async () => {
    const a = flow({ children: [null, finished()] });
    const r = await runUpdateFlow(a.d);
    expect(r.exitCode).toBe(0);
    expect(r.update).toMatchObject({ outcome: 'failed', from: 'aaaaaaa', to: 'aaaaaaa', toSha: UPDATED.fromSha });
    expect(r.update!.note).toMatch(/新しい版\(bbbbbbb\)はこの PC で動かなかったので、前の版\(aaaaaaa\)に戻しました。前の版で送ります/);
    expect(a.avoided).toEqual([UPDATED.toSha]);
    expect(a.rolledBack).toEqual([UPDATED.fromSha]);
    expect(a.relaunches).toHaveLength(2);
    expect(JSON.parse(a.relaunches[1]![UPDATED_ENV]!)).toMatchObject({ outcome: 'failed', toSha: UPDATED.fromSha });
    // 落ちた側のエラー出力は記録に残す
    expect(a.logs.join('\n')).toContain('結果を残さずに終わりました(終了コード 1)');
    expect(a.logs.join('\n')).toContain('SyntaxError: 新しい版が読めない');
    expect(a.notes).toEqual([]);
  });

  it('前の版に戻せない・前の版でも結果が残らないときは、送れなかったことを結果に書いて知らせる(前の回の結果のままにしない)', async () => {
    const a = flow({ children: [null], rollbackOk: false });
    expect(await runUpdateFlow(a.d)).toMatchObject({ exitCode: 1, update: { outcome: 'failed' } });
    expect(a.written).toHaveLength(1);
    expect(a.written[0]).toMatchObject({ startedAt: STARTED, ok: false, finishedAt: '2026-11-13T09:02:00.000Z' });
    expect(a.written[0]!.error).toMatch(/動かなかったので前の版に戻そうとしましたが、前の版\(aaaaaaa\)に戻せませんでした/);
    expect(a.notes).toHaveLength(1);
    expect(a.relaunches).toHaveLength(1);

    const b = flow({ children: [null, null] });
    expect(await runUpdateFlow(b.d)).toMatchObject({ exitCode: 1 });
    expect(b.written[0]!.error).toMatch(/前の版でも動かせませんでした/);
    expect(b.notes).toHaveLength(1);
  });

  it('動かし直した側が途中で落ちた(始めたが終わっていない)ときも、結果が残らなかったものとして前の版で送る', async () => {
    const a = flow({ children: [finished({ finishedAt: null }), finished()] });
    expect(await runUpdateFlow(a.d)).toMatchObject({ exitCode: 0, update: { outcome: 'failed' } });
    expect(a.rolledBack).toHaveLength(1);
  });
});

describe('atlas の処理が動いているか・動かなかった版', () => {
  it('印のファイルの名前は、jobs.ts と serve.ts のものと同じ', () => {
    expect(JOB_LOCK_NAME).toBe(JOB_LOCK_FILE);
    expect(SERVE_STATE_NAME).toBe(SERVE_STATE_FILE);
  });

  it('いつもの出力先と、別のフォルダを開いた出力先の、集計の印とサーバの印を見る。プロセスが無い印・自分の印は動いていないとみなす', () => {
    const out = join(dir, 'out');
    mkdirSync(out);
    expect(atlasRunning(out)).toBeNull();
    // 動いているプロセス(このテストを動かしている親)
    const live = process.ppid;
    writeFileSync(join(out, JOB_LOCK_NAME), JSON.stringify({ pid: process.pid }));
    expect(atlasRunning(out)).toBeNull();
    writeFileSync(join(out, JOB_LOCK_NAME), JSON.stringify({ pid: 2_147_483_000 }));
    expect(atlasRunning(out)).toBeNull();
    writeFileSync(join(out, SERVE_STATE_NAME), JSON.stringify({ port: 1, pid: live }));
    expect(atlasRunning(out)).toMatch(/^画面のサーバ。/);
    rmSync(join(out, SERVE_STATE_NAME));
    const opened = join(`${out}-folders`, 'logs-12345678', 'out');
    mkdirSync(opened, { recursive: true });
    writeFileSync(join(opened, JOB_LOCK_NAME), JSON.stringify({ pid: live, kind: 'all' }));
    expect(atlasRunning(out)).toBe(`集計など。${opened}`);
  });

  it('動かなかった版を覚えて読み出す。無い・壊れているときは null', () => {
    expect(readAvoid(dir)).toBeNull();
    writeAvoid(dir, 'b'.repeat(40), '動かなかった');
    expect(readAvoid(dir)).toBe('b'.repeat(40));
    writeFileSync(join(dir, 'auto-update.json'), '{"avoid":');
    expect(readAvoid(dir)).toBeNull();
  });
});
