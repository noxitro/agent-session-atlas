# このフォルダの atlas を、すべて止める(stop.bat が呼ぶ)。
# どこかのブラウザのタブが開いたままで画面のサーバが動き続けていると、atlas.bat は更新を飛ばし、前のサーバを開き直すだけになる。
# 画面から別のフォルダを開いたときのサーバは、窓の無いまま動く(packages/cli/src/folders.ts の起動)。そういうものも止める。
#
# 止めるもの: このフォルダの packages\cli\src\ の .ts を動かしている node のプロセス(起動用の .bat も、自動で送るタスクも、
#   絶対パスで動かす)と、前の版の bin\atlas.exe(置き換えで移した bin\atlas.old-*.exe を含む)のプロセスと、それらの子孫
#   (集計・判定の子プロセスや、判定が動かした copilot など)。別のフォルダの atlas や、関係の無いプロセスは止めない。
#   印(out\.serve.json・out\.job.json)の pid は使わない(pid は使い回されるので、別のプロセスを止めかねない)。
# 画面のサーバ(atlas serve・atlas open)だけなら、尋ねずに止める。集計・判定・送る操作などが動いていれば、止めてよいか尋ねる
#   (途中で止めても、集計は次の集計で作り直し、判定は済んだ分が残る)。
# 止めた後、残った印(out\ と out-folders\<キー>\out\ の .serve.json・.job.json)と、前の版の実行ファイル(bin\atlas*.exe)を消す。
#   自動で送るタスクが、まだ動かす登録になっている実行ファイルは消さない(消すと、タスクが動かせず、自動で送れなくなる)。
#
#   -Yes   尋ねずに止める
#   -Repo  対象のフォルダ(テスト用。ふだんはこのスクリプトの 1 つ上のフォルダ)
#
# 終了コード: 0 = 動いていなかった・止めた・止めないと答えた、1 = 止められなかったものがある
# 管理者の権限は要らない(自分のプロセスだけを止める)。Windows だけで動く。
# Windows PowerShell 5.1 が日本語を読めるよう、このファイルは BOM 付きの UTF-8 で置く(.gitattributes で改行は CRLF)。
param([switch]$Yes, [string]$Repo = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Say([string]$m) { Write-Host $m }

if ($env:OS -ne 'Windows_NT') {
  Say 'stop.bat は Windows だけで動きます。'
  exit 1
}

if (-not $Repo) { $Repo = Split-Path -Parent $PSScriptRoot }
$Repo = [IO.Path]::GetFullPath($Repo).TrimEnd('\')
$Bin = Join-Path $Repo 'bin'
$CliSrc = Join-Path $Repo 'packages\cli\src'
# atlas.bat と同じ出力先(ATLAS_OUT は試すとき用)
$Out = if ($env:ATLAS_OUT) { [IO.Path]::GetFullPath($env:ATLAS_OUT) } else { Join-Path $Repo 'out' }

# 画面のサーバ(止めても、開き直せば同じ画面に戻る)
$Viewers = @('serve', 'open')
$Labels = @{
  'serve'           = '画面のサーバ'
  'open'            = '別のフォルダの画面'
  'all'             = '集計'
  'build'           = '集計'
  'judge'           = '判定'
  'judge-flow'      = '判定'
  'upload-auto'     = '自動で送る処理'
  'upload-project'  = 'プロジェクトを送る処理'
  'upload-schedule' = '自動で送る登録'
  'setup'           = '初期設定'
  'self-update'     = '更新'
  'launcher-update' = '更新'
}

# 前の版の bin の atlas か(置き換えで移した atlas.old-*.exe も)
function Test-LegacyExe($p) {
  $path = $p.ExecutablePath
  if (-not $path) { return $false }
  try { $full = [IO.Path]::GetFullPath($path) } catch { return $false }
  $dir = Split-Path -Parent $full
  $name = Split-Path -Leaf $full
  return ($dir -ieq $Bin) -and ($name -imatch '^atlas(\.old-[0-9a-f]+)?\.exe$')
}

# node が動かしている、このフォルダの packages\cli\src\ の .ts の名前(main.ts など)。違えば ''
function Get-AtlasScript($p) {
  if ([string]$p.Name -inotmatch '^node(\.exe)?$') { return '' }
  $line = [string]$p.CommandLine
  foreach ($m in [regex]::Matches($line, '"([^"]+)"|(\S+)')) {
    $arg = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
    if ($arg -notmatch '\.ts$') { continue }
    try { $full = [IO.Path]::GetFullPath($arg) } catch { continue }
    if ((Split-Path -Parent $full) -ieq $CliSrc) { return (Split-Path -Leaf $full) }
  }
  return ''
}

# このフォルダの atlas か
function Test-OurExe($p) {
  if (Get-AtlasScript $p) { return $true }
  return (Test-LegacyExe $p)
}

# コマンドラインのサブコマンド(main.ts と前の版の atlas.exe は次の語、ほかの .ts はファイルの名前)
function Get-SubCommand($p) {
  $line = [string]$p.CommandLine
  $script = Get-AtlasScript $p
  if ($script -and $script -ine 'main.ts') { return [IO.Path]::GetFileNameWithoutExtension($script) }
  $pattern = if ($script) { 'main\.ts"?\s+(\S+)' } else { '^\s*(?:"[^"]*"|\S+)\s+(\S+)' }
  $m = [regex]::Match($line, $pattern)
  if ($m.Success) { return $m.Groups[1].Value.Trim('"') }
  return ''
}

function Get-Label([string]$sub) {
  if ($Labels.ContainsKey($sub)) { return $Labels[$sub] }
  if ($sub) { return "atlas $sub" }
  return 'atlas'
}

function Get-All { return @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate) }

# root の子孫(親より後に作られたものだけ。pid の使い回しで、無関係のプロセスを子孫と取り違えないように)。
# エクスプローラーは止めない(フォルダを開く操作で子に見えることがある)
function Get-Descendants($root, $all) {
  $found = @()
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $cur = $stack.Pop()
    foreach ($c in $all) {
      if ($c.ParentProcessId -ne $cur.ProcessId -or $c.ProcessId -eq $cur.ProcessId) { continue }
      if ($c.CreationDate -and $cur.CreationDate -and $c.CreationDate -lt $cur.CreationDate) { continue }
      if ($c.Name -ieq 'explorer.exe') { continue }
      if ($found | Where-Object { $_.ProcessId -eq $c.ProcessId }) { continue }
      $found += $c
      $stack.Push($c)
    }
  }
  return ,$found
}

