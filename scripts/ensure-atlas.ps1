# atlas の実行ファイル(bin\atlas.exe)を、このチェックアウトの版(Cargo.toml の [workspace.package] の version)にそろえる。
# 起動用の .bat がすべて最初に呼ぶ。自動で送るタスク(atlas upload-auto)も、git pull で新しい版にした後に呼ぶ(crates/atlas-cli/src/self_update.rs)。
#
# 順に試す:
#  1. bin\atlas.exe があり、atlas --version の版が Cargo.toml の version と同じなら、何もしない
#     (この PC でビルドしたものは、作ったときのコミットが今のコミットと違い、Node.js と Rust があれば、ビルドし直す)
#  2. このリポジトリ(git remote get-url origin の GitHub)のリリース v<version> から atlas.exe を取ってきて、
#     同じリリースの atlas.exe.sha256 と照らし合わせてから bin\ に置く(取れなければ gh release download も試す)
#  3. リリースが無いか取れなければ、Node.js と Rust があれば、ここでビルドして bin\ に置く
#     (npm ci → npm run build:report → cargo build --release。経過は bin\build.log)
#  4. どれもできなければ、何を入れればよいかを出して、終了コード 1 で終わる
#
# 管理者の権限は要らない(書くのは bin\ と target\ と node_modules\ だけ)。
# 動いている bin\atlas.exe(開いたままの画面のサーバなど)は消せないので、別の名前に移してから置き換える(次に動かしたときに消す)。
#
#   -Check  何も変えずに、bin\atlas.exe が今の版のものかだけを終了コードで返す(0 = そのまま使える、1 = 用意し直す)
#
# 環境変数(ふだんは要らない):
#   ATLAS_BUILD_LOCAL=1   リリースを取りに行かず、この PC でビルドする(開発用)
#   ATLAS_RELEASE_REPO    リリースを探すリポジトリ(owner/name)。無ければ origin から決める
#
# Windows PowerShell 5.1 が日本語を読めるよう、このファイルは BOM 付きの UTF-8 で置く(.gitattributes で改行は CRLF)。
param([switch]$Check)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# PowerShell の変数は大文字小文字を区別しない。置き場所の $Exe を、大文字小文字だけ違う同じ名前で上書きしないこと(取ってきた・作ったファイルは $file・$got)
$Repo = Split-Path -Parent $PSScriptRoot
$OnWindows = ($env:OS -eq 'Windows_NT')
$ExeName = if ($OnWindows) { 'atlas.exe' } else { 'atlas' }
$Bin = Join-Path $Repo 'bin'
$Exe = Join-Path $Bin $ExeName
# どこから来た実行ファイルか(release v<version> / local <コミット>)
$SourceFile = Join-Path $Bin 'atlas-source.txt'
$BuildLog = Join-Path $Bin 'build.log'

# 自動で送るタスクから動かすときは出力をパイプで読むので、UTF-8 で書く(窓が無いと設定できないことがある)
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# 関数の戻り値に混ざらないよう、Write-Output ではなく Write-Host で出す(パイプで読まれたときも標準出力に出る)
function Say([string]$m) { Write-Host $m }

function Get-WantVersion {
  $text = [IO.File]::ReadAllText((Join-Path $Repo 'Cargo.toml'))
  $section = [regex]::Match($text, '(?ms)^\[workspace\.package\][ \t]*\r?$(.*?)(?=^\[|\z)')
  $v = [regex]::Match($section.Groups[1].Value, '(?m)^version\s*=\s*"([^"]+)"')
  if (-not $v.Success) { throw 'Cargo.toml の [workspace.package] に version がありません' }
  return $v.Groups[1].Value
}

