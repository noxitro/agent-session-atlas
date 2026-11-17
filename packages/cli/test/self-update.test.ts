// 自動で送る前に atlas 自身を新しい版にする(self-update.ts)。一時フォルダに本物の git のリポジトリ(送り元の origin と、
// 作る人のチェックアウトと、作業メンバーのチェックアウト)を作って確かめる。npm install は偽物に替える
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exitCode, LAUNCHER_FETCH_TIMEOUT_MS, launcherUpdate, UPDATED_EXIT, type LauncherUpdateOptions } from '../src/launcher-update.ts';
import { rollback, runCmd, selfUpdate, type CmdRunner, type UpdateOptions } from '../src/self-update.ts';
import { AUTO_UPDATE_STATE_FILE, SERVE_STATE_NAME } from '../src/upload-auto-files.ts';

// 1 つのテストと準備で、本物の git(clone・commit・push)を何度も動かす。Windows の CI では既定の待ち時間
// (テスト 5 秒・準備 10 秒)を超えることがあるので、このファイルだけ延ばす
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let base = '';
/** 作る人のチェックアウト(新しい版を origin に送る) */
let dev = '';
/** 作業メンバーのチェックアウト(自動で送るタスクが動く) */
let member = '';
const saved: Record<string, string | undefined> = {};

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const head = (cwd: string): string => git(cwd, 'rev-parse', 'HEAD');
/** 作る人が新しい版を作って origin に送る */
function release(file = 'a.txt', text = `${Date.now()}-${Math.random()}`): string {
  writeFileSync(join(dev, file), text);
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', `update ${file}`);
  git(dev, 'push', '-q', 'origin', 'main');
  return head(dev);
}

beforeAll(() => {
  // この PC の git の設定(フックや署名など)を使わない
  for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) saved[k] = process.env[k];
  const cfgDir = mkdtempSync(join(tmpdir(), 'atlas-selfupdate-cfg-'));
  writeFileSync(join(cfgDir, 'gitconfig'), '');
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: join(cfgDir, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  });
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'atlas-selfupdate-'));
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  dev = join(base, 'dev');
  git(base, 'clone', '-q', origin, dev);
  git(dev, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(dev, 'a.txt'), 'first');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'first');
  git(dev, 'push', '-q', '-u', 'origin', 'main');
  member = join(base, 'member');
  git(base, 'clone', '-q', origin, member);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function update(extra: Partial<UpdateOptions> = {}): { r: ReturnType<typeof selfUpdate>; logs: string[]; installs: number } {
  const logs: string[] = [];
  let installs = 0;
  const r = selfUpdate({
    repo: member,
    log: (l) => logs.push(l),
    depsFresh: () => true,
    installDeps: () => {
      installs++;
      return true;
    },
    ...extra,
  });
  return { r, logs, installs };
}

