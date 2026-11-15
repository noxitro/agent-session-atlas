# M365 Copilot のアプリ(または Edge で開いた M365 Copilot)を UI Automation で操作し、添付ファイル 1 つを判定させて返答を書き出す。
# m365.ts が 1 ファイルごとに起動する(Windows PowerShell 5.1)。標準出力の 1 行ずつが進み具合(progress: …)か失敗(error: …)。
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File m365-uia.ps1 -Attach <ファイル> -Prompt <依頼文> -Model "Think Deeper" -TimeoutSec 900 -OutFile <返答>
#   -Probe だけなら、画面が見つかるかと今のモデルを出して終わる(何も送らない)
# 手順: 新しいチャット → モデルを選ぶ → 依頼文を打つ → 「画像とファイルのアップロード」でファイルを添付 → 送る → 返答が終わるまで待つ → 返答の文字を書き出す。
# 利用者がほかのアプリで作業していてもよいように、M365 Copilot が前面に出たらすぐ戻し(AtlasM365Guard)、入力欄に混ざった文字は送る前に消して打ち直す。
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
Add-Type @"
using System; using System.Collections.Generic; using System.Diagnostics; using System.Runtime.InteropServices; using System.Text; using System.Threading;
public static class AtlasM365Win32 {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] public static extern IntPtr SendMessageText(IntPtr h, int msg, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  /// 窓を前面に出す。前面の窓の入力に一時的につなぐと、裏のプロセスからでも前面を移せる
  public static bool Front(IntPtr h) {
    var fg = GetForegroundWindow();
    if (fg == h) return true;
    uint pid;
    uint other = GetWindowThreadProcessId(fg, out pid), me = GetCurrentThreadId();
    AttachThreadInput(me, other, true);
    SetForegroundWindow(h);
    AttachThreadInput(me, other, false);
    return GetForegroundWindow() == h;
  }
  /// 前面の窓の入力欄を text にする(clear なら Ctrl+A と Backspace で消してから)。
  /// 1 回の SendInput にまとめるので、利用者の入力が途中に割り込まない。文字は KEYEVENTF_UNICODE で打つ(クリップボードも IME も使わない)
  public static uint ReplaceText(string text, bool clear) {
    var l = new List<INPUT>();
    if (clear) { l.Add(Key(0x11, 0, 0)); l.Add(Key(0x41, 0, 0)); l.Add(Key(0x41, 0, 2)); l.Add(Key(0x11, 0, 2)); l.Add(Key(0x08, 0, 0)); l.Add(Key(0x08, 0, 2)); }
    foreach (char c in text) { l.Add(Key(0, c, 4)); l.Add(Key(0, c, 4 | 2)); }
    var a = l.ToArray();
    return SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
  }
}
/// 利用者がほかのアプリで作業していても邪魔しないための見張り(別スレッド)。
/// 画面の部品を押すと、少し遅れて M365 Copilot(やファイルを選ぶ画面)が前面に出て、利用者が打った文字がその入力欄に入ってしまう。
/// Active のあいだは、M365 Copilot が前面に出たらすぐ、直前に利用者が使っていた窓へ戻す
public static class AtlasM365Guard {
  static volatile bool active;
  static uint copilotPid, ownPid;
  static readonly List<IntPtr> recent = new List<IntPtr>();
  static readonly object gate = new object();
  public static int Restored, Failed, Loops;
  public static string LastError = "";
  public static bool Active { get { return active; } set { active = value; } }
  public static void Start(uint copilot) {
    copilotPid = copilot;
    ownPid = (uint)Process.GetCurrentProcess().Id;
    var t = new Thread(Loop); t.IsBackground = true; t.Start();
  }
  /// 直前に利用者が使っていた窓(閉じた窓・隠れた窓・最小化した窓は除く)
  public static IntPtr UserWindow() {
    lock (gate) {
      for (int i = recent.Count - 1; i >= 0; i--) {
        var h = recent[i];
        if (AtlasM365Win32.IsWindow(h) && AtlasM365Win32.IsWindowVisible(h) && !AtlasM365Win32.IsIconic(h)) return h;
      }
    }
    return IntPtr.Zero;
  }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
  static void Loop() {
    // このスレッドに入力のキューを作る(キューが無いと、前面を戻すための AttachThreadInput が効かない)
    MSG m; PeekMessage(out m, IntPtr.Zero, 0, 0, 0);
    while (true) {
      try {
        var fg = AtlasM365Win32.GetForegroundWindow();
        uint pid = 0;
        if (fg != IntPtr.Zero) AtlasM365Win32.GetWindowThreadProcessId(fg, out pid);
        if (fg == IntPtr.Zero) { }
        else if (pid == copilotPid) {
          if (active) { var u = UserWindow(); if (u != IntPtr.Zero) { if (AtlasM365Win32.Front(u)) Restored++; else Failed++; } }
        } else if (pid != ownPid && AtlasM365Win32.IsWindowVisible(fg)) {
          lock (gate) { recent.Remove(fg); recent.Add(fg); if (recent.Count > 8) recent.RemoveAt(0); }
        }
      } catch (Exception e) { LastError = e.Message; }
      Loops++;
      Thread.Sleep(30);
    }
  }
}
"@
# 開いたままのファイルを選ぶ画面(止まったときに「キャンセル」で閉じる)
$script:DialogHwnd = [IntPtr]::Zero

