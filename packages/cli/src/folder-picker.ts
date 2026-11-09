// フォルダを選ぶダイアログ(Windows の「フォルダーの参照」)と、エクスプローラーで開く操作。atlas serve の画面から使う。
// ブラウザからはフォルダのフルパスを取れないので、サーバ(利用者自身の PC の 127.0.0.1)が PowerShell でダイアログを出す。
import { spawn } from 'node:child_process';

/** Windows 以外ではダイアログを出せない(画面ではパスを入力してもらう) */
export const CAN_PICK_FOLDER = process.platform === 'win32';

/** ダイアログを最前面に出す(ブラウザの後ろに隠れないよう、最前面の見えない窓を親にする)。選んだパスを UTF-8 で 1 行返す */
const PICK_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = $env:ATLAS_PICK_TITLE
$d.ShowNewFolderButton = $true
if ($env:ATLAS_PICK_INITIAL -and (Test-Path -LiteralPath $env:ATLAS_PICK_INITIAL)) { $d.SelectedPath = $env:ATLAS_PICK_INITIAL }
$r = $d.ShowDialog($owner)
$owner.Dispose()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
`;

/**
 * フォルダを選んでもらう。取り消したら null。initial があればそこを開いた状態で出す。
 * PowerShell 7(pwsh)があればそちらで出す(.NET の新しい版では、アドレス欄に \\server\share なども貼れる新しい形のダイアログになる)。
 * 無ければ Windows に入っている PowerShell 5.1 の古い形のダイアログ
 */
export async function pickFolder(title: string, initial: string | null): Promise<string | null> {
  if (!CAN_PICK_FOLDER) throw new Error('この OS ではフォルダを選ぶ画面を出せません。パスを入力してください');
  try {
    return await runPicker('pwsh.exe', title, initial);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return runPicker('powershell.exe', title, initial);
  }
}

function runPicker(exe: string, title: string, initial: string | null): Promise<string | null> {
  return new Promise((resolve, reject) => {
    // スクリプトは -EncodedCommand(UTF-16LE の base64)で渡し、日本語の題名と初期パスは環境変数で渡す(引用符の扱いで壊さない)
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(PICK_SCRIPT, 'utf16le').toString('base64')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ATLAS_PICK_TITLE: title, ATLAS_PICK_INITIAL: initial ?? '' },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e) => {
      // pwsh が無いときは呼び元が powershell.exe で出し直す
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') reject(e);
      else reject(new Error(`フォルダを選ぶ画面を出せませんでした(${e.message})`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`フォルダを選ぶ画面を出せませんでした(PowerShell の終了コード ${code}${err.length ? `: ${Buffer.concat(err).toString('utf8').trim().split(/\r?\n/)[0]}` : ''})`));
        return;
      }
      const path = Buffer.concat(out).toString('utf8').replace(/^﻿/, '').trim();
      resolve(path || null);
    });
  });
}

/** フォルダをエクスプローラー(macOS は Finder、他は既定のファイルマネージャー)で開く。開くだけで終わりを待たない */
export function openFolder(dir: string): void {
  const child =
    process.platform === 'win32'
      ? spawn('explorer.exe', [dir], { stdio: 'ignore', detached: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}