function Test-Alive([int]$id) { return [bool](Get-Process -Id $id -ErrorAction SilentlyContinue) }

# 印(.serve.json・.job.json)のうち、pid が止めずに残ったこのフォルダの atlas ではないもの(止めたか、もう無い)を消す
function Remove-StaleStamps([int[]]$keep) {
  $dirs = @($Out)
  $folders = "$Out-folders"
  if (Test-Path -LiteralPath $folders -PathType Container) {
    foreach ($d in @(Get-ChildItem -LiteralPath $folders -Directory -ErrorAction SilentlyContinue)) { $dirs += (Join-Path $d.FullName 'out') }
  }
  $removed = 0
  foreach ($dir in $dirs) {
    foreach ($name in @('.serve.json', '.job.json')) {
      $f = Join-Path $dir $name
      if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
      $stampPid = 0
      try { $stampPid = [int]((Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json).pid) } catch { }
      if ($stampPid -gt 0 -and $keep -contains $stampPid) { continue }
      try { Remove-Item -LiteralPath $f -Force; $removed++ } catch { }
    }
  }
  return $removed
}

# 自動で送るタスクが、まだ動かす登録になっている前の版の実行ファイル(このフォルダの bin\ の中のもの)。無ければ $null。
# 前の版は、conhost に `--headless "<このフォルダ>\bin\atlas.exe" upload-auto` を渡して登録していた。この形のままのタスクは、
# schedule-upload.bat を開くか、前の版の atlas.exe がこの版を取り込んだとき(scripts\ensure-atlas.ps1)に、Node.js で動かす形に
# 登録し直される。それまではタスクがこの実行ファイルを動かすので、消すと、記録も通知も残らないまま自動で送れなくなる
function Get-TaskExe {
  $t = Get-ScheduledTask -TaskName 'agent-session-atlas-upload' -TaskPath '\' -ErrorAction SilentlyContinue
  if (-not $t) { return $null }
  foreach ($a in @($t.Actions)) {
    if (-not $a -or $a.PSObject.Properties.Name -notcontains 'Arguments') { continue }
    $m = [regex]::Match([string]$a.Arguments, '^\s*--headless\s+"([^"]+)"\s+upload-auto\b')
    if (-not $m.Success) { continue }
    try { $exe = [IO.Path]::GetFullPath($m.Groups[1].Value) } catch { continue }
    if ((Split-Path -Parent $exe).TrimEnd('\') -ieq $Bin) { return $exe }
  }
  return $null
}

# 前の版の実行ファイル(bin\atlas*.exe。この版は使わない。動いていれば消せないので、次に止めたときに消す)。
# 自動で送るタスクがまだ動かす登録になっているものは残し、どうすれば要らなくなるかを出す。
# タスクを確かめられなかったときは、どれも消さない(残っても動きに差は無い)
function Remove-LegacyExe {
  if (-not (Test-Path -LiteralPath $Bin -PathType Container)) { return }
  $files = @(Get-ChildItem -LiteralPath $Bin -Filter 'atlas*.exe' -ErrorAction SilentlyContinue)
  if ($files.Count -eq 0) { return }
  $keep = $null
  try { $keep = Get-TaskExe } catch { return }
  foreach ($f in $files) {
    if ($keep -and $f.FullName -ieq $keep) { continue }
    Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
  }
  if ($keep -and (Test-Path -LiteralPath $keep)) {
    Say ''
    Say "毎日自動で送るタスクが、前の版の実行ファイル($keep)で登録されたままなので、この実行ファイルは消しませんでした。"
    Say 'schedule-upload.bat を開くと、Node.js で動かす形に登録し直します(その後は、この実行ファイルを使いません)。'
  }
}

try {
  $all = Get-All
  $ours = @($all | Where-Object { Test-OurExe $_ })
  # 子孫にもこのフォルダの atlas がいる(サーバが動かした集計など)。いちばん上のものだけを数え、子孫はその下に並べる
  $ids = @($ours | ForEach-Object { $_.ProcessId })
  $roots = @($ours | Where-Object { $ids -notcontains $_.ParentProcessId })

  if ($roots.Count -eq 0) {
    Say '動いている atlas はありません(このフォルダの atlas のプロセスは見つかりませんでした)。'
    $n = Remove-StaleStamps @()
    if ($n -gt 0) { Say "残っていた印を $n 個消しました。" }
    Remove-LegacyExe
    exit 0
  }

  $targets = @()
  $needAsk = $false
  Say '動いている atlas:'
  foreach ($r in $roots) {
    $sub = Get-SubCommand $r
    $kids = Get-Descendants $r $all
    $kidAtlas = @($kids | Where-Object { Test-OurExe $_ })
    $line = "  - $(Get-Label $sub)(pid $($r.ProcessId))"
    if ($kids.Count -gt 0) {
      $parts = @($kidAtlas | ForEach-Object { Get-Label (Get-SubCommand $_) } | Select-Object -Unique)
      $others = $kids.Count - $kidAtlas.Count
      if ($others -gt 0) { $parts += "ほかの子プロセス $others 個" }
      $line += "。中で動いているもの: $($parts -join '、')"
    }
    Say $line
    if ($Viewers -notcontains $sub -or $kidAtlas.Count -gt 0) { $needAsk = $true }
    $targets += $kids
    $targets += $r
  }

  if ($needAsk -and -not $Yes) {
    Say ''
    Say '画面のサーバのほかに、集計・判定・送る操作などが動いています。途中で止めても、集計は次の集計で作り直し、判定は済んだ分が残ります。'
    $a = Read-Host '止めますか? y で止めます(ほかの入力で、止めずに終わります)'
    if ($a -notmatch '^\s*[yY]') {
      Say '止めませんでした。'
      exit 0
    }
  }

  # 子から止める(親が子を動かし直さないように)
  $seen = @{}
  foreach ($t in $targets) {
    if ($seen.ContainsKey([int]$t.ProcessId)) { continue }
    $seen[[int]$t.ProcessId] = $true
    try { Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop } catch { }
  }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and @($seen.Keys | Where-Object { Test-Alive $_ }).Count -gt 0) { Start-Sleep -Milliseconds 200 }

  $left = @($seen.Keys | Where-Object { Test-Alive $_ })
  $n = Remove-StaleStamps $left
  Remove-LegacyExe

  Say ''
  if ($left.Count -gt 0) {
    Say "止められなかったプロセスがあります(pid $($left -join '、'))。タスク マネージャーで止めるか、PC を再起動してください。"
    exit 1
  }
  Say "止めました($($seen.Count) 個のプロセス)。$(if ($n -gt 0) { "残った印を $n 個消しました。" })"
  Say '開いたままのタブは閉じてください。atlas.bat を開くと、新しい版にしてから開き直します。'
  exit 0
} catch {
  Say "atlas を止められませんでした: $($_.Exception.Message)"
  exit 1
}