function Say([string]$msg) { [Console]::Out.WriteLine("progress: $msg"); [Console]::Out.Flush() }
# 画面が見つからないとき(やり直しても同じなので、呼び出し側は残りを送らずに止まる)は終了コード 3、それ以外は 2
function Fail([string]$msg, [int]$code = 2) {
  if ($script:DialogHwnd -ne [IntPtr]::Zero) { $null = [AtlasM365Win32]::PostMessage($script:DialogHwnd, 0x0111, [IntPtr]2, [IntPtr]::Zero) }
  [Console]::Out.WriteLine("error: $msg"); [Console]::Out.Flush(); exit $code
}
function ClassOf([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 64
  $null = [AtlasM365Win32]::GetClassName($h, $sb, 64)
  $sb.ToString()
}
# アプリが出したファイルを選ぶ画面(#32770)。アプリの窓の下か、デスクトップの直下にある
function FileDialog($win, $procCond) {
  $d = $win.FindFirst($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32770')))
  if (-not $d) { $d = @($AE::RootElement.FindAll($Scope::Children, $procCond) | Where-Object { $_.Current.ClassName -eq '#32770' })[0] }
  $d
}

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
    Start-Sleep -Milliseconds 250
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
# M365 Copilot の 1 日の利用上限に達した(返答がこの知らせになり、入力欄が消える。翌朝まで送れないので、やり直さずに止める)
$LimitMessage = 'M365 Copilot の 1 日の利用上限に達しました。M365 Copilot に出ている時刻(翌朝)を過ぎてから、もう一度実行してください(残りのファイルはそのとき送ります)'
function LimitReached($root) { [bool](ByName $root $CT::Text @('*1 日の上限に達しました*', '*日の上限に達しました*', '*daily limit*', '*reached your*limit*')) }
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
if (-not $win) {
  # 入力欄が無いのが上限のせいなら、そう伝える
  foreach ($proc in (Get-Process -Name 'copilotapp', 'msedge' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })) {
    $w = $AE::FromHandle($proc.MainWindowHandle)
    if ($w -and (LimitReached $w)) { Fail $LimitMessage 3 }
  }
  Fail 'M365 Copilot の画面が見つかりません。M365 Copilot のアプリ(または Edge で m365.cloud.microsoft)を開き、サインインしてチャットの画面を出してください' 3 }
$mb = ModelButton $win
$current = if ($mb) { $mb.Current.Name -replace '、.*$', '' -replace ',.*$', '' } else { '(不明)' }
if ($Probe) { [Console]::Out.WriteLine("ok: $($win.Current.Name) model=$current"); exit 0 }
if (-not $Attach -or -not (Test-Path -LiteralPath $Attach)) { Fail "添付するファイルがありません: $Attach" }
if (-not $OutFile) { Fail '-OutFile がありません' }
$attachName = [System.IO.Path]::GetFileName($Attach)
$top = [IntPtr]$win.Current.NativeWindowHandle
# ここから送るまで、M365 Copilot が前面に出たら利用者の窓へ戻す
[AtlasM365Guard]::Start([uint32]$win.Current.ProcessId)
[AtlasM365Guard]::Active = $true

# 入力欄の文字が依頼文と同じか
function EditorText {
  $ed = ById $win 'm365-chat-editor-target-element'
  if (-not $ed) { return $null }
  $v = Pattern $ed ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($v) { "$($v.Current.Value)" } else { $null }
}
function EditorHasPrompt { "$(EditorText)".Trim() -eq $Prompt.Trim() }
# 入力欄を依頼文にする。UIA の SetValue は、入力欄に文字が残っていると効かないので、キー入力で打つ。
# M365 Copilot を一瞬(0.3 秒ほど)前面に出し、Ctrl+A・Backspace・依頼文の文字を 1 回の SendInput で送って、すぐ利用者の窓へ戻す。
# 前面に出ていたあいだに利用者が打った文字が混ざったら、消して打ち直す
function TypePrompt {
  for ($i = 1; $i -le 4 -and -not (EditorHasPrompt); $i++) {
    $user = [AtlasM365Guard]::UserWindow()
    [AtlasM365Guard]::Active = $false
    try {
      if (-not [AtlasM365Win32]::Front($top)) { continue }
      $ed = ById $win 'm365-chat-editor-target-element'
      if (-not $ed) { continue }
      $ed.SetFocus()
      # 前面が M365 Copilot のままのときだけ送る(ほかの窓へキーが行かないように)
      if ([AtlasM365Win32]::GetForegroundWindow() -ne $top) { continue }
      $null = [AtlasM365Win32]::ReplaceText($Prompt, "$(EditorText)".Length -gt 0)
      for ($k = 0; $k -lt 60 -and -not (EditorHasPrompt); $k++) { Start-Sleep -Milliseconds 25 }
    } finally {
      if ($user -ne [IntPtr]::Zero) { $null = [AtlasM365Win32]::Front($user) }
      [AtlasM365Guard]::Active = $true
    }
    if (-not (EditorHasPrompt)) { Start-Sleep -Milliseconds 500 }
  }
  if (-not (EditorHasPrompt)) { Fail "入力欄に依頼文を入れられませんでした(今: $(EditorText))" }
}

# 1. 新しいチャット(前の判定の会話を混ぜない)
$newChat = ByName $win $CT::Hyperlink @('新しいチャット', 'New chat')
if (-not $newChat) { $newChat = ByName $win $CT::Button @('新しいチャット', 'New chat') }
if (-not $newChat) { Fail '「新しいチャット」が見つかりません(左の欄を開いてから、もう一度試してください)' }
Press $newChat
Start-Sleep -Seconds 1
$null = WaitFor { ById $win 'm365-chat-editor-target-element' } 30 '新しいチャットの入力欄'
Say '新しいチャットを開きました'

# 2. モデルを選ぶ(既に選ばれていればそのまま)
$mb = WaitFor { ModelButton $win } 15 'モデルの選択'
if ($mb.Current.Name -notlike "$Model*") {
  $ec = Pattern $mb ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  if ($ec) { $ec.Expand() } else { Press $mb }
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

# 依頼文は添付より先に入れる(入力欄が空のまま Backspace を打つと、添付を消してしまうことがあるため)
TypePrompt

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
$dialog = WaitFor { FileDialog $win $procCond } 15 'ファイルを選ぶ画面'
$script:DialogHwnd = [IntPtr]$dialog.Current.NativeWindowHandle
# この画面の中の部品は UIA の pattern を出さない(アプリの窓の下にあるため)。Win32 の窓に直接入れる:
# 「ファイル名」(1148 の Edit)に WM_SETTEXT でパスを入れ、画面に WM_COMMAND の IDOK(「開く」)を送る。前面でなくても届く
$nameEdit = WaitFor {
  @($dialog.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, '1148'))) | Where-Object { (ClassOf ([IntPtr]$_.Current.NativeWindowHandle)) -eq 'Edit' })[0]
} 10 'ファイルを選ぶ画面の「ファイル名」'
$path = (Resolve-Path -LiteralPath $Attach).Path
$null = [AtlasM365Win32]::SendMessageText([IntPtr]$nameEdit.Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero, $path)
$null = [AtlasM365Win32]::PostMessage($script:DialogHwnd, 0x0111, [IntPtr]1, [IntPtr]::Zero)
$null = WaitFor { if (-not (FileDialog $win $procCond)) { $true } } 15 'ファイルを選ぶ画面が閉じること'
$script:DialogHwnd = [IntPtr]::Zero
# 添付したファイルの名前は、文字(Text)のときと、添付の欄のボタンやグループのときがある
$null = WaitFor { foreach ($ty in @($CT::Text, $CT::Button, $CT::Group)) { $e = ByName $win $ty @("*$attachName*"); if ($e) { return $e } } } 120 "添付した $attachName"
Say "添付しました: $attachName"

