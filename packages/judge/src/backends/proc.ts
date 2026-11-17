// 子プロセスの起動。シェルを経由しない(プロンプトに改行・引用符・% などが入るため)。
// Windows の npm シム(copilot.cmd 等)は中身を読んで node + JS / .exe を直接起動する。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';

export interface ResolvedCommand {
  command: string;
  /** 本来の引数の前に付ける引数(node でスクリプトを起動する場合のスクリプトパス) */
  prefix: string[];
  /** 表示用 */
  display: string;
}

const SCRIPT_EXT = new Set(['.js', '.mjs', '.cjs']);

function fromFile(p: string): ResolvedCommand | null {
  const ext = extname(p).toLowerCase();
  if (SCRIPT_EXT.has(ext)) return { command: process.execPath, prefix: [p], display: `node ${p}` };
  if (ext === '.cmd' || ext === '.bat') {
    // npm のシム: "%dp0%\node_modules\...\xxx.js" %* または "%dp0%\...\xxx.exe" %*
    const text = readFileSync(p, 'utf8');
    const m = /"%dp0%\\([^"]+\.(?:js|mjs|cjs|exe))"\s+%\*/i.exec(text);
    if (!m) throw new Error(`${p} の起動先を読み取れません(npm のシム形式ではありません)。実行ファイルか .js のパスを直接指定してください。`);
    // シム内のパスは \ 区切り。POSIX でも解決できるように分割してから結合する
    const target = join(dirname(p), ...m[1].split('\\'));
    if (!existsSync(target)) throw new Error(`${p} の起動先 ${target} がありません`);
    return fromFile(target);
  }
  return { command: p, prefix: [], display: p };
}

/** 実行ファイルを解決する。パス指定ならそれを、名前なら PATH から探す */
export function resolveCommand(bin: string): ResolvedCommand {
  const looksLikePath = isAbsolute(bin) || bin.includes('/') || bin.includes('\\');
  if (looksLikePath) {
    const p = resolve(bin);
    if (!existsSync(p)) throw new Error(`実行ファイルが見つかりません: ${p}`);
    return fromFile(p)!;
  }
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = join(d, bin + e);
      if (existsSync(p) && (process.platform !== 'win32' || e !== '')) return fromFile(p)!;
    }
  }
  throw new Error(`${bin} が PATH に見つかりません(インストールするか、実行ファイルのパスを指定してください)`);
}

/** Windows の CreateProcess のコマンドライン上限(UTF-16 で 32,767)に余裕を見た値 */
export const MAX_COMMAND_LINE = 32_000;

export function commandLineLength(cmd: ResolvedCommand, args: string[]): number {
  return [cmd.command, ...cmd.prefix, ...args].reduce((a, s) => a + s.length + 3 + (s.match(/"/g)?.length ?? 0), 0);
}

export interface ProcResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runProcess(cmd: ResolvedCommand, args: string[], o: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; input?: string }): Promise<ProcResult> {
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd.command, [...cmd.prefix, ...args], { cwd: o.cwd, env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, o.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${cmd.display} を起動できません: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveP({ code, signal, stdout, stderr, timedOut });
    });
    child.stdin.end(o.input ?? '');
  });
}

export function tail(s: string, n = 600): string {
  const t = s.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}
