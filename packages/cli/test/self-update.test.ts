// 自動で送る前に atlas 自身を新しい版にする(self-update.ts)。一時フォルダに本物の git のリポジトリ(送り元の origin と、
// 作る人のチェックアウトと、作業メンバーのチェックアウト)を作って確かめる。npm install は偽物に替える
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { selfUpdate, type UpdateOptions } from '../src/self-update.ts';

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

  it('依存が変わっていれば入れる。入れられなければ前の版に戻す', () => {
    const before = head(member);
    release('package-lock.json', '{"v":2}');
    const ok = update({ depsFresh: () => false });
    expect(ok.r.outcome).toBe('updated');
    expect(ok.installs).toBe(1);

    const mid = head(member);
    release('package-lock.json', '{"v":3}');
    const ng = update({ depsFresh: () => false, installDeps: () => false });
    expect(ng.r).toMatchObject({ outcome: 'failed', from: mid.slice(0, 7), to: mid.slice(0, 7) });
    expect(ng.r.note).toMatch(/依存を入れられなかったので、前の版.*に戻して送ります/);
    expect(head(member)).toBe(mid);
    expect(git(member, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(before).not.toBe(mid);
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

  it('git を動かせなければ、何もしない', () => {
    const { r } = update({ run: () => ({ code: -1, stdout: '', stderr: 'spawn git ENOENT' }) });
    expect(r.outcome).toBe('skipped');
    expect(r.note).toMatch(/git を使えない.*ENOENT/);
  });
});