# 4. 送る(添付の読み込みが終わるまで送るボタンは押せない)。
# 添付のあいだに利用者の打った文字が入力欄に混ざることがあるので、押す直前に確かめ、違えば打ち直す
$before = (CopilotMessages $win).Count
$send = WaitFor {
  $b = ByName $win $CT::Button @('送信', '*送信*', 'Send', 'Submit')
  if ($b -and $b.Current.IsEnabled) { $b }
} 180 '押せる「送信」ボタン'
TypePrompt
# 添付のアップロードが終わる前に押すと送られない(依頼文が先に入っているので、送信ボタンはその間も押せる)。入力欄が空くまで 3 秒おきに押し直す
Press $send
$script:SentAt = Get-Date
$null = WaitFor {
  if (-not (EditorHasPrompt)) { return $true }
  if (((Get-Date) - $script:SentAt).TotalSeconds -ge 3) { Press $send; $script:SentAt = Get-Date }
} 120 '送った依頼が入力欄から消えること'
Say '送りました。返答を待っています'
# 送った後に M365 Copilot が前面に出ることもあるので、少し見張ってから止める
Start-Sleep -Seconds 3
[AtlasM365Guard]::Active = $false
if ([AtlasM365Guard]::Restored + [AtlasM365Guard]::Failed -gt 0) { Say ("M365 Copilot が前面に出たので戻しました({0} 回、戻せなかった {1} 回)" -f [AtlasM365Guard]::Restored, [AtlasM365Guard]::Failed) }

