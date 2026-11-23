# このフォルダの atlas を、すべて止める(stop.bat が呼ぶ)。
# どこかのブラウザのタブが開いたままで画面のサーバが動き続けていると、atlas.bat は更新を飛ばし、前のサーバを開き直すだけになる。
# 画面から別のフォルダを開いたときのサーバは、窓の無いまま動く(crates/atlas-cli/src/folders.rs の launch_detached)。そういうものも止める。
#
# 止めるもの: 実行ファイルが、このフォルダの bin\atlas.exe(置き換えで移した bin\atlas.prev.exe・bin\atlas.old-*.exe を含む)のプロセスと、その子孫
#   (集計・判定の子プロセスや、M365 Copilot を操作する PowerShell、skill-draft が動かした copilot など)。別のフォルダの atlas や、関係の無いプロセスは止めない。
#   印(out\.serve.json・out\.job.json)の pid は使わない(pid は使い回されるので、別のプロセスを止めかねない)。
# 画面のサーバ(atlas serve・atlas open)だけなら、尋ねずに止める。集計・判定・送る操作などが動いていれば、止めてよいか尋ねる
#   (途中で止めても、集計は次の集計で作り直し、判定は済んだ分が残る)。
# 止めた後、残った印(out\ と out-folders\<キー>\out\ の .serve.json・.job.json)と、置き換えで移した前の実行ファイルを消す。
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
# atlas.bat と同じ出力先(ATLAS_OUT は試すとき用。crates/atlas-cli/src/paths.rs の auto_out_dir)
$Out = if ($env:ATLAS_OUT) { [IO.Path]::GetFullPath($env:ATLAS_OUT) } else { Join-Path $Repo 'out' }

# 画面のサーバ(止めても、開き直せば同じ画面に戻る)
$Viewers = @('serve', 'open')
$Labels = @{
  'serve'           = '画面のサーバ'
  'open'            = '別のフォルダの画面'
  'all'             = '集計'
  'build'           = '集計'
  'judge'           = '判定'
  'turns'           = '判定'
  'tasks'           = 'タスクの紐づけ'
  'upload-auto'     = '自動で送る処理'
  'upload-project'  = 'プロジェクトを送る処理'
  'upload-schedule' = '自動で送る登録'
  'setup'           = '初期設定'
  'self-update'     = '更新'
}

# このフォルダの bin の atlas か(置き換えで移した atlas.prev.exe・atlas.old-*.exe も)
function Test-OurExe($p) {
  $path = $p.ExecutablePath
  if (-not $path) { return $false }
  try { $full = [IO.Path]::GetFullPath($path) } catch { return $false }
  $dir = Split-Path -Parent $full
  $name = Split-Path -Leaf $full
  return ($dir -ieq $Bin) -and ($name -imatch '^atlas(\.old-[0-9a-f]+|\.prev)?\.exe$')
}

# コマンドラインのサブコマンド(実行ファイルの次の語)
function Get-SubCommand($p) {
  $line = [string]$p.CommandLine
  $m = [regex]::Match($line, '^\s*(?:"[^"]*"|\S+)\s+(\S+)')
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

try {
  $all = Get-All
  $ours = @($all | Where-Object { Test-OurExe $_ })
  # 子孫にもこのフォルダの atlas がいる(サーバが動かした集計など)。いちばん上のものだけを数え、子孫はその下に並べる
  $ids = @($ours | ForEach-Object { $_.ProcessId })
  $roots = @($ours | Where-Object { $ids -notcontains $_.ParentProcessId })

  if ($roots.Count -eq 0) {
    Say '動いている atlas はありません(このフォルダの bin\atlas.exe のプロセスは見つかりませんでした)。'
    $n = Remove-StaleStamps @()
    if ($n -gt 0) { Say "残っていた印を $n 個消しました。" }
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
  # 置き換えで移した前の実行ファイル(もう動いていなければ消せる。残っても次の atlas.bat が消す)
  if (Test-Path -LiteralPath $Bin) { Get-ChildItem -LiteralPath $Bin -Filter 'atlas.old-*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue }

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
