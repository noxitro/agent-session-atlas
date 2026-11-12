# M365 Copilot のアプリ(または Edge で開いた M365 Copilot)を UI Automation で操作し、添付ファイル 1 つを判定させて返答を書き出す。
# m365.ts が 1 ファイルごとに起動する(Windows PowerShell 5.1)。標準出力の 1 行ずつが進み具合(progress: …)か失敗(error: …)。
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File m365-uia.ps1 -Attach <ファイル> -Prompt <依頼文> -Model "Think Deeper" -TimeoutSec 900 -OutFile <返答>
#   -Probe だけなら、画面が見つかるかと今のモデルを出して終わる(何も送らない)
# 手順: 新しいチャット → モデルを選ぶ → 「画像とファイルのアップロード」でファイルを添付 → 依頼文を入れて送る → 返答が終わるまで待つ → 返答の文字を書き出す。
# 画面の要素は名前(日本語・英語)と AutomationId で探す。画面の作りが変わると見つからなくなるので、そのときは何をしていたかを error に出して止まる。
param(
  [string]$Attach,
  [string]$Prompt,
  [string]$Model = 'Think Deeper',
  [int]$TimeoutSec = 900,
  [string]$OutFile,
  [switch]$Probe
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$True_ = [System.Windows.Automation.Condition]::TrueCondition

function Say([string]$msg) { [Console]::Out.WriteLine("progress: $msg"); [Console]::Out.Flush() }
function Fail([string]$msg) { [Console]::Out.WriteLine("error: $msg"); [Console]::Out.Flush(); exit 2 }

function ById($root, [string]$aid) {
  $root.FindFirst($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $aid)))
}
function OfType($root, $type) {
  $root.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type)))
}
# 名前がどれかの形に合う最初の要素(-like の形。日本語と英語の画面のどちらにも合わせる)
function ByName($root, $type, [string[]]$patterns) {
  foreach ($e in (OfType $root $type)) {
    $n = $e.Current.Name
    foreach ($p in $patterns) { if ($n -like $p) { return $e } }
  }
  return $null
}
function Pattern($el, $pattern) {
  $obj = $null
  if ($el.TryGetCurrentPattern($pattern, [ref]$obj)) { return $obj }
  return $null
}
function Press($el) {
  $p = Pattern $el ([System.Windows.Automation.InvokePattern]::Pattern)
  if ($p) { $p.Invoke(); return }
  $s = Pattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($s) { $s.Select(); return }
  $x = Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  if ($x) { $x.Expand(); return }
  throw "押せない要素です: $($el.Current.Name)"
}
function WaitFor([scriptblock]$probe, [int]$seconds, [string]$what) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $r = & $probe
    if ($r) { return $r }
    Start-Sleep -Milliseconds 500
  }
  Fail "$what が $seconds 秒たっても見つかりません(M365 Copilot の画面の作りが変わったかもしれません)"
}
# 開いている M365 Copilot の画面(入力欄 m365-chat-editor-target-element がある窓)。アプリ(copilotapp)を先に、無ければ Edge を探す
function FindWindow {
  foreach ($name in @('copilotapp', 'msedge')) {
    foreach ($proc in (Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })) {
      $w = $AE::FromHandle($proc.MainWindowHandle)
      if ($w -and (ById $w 'm365-chat-editor-target-element')) { return $w }
    }
  }
  return $null
}
function ModelButton($win) { ByName $win $CT::Button @('*モデル セレクター*', '*model selector*', '*Model selector*') }
function CopilotMessages($win) {
  @((OfType $win $CT::Group) | Where-Object { $_.Current.ClassName -like 'fai-CopilotMessage *' })
}
function StopButton($win) { ByName $win $CT::Button @('*応答を停止*', '*停止*', 'Stop*', '*Stop generating*', '*Stop responding*') }
# 返答の文字: その返答を含む文書の TextPattern で範囲を取る。取れなければ中の Text 要素の名前をつなぐ
function MessageText($msg) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $doc = $walker.GetParent($msg)
  while ($doc -and $doc.Current.ControlType -ne $CT::Document) { $doc = $walker.GetParent($doc) }
  if ($doc) {
    $tp = Pattern $doc ([System.Windows.Automation.TextPattern]::Pattern)
    if ($tp) {
      try { return $tp.RangeFromChild($msg).GetText(-1) } catch { }
    }
  }
  ((OfType $msg $CT::Text) | ForEach-Object { $_.Current.Name }) -join "`n"
}

$win = FindWindow
if (-not $win) { Fail 'M365 Copilot の画面が見つかりません。M365 Copilot のアプリ(または Edge で m365.cloud.microsoft)を開き、サインインしてチャットの画面を出してください' }
$mb = ModelButton $win
$current = if ($mb) { $mb.Current.Name -replace '、.*$', '' -replace ',.*$', '' } else { '(不明)' }
if ($Probe) { [Console]::Out.WriteLine("ok: $($win.Current.Name) model=$current"); exit 0 }
if (-not $Attach -or -not (Test-Path -LiteralPath $Attach)) { Fail "添付するファイルがありません: $Attach" }
if (-not $OutFile) { Fail '-OutFile がありません' }
$attachName = [System.IO.Path]::GetFileName($Attach)