# 5. 返答が終わるまで待つ(返答が増え、停止のボタンが消え、その返答にコピーのボタンが出て、2 回続けて同じ文字)。
# 返答も停止のボタンも出ないまま 180 秒たったら、送った依頼が画面から消えたとみなして止める(呼び出し側がやり直す)
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$started = Get-Date
$last = ''
$lastSay = Get-Date
$seen = $false
$text = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if (((Get-Date) - $lastSay).TotalSeconds -ge 30) {
    Say ("返答を待っています({0} 秒)" -f [int]((Get-Date) - $started).TotalSeconds)
    $lastSay = Get-Date
  }
  $msgs = CopilotMessages $win
  if ($msgs.Count -gt $before -and (LimitReached $msgs[$msgs.Count - 1])) { Fail $LimitMessage 3 }
  $busy = StopButton $win
  if ($busy) { $seen = $true }
  if ($msgs.Count -le $before) {
    if (-not $seen -and ((Get-Date) - $started).TotalSeconds -ge 180) { Fail '送ってから 180 秒たっても返答が始まりません(画面が別のチャットに移ったかもしれません)' }
    continue
  }
  $seen = $true
  $msg = $msgs[$msgs.Count - 1]
  $copy = ByName $msg $CT::Button @('*コピー*', '*Copy*')
  if ($copy -and -not $busy) {
    $t = MessageText $msg
    if ($t -and $t -eq $last) { $text = $t; break }
    $last = $t
  }
}
if ($null -eq $text) { Fail "返答が $TimeoutSec 秒で終わりませんでした(--timeout で延ばせます)" }
$text = $text -replace '^\s*(Copilot said:|Copilot の発言:)\s*', ''
[System.IO.File]::WriteAllText($OutFile, $text, (New-Object System.Text.UTF8Encoding $false))
Say ("返答を受け取りました({0} 文字、{1} 秒)" -f $text.Length, [int]((Get-Date) - $started).TotalSeconds)
exit 0
