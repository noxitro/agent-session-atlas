# atlas の実行ファイル(bin\atlas.exe)を、このチェックアウトのソースからこの PC でビルドして、今のコミットのものにそろえる。
# atlas.exe は配っていない(GitHub のリリースで配るのは 2026-11-23 にやめた)。いつもこの PC で、このフォルダのソースからビルドする。
# 起動用の .bat がすべて最初に呼ぶ。.bat と自動で送るタスク(atlas upload-auto)は、git fetch で新しい版にした後にも呼ぶ(crates/atlas-cli/src/self_update.rs)。
#
# 順に試す:
#  1. bin\atlas.exe があり、作ったときのコミット(atlas --version に出る)が今のコミット(HEAD)と同じなら、何もしない。
#     git が管理しているファイルを変えたまま作ったもの(コミットの後ろに -dirty。開発の手元だけ)は、HEAD と同じとはみなさない。
#     git で取得したフォルダでない(今のコミットが分からない)ときは、版(Cargo.toml の [workspace.package] の version)が同じなら何もしない
#     (版はふだん上げないので、そういうフォルダでソースを変えたら、bin\atlas.exe を消してから開く)
#  2. Node.js と Rust(Windows では Visual Studio の C++ のビルドツールも)があれば、ここでビルドして bin\ に置く
#     (npm ci → npm run build:report → cargo build --release。経過は bin\build.log。初めてのときは数分から十数分かかる)。
#     ビルドできなければ、そのときのコミットを bin\build-failed.txt に書く(自動の更新が、同じコミットを何度も試さないように。self_update.rs)
#  3. ビルドに要るものが無ければ、何を入れればよいかを出して、終了コード 1 で終わる
#
# 管理者の権限は要らない(書くのは bin\ と target\ と node_modules\ だけ)。
# 置き換えるときは、今の bin\atlas.exe を bin\atlas.prev.exe に移してから置く(動いていても移せる)。前の atlas.prev.exe は消し、
# 動いていて消せなければ atlas.old-<番号>.exe に移す(次に動かしたときに消す)。atlas.prev.exe は、新しい版がこの PC で動かなかったときに、
# ビルドせずに戻すのに使う(self_update.rs の rollback)。
# 同じフォルダで 2 つ同時にビルドしない(自動で送るタスクがビルドしている間に .bat を開いたときなど): bin\build.lock を開いたままにして印にする
# (プロセスが終われば閉じるので、残っても次の回の邪魔をしない)。ほかがビルドしている間は、-KeepOlder で前のものが動けば少し待ってからそれで続け、
# そうでなければ終わるのを待つ。
#
#   -Check       何も変えずに、bin\atlas.exe が今のコミットから作ったものかだけを終了コードで返す(0 = そのまま使える、1 = ビルドし直す)
#   -CheckTools  何も変えずに、ビルドに要るものがそろっているかだけを終了コードで返す(0 = そろっている、1 = 足りない。足りないものを 1 行で出す)。
#                Node.js の版(package.json の engines)と、cargo が実際に動くか(既定のツールチェーンがあるか)も見る。
#                自動の更新(self_update.rs)が、新しい版を取り込む前に使う(ビルドできない PC では、取り込まずに今の版のまま続ける)
#   -KeepOlder   ビルドできなくても(ビルドに要るものが無い・ビルドに失敗した・ほかがビルドしている・置けなかった)、前のソースから作った
#                bin\atlas.exe が動けば、それで続ける(終了コード 0)。起動用の .bat が付ける。自動の更新(self_update.rs)は付けない
#                (ビルドできなければ前の版に戻す)
#
# 環境変数 ATLAS_BUILD_LOCAL(前はリリースを取りに行かずにビルドする指定)は、もう読まない(いつもビルドする)。付けたままでも害は無い。
#
# Windows PowerShell 5.1 が日本語を読めるよう、このファイルは BOM 付きの UTF-8 で置く(.gitattributes で改行は CRLF)。
param([switch]$Check, [switch]$CheckTools, [switch]$KeepOlder)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# PowerShell の変数は大文字小文字を区別しない。置き場所の $Exe を、大文字小文字だけ違う同じ名前で上書きしないこと(作ったファイルは $got・$built)
$Repo = Split-Path -Parent $PSScriptRoot
$OnWindows = ($env:OS -eq 'Windows_NT')
$ExeName = if ($OnWindows) { 'atlas.exe' } else { 'atlas' }
$PrevName = if ($OnWindows) { 'atlas.prev.exe' } else { 'atlas.prev' }
$Bin = Join-Path $Repo 'bin'
$Exe = Join-Path $Bin $ExeName
$Prev = Join-Path $Bin $PrevName
# どのソースから作った実行ファイルか(local <コミット>。調べるとき用。使えるかどうかは atlas --version で決める)
$SourceFile = Join-Path $Bin 'atlas-source.txt'
$BuildLog = Join-Path $Bin 'build.log'
# ビルドできなかったコミット(self_update.rs の FAILED_BUILD_FILE と同じ名前)
$FailedFile = Join-Path $Bin 'build-failed.txt'
$LockFile = Join-Path $Bin 'build.lock'