# 1. 新しいチャット(前の判定の会話を混ぜない)
$newChat = ByName $win $CT::Hyperlink @('新しいチャット', 'New chat')
if (-not $newChat) { $newChat = ByName $win $CT::Button @('新しいチャット', 'New chat') }
if (-not $newChat) { Fail '「新しいチャット」が見つかりません(左の欄を開いてから、もう一度試してください)' }
Press $newChat
Start-Sleep -Seconds 2
$null = WaitFor { ById $win 'm365-chat-editor-target-element' } 30 '新しいチャットの入力欄'
Say '新しいチャットを開きました'

# 2. モデルを選ぶ(既に選ばれていればそのまま)
$mb = WaitFor { ModelButton $win } 15 'モデルの選択'
if ($mb.Current.Name -notlike "$Model*") {
  $ec = Pattern $mb ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  if ($ec) { $ec.Expand() } else { Press $mb }
  Start-Sleep -Milliseconds 800
  $procCond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $win.Current.ProcessId)
  $radio = WaitFor {
    @($AE::RootElement.FindAll($Scope::Descendants, $procCond) | Where-Object { $_.Current.ControlType -eq $CT::RadioButton -and $_.Current.Name -like "$Model*" })[0]
  } 10 "モデル「$Model」の選択肢"
  Press $radio
  Start-Sleep -Milliseconds 800
  $mb = ModelButton $win
  if (-not $mb -or $mb.Current.Name -notlike "$Model*") { Fail "モデル「$Model」を選べませんでした(今: $($mb.Current.Name))" }
}
Say "モデル: $Model"

# 3. ファイルを添付する(「ソースの追加と管理」→「画像とファイルのアップロード」→ ファイルを選ぶ画面)
$add = ByName $win $CT::Button @('*ソースの追加*', '*Add*source*', '*Add content*')
if (-not $add) { Fail '「ソースの追加と管理」のボタンが見つかりません' }
$ec = Pattern $add ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
if ($ec) { $ec.Expand() } else { Press $add }
$procCond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $win.Current.ProcessId)
$upload = WaitFor {
  @($AE::RootElement.FindAll($Scope::Descendants, $procCond) | Where-Object { $_.Current.ControlType -eq $CT::MenuItem -and ($_.Current.Name -like '*ファイルのアップロード*' -or $_.Current.Name -like '*Upload*') })[0]
} 10 '「画像とファイルのアップロード」'
Press $upload
$dialog = WaitFor {
  $d = $win.FindFirst($Scope::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32770')))
  if (-not $d) { $d = @($AE::RootElement.FindAll($Scope::Children, $procCond) | Where-Object { $_.Current.ClassName -eq '#32770' })[0] }
  $d
} 15 'ファイルを選ぶ画面'
$nameBox = WaitFor { ById $dialog '1148' } 10 'ファイルを選ぶ画面の「ファイル名」'
$vp = Pattern $nameBox ([System.Windows.Automation.ValuePattern]::Pattern)
if (-not $vp) { Fail 'ファイルを選ぶ画面の「ファイル名」に書けません' }
$vp.SetValue((Resolve-Path -LiteralPath $Attach).Path)
$open = $dialog.FindFirst($Scope::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, '1')))
if (-not $open) { Fail 'ファイルを選ぶ画面の「開く」が見つかりません' }
Press $open
$null = WaitFor { if (-not ($win.FindFirst($Scope::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32770'))))) { $true } } 15 'ファイルを選ぶ画面が閉じること'
$null = WaitFor { ByName $win $CT::Text @("*$attachName*") ; } 120 "添付した $attachName"
Say "添付しました: $attachName"

# 4. 依頼文を入れて送る(添付の読み込みが終わるまで送るボタンは押せない)
$editor = ById $win 'm365-chat-editor-target-element'
$ev = Pattern $editor ([System.Windows.Automation.ValuePattern]::Pattern)
if (-not $ev) { Fail '入力欄に書けません' }
$ev.SetValue($Prompt)
$before = (CopilotMessages $win).Count
$send = WaitFor {
  $b = ByName $win $CT::Button @('送信', '*送信*', 'Send', 'Submit')
  if ($b -and $b.Current.IsEnabled) { $b }
} 180 '押せる「送信」ボタン'
Press $send
Say '送りました。返答を待っています'

# 5. 返答が終わるまで待つ(返答が増え、停止のボタンが消え、その返答にコピーのボタンが出て、2 回続けて同じ文字)
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$started = Get-Date
$last = ''
$lastSay = Get-Date
$text = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  $msgs = CopilotMessages $win
  if ($msgs.Count -le $before) { continue }
  $msg = $msgs[$msgs.Count - 1]
  $copy = ByName $msg $CT::Button @('*コピー*', '*Copy*')
  $busy = StopButton $win
  if ($copy -and -not $busy) {
    $t = MessageText $msg
    if ($t -and $t -eq $last) { $text = $t; break }
    $last = $t
  }
  if (((Get-Date) - $lastSay).TotalSeconds -ge 30) {
    Say ("返答を待っています({0} 秒)" -f [int]((Get-Date) - $started).TotalSeconds)
    $lastSay = Get-Date
  }
}
if ($null -eq $text) { Fail "返答が $TimeoutSec 秒で終わりませんでした(--timeout で延ばせます)" }
$text = $text -replace '^\s*(Copilot said:|Copilot の発言:)\s*', ''
[System.IO.File]::WriteAllText($OutFile, $text, (New-Object System.Text.UTF8Encoding $false))
Say ("返答を受け取りました({0} 文字、{1} 秒)" -f $text.Length, [int]((Get-Date) - $started).TotalSeconds)
exit 0