# atlas --version の 1 行(atlas 0.1.0 (commit <全桁>, code <目印>))から版とコミットを読む。動かせなければ $null
function Get-ExeInfo([string]$path) {
  # 外のコマンドの標準エラーを止める理由にしない(Windows PowerShell 5.1 は 2>$null でも Stop だと止まる)
  $ErrorActionPreference = 'Continue'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try {
    $out = & $path --version 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
  } catch { return $null }
  $m = [regex]::Match([string]($out | Select-Object -First 1), '^atlas (\S+) \((?:commit ([0-9a-f]{40,64}), )?code [0-9a-f]+\)')
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

function Get-Source {
  if (Test-Path -LiteralPath $SourceFile) { return ([IO.File]::ReadAllText($SourceFile)).Trim() }
  return ''
}

# この PC でビルドするのに足りないもの(無ければ空)
function Get-MissingTools {
  $missing = @()
  if (-not (Test-Tool 'node')) { $missing += 'Node.js' }
  if (-not (Test-Tool 'npm')) { $missing += 'npm' }
  if (-not (Test-Tool 'cargo')) { $missing += 'Rust(cargo)' }
  return ,$missing
}

# 今の bin\atlas.exe をそのまま使えるか。使えなければ理由を返す(使えれば $null)
function Get-StaleReason([string]$want) {
  $info = Get-ExeInfo $Exe
  if (-not $info) { return 'bin\atlas.exe がありません' }
  if ($info.Version -ne $want) { return "bin\atlas.exe の版($($info.Version))が、このフォルダの版($want)と違います" }
  # この PC でビルドしたものは、ソースが変わっていて、ビルドし直せるなら、し直す(リリースから取ったものは、同じ版ならそのまま使う)
  $source = Get-Source
  if ($source -like 'local *') {
    $head = Get-Head
    if ($head -and $info.Commit -and $info.Commit -ne $head -and (Get-MissingTools).Count -eq 0) {
      return 'この PC でビルドした bin\atlas.exe より、ソースが新しくなっています'
    }
  }
  return $null
}

# origin の GitHub のリポジトリ(owner/name)。分からなければ $null
function Get-RepoSlug {
  $ErrorActionPreference = 'Continue'
  if ($env:ATLAS_RELEASE_REPO) { return $env:ATLAS_RELEASE_REPO }
  if (-not (Test-Tool 'git')) { return $null }
  $url = & git -C $Repo remote get-url origin 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $url) { return $null }
  $m = [regex]::Match(([string]$url).Trim(), '^(?:https://(?:[^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+)/([^/]+?)(?:\.git)?/?$')
  if (-not $m.Success) { return $null }
  return "$($m.Groups[1].Value)/$($m.Groups[2].Value)"
}