describe('selfUpdate: 新しい版にする', () => {
  it('origin に新しい版があれば早送りで取り込む。もう最新なら何もしない', () => {
    const before = head(member);
    expect(update().r).toMatchObject({ outcome: 'latest', from: before.slice(0, 7), to: before.slice(0, 7) });
    const next = release();
    const { r, logs } = update();
    expect(r).toMatchObject({ outcome: 'updated', from: before.slice(0, 7), to: next.slice(0, 7) });
    expect(head(member)).toBe(next);
    expect(logs.join('\n')).toContain(`${before.slice(0, 7)} から ${next.slice(0, 7)} に更新しました`);
  });

  it('git が管理していないファイル(out/ や設定ファイルなど)があっても、新しい版にする', () => {
    writeFileSync(join(member, 'atlas.config.json'), '{}');
    const next = release();
    expect(update().r.outcome).toBe('updated');
    expect(head(member)).toBe(next);
  });

  it('依存が変わっていれば入れる。入れられなければ前の版に戻し、前の版の依存を入れ直す', () => {
    release('package-lock.json', '{"v":2}');
    const ok = update({ depsFresh: () => false });
    expect(ok.r.outcome).toBe('updated');
    expect(ok.installs).toBe(1);

    const mid = head(member);
    release('package-lock.json', '{"v":3}');
    // 新しい版の依存は入れられない。前の版に戻した後は、前の版の依存を入れ直せる
    let installs = 0;
    const ng = update({ depsFresh: () => false, installDeps: () => ++installs > 1 });
    expect(ng.r).toMatchObject({ outcome: 'failed', from: mid.slice(0, 7), to: mid.slice(0, 7), fromSha: mid });
    expect(ng.r.note).toMatch(/依存を入れられなかったので、前の版\(.{7}\)に戻し、依存も入れ直しました。今の版のまま送ります/);
    expect(installs).toBe(2);
    expect(head(member)).toBe(mid);
    expect(git(member, 'status', '--porcelain', '--untracked-files=no')).toBe('');

    // 前の版の依存も入れ直せないときは、そう書く(コードは前の版に戻っている)
    const worse = update({ depsFresh: () => false, installDeps: () => false });
    expect(worse.r).toMatchObject({ outcome: 'failed', to: mid.slice(0, 7) });
    expect(worse.r.note).toMatch(/依存を入れ直せませんでした。atlas\.bat を開くと入れ直します/);
    expect(head(member)).toBe(mid);
  });

  it('依存は npm ci で入れる(package-lock.json を書き換えない)', () => {
    release('package-lock.json', '{"v":2}');
    const calls: string[] = [];
    const run: CmdRunner = (cmd, args, o) => {
      if (cmd === 'git') return runCmd(cmd, args, o);
      calls.push([cmd, ...args].join(' '));
      return { code: 0, stdout: '', stderr: '' };
    };
    const { r } = update({ run, depsFresh: () => false, installDeps: undefined });
    expect(r.outcome).toBe('updated');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/npm ci --no-audit --no-fund/);
  });

  it('npm が書き換えた package-lock.json だけが変わっているときは、元に戻してから新しい版にする', () => {
    writeFileSync(join(member, 'package-lock.json'), '{"lock":1}');
    git(member, 'add', '-A');
    git(member, 'commit', '-q', '-m', 'lock');
    git(member, 'push', '-q', 'origin', 'HEAD:main');
    git(dev, 'pull', '-q', 'origin', 'main');
    writeFileSync(join(member, 'package-lock.json'), '{"lock":1,"rewritten":true}');
    const next = release();
    const { r, logs } = update();
    expect(r.outcome).toBe('updated');
    expect(head(member)).toBe(next);
    expect(logs.join('\n')).toContain('npm が書き換えた package-lock.json を元に戻しました');
    expect(git(member, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    // ほかのファイルも変わっていれば、手で変えたものとして何もしない
    writeFileSync(join(member, 'package-lock.json'), '{"lock":1,"rewritten":2}');
    writeFileSync(join(member, 'a.txt'), 'local edit');
    release('b.txt');
    expect(update().r.note).toMatch(/手で変えている/);
  });

  it('前にこの PC で動かなかった版は使わない。もっと新しい版が出たら、それにする', () => {
    const before = head(member);
    const bad = release();
    const skipped = update({ avoid: bad });
    expect(skipped.r.outcome).toBe('skipped');
    expect(skipped.r.note).toMatch(/前にこの PC で動かなかったので、使いません/);
    expect(head(member)).toBe(before);
    const good = release();
    expect(update({ avoid: bad }).r).toMatchObject({ outcome: 'updated', toSha: good });
  });

  it('rollback: 前の版に戻し、依存が揃っていなければ入れ直す', () => {
    const before = head(member);
    release();
    expect(update().r.outcome).toBe('updated');
    let installs = 0;
    const r = rollback({ repo: member, log: () => {}, depsFresh: () => false, installDeps: () => (installs++, true) }, before);
    expect(r).toMatchObject({ ok: true, reverted: true });
    expect(installs).toBe(1);
    expect(head(member)).toBe(before);
  });
});

describe('selfUpdate: 手で触っているチェックアウトは変えない', () => {
  it('git が管理しているファイルを変えていれば、新しい版にしない', () => {
    const before = head(member);
    release();
    writeFileSync(join(member, 'a.txt'), 'local edit');
    const { r } = update();
    expect(r.outcome).toBe('skipped');
    expect(r.note).toMatch(/手で変えている/);
    expect(head(member)).toBe(before);
  });

  it('main 以外のブランチなら、新しい版にしない', () => {
    git(member, 'checkout', '-q', '-b', 'feature');
    const before = head(member);
    release();
    const { r } = update();
    expect(r.outcome).toBe('skipped');
    expect(r.note).toContain('origin/main を追っていないブランチ(feature)');
    expect(r.note).toContain('git switch main で戻すと');
    expect(head(member)).toBe(before);
  });

  it('手元にだけあるコミットがあれば(早送りできなければ)、新しい版にしない', () => {
    writeFileSync(join(member, 'b.txt'), 'local commit');
    git(member, 'add', '-A');
    git(member, 'commit', '-q', '-m', 'local');
    const before = head(member);
    release();
    const { r } = update();
    expect(r.outcome).toBe('skipped');
    expect(r.note).toMatch(/早送りだけでは/);
    expect(head(member)).toBe(before);
  });

  it('origin の履歴が書き換えられた(force push)だけなら、新しい main に合わせ直す。手元にだけあるコミットがあれば、何もしない', () => {
    // 作業メンバーは、前に取りに行った main のまま
    release();
    expect(update().r.outcome).toBe('updated');
    const before = head(member);
    // 作る人が、main の履歴を書き換えて送り直す(同じ親の上に、別のコミット)
    writeFileSync(join(dev, 'a.txt'), 'rewritten');
    git(dev, 'add', '-A');
    git(dev, 'commit', '-q', '--amend', '-m', 'rewritten');
    git(dev, 'push', '-q', '--force', 'origin', 'main');
    const rewritten = head(dev);
    const { r, logs } = update();
    expect(r).toMatchObject({ outcome: 'updated', fromSha: before, toSha: rewritten });
    expect(r.note).toContain('履歴が書き換えられていたので、新しい origin/main に合わせました');
    expect(logs.join('\n')).toContain('履歴が書き換えられていたので');
    expect(head(member)).toBe(rewritten);
    expect(git(member, 'status', '--porcelain', '--untracked-files=no')).toBe('');

    // 手元にだけあるコミットがあるときに書き換えられたら、合わせ直さない(手元のコミットを消さない)
    writeFileSync(join(member, 'b.txt'), 'local commit');
    git(member, 'add', '-A');
    git(member, 'commit', '-q', '-m', 'local');
    const local = head(member);
    writeFileSync(join(dev, 'a.txt'), 'rewritten again');
    git(dev, 'add', '-A');
    git(dev, 'commit', '-q', '--amend', '-m', 'rewritten again');
    git(dev, 'push', '-q', '--force', 'origin', 'main');
    const kept = update();
    expect(kept.r.outcome).toBe('skipped');
    expect(kept.r.note).toMatch(/早送りだけでは/);
    expect(head(member)).toBe(local);
  });

  it('origin に届かなければ、今の版のまま(送るのは止めない)', () => {
    const before = head(member);
    git(member, 'remote', 'set-url', 'origin', join(base, 'no-such-origin.git'));
    const { r } = update();
    expect(r.outcome).toBe('failed');
    expect(r.note).toMatch(/取りに行けなかったので、今の版のまま送ります/);
    expect(head(member)).toBe(before);
  });

  it('git で取得したフォルダでなければ、何もしない', () => {
    const plain = mkdtempSync(join(base, 'plain-'));
    const { r } = update({ repo: plain });
    expect(r).toMatchObject({ outcome: 'skipped', from: null, to: null });
    expect(r.note).toMatch(/git で取得したフォルダではない/);
  });

  it('atlas の処理がこのチェックアウトで動いていれば、今回は更新しない(取りに行きもしない)', () => {
    const before = head(member);
    release();
    const seen: string[] = [];
    const run: CmdRunner = (cmd, args, o) => (seen.push(args[0] ?? ''), runCmd(cmd, args, o));
    const { r } = update({ run, busy: () => '画面のサーバ。X:\\out' });
    expect(r.outcome).toBe('skipped');
    expect(r.note).toMatch(/atlas が動いている\(画面のサーバ/);
    expect(seen).not.toContain('fetch');
    expect(head(member)).toBe(before);
  });

  it('git を動かせなければ、何もしない', () => {
    const { r } = update({ run: () => ({ code: -1, stdout: '', stderr: 'spawn git ENOENT' }) });
    expect(r.outcome).toBe('skipped');
    expect(r.note).toMatch(/git を使えない.*ENOENT/);
  });
});

// 起動用の .bat が開くたびに動かす更新(launcher-update.ts)。自動で送るタスクと同じ確かめで、出し方・終了コード・待つ長さだけが違う
describe('launcherUpdate: 起動用の .bat を開いたときの更新', () => {
  function open(extra: Partial<LauncherUpdateOptions> = {}): { code: number; logs: string[] } {
    const logs: string[] = [];
    const code = launcherUpdate({
      repo: member,
      // 出力先は ATLAS_OUT が無ければ <リポジトリ>/out(git は管理していないので、手で変えたとはみなさない)
      env: {},
      log: (l) => logs.push(l),
      depsFresh: () => true,
      installDeps: () => true,
      ...extra,
    });
    return { code, logs };
  }

  it('最新なら何も出さずに 0 で終わる', () => {
    expect(open()).toEqual({ code: 0, logs: [] });
  });

  it('新しい版にしたら、したことを出して 10 で終わる(.bat が自分を動かし直す)', () => {
    const before = head(member);
    const next = release();
    const { code, logs } = open();
    expect(code).toBe(UPDATED_EXIT);
    expect(head(member)).toBe(next);
    expect(logs.at(-1)).toBe(`atlas の更新: ${before.slice(0, 7)} から ${next.slice(0, 7)} に更新しました`);
    // 動かし直した後は最新なので、何も出さない
    expect(open()).toEqual({ code: 0, logs: [] });
  });

  it('取りに行けなければ、開く側の言い方で 1 行だけ出して 0 で終わる', () => {
    git(member, 'remote', 'set-url', 'origin', join(base, 'no-such-origin.git'));
    const { code, logs } = open();
    expect(code).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^atlas の更新: 新しい版を取りに行けなかったので、今の版のまま開きます\(/);
  });

  it('しなかったとき(main を追っていないブランチ)は理由を 1 行で出して 0 で終わる', () => {
    git(member, 'checkout', '-q', '-b', 'feature');
    release();
    const { code, logs } = open();
    expect(code).toBe(0);
    expect(logs).toEqual(['atlas の更新: origin/main を追っていないブランチ(feature)なので、更新しません(git switch main で戻すと、次の回から新しい版にします)']);
  });

  it('新しい版の依存を入れられず前の版に戻したら、コミットは変わらないので 0。開く側の言い方で知らせる', () => {
    const before = head(member);
    release('package-lock.json', '{"v":2}');
    let installs = 0;
    const { code, logs } = open({ depsFresh: () => false, installDeps: () => ++installs > 1 });
    expect(code).toBe(0);
    expect(head(member)).toBe(before);
    expect(logs.at(-1)).toMatch(/依存を入れられなかったので、前の版\(.{7}\)に戻し、依存も入れ直しました。今の版のまま開きます\(次の回にもう一度試します\)$/);
  });

  it('git fetch は 20 秒まで待つ(自動で送るタスクは 2 分)', () => {
    const fetches: number[] = [];
    const run: CmdRunner = (cmd, args, o) => {
      if (args[0] === 'fetch') fetches.push(o.timeoutMs);
      return runCmd(cmd, args, o);
    };
    open({ run });
    expect(fetches).toEqual([LAUNCHER_FETCH_TIMEOUT_MS]);
    expect(LAUNCHER_FETCH_TIMEOUT_MS).toBe(20_000);
    fetches.length = 0;
    update({ run });
    expect(fetches).toEqual([2 * 60_000]);
  });

  it('atlas がこのチェックアウトで動いていれば(出力先の印のプロセスが生きていれば)、取りに行かずに 0 で終わる。出力先は ATLAS_OUT', () => {
    const before = head(member);
    release();
    const out = join(base, 'elsewhere-out');
    mkdirSync(out, { recursive: true });
    // 生きているプロセス(このテストを動かしている親)の印
    writeFileSync(join(out, SERVE_STATE_NAME), JSON.stringify({ port: 1, pid: process.ppid }));
    const seen: string[] = [];
    const run: CmdRunner = (cmd, args, o) => (seen.push(args[0] ?? ''), runCmd(cmd, args, o));
    const { code, logs } = open({ run, env: { ATLAS_OUT: out } });
    expect(code).toBe(0);
    expect(logs).toEqual([`atlas の更新: atlas が動いている(画面のサーバ。${out})ので、今回は更新しません(次の回に新しい版にします)`]);
    expect(seen).not.toContain('fetch');
    expect(head(member)).toBe(before);
    // ATLAS_OUT が無ければ <リポジトリ>/out を見るので、そちらに印が無ければ更新する
    expect(open().code).toBe(UPDATED_EXIT);
  });

  it('前にこの PC で動かなかった版(<リポジトリ>/out の auto-update.json)は使わない', () => {
    const before = head(member);
    const bad = release();
    mkdirSync(join(member, 'out'), { recursive: true });
    writeFileSync(join(member, 'out', AUTO_UPDATE_STATE_FILE), JSON.stringify({ avoid: bad }));
    const { code, logs } = open();
    expect(code).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/前にこの PC で動かなかったので、使いません/);
    expect(head(member)).toBe(before);
  });

  it('ATLAS_NO_AUTO_UPDATE=1 なら、git も動かさずに 0 で終わる', () => {
    release();
    const seen: string[] = [];
    const run: CmdRunner = (cmd, args, o) => (seen.push(cmd), runCmd(cmd, args, o));
    expect(open({ run, env: { ATLAS_NO_AUTO_UPDATE: '1' } })).toEqual({ code: 0, logs: [] });
    expect(seen).toEqual([]);
  });

  it('git で取得したフォルダでなければ、理由を 1 行出して 0 で終わる', () => {
    const plain = mkdtempSync(join(base, 'plain-'));
    const { code, logs } = open({ repo: plain });
    expect(code).toBe(0);
    expect(logs).toEqual(['atlas の更新: git で取得したフォルダではないので、更新しません(git clone し直すと、自動で新しい版にできます)']);
  });

  it('終了コードは、コミットが変わったときだけ 10', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    expect(exitCode(a, b)).toBe(UPDATED_EXIT);
    expect(exitCode(a, a)).toBe(0);
    expect(exitCode(null, a)).toBe(0);
    expect(exitCode(a, null)).toBe(0);
    expect(exitCode(undefined, undefined)).toBe(0);
  });
});
