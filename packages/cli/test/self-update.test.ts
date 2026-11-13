// 自動で送る前に atlas 自身を新しい版にする(self-update.ts)。一時フォルダに本物の git のリポジトリ(送り元の origin と、
// 作る人のチェックアウトと、作業メンバーのチェックアウト)を作って確かめる。npm install は偽物に替える
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rollback, runCmd, selfUpdate, type CmdRunner, type UpdateOptions } from '../src/self-update.ts';

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