function New-WorkDir {
  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  $d = Join-Path $Bin ('work-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $d | Out-Null
  return $d
}

# 用意した実行ファイルを bin\ に置く。動いている bin\atlas.exe は消せないので、別の名前に移す(移すのはできる)
function Install-Exe([string]$src, [string]$source) {
  if (Test-Path -LiteralPath $Exe) {
    try { Remove-Item -LiteralPath $Exe -Force }
    catch { Move-Item -LiteralPath $Exe -Destination (Join-Path $Bin ('atlas.old-' + [guid]::NewGuid().ToString('N') + '.exe')) -Force }
  }
  Move-Item -LiteralPath $src -Destination $Exe
  [IO.File]::WriteAllText($SourceFile, $source + "`n")
}

$script:DownloadReason = ''

# リリース v<version> の atlas.exe を取ってきて、sha256 と版を確かめる。確かめた実行ファイルのパス(だめなら $null。理由は DownloadReason)
function Get-ReleaseExe([string]$want, [string]$work) {
  if (-not $OnWindows) { $script:DownloadReason = 'リリースの実行ファイルは Windows 用だけです'; return $null }
  $slug = Get-RepoSlug
  if (-not $slug) { $script:DownloadReason = 'GitHub から取得したフォルダではないので、リリースを探せません'; return $null }
  $tag = "v$want"
  $file = Join-Path $work 'atlas.exe'
  $sum = Join-Path $work 'atlas.exe.sha256'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    $base = "https://github.com/$slug/releases/download/$tag"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/atlas.exe.sha256" -OutFile $sum -TimeoutSec 60
    Invoke-WebRequest -UseBasicParsing -Uri "$base/atlas.exe" -OutFile $file -TimeoutSec 900
  } catch {
    $script:DownloadReason = "$slug のリリース $tag を取得できません($($_.Exception.Message))"
    # 公開していないリポジトリなど。gh にログインしていれば、gh で取れる
    if ((Test-Tool 'gh')) {
      $ErrorActionPreference = 'Continue'
      & gh release download $tag -R $slug -p atlas.exe -p atlas.exe.sha256 -D $work --clobber *> $null
      if ($LASTEXITCODE -ne 0) { return $null }
    } else { return $null }
  }
  if (-not (Test-Path -LiteralPath $file) -or -not (Test-Path -LiteralPath $sum)) { $script:DownloadReason = "リリース $tag に atlas.exe と atlas.exe.sha256 がそろっていません"; return $null }
  $expect = [regex]::Match([IO.File]::ReadAllText($sum), '\b[0-9a-fA-F]{64}\b').Value.ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
  if (-not $expect -or $expect -ne $actual) { $script:DownloadReason = "取ってきた atlas.exe の sha256 がリリースの atlas.exe.sha256 と合いません(使いません)"; return $null }
  $info = Get-ExeInfo $file
  if (-not $info -or $info.Version -ne $want) { $script:DownloadReason = "取ってきた atlas.exe の版が $want ではありません(使いません)"; return $null }
  return $file
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
    Say '  atlas をビルドしています(cargo build --release。初めてのときは数分かかります)...'
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

function Show-LogTail {
  if (Test-Path -LiteralPath $BuildLog) {
    Say "  --- $BuildLog の最後 ---"
    Get-Content -LiteralPath $BuildLog -Tail 15 -Encoding UTF8 | ForEach-Object { Say "  $_" }
  }
}

try {
  $want = Get-WantVersion
  $stale = Get-StaleReason $want
  if ($Check) { if ($stale) { exit 1 } else { exit 0 } }
  # 前に置き換えたときに移した、前の実行ファイル(もう動いていなければ消せる)
  if (Test-Path -LiteralPath $Bin) { Get-ChildItem -LiteralPath $Bin -Filter 'atlas.old-*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue }
  if (-not $stale) { exit 0 }

  Say "atlas を用意します: $stale"
  $work = New-WorkDir
  try {
    $got = $null
    if ($env:ATLAS_BUILD_LOCAL -ne '1') {
      Say "  リリース v$want を探しています..."
      $got = Get-ReleaseExe $want $work
      if ($got) {
        Install-Exe $got "release v$want"
        Say "  リリース v$want の atlas.exe を置きました(sha256 を確かめました)"
        exit 0
      }
      Say "  $($script:DownloadReason)"
    }
    $missing = Get-MissingTools
    if ($missing.Count -eq 0) {
      Say '  この PC でビルドします。'
      $got = Build-LocalExe $work
      if ($got) {
        Install-Exe $got ('local ' + (Get-Head))
        exit 0
      }
      Show-LogTail
      Say ''
      Say 'atlas をビルドできませんでした。上の記録を確かめてください。'
      exit 1
    }
    Say ''
    Say "atlas.exe を用意できませんでした(版 v$want)。次のどちらかをしてから、もう一度実行してください:"
    Say "  - Node.js 24 以上(https://nodejs.org/)と Rust(https://rustup.rs/)を入れる。この PC でビルドします(足りないもの: $($missing -join '、'))"
    Say "  - 版 v$want のリリースが出るのを待つ(出ていなければ、atlas を作っている人に知らせてください)"
    exit 1
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
} catch {
  Say "atlas を用意できませんでした: $($_.Exception.Message)"
  exit 1
}
