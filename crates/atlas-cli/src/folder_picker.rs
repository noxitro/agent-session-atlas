//! フォルダを選ぶダイアログ(Windows の「フォルダーの参照」)と、エクスプローラーで開く操作(packages/cli/src/folder-picker.ts の移植)。
//! atlas serve の画面・setup・upload-project から使う。ブラウザからはフォルダのフルパスを取れないので、PowerShell でダイアログを出す。

use anyhow::{anyhow, bail, Result};
use std::process::{Command, Stdio};

/// Windows 以外ではダイアログを出せない(画面ではパスを入力してもらう)
pub const CAN_PICK_FOLDER: bool = cfg!(windows);

/// ダイアログを最前面に出す(ブラウザの後ろに隠れないよう、最前面の見えない窓を親にする)。選んだパスを UTF-8 で 1 行返す
const PICK_SCRIPT: &str = r#"
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
"#;

/// 出せなかったときの理由。pwsh が無いとき(NotFound)は呼び元が powershell.exe で出し直す
enum PickError {
    NotFound,
    Other(anyhow::Error),
}

/// フォルダを選んでもらう。取り消したら None。initial があればそこを開いた状態で出す。
/// PowerShell 7(pwsh)があればそちらで出す(新しい形のダイアログ)。無ければ Windows に入っている PowerShell 5.1 の古い形のダイアログ
pub fn pick_folder(title: &str, initial: Option<&str>) -> Result<Option<String>> {
    if !CAN_PICK_FOLDER {
        bail!("この OS ではフォルダを選ぶ画面を出せません。パスを入力してください");
    }
    // 偽の PowerShell を使うとき(ATLAS_PARITY_FAKE_PS。試すとき用)は画面を出さない
    if std::env::var_os("ATLAS_PARITY_FAKE_PS").is_some() {
        bail!("parity: フォルダを選ぶ画面は出しません");
    }
    match run_picker("pwsh.exe", title, initial) {
        Ok(r) => Ok(r),
        Err(PickError::NotFound) => match run_picker("powershell.exe", title, initial) {
            Ok(r) => Ok(r),
            Err(PickError::NotFound) => Err(anyhow!("フォルダを選ぶ画面を出せませんでした(powershell.exe が見つかりません)")),
            Err(PickError::Other(e)) => Err(e),
        },
        Err(PickError::Other(e)) => Err(e),
    }
}

fn run_picker(exe: &str, title: &str, initial: Option<&str>) -> std::result::Result<Option<String>, PickError> {
    // スクリプトは -EncodedCommand(UTF-16LE の base64)で渡し、日本語の題名と初期パスは環境変数で渡す(引用符の扱いで壊さない)
    let mut c = Command::new(exe);
    c.args(["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", &crate::sys::encoded_command(PICK_SCRIPT)])
        .env("ATLAS_PICK_TITLE", title)
        .env("ATLAS_PICK_INITIAL", initial.unwrap_or(""))
        .stdin(Stdio::null());
    crate::self_update::hide_window(&mut c);
    let o = match c.output() {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(PickError::NotFound),
        Err(e) => return Err(PickError::Other(anyhow!("フォルダを選ぶ画面を出せませんでした({e})"))),
    };
    if !o.status.success() {
        let err = String::from_utf8_lossy(&o.stderr);
        let first = atlas_core::js::trim(&err).split('\n').next().map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).unwrap_or_default();
        return Err(PickError::Other(anyhow!(
            "フォルダを選ぶ画面を出せませんでした(PowerShell の終了コード {}{})",
            o.status.code().map_or("null".to_string(), |c| c.to_string()),
            if o.stderr.is_empty() { String::new() } else { format!(": {first}") }
        )));
    }
    let out = String::from_utf8_lossy(&o.stdout);
    let path = atlas_core::js::trim(out.strip_prefix('\u{feff}').unwrap_or(&out)).to_string();
    Ok((!path.is_empty()).then_some(path))
}

/// フォルダをエクスプローラー(macOS は Finder、他は既定のファイルマネージャー)で開く。開くだけで終わりを待たない
pub fn open_folder(dir: &str) {
    let prog = if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let _ = Command::new(prog).arg(dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}