# 自動で送るタスクから動かすときは出力をパイプで読むので、UTF-8 で書く(窓が無いと設定できないことがある)
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# 関数の戻り値に混ざらないよう、Write-Output ではなく Write-Host で出す(パイプで読まれたときも標準出力に出る)
function Say([string]$m) { Write-Host $m }

function Get-CargoVersion {
  $text = [IO.File]::ReadAllText((Join-Path $Repo 'Cargo.toml'))
  $section = [regex]::Match($text, '(?ms)^\[workspace\.package\][ \t]*\r?$(.*?)(?=^\[|\z)')
  $v = [regex]::Match($section.Groups[1].Value, '(?m)^version\s*=\s*"([^"]+)"')
  if (-not $v.Success) { throw 'Cargo.toml の [workspace.package] に version がありません' }
  return $v.Groups[1].Value
}

# atlas --version の 1 行(atlas 0.1.0 (commit <全桁>[-dirty], code <目印>))から版とコミットを読む。動かせなければ $null
function Get-ExeInfo([string]$path) {
  # 外のコマンドの標準エラーを止める理由にしない(Windows PowerShell 5.1 は 2>$null でも Stop だと止まる)
  $ErrorActionPreference = 'Continue'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try {
    $out = & $path --version 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
  } catch { return $null }
  $m = [regex]::Match([string]($out | Select-Object -First 1), '^atlas (\S+) \((?:commit ([0-9a-f]{40,64}(?:-dirty)?), )?code [0-9a-f]+\)')
  if (-not $m.Success) { return $null }
  return [pscustomobject]@{ Version = $m.Groups[1].Value; Commit = $m.Groups[2].Value }
}

