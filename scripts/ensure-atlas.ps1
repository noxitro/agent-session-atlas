# 前の版(Rust で作った bin\atlas.exe で動いていた版)から、この版(Node.js で動く版)へ移るための入口。この版の .bat と atlas は呼ばない。
#
# 前の版の atlas.exe は、自分で新しい版を取り込んだ後(開いたときの更新と、自動で送るタスクの更新)に、このスクリプトを
#   -Check(今の版で動けるかを終了コードで返す)と、引数なし(動けるように用意する)で呼ぶ。用意できなければ(終了コードが 0 でなければ)、
#   前の版に戻して、前の版の atlas.exe で続ける。このスクリプトが無いと、どの PC も前の版に戻り続けて新しい版に進めないので、ここに残す。
#
# この版で動けるのは、次をすべて満たすとき:
#   1. Node.js 24 以上がある(無ければ、入れ方を出して終了コード 1。前の版の atlas.exe のまま送り続ける)
#   2. npm の依存が package-lock.json とそろっている(-Check では確かめるだけ。引数なしでは npm ci で入れる)
#   3. (Windows)自動で送るタスクが、前の版の形(conhost --headless "<このフォルダ>\bin\atlas.exe" upload-auto)で登録されていない。
#      前の版の形なら、引数なしの呼び出しで、動かすものだけを node と packages\cli\src\upload-auto.ts に差し替える
#      (時刻・電池・ログオンなどの設定と、送る前に更新するか(--no-update)はそのまま)
#
# 前の版の atlas.exe(bin\)は、タスクを登録し直した後は使わない。動いていなければ、stop.bat が消す(消さなくても動きに差は無い。
#   タスクが前の版の形のままの間は、stop.bat は消さない)。
# 管理者の権限は要らない(書くのは node_modules\ と、自分のユーザーのタスクだけ)。
# Windows PowerShell 5.1 が日本語を読めるよう、このファイルは BOM 付きの UTF-8 で置く(.gitattributes で改行は CRLF)。
#
#   -Check      何も変えずに、この版で動けるかだけを終了コードで返す(0 = 動ける、1 = 用意が要る)
#   -KeepOlder  前の版の起動用の .bat が付ける。この版では意味を持たない(受け取るだけ)
param([switch]$Check, [switch]$KeepOlder)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Say([string]$m) { Write-Host $m }

# ネイティブのコマンド(node・npm)を動かし、終了コードと標準出力の行を返す。標準エラーは捨てる。
# Windows PowerShell 5.1 は、標準エラーをリダイレクトしたネイティブのコマンドの出力を、エラーの記録に変える。
# $ErrorActionPreference が Stop のままだと、警告の 1 行(npm warn・npm notice など)で NativeCommandError になって止まり、
# 入れられたはずの依存を入れられない。この関数の中だけ Continue にして、成否は終了コードで見る
function Invoke-Native([string]$exe, [string[]]$arguments) {
  $ErrorActionPreference = 'Continue'
  $out = & $exe @arguments 2>$null
  return [pscustomobject]@{ Code = $LASTEXITCODE; Out = @($out) }
}

$Repo = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\', '/')
$IsWin = $env:OS -eq 'Windows_NT'
$TaskName = 'agent-session-atlas-upload'
$Entry = Join-Path (Join-Path (Join-Path (Join-Path $Repo 'packages') 'cli') 'src') 'upload-auto.ts'

# Node.js 24 以上のパス。無ければ $null
function Find-Node {
  $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { return $null }
  try {
    $r = Invoke-Native $cmd.Source @('-p', 'process.versions.node')
    $v = [string]($r.Out | Select-Object -First 1)
    if ($r.Code -eq 0 -and [int]($v.Split('.')[0]) -ge 24) { return $cmd.Source }
  } catch { }
  return $null
}

# npm の依存がそろっているか(起動用の .bat と同じ判定。scripts\deps-fresh.mjs)
function Test-Deps([string]$node) {
  return (Invoke-Native $node @((Join-Path $Repo 'scripts\deps-fresh.mjs'), $Repo)).Code -eq 0
}

# 前の版の形で登録された自動で送るタスク。無ければ $null
function Get-ExeTask {
  if (-not $IsWin) { return $null }
  $t = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
  if (-not $t) { return $null }
  $a = @($t.Actions)[0]
  if (-not $a) { return $null }
  $m = [regex]::Match([string]$a.Arguments, '^\s*--headless\s+"([^"]+)"\s+upload-auto\b')
  if (-not $m.Success) { return $null }
  $exe = $m.Groups[1].Value
  try { $exe = [IO.Path]::GetFullPath($exe) } catch { return $null }
  if ((Split-Path -Leaf $exe) -inotmatch '^atlas(\.old-[0-9a-f]+)?\.exe$') { return $null }
  if ((Split-Path -Parent (Split-Path -Parent $exe)).TrimEnd('\') -ine $Repo) { return $null }
  return $t
}

try {
  $node = Find-Node
  if (-not $node) {
    Say 'この版の atlas は Node.js で動きます(atlas.exe は使わなくなりました)。Node.js 24 以上が見つかりません。'
    Say 'Node.js 24 以上を入れてください(https://nodejs.org/ の LTS)。入れるまでは、前の版の atlas.exe のまま動きます。'
    exit 1
  }
  $depsOk = Test-Deps $node
  $task = Get-ExeTask
  if ($Check) {
    if ($depsOk -and -not $task) { exit 0 }
    exit 1
  }

  if (-not $depsOk) {
    Say 'この版の atlas は Node.js で動きます。npm の依存を入れます(npm ci)...'
    $npm = Join-Path (Split-Path -Parent $node) $(if ($IsWin) { 'npm.cmd' } else { 'npm' })
    if (-not (Test-Path -LiteralPath $npm)) { $npm = 'npm' }
    Push-Location $Repo
    try {
      $code = (Invoke-Native $npm @('ci', '--no-audit', '--no-fund')).Code
    } finally { Pop-Location }
    if ($code -ne 0 -or -not (Test-Deps $node)) {
      Say "npm の依存を入れられませんでした(npm ci の終了コード $code)。atlas.bat を開くと、もう一度入れます。"
      exit 1
    }
    Say 'npm の依存を入れました。'
  }

  if ($task) {
    $old = [string]@($task.Actions)[0].Arguments
    $noUpdate = $old -match '(^|\s)--no-update(\s|$)'
    $newArgs = "--headless `"$node`" `"$Entry`"$(if ($noUpdate) { ' --no-update' } else { '' })"
    $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $newArgs -WorkingDirectory $Repo
    Set-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action | Out-Null
    Say '自動で送るタスクを、Node.js で動かす形に登録し直しました(時刻などの設定はそのままです)。'
  }
  exit 0
} catch {
  Say "この版へ移る用意ができませんでした: $($_.Exception.Message)"
  exit 1
}