function Test-Tool([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Get-Head {
  $ErrorActionPreference = 'Continue'
  if (-not (Test-Path -LiteralPath (Join-Path $Repo '.git')) -or -not (Test-Tool 'git')) { return '' }
  $h = & git -C $Repo rev-parse HEAD 2>$null
  if ($LASTEXITCODE -ne 0) { return '' }
  return ([string]$h).Trim()
}

function Get-Short([string]$commit) { if ($commit.Length -gt 7) { return $commit.Substring(0, 7) } else { return $commit } }

# Rust の MSVC 向けのツールチェーン(Windows の既定)が使う、Visual Studio の C++ のビルドツール(リンカーと、同梱の SQLite を
# コンパイルする cl.exe。Windows SDK と一緒に入れる)があるか。Windows 以外と、MSVC 向けでない Rust(gnu など)では要らない
function Test-MsvcTools {
  if (-not $OnWindows) { return $true }
  $ErrorActionPreference = 'Continue'
  if (Test-Tool 'rustc') {
    $rustHost = [regex]::Match([string]((& rustc -vV 2>$null) -join "`n"), '(?m)^host:\s*(\S+)').Groups[1].Value
    if ($rustHost -and $rustHost -notlike '*-msvc') { return $true }
  }
  # Visual Studio(Build Tools を含む)に付く vswhere.exe で、x64 の C++ のビルドツールが入っているものを探す
  $x86 = ${env:ProgramFiles(x86)}
  if ($x86) {
    $vswhere = Join-Path $x86 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
      $found = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
      if ($LASTEXITCODE -eq 0 -and $found) { return $true }
    }
  }
  # 開発者用のコマンド プロンプトなどで PATH に通っていれば、それで足りる(Git に付く別の link.exe と取り違えないよう cl.exe も見る)
  return ((Test-Tool 'cl.exe') -and (Test-Tool 'link.exe'))
}

# package.json の engines.node が求める Node.js のいちばん下の版(>=24 なら 24)。読めなければ 24
function Get-NodeMajorWanted {
  try {
    $text = [IO.File]::ReadAllText((Join-Path $Repo 'package.json'))
    $m = [regex]::Match($text, '"node"\s*:\s*">=\s*(\d+)')
    if ($m.Success) { return [int]$m.Groups[1].Value }
  } catch { }
  return 24
}

# この PC でビルドするのに足りないもの(無ければ空)。ある・動く・版が足りる、まで見る
function Get-MissingTools {
  $ErrorActionPreference = 'Continue'
  $missing = @()
  if (-not (Test-Tool 'node')) { $missing += 'Node.js' }
  else {
    $want = Get-NodeMajorWanted
    $v = ([string](& node --version 2>$null)).Trim()
    $m = [regex]::Match($v, '^v(\d+)\.')
    if ($LASTEXITCODE -ne 0 -or -not $m.Success) { $missing += "Node.js $want 以上(node が動きません)" }
    elseif ([int]$m.Groups[1].Value -lt $want) { $missing += "Node.js $want 以上(今は $v)" }
  }
  if (-not (Test-Tool 'npm')) { $missing += 'npm' }
  if (-not (Test-Tool 'cargo')) { $missing += 'Rust(cargo)' }
  else {
    # rustup だけで既定のツールチェーンが無いときなど、cargo はあっても動かない
    & cargo --version *> $null
    if ($LASTEXITCODE -ne 0) { $missing += 'Rust(cargo が動きません。rustup default stable で既定のツールチェーンを入れます)' }
  }
  if (-not (Test-MsvcTools)) { $missing += 'Visual Studio の C++ のビルドツール(MSVC)' }
  return ,$missing
}

# 今の bin\atlas.exe をそのまま使えるか。使えなければ理由を返す(使えれば $null)
function Get-StaleReason {
  $info = Get-ExeInfo $Exe
  if (-not $info) { return 'bin\atlas.exe がありません(か、動きません)' }
  $head = Get-Head
  if ($head) {
    # -dirty の付いたもの(変えたまま作ったもの)は、HEAD と同じにならない
    if ($info.Commit -ne $head) { return "bin\atlas.exe は、今のソース(コミット $(Get-Short $head))から作ったものではありません" }
    return $null
  }
  # git で取得したフォルダでない(今のコミットが分からない)ときは、版で比べる
  $want = Get-CargoVersion
  if ($info.Version -ne $want) { return "bin\atlas.exe の版($($info.Version))が、このフォルダの版($want)と違います" }
  return $null
}

function New-WorkDir {
  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  $d = Join-Path $Bin ('work-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $d | Out-Null
  return $d
}

# ビルドの印(bin\build.lock を、ほかが開けないように開いたままにする)。開けたら閉じるためのもの、ほかが開いていれば $null
function Open-BuildLock {
  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  try { return [IO.File]::Open($LockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
  catch { return $null }
}

# 印を取れるまで、seconds 秒まで待つ。取れなければ $null
function Wait-BuildLock([int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ($true) {
    $l = Open-BuildLock
    if ($l) { return $l }
    if ((Get-Date) -ge $deadline) { return $null }
    Start-Sleep -Milliseconds 500
  }
}

# 作った実行ファイルを bin\ に置く。今の bin\atlas.exe はいつも先に bin\atlas.prev.exe に移す(動いていても移せる。置けなかったら戻せるように)
function Install-Exe([string]$src, [string]$source) {
  $moved = $false
  if (Test-Path -LiteralPath $Exe) {
    if (Test-Path -LiteralPath $Prev) {
      try { Remove-Item -LiteralPath $Prev -Force }
      catch { Move-Item -LiteralPath $Prev -Destination (Join-Path $Bin ('atlas.old-' + [guid]::NewGuid().ToString('N') + '.exe')) -Force }
    }
    Move-Item -LiteralPath $Exe -Destination $Prev
    $moved = $true
  }
  try { Move-Item -LiteralPath $src -Destination $Exe }
  catch {
    if ($moved -and -not (Test-Path -LiteralPath $Exe)) { Move-Item -LiteralPath $Prev -Destination $Exe -ErrorAction SilentlyContinue }
    throw
  }
  # ここから先は、置けた後の記録だけ(失敗しても、置いたものは使える。自動の更新が前の版に戻さないよう、止めない)
  try { [IO.File]::WriteAllText($SourceFile, $source + "`n") } catch { Say "  注意: $SourceFile を書けませんでした($($_.Exception.Message))" }
  Remove-Item -LiteralPath $FailedFile -Force -ErrorAction SilentlyContinue
}

# cmd(Windows)か sh で動かし、出力は bin\build.log に足す。終了コードを返す
function Invoke-Logged([string]$line) {
  Add-Content -LiteralPath $BuildLog -Value "> $line" -Encoding UTF8
  if ($OnWindows) { & cmd.exe /d /s /c "$line >> `"$BuildLog`" 2>&1" } else { & /bin/sh -c "$line >> '$BuildLog' 2>&1" }
  return $LASTEXITCODE
}

# この PC でビルドする。できた実行ファイルのパス(だめなら $null)
function Build-LocalExe([string]$work) {
  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  Set-Content -LiteralPath $BuildLog -Value "atlas のビルド $(Get-Date -Format s)" -Encoding UTF8
  $started = Get-Date
  Push-Location $Repo
  $ErrorActionPreference = 'Continue'
  try {
    & node scripts/deps-fresh.mjs *> $null
    if ($LASTEXITCODE -ne 0) {
      Say '  依存を入れています(npm ci)...'
      if ((Invoke-Logged 'npm ci --no-audit --no-fund') -ne 0) { Say '  npm ci に失敗しました。'; return $null }
    }
    Say '  画面を作っています(npm run build:report)...'
    if ((Invoke-Logged 'npm run build:report') -ne 0) { Say '  画面を作れませんでした。'; return $null }
    Say '  atlas をビルドしています(cargo build --release。初めてのときは数分から十数分かかります)...'
    $env:ATLAS_REQUIRE_TEMPLATE = '1'
    if ((Invoke-Logged 'cargo build --release --locked -p atlas-cli') -ne 0) { Say '  cargo build に失敗しました。'; return $null }
  } finally { Pop-Location }
  $target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $Repo 'target' }
  $built = Join-Path (Join-Path $target 'release') $ExeName
  if (-not (Test-Path -LiteralPath $built)) { Say "  $built がありません。"; return $null }
  $copy = Join-Path $work $ExeName
  Copy-Item -LiteralPath $built -Destination $copy
  Say ("  ビルドしました({0:N0} 秒)" -f ((Get-Date) - $started).TotalSeconds)
  return $copy
}

# ビルドできなかったコミットを残す(自動の更新が、同じコミットを開くたびに試さないように)。書けなくても止めない
function Save-FailedBuild {
  try { [IO.File]::WriteAllText($FailedFile, (Get-Head) + "`n") } catch { }
}

# -KeepOlder のとき、用意できなかったら、動く前の bin\atlas.exe で続ける。続けるなら $true
function Use-Older {
  if (-not $KeepOlder) { return $false }
  $info = Get-ExeInfo $Exe
  if (-not $info) { return $false }
  $from = if ($info.Commit) { "版 $($info.Version)、コミット $(Get-Short $info.Commit)" } else { "版 $($info.Version)" }
  Say ''
  Say "今回は、前のソースから作った bin\atlas.exe($from)のまま続けます。今のソースの変更は入っていません。次に開いたときに、もう一度ビルドします。"
  return $true
}

function Show-LogTail {
  if (Test-Path -LiteralPath $BuildLog) {
    Say "  --- $BuildLog の最後 ---"
    Get-Content -LiteralPath $BuildLog -Tail 15 -Encoding UTF8 | ForEach-Object { Say "  $_" }
  }
}

function Show-ToolsHelp($missing) {
  $tools = 'Node.js 24 以上(https://nodejs.org/)と Rust(https://rustup.rs/)'
  if ($OnWindows) { $tools += '、Visual Studio Build Tools の「C++ によるデスクトップ開発」(MSVC と Windows SDK。https://visualstudio.microsoft.com/visual-cpp-build-tools/)' }
  Say ''
  Say "atlas をビルドするのに要るものが足りません(足りないもの: $($missing -join '、'))。"
  Say "atlas.exe は配っていないので、この PC でビルドします。$tools を入れてから、もう一度実行してください。"
}

$lock = $null
try {
  if ($CheckTools) {
    $missing = Get-MissingTools
    if ($missing.Count -eq 0) { exit 0 }
    Say ($missing -join '、')
    exit 1
  }
  $stale = Get-StaleReason
  if ($Check) { if ($stale) { exit 1 } else { exit 0 } }
  # 前に置き換えたときに移した、前の実行ファイル(もう動いていなければ消せる)
  if (Test-Path -LiteralPath $Bin) { Get-ChildItem -LiteralPath $Bin -Filter 'atlas.old-*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue }
  if (-not $stale) { exit 0 }

  Say "atlas を用意します: $stale"
  $missing = Get-MissingTools
  if ($missing.Count -ne 0) {
    Show-ToolsHelp $missing
    if (Use-Older) { exit 0 }
    exit 1
  }
  $lock = Open-BuildLock
  if (-not $lock) {
    Say '  ほかの atlas が、このフォルダで atlas.exe をビルドしています(自動で送るタスクなど)。'
    # 前のものが動くなら長く待たせない。無ければ、終わるのを待つ(ビルドは初めてだと十数分かかる)
    $older = [bool]($KeepOlder -and (Get-ExeInfo $Exe))
    if (-not $older) { Say '  終わるのを待っています...' }
    $lock = Wait-BuildLock $(if ($older) { 5 } else { 40 * 60 })
    if (-not $lock) {
      if (Use-Older) { exit 0 }
      Say 'ほかのビルドが終わらなかったので、やめます。しばらくしてから、もう一度実行してください。'
      exit 1
    }
    # ほかがビルドし終えていれば、それを使う
    $stale = Get-StaleReason
    if (-not $stale) { Say '  ほかの atlas がビルドし終えたものを使います。'; exit 0 }
  }
  Say '  この PC でビルドします(経過は bin\build.log)。'
  $work = New-WorkDir
  try {
    $got = Build-LocalExe $work
    if ($got) {
      $head = Get-Head
      Install-Exe $got ('local ' + $head)
      # 置いたものが今のコミットから作ったものか(変えたまま作ると -dirty が付く)。違っても繰り返さない(次に開いたときにもう一度ビルドする)
      $after = Get-ExeInfo $Exe
      if ($head -and (-not $after -or $after.Commit -ne $head)) {
        $made = if ($after -and $after.Commit) { $after.Commit } else { '不明' }
        Say "  注意: 置いた bin\atlas.exe の作ったときのコミット($made)が、今のコミット($head)と違います(git が管理しているファイルを変えたままだと -dirty が付きます)。次に開いたときに、もう一度ビルドします。"
      }
      exit 0
    }
    Save-FailedBuild
    Show-LogTail
    Say ''
    Say 'atlas をビルドできませんでした。上の記録を確かめてください。'
    if (Use-Older) { exit 0 }
    exit 1
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
} catch {
  Say "atlas を用意できませんでした: $($_.Exception.Message)"
  if (Use-Older) { exit 0 }
  exit 1
} finally {
  if ($lock) { $lock.Dispose() }
}
