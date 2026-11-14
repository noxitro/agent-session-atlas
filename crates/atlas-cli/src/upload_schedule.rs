//! 毎日決まった時刻に、プロジェクトのセッションを自動で送る(TS 版の packages/cli/src/upload-schedule.ts の移植。schedule-upload.bat から `atlas upload-schedule` で呼ぶ)。
//! Windows のタスク スケジューラに、自分のユーザーで動くタスクを 1 つ登録する。タスクは窓を出さずに `atlas upload-auto` を動かし、
//! 集計し直してから、画面の「プロジェクト別」で「まとめて送る」に印を付けたプロジェクトを、覚えた送り先(uploadRoot)へ送る。
//! 送る前の確認は出さない(登録するときに承知してもらう)。結果は out/auto-upload.json と out/auto-upload.log に残し、ここで見せる。
//!
//! タスクの作り(TS 版と同じ):
//!  - 毎日 HH:MM(1 日に何回かでもよい。時刻ごとにトリガーを 1 つ)。その時刻に PC が止まっていたら、次に使い始めたときに動かす(StartWhenAvailable)
//!  - ログオンしている間だけ、自分のユーザーで動かす(Interactive)
//!  - 電池で動いているときも動かし、電池に切り替わっても止めない
//!  - 窓は出さない(conhost.exe --headless)。2 時間で打ち切り、前の回が動いていれば重ねない
//!
//! TS 版との違い: タスクが動かすのは `conhost.exe --headless "<node>" "<upload-auto.ts>"` ではなく
//! `conhost.exe --headless "<リポジトリ>\bin\atlas.exe" upload-auto`(--no-update はどちらも末尾)。
//! TS 版で登録したタスクは、packages/cli/src/upload-auto.ts(互換の入口)が bin\atlas.exe を動かすので、そのままでも送れる。
//! schedule-upload.bat を開いたときに TS 版のタスクだと分かれば、時刻と自動更新の設定はそのままで、atlas.exe を動かす形に登録し直す。

use crate::upload_auto_files::{AutoStatusFile, AUTO_LOG_FILE, AUTO_STATUS_FILE, NO_UPDATE_FLAG};
use crate::upload_project::ConsoleIo;
use regex::Regex;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use unicode_normalization::UnicodeNormalization;

/// タスク スケジューラでの名前(ライブラリの直下。サブフォルダは、作る権限が無い PC があるため使わない)
pub const TASK_NAME: &str = "agent-session-atlas-upload";
/// 時刻を入れずに Enter を押したときの時刻
pub const DEFAULT_TIME: &str = "18:00";
/// タスクが動かす atlas のサブコマンド
pub const AUTO_COMMAND: &str = "upload-auto";

/// PowerShell のスクリプトを動かした結果
#[derive(Debug, Clone, PartialEq)]
pub struct PsResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// PowerShell を動かす口(テストでは偽物を渡す)。値はスクリプトに埋め込まず、環境変数で渡す(引用符の扱いで壊さない)
pub type PsRunner<'a> = &'a dyn Fn(&str, &[(String, String)]) -> anyhow::Result<PsResult>;

/// Windows に入っている PowerShell 5.1 で動かす(タスク スケジューラの操作と、Windows の通知を出すのに使う)
pub fn run_power_shell(script: &str, env: &[(String, String)]) -> anyhow::Result<PsResult> {
    if let Some(dir) = std::env::var_os("ATLAS_PARITY_FAKE_PS") {
        return Ok(parity_fake_power_shell(Path::new(&dir), script, env));
    }
    // 進み具合(初めてモジュールを読むときの「準備しています」など)はエラー出力に混ざるので出さない
    let body = format!("$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n{script}");
    let mut c = std::process::Command::new("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &crate::sys::encoded_command(&body)]).stdin(std::process::Stdio::null());
    for (k, v) in env {
        c.env(k, v);
    }
    crate::self_update::hide_window(&mut c);
    let o = c.output().map_err(|e| anyhow::anyhow!("PowerShell を動かせませんでした({e})"))?;
    Ok(PsResult { code: o.status.code().unwrap_or(1), stdout: String::from_utf8_lossy(&o.stdout).into_owned(), stderr: String::from_utf8_lossy(&o.stderr).into_owned() })
}

/// 試すとき用の偽の PowerShell(環境変数 ATLAS_PARITY_FAKE_PS=<フォルダ>。TS 版との突き合わせに使ったもの)。
/// 本物のタスク スケジューラと通知に触れずに、渡すはずだった値を比べるため。呼ばれたスクリプトの種類と環境変数を <フォルダ>/calls.jsonl に 1 行ずつ足し、
/// (スクリプトは sha256 で残す)。<フォルダ>/<種類>.json があれば、その { code, stdout, stderr } を返す(無ければ code 0)
fn parity_fake_power_shell(dir: &Path, script: &str, env: &[(String, String)]) -> PsResult {
    let kind = match script {
        s if s == QUERY_SCRIPT => "query",
        s if s == REGISTER_SCRIPT => "register",
        s if s == START_SCRIPT => "start",
        s if s == UNREGISTER_SCRIPT => "unregister",
        s if s == crate::upload_auto::TOAST_SCRIPT => "toast",
        _ => "other",
    };
    let mut sorted: Vec<&(String, String)> = env.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut m = serde_json::Map::new();
    for (k, v) in sorted {
        m.insert(k.clone(), serde_json::Value::String(v.clone()));
    }
    use sha2::Digest;
    let line = serde_json::json!({ "kind": kind, "script": hex::encode(sha2::Sha256::digest(script.as_bytes())), "env": m });
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("calls.jsonl")) {
        use std::io::Write;
        let _ = writeln!(f, "{}", atlas_core::json::to_js_string(&line).unwrap_or_default());
    }
    let reply = std::fs::read(dir.join(format!("{kind}.json"))).ok().and_then(|t| atlas_core::js::parse_json(&String::from_utf8_lossy(&t)).ok());
    let get = |k: &str| reply.as_ref().and_then(|r| r.get(k)).and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    PsResult { code: reply.as_ref().and_then(|r| r.get("code")).and_then(serde_json::Value::as_i64).unwrap_or(0) as i32, stdout: get("stdout"), stderr: get("stderr") }
}

static CLIXML_S: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?s)<S S="Error">(.*?)</S>"#).unwrap());
static CLIXML_X: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"_x([0-9A-Fa-f]{4})_").unwrap());

/// PowerShell のエラー出力を読める文にする。-EncodedCommand で動かすと、エラーは CLIXML(#< CLIXML の後の XML)で届くので、
/// エラーの文(<S S="Error">)だけを取り出す
pub fn ps_error_text(stderr: &str) -> String {
    if !stderr.trim_start_matches(atlas_core::js::is_js_whitespace).starts_with("#< CLIXML") {
        return atlas_core::js::trim(stderr).to_string();
    }
    let xml = |s: &str| -> String {
        // String.fromCharCode なので、サロゲートの片割れも 1 単位として扱う
        let mut units: Vec<u16> = Vec::new();
        let mut last = 0;
        for m in CLIXML_X.captures_iter(s) {
            let all = m.get(0).unwrap();
            units.extend(s[last..all.start()].encode_utf16());
            units.push(u16::from_str_radix(&m[1], 16).unwrap_or(0));
            last = all.end();
        }
        units.extend(s[last..].encode_utf16());
        String::from_utf16_lossy(&units).replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
    };
    let joined: String = CLIXML_S.captures_iter(stderr).map(|m| xml(&m[1])).collect();
    atlas_core::js::trim(&joined).to_string()
}

/// PowerShell が失敗したときの理由(エラーの最初の行)
fn ps_error(r: &PsResult, what: &str) -> anyhow::Error {
    let text = ps_error_text(&r.stderr);
    let first = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).find(|l| !atlas_core::js::trim(l).is_empty()).map(|l| atlas_core::js::trim(l).to_string());
    anyhow::anyhow!("{what}({})", first.unwrap_or_else(|| format!("終了コード {}", r.code)))
}

static TIME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]{1,2})(?:[:時]?([0-9]{2})分?|:([0-9]{1,2})分?|時)?$").unwrap());
static WS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{}+", atlas_core::js::RE_S)).unwrap());
static TIMES_SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("(?:[,、;]|{})+", atlas_core::js::RE_S)).unwrap());

/// 送る時刻の入力(「18:00」「18」「1830」「18時30分」「8:5」。全角も可)を HH:MM にする。読めない・範囲の外は None
pub fn parse_time(answer: &str) -> Option<String> {
    let n: String = answer.nfkc().collect();
    let s = WS_RE.replace_all(atlas_core::js::trim(&n), "").into_owned();
    let m = TIME_RE.captures(&s)?;
    let h: u32 = m[1].parse().ok()?;
    let min: u32 = m.get(2).or(m.get(3)).map_or(Some(0), |g| g.as_str().parse().ok())?;
    if h > 23 || min > 59 {
        return None;
    }
    Some(format!("{h:02}:{min:02}"))
}

/// 1 日に送る回数の上限(打ち間違いで大量のトリガーを作らないように)
pub const MAX_TIMES: usize = 6;

/// 送る時刻の入力を HH:MM の並び(早い順・重なりなし)にする。1 日に何回か送るときは「12:00,18:00」のように
/// 「,」「、」や空白で区切る。どれか 1 つでも読めない・上限より多いときは None
pub fn parse_times(answer: &str) -> Option<Vec<String>> {
    let n: String = answer.nfkc().collect();
    let parts: Vec<&str> = TIMES_SPLIT.split(&n).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    let mut times: Vec<String> = Vec::new();
    for p in parts {
        let t = parse_time(p)?;
        if !times.contains(&t) {
            times.push(t);
        }
    }
    if times.len() > MAX_TIMES {
        return None;
    }
    times.sort();
    Some(times)
}

/// タスクの登録(同じ名前があれば置き換える)。値は環境変数 ATLAS_TASK_* で渡す
pub const REGISTER_SCRIPT: &str = r#"
$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $env:ATLAS_TASK_ARGS -WorkingDirectory $env:ATLAS_TASK_CWD
$t = @($env:ATLAS_TASK_TIMES -split ',' | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ })
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$p = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $a -Trigger $t -Settings $s -Principal $p -Description $env:ATLAS_TASK_DESCRIPTION
if ($env:ATLAS_TASK_DRY_RUN -eq '1') {
  [Console]::Out.Write((@{ execute = $task.Actions[0].Execute; arguments = $task.Actions[0].Arguments; cwd = $task.Actions[0].WorkingDirectory; times = @($task.Triggers | ForEach-Object { ([datetime]$_.StartBoundary).ToString('HH:mm') }); startWhenAvailable = $task.Settings.StartWhenAvailable; onBatteries = (-not $task.Settings.DisallowStartIfOnBatteries); logon = "$($task.Principal.LogonType)" } | ConvertTo-Json -Compress))
  return
}
Register-ScheduledTask -TaskName $env:ATLAS_TASK_NAME -TaskPath '\' -InputObject $task -Force | Out-Null
"#;

/// タスクの今の様子を JSON で 1 行返す(無ければ {"exists":false})
pub const QUERY_SCRIPT: &str = r#"
$t = Get-ScheduledTask -TaskName $env:ATLAS_TASK_NAME -TaskPath '\' -ErrorAction SilentlyContinue
if (-not $t) { [Console]::Out.Write('{"exists":false}'); return }
$i = $t | Get-ScheduledTaskInfo
function When($d) { if ($d -and $d.Year -gt 2000) { $d.ToString('yyyy-MM-ddTHH:mm:ss') } else { $null } }
$times = @($t.Triggers | Where-Object { $_.StartBoundary } | ForEach-Object { ([datetime]$_.StartBoundary).ToString('HH:mm') } | Sort-Object -Unique)
[Console]::Out.Write((@{ exists = $true; state = "$($t.State)"; times = $times; arguments = $t.Actions[0].Arguments; lastRun = (When $i.LastRunTime); lastResult = $i.LastTaskResult; nextRun = (When $i.NextRunTime) } | ConvertTo-Json -Compress))
"#;

pub const START_SCRIPT: &str = r"Start-ScheduledTask -TaskName $env:ATLAS_TASK_NAME -TaskPath '\'";
pub const UNREGISTER_SCRIPT: &str = r"Unregister-ScheduledTask -TaskName $env:ATLAS_TASK_NAME -TaskPath '\' -Confirm:$false";

/// タスクの今の様子(exists が false なら他は空)
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskState {
    pub exists: bool,
    #[serde(default)]
    pub state: String,
    /// 送る時刻(早い順。トリガーの無いタスクは空。PowerShell 5.1 の ConvertTo-Json は、空の並びを null にすることがある)
    #[serde(default, deserialize_with = "null_as_empty")]
    pub times: Vec<String>,
    #[serde(default)]
    pub arguments: String,
    #[serde(default)]
    pub last_run: Option<String>,
    #[serde(default)]
    pub last_result: Option<f64>,
    #[serde(default)]
    pub next_run: Option<String>,
}

fn null_as_empty<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    // 1 つだけのときに文字列で届くこともある(ConvertTo-Json の配列の扱い)
    let v = serde_json::Value::deserialize(d)?;
    Ok(match v {
        serde_json::Value::Array(a) => a.into_iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        serde_json::Value::String(s) => vec![s],
        _ => Vec::new(),
    })
}

/// 時刻の並びを「12:00・18:00」の形で
pub fn list_times(times: &[String]) -> String {
    times.join("・")
}

/// 窓を出さずに atlas の upload-auto を動かす引数(conhost.exe に渡す)。update が false なら、送る前に atlas を新しい版にしない
pub fn task_arguments(exe: &str, update: bool) -> String {
    format!("--headless \"{exe}\" {AUTO_COMMAND}{}", if update { String::new() } else { format!(" {NO_UPDATE_FLAG}") })
}

/// タスクの引数から、送る前に atlas を新しい版にするかを読む(--no-update が無ければする。この版より前に登録したタスクも、する)
pub fn updates_of(args: &str) -> bool {
    !WS_RE.split(args).any(|a| a == NO_UPDATE_FLAG)
}

static PROGRAM_OF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^--headless "([^"]+)""#).unwrap());

/// タスクの引数から、登録したときに動かすもの(TS 版で登録したタスクは node、この版は atlas の実行ファイル)のパスを取り出す
pub fn program_of(args: &str) -> Option<String> {
    PROGRAM_OF.captures(args).map(|c| c[1].to_string())
}

/// TS 版(node で upload-auto.ts を動かす)で登録したタスクか
pub fn is_ts_task(args: &str) -> bool {
    args.contains("upload-auto.ts")
}

pub trait Scheduler {
    fn query(&self) -> anyhow::Result<TaskState>;
    /// update: 送る前に atlas を新しい版にするか(既定はする)
    fn register(&self, times: &[String], update: bool) -> anyhow::Result<()>;
    fn start(&self) -> anyhow::Result<()>;
    fn unregister(&self) -> anyhow::Result<()>;
}

/// タスク スケジューラを PowerShell で操作する(exe は今動いている atlas を登録する)
pub struct TaskScheduler<'a> {
    pub run: PsRunner<'a>,
    pub exe: String,
    pub cwd: String,
}

/// 既定のタスク スケジューラ(リポジトリの直下の bin\atlas.exe を、リポジトリの直下で動かす。bin\ に無ければ今動いている atlas の実行ファイル)
pub fn task_scheduler() -> TaskScheduler<'static> {
    let exe = crate::paths::installed_exe()
        .map(Ok)
        .unwrap_or_else(std::env::current_exe)
        .map(crate::paths::strip_verbatim)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "atlas.exe".into());
    TaskScheduler { run: &run_power_shell, exe, cwd: crate::paths::REPO_ROOT.to_string_lossy().into_owned() }
}

fn env_of(pairs: &[(&str, String)]) -> Vec<(String, String)> {
    let mut v = vec![("ATLAS_TASK_NAME".to_string(), TASK_NAME.to_string())];
    v.extend(pairs.iter().map(|(k, x)| (k.to_string(), x.clone())));
    v
}

impl Scheduler for TaskScheduler<'_> {
    fn query(&self) -> anyhow::Result<TaskState> {
        let r = (self.run)(QUERY_SCRIPT, &env_of(&[]))?;
        if r.code != 0 {
            return Err(ps_error(&r, "タスク スケジューラを読めませんでした"));
        }
        Ok(atlas_core::js::parse_json_as::<TaskState>(atlas_core::js::trim(&r.stdout))?)
    }
    fn register(&self, times: &[String], update: bool) -> anyhow::Result<()> {
        let r = (self.run)(
            REGISTER_SCRIPT,
            &env_of(&[
                ("ATLAS_TASK_ARGS", task_arguments(&self.exe, update)),
                ("ATLAS_TASK_CWD", self.cwd.clone()),
                ("ATLAS_TASK_TIMES", times.join(",")),
                (
                    "ATLAS_TASK_DESCRIPTION",
                    format!(
                        "agent-session-atlas: 毎日 {} に、{}印を付けたプロジェクトのセッションを送り先へ送ります(schedule-upload.bat で変更・停止できます)",
                        list_times(times),
                        if update { "atlas を新しい版にしてから、" } else { "" }
                    ),
                ),
            ]),
        )?;
        if r.code != 0 {
            return Err(ps_error(&r, "タスクを登録できませんでした"));
        }
        Ok(())
    }
    fn start(&self) -> anyhow::Result<()> {
        let r = (self.run)(START_SCRIPT, &env_of(&[]))?;
        if r.code != 0 {
            return Err(ps_error(&r, "タスクを動かせませんでした"));
        }
        Ok(())
    }
    fn unregister(&self) -> anyhow::Result<()> {
        let r = (self.run)(UNREGISTER_SCRIPT, &env_of(&[]))?;
        if r.code != 0 {
            return Err(ps_error(&r, "タスクを消せませんでした"));
        }
        Ok(())
    }
}

pub fn read_auto_status(out_dir: &Path) -> Option<AutoStatusFile> {
    let t = std::fs::read(out_dir.join(AUTO_STATUS_FILE)).ok()?;
    atlas_core::js::parse_json_as(&String::from_utf8_lossy(&t)).ok()
}

/// 日時を「2026-11-12 18:00」の形で(ローカルの時刻)
pub fn when(iso: Option<&str>) -> String {
    let Some(iso) = iso.filter(|s| !s.is_empty()) else { return "不明".into() };
    if atlas_core::jsdate::parse_ms(iso).is_none() {
        return atlas_core::js::head(iso, 16).replacen('T', " ", 1);
    }
    atlas_report::format::date_time(Some(iso), "不明")
}

/// 前回の結果を 1 行で
pub fn describe_status(s: &AutoStatusFile) -> String {
    let Some(finished) = s.finished_at.as_deref() else {
        return format!("前回: {} に始めて、まだ終わっていません(動いている途中か、途中で止まりました)。", when(Some(&s.started_at)));
    };
    if !s.ok {
        return format!("前回: {} に送れませんでした: {}", when(Some(finished)), s.error.as_deref().unwrap_or("理由は記録をご覧ください"));
    }
    let sessions: f64 = s.sent.iter().map(|p| p.sessions).sum();
    let kept: f64 = s.sent.iter().map(|p| p.unchanged.unwrap_or(0.0)).sum();
    let notes: Vec<String> = [
        if kept != 0.0 { format!("変わっていない {} セッションはそのまま", atlas_core::js::num_to_string(kept)) } else { String::new() },
        if s.secrets != 0.0 { format!("秘密らしい文字列 {} 件を含む", atlas_core::js::num_to_string(s.secrets)) } else { String::new() },
    ]
    .into_iter()
    .filter(|x| !x.is_empty())
    .collect();
    format!(
        "前回: {} に {} プロジェクト・{} セッションを送りました{}。",
        when(Some(finished)),
        s.sent.len(),
        atlas_core::js::num_to_string(sessions),
        if notes.is_empty() { String::new() } else { format!("({})", notes.join("・")) }
    )
}

/// 前回、送る前に atlas を新しい版にしたかを 1 行で(記録が無い・最新だったときは None。知らせることがあるときだけ)
pub fn describe_update(s: &AutoStatusFile) -> Option<String> {
    let u = s.update.as_ref()?.as_ref()?;
    if u.outcome == "latest" {
        return None;
    }
    Some(format!("atlas の更新: {}。", u.note))
}

/// 送り先と印(設定から読むもの)
#[derive(Debug, Clone, Default)]
pub struct ScheduleConfig {
    pub upload_root: Option<String>,
    pub upload_projects: Option<Vec<String>>,
}

pub struct ScheduleOptions<'a> {
    pub scheduler: &'a dyn Scheduler,
    /// 送り先と印を読む設定
    pub config: &'a dyn Fn() -> anyhow::Result<ScheduleConfig>,
    pub out_dir: PathBuf,
    /// 試しに 1 回送ったとき、終わるのを待つ長さ(既定 15 分)と、見に行く間隔(既定 2 秒)
    pub wait: Duration,
    pub poll: Duration,
    /// ファイルがあるか(テストでは偽物を渡す)
    pub exists: &'a dyn Fn(&str) -> bool,
}

fn real_exists(p: &str) -> bool {
    Path::new(p).exists()
}

impl<'a> ScheduleOptions<'a> {
    pub fn new(scheduler: &'a dyn Scheduler, config: &'a dyn Fn() -> anyhow::Result<ScheduleConfig>, out_dir: PathBuf) -> Self {
        ScheduleOptions { scheduler, config, out_dir, wait: Duration::from_secs(15 * 60), poll: Duration::from_secs(2), exists: &real_exists }
    }
}

static YES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?:y|yes|はい)$").unwrap());
static NO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^n(o)?$").unwrap());

fn nfkc(s: &str) -> String {
    s.nfkc().collect()
}

fn yes(a: &str) -> bool {
    YES.is_match(&nfkc(a))
}

/// 黒い窓とのやりとり(upload_project.rs の ConsoleIo と同じ口)
pub type ScheduleIo = dyn ConsoleIo;

/// 試しに 1 回送り、終わるのを待って結果を出す(窓は出ないので、ここで待って見せる)
fn run_once(io: &ScheduleIo, o: &ScheduleOptions<'_>) -> anyhow::Result<()> {
    let before = read_auto_status(&o.out_dir).map(|s| s.started_at).unwrap_or_default();
    o.scheduler.start()?;
    io.print("  送り始めました(窓は出ません)。終わるまで待ちます。この窓を閉じても、送るのは続きます。");
    let started = Instant::now();
    loop {
        if let Some(s) = read_auto_status(&o.out_dir).filter(|s| s.started_at != before && s.finished_at.is_some()) {
            io.print(&format!("  {}", describe_status(&s).strip_prefix("前回: ").map(str::to_string).unwrap_or_else(|| describe_status(&s))));
            if let Some(u) = describe_update(&s) {
                io.print(&format!("  {u}"));
            }
            if !s.ok {
                io.print(&format!("  記録: {}", o.out_dir.join(AUTO_LOG_FILE).display()));
            }
            return Ok(());
        }
        if started.elapsed() > o.wait {
            io.print(&format!("  まだ終わっていません。結果は、もう一度 schedule-upload.bat を開くと見られます(記録: {})。", o.out_dir.join(AUTO_LOG_FILE).display()));
            return Ok(());
        }
        io.status(&format!("  送っています...(経過 {} 秒)", (started.elapsed().as_millis() as f64 / 1000.0).round()));
        std::thread::sleep(o.poll);
    }
}

/// 送る時刻を尋ねる。やめたら None
fn ask_times(io: &ScheduleIo, current: &[String]) -> Option<Vec<String>> {
    let def: Vec<String> = if current.is_empty() { vec![DEFAULT_TIME.to_string()] } else { current.to_vec() };
    loop {
        let a = io.ask(&format!(
            "  送る時刻を入れて Enter(例: 18:00。1 日に何回か送るなら 12:00,18:00 のように「,」で区切る。Enter だけなら {}。やめるなら n)\n  > ",
            list_times(&def)
        ));
        if NO.is_match(atlas_core::js::trim(&nfkc(&a))) {
            return None;
        }
        if atlas_core::js::trim(&a).is_empty() {
            return Some(def);
        }
        if let Some(t) = parse_times(&a) {
            return Some(t);
        }
        io.print(&format!("  「{a}」は時刻として読めません。18:00 や 12:00,18:00 の形で入れ直してください(1 日に {MAX_TIMES} 回まで)。"));
    }
}

/// 対話の本体。登録していなければ、決まりを見せて時刻を尋ね、登録する。登録してあれば、様子と前回の結果を見せ、
/// 時刻を変える・今すぐ 1 回送る・やめる(登録を消す)を選んでもらう
pub fn run_schedule(io: &ScheduleIo, o: &ScheduleOptions<'_>) -> anyhow::Result<()> {
    let exists = o.exists;
    let task = o.scheduler.query()?;
    let cfg = (o.config)()?;
    let last = read_auto_status(&o.out_dir);
    io.print("");
    io.print("== 毎日自動で送る ==");
    if task.exists {
        io.print(&format!(
            "  毎日 {} に送ります{}。",
            if task.times.is_empty() { "(時刻不明)".to_string() } else { list_times(&task.times) },
            task.next_run.as_deref().filter(|s| !s.is_empty()).map(|n| format!("(次: {})", when(Some(n)))).unwrap_or_default()
        ));
        if task.state == "Disabled" {
            io.print("  ただし、タスク スケジューラで「無効」になっています。t で登録し直すと有効に戻ります。");
        }
        if is_ts_task(&task.arguments) {
            if task.times.is_empty() {
                io.print("  前の版(Node.js で動かす版)で登録したタスクです。t で時刻を入れて登録し直してください(atlas.exe で動くようにします)。");
            } else {
                o.scheduler.register(&task.times, updates_of(&task.arguments))?;
                io.print("  前の版(Node.js で動かす版)で登録したタスクだったので、atlas.exe で動くように登録し直しました(時刻と自動更新はそのままです)。");
            }
        } else if let Some(exe) = program_of(&task.arguments) {
            if !exists(&exe) {
                io.print(&format!("  登録したときの atlas の実行ファイルが見つかりません({exe})。t で登録し直してください。"));
            }
        }
        io.print(&format!(
            "  atlas の自動更新: {}",
            if updates_of(&task.arguments) { "送る前に、atlas を新しい版にします" } else { "しません(u で、送る前に新しい版にするよう切り替えられます)" }
        ));
        if let Some(last) = &last {
            io.print(&format!("  {}", describe_status(last)));
            if let Some(u) = describe_update(last) {
                io.print(&format!("  {u}"));
            }
        } else if task.last_run.as_deref().is_some_and(|s| !s.is_empty()) {
            io.print(&format!(
                "  前回: {} に動きましたが、結果の記録がありません(終了コード {})。",
                when(task.last_run.as_deref()),
                task.last_result.map_or("null".to_string(), atlas_core::js::num_to_string)
            ));
        } else {
            io.print("  まだ 1 回も動いていません。");
        }
    } else {
        io.print("  まだ登録していません。");
    }
    // 自動で送るのに要るもの(尋ねずに送るので、先に揃っていないと毎回失敗する)
    let root_ok = cfg.upload_root.as_deref().is_some_and(exists);
    io.print(&format!(
        "  送り先: {}",
        match &cfg.upload_root {
            Some(r) => format!("{r}{}", if root_ok { "" } else { "(今は見つかりません)" }),
            None => "まだ決まっていません".into(),
        }
    ));
    io.print(&format!(
        "  送るプロジェクト: {}",
        match &cfg.upload_projects {
            Some(p) => format!("画面で印を付けた {} プロジェクト({}{})", p.len(), p.iter().take(3).cloned().collect::<Vec<_>>().join("、"), if p.len() > 3 { " ほか" } else { "" }),
            None => "印がありません".into(),
        }
    ));

    if !task.exists {
        let mut missing: Vec<&str> = Vec::new();
        if cfg.upload_root.is_none() {
            missing.push("送り先を決めてください(upload-project.bat を一度使うか、atlas.bat の画面の「設定…」で決められます)。");
        }
        if cfg.upload_projects.is_none() {
            missing.push("送るプロジェクトに印を付けてください(atlas.bat の画面の「プロジェクト別」の表の「まとめて送る」)。");
        }
        if !missing.is_empty() {
            io.print("");
            io.print("== 先に決めること ==");
            for m in missing {
                io.print(&format!("  {m}"));
            }
            io.print("  決めてから、もう一度 schedule-upload.bat を開いてください(何も登録していません)。");
            return Ok(());
        }
        io.print("");
        io.print("== 自動で送るときの決まり ==");
        io.print("  - 毎日決まった時刻に、窓を出さずに集計し直してから、印を付けたプロジェクトを送り先へ送ります。");
        io.print("  - 送る前に、atlas を新しい版にします(git pull。版が変わっていれば、その版の atlas.exe を取ってくるかビルドします)。手でファイルを変えているとき・");
        io.print("    main 以外のブランチのときは、新しい版にせず、今の版のまま送ります。更新しないようにするには、登録した後に u で切り替えます。");
        io.print("  - その時刻に PC が止まっていたら、次に PC を使い始めたときに送ります(ログオンしている間だけ動きます)。");
        io.print("  - 送る前の確認(送り先・大きさ・秘密らしい文字列)は出しません。秘密らしい文字列があっても送り、数を記録に残します。");
        io.print("  - 印の無いプロジェクトは送りません。新しく始めたプロジェクトは、画面で印を付けてください。");
        io.print("  - 送れなかったときは、Windows の通知で知らせます。結果は、この schedule-upload.bat を開くと見られます。");
        io.print("");
        let Some(times) = ask_times(io, &[]) else {
            io.print("  やめました(何も登録していません)。");
            return Ok(());
        };
        o.scheduler.register(&times, true)?;
        io.print(&format!("  登録しました。毎日 {} に送ります。", list_times(&times)));
        io.print("");
        if yes(&io.ask("  今すぐ 1 回送って試しますか? y = 送る   Enter = 送らない\n  > ")) {
            run_once(io, o)?;
        }
        return Ok(());
    }

    io.print("");
    let updating = updates_of(&task.arguments);
    let a = atlas_core::js::to_lower(atlas_core::js::trim(&nfkc(&io.ask(&format!(
        "  t = 時刻を変える   s = 今すぐ 1 回送る   u = atlas の自動更新を{}   d = 自動で送るのをやめる   Enter = 閉じる\n  > ",
        if updating { "やめる" } else { "する" }
    )))));
    match a.as_str() {
        "t" => {
            let Some(times) = ask_times(io, &task.times) else {
                io.print("  やめました(登録は今のままです)。");
                return Ok(());
            };
            o.scheduler.register(&times, updating)?;
            io.print(&format!("  登録し直しました。毎日 {} に送ります。", list_times(&times)));
        }
        "u" => {
            if task.times.is_empty() {
                io.print("  送る時刻が分からないので、切り替えられません。t で時刻を入れて登録し直してください。");
                return Ok(());
            }
            o.scheduler.register(&task.times, !updating)?;
            io.print(if updating {
                "  切り替えました。これからは、送る前に atlas を新しい版にしません(新しい版にするには、git pull してください)。"
            } else {
                "  切り替えました。これからは、送る前に atlas を新しい版にします。"
            });
        }
        "s" => run_once(io, o)?,
        "d" => {
            o.scheduler.unregister()?;
            io.print("  登録を消しました。これからは自動で送りません(送ったものはそのまま残ります)。");
        }
        _ => {}
    }
    Ok(())
}

/// schedule-upload.bat から(`atlas upload-schedule`)。黒い窓とのやりとりは upload-project.bat と同じ作り(尋ねていない間に打ったキーは捨てる)
pub fn main(_argv: &[String]) -> u8 {
    let c = crate::upload_project::Console::new();
    let code = if !cfg!(windows) {
        c.print("毎日自動で送る登録は、Windows でだけ使えます。ほかの OS では、cron などから次を動かしてください:");
        let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "atlas".into());
        c.print(&format!("  \"{exe}\" {AUTO_COMMAND}"));
        1
    } else {
        let sched = task_scheduler();
        let config = || -> anyhow::Result<ScheduleConfig> {
            let c = crate::config::load_config(&crate::config::default_config_path(), false)?;
            Ok(ScheduleConfig { upload_root: c.upload_root, upload_projects: c.upload_projects })
        };
        // ATLAS_OUT は試すとき用(upload-auto と同じ出力先を見る)
        let out_dir = match std::env::var("ATLAS_OUT").ok().filter(|s| !s.is_empty()) {
            Some(o) => crate::paths::resolve(o),
            None => crate::paths::resolve_paths(crate::paths::PathInputs { home: None, out: None, judgments: None, bundle: None, notes_dir: None }).out,
        };
        match run_schedule(&c, &ScheduleOptions::new(&sched, &config, out_dir)) {
            Ok(()) => 0,
            Err(e) => {
                c.clear();
                eprint!("\n止まりました: {e}\n");
                1
            }
        }
    };
    c.close();
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::upload_auto_files::{AutoUpdateResult, SentProject};
    use crate::upload_project::tests::Scripted;
    use std::cell::RefCell;

    #[test]
    fn times() {
        for (i, w) in [("18:00", Some("18:00")), ("18", Some("18:00")), ("1830", Some("18:30")), ("18時30分", Some("18:30")), ("8:5", Some("08:05")), ("１８：３０", Some("18:30")), ("18時", Some("18:00")), ("24:00", None), ("18:60", None), ("x", None), ("", None)] {
            assert_eq!(parse_time(i).as_deref(), w, "{i}");
        }
        assert_eq!(parse_times("18:00, 12:00、18:00").unwrap(), vec!["12:00", "18:00"]);
        assert_eq!(parse_times("1 2 3 4 5 6"), Some(vec!["01:00", "02:00", "03:00", "04:00", "05:00", "06:00"].into_iter().map(String::from).collect()));
        assert_eq!(parse_times("1 2 3 4 5 6 7"), None);
        assert_eq!(parse_times("12:00,x"), None);
        assert_eq!(parse_times(" , "), None);
    }

    #[test]
    fn task_arguments_and_updates() {
        let a = task_arguments("C:\\x\\atlas.exe", true);
        assert_eq!(a, "--headless \"C:\\x\\atlas.exe\" upload-auto");
        assert_eq!(program_of(&a).as_deref(), Some("C:\\x\\atlas.exe"));
        assert!(!is_ts_task(&a));
        assert!(updates_of(&a));
        let b = task_arguments("C:\\x\\atlas.exe", false);
        assert_eq!(b, "--headless \"C:\\x\\atlas.exe\" upload-auto --no-update");
        assert!(!updates_of(&b));
        // TS 版で登録したタスク(node と upload-auto.ts)も読める
        assert!(updates_of("--headless \"C:\\n\\node.exe\" \"C:\\r\\upload-auto.ts\""));
        assert_eq!(program_of("--headless \"C:\\n\\node.exe\" \"C:\\r\\upload-auto.ts\"").as_deref(), Some("C:\\n\\node.exe"));
        assert!(is_ts_task("--headless \"C:\\n\\node.exe\" \"C:\\r\\upload-auto.ts\" --no-update"));
        assert!(REGISTER_SCRIPT.contains("-StartWhenAvailable") && REGISTER_SCRIPT.contains("-AllowStartIfOnBatteries") && REGISTER_SCRIPT.contains("-LogonType Interactive"));
        assert!(REGISTER_SCRIPT.contains("-TaskPath '\\'"));
    }

    #[test]
    fn scheduler_passes_values_by_env_and_reads_json() {
        let calls = RefCell::new(Vec::<(String, Vec<(String, String)>)>::new());
        let run = |s: &str, env: &[(String, String)]| -> anyhow::Result<PsResult> {
            calls.borrow_mut().push((s.to_string(), env.to_vec()));
            if s == QUERY_SCRIPT {
                return Ok(PsResult { code: 0, stdout: r#"{"exists":true,"state":"Ready","times":null,"arguments":"--headless \"a\" upload-auto","lastRun":null,"lastResult":267011,"nextRun":"2026-11-12T18:00:00"}"#.into(), stderr: String::new() });
            }
            Ok(PsResult { code: 1, stdout: String::new(), stderr: "#< CLIXML\r\n<Objs><S S=\"Error\">アクセスが拒否されました。_x000D__x000A_</S><S S=\"Error\">2 行目_x000D__x000A_</S></Objs>".into() })
        };
        let s = TaskScheduler { run: &run, exe: "C:\\a\\atlas.exe".into(), cwd: "C:\\a".into() };
        let t = s.query().unwrap();
        assert!(t.exists);
        assert_eq!(t.times, Vec::<String>::new());
        assert_eq!(t.last_result, Some(267011.0));
        let e = s.register(&["12:00".into(), "18:00".into()], false).unwrap_err();
        assert_eq!(e.to_string(), "タスクを登録できませんでした(アクセスが拒否されました。)");
        let c = calls.borrow();
        let env: std::collections::HashMap<_, _> = c[1].1.iter().cloned().collect();
        assert_eq!(env["ATLAS_TASK_NAME"], TASK_NAME);
        assert_eq!(env["ATLAS_TASK_ARGS"], "--headless \"C:\\a\\atlas.exe\" upload-auto --no-update");
        assert_eq!(env["ATLAS_TASK_CWD"], "C:\\a");
        assert_eq!(env["ATLAS_TASK_TIMES"], "12:00,18:00");
        assert_eq!(env["ATLAS_TASK_DESCRIPTION"], "agent-session-atlas: 毎日 12:00・18:00 に、印を付けたプロジェクトのセッションを送り先へ送ります(schedule-upload.bat で変更・停止できます)");
        assert_eq!(ps_error_text("plain\n"), "plain");
    }

    fn status(o: impl FnOnce(&mut AutoStatusFile)) -> AutoStatusFile {
        let mut s = AutoStatusFile { started_at: "2026-11-12T09:00:00.000Z".into(), finished_at: Some("2026-11-12T09:01:00.000Z".into()), ok: true, error: None, sent: vec![], secrets: 0.0, root: None, update: None };
        o(&mut s);
        s
    }

    #[test]
    fn describe() {
        let s = status(|s| {
            s.sent = vec![SentProject { name: "a".into(), sessions: 3.0, unchanged: Some(2.0) }, SentProject { name: "b".into(), sessions: 1.0, unchanged: None }];
            s.secrets = 2.0;
        });
        assert!(describe_status(&s).ends_with("に 2 プロジェクト・4 セッションを送りました(変わっていない 2 セッションはそのまま・秘密らしい文字列 2 件を含む)。"));
        assert!(describe_status(&status(|s| {
            s.ok = false;
            s.error = Some("x".into())
        }))
        .ends_with("に送れませんでした: x"));
        assert!(describe_status(&status(|s| s.finished_at = None)).ends_with("に始めて、まだ終わっていません(動いている途中か、途中で止まりました)。"));
        let u = |outcome: &str| AutoUpdateResult { outcome: outcome.into(), from: None, to: None, from_sha: None, to_sha: None, note: "n".into() };
        assert_eq!(describe_update(&status(|s| s.update = Some(Some(u("latest"))))), None);
        assert_eq!(describe_update(&status(|_| {})), None);
        assert_eq!(describe_update(&status(|s| s.update = Some(Some(u("skipped"))))).as_deref(), Some("atlas の更新: n。"));
        assert_eq!(when(Some("x-not-a-date-T12")), "x-not-a-date- 12");
        assert_eq!(when(None), "不明");
    }

    struct FakeScheduler {
        state: RefCell<TaskState>,
        calls: RefCell<Vec<String>>,
        on_start: Box<dyn Fn()>,
    }

    impl Scheduler for FakeScheduler {
        fn query(&self) -> anyhow::Result<TaskState> {
            Ok(self.state.borrow().clone())
        }
        fn register(&self, times: &[String], update: bool) -> anyhow::Result<()> {
            self.calls.borrow_mut().push(format!("register {} {update}", times.join(",")));
            Ok(())
        }
        fn start(&self) -> anyhow::Result<()> {
            self.calls.borrow_mut().push("start".into());
            (self.on_start)();
            Ok(())
        }
        fn unregister(&self) -> anyhow::Result<()> {
            self.calls.borrow_mut().push("unregister".into());
            Ok(())
        }
    }

    #[test]
    fn dialog() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().to_path_buf();
        let cfg_none = || Ok(ScheduleConfig::default());
        let cfg_ok = || Ok(ScheduleConfig { upload_root: Some("R".into()), upload_projects: Some(vec!["a".into(), "b".into(), "c".into(), "d".into()]) });
        let yes_exists = |_: &str| true;
        let no_start = Box::new(|| {});
        // 登録していなくて、送り先か印が無ければ、何も登録しない(尋ねない)
        let s = FakeScheduler { state: RefCell::new(TaskState::default()), calls: RefCell::new(vec![]), on_start: no_start };
        let io = Scripted::new(&[]);
        let mut o = ScheduleOptions::new(&s, &cfg_none, out.clone());
        o.exists = &yes_exists;
        run_schedule(&io, &o).unwrap();
        assert!(io.printed().contains("== 先に決めること =="));
        assert!(s.calls.borrow().is_empty());
        // 読めない時刻は入れ直せる。登録した後に y なら今すぐ 1 回動かし、終わるのを待って結果を出す
        let out2 = out.clone();
        let s = FakeScheduler {
            state: RefCell::new(TaskState::default()),
            calls: RefCell::new(vec![]),
            on_start: Box::new(move || {
                std::fs::write(out2.join(AUTO_STATUS_FILE), r#"{"startedAt":"2026-11-13T09:00:00.000Z","finishedAt":"2026-11-13T09:00:01.000Z","ok":true,"error":null,"sent":[{"name":"a","sessions":2}],"secrets":0,"root":"R"}"#).unwrap();
            }),
        };
        let io = Scripted::new(&["25:00", "12:00,18:00", "y"]);
        let mut o = ScheduleOptions::new(&s, &cfg_ok, out.clone());
        o.exists = &yes_exists;
        o.poll = Duration::from_millis(1);
        run_schedule(&io, &o).unwrap();
        assert_eq!(*s.calls.borrow(), vec!["register 12:00,18:00 true", "start"]);
        let text = io.printed();
        assert!(text.contains("  「25:00」は時刻として読めません。"));
        assert!(text.contains("  送るプロジェクト: 画面で印を付けた 4 プロジェクト(a、b、c ほか)"));
        assert!(text.contains("に 1 プロジェクト・2 セッションを送りました。"));
        // 登録してあれば様子を見せ、u で切り替える。登録したときのものが無ければ知らせる
        let s = FakeScheduler {
            state: RefCell::new(TaskState { exists: true, state: "Disabled".into(), times: vec!["18:00".into()], arguments: task_arguments("C:\\gone\\atlas.exe", true), ..Default::default() }),
            calls: RefCell::new(vec![]),
            on_start: Box::new(|| {}),
        };
        let io = Scripted::new(&["u"]);
        let gone = |p: &str| !p.contains("gone");
        let mut o = ScheduleOptions::new(&s, &cfg_ok, out.clone());
        o.exists = &gone;
        run_schedule(&io, &o).unwrap();
        assert_eq!(*s.calls.borrow(), vec!["register 18:00 false"]);
        let text = io.printed();
        assert!(text.contains("  ただし、タスク スケジューラで「無効」になっています。"));
        assert!(text.contains("  登録したときの atlas の実行ファイルが見つかりません(C:\\gone\\atlas.exe)。t で登録し直してください。"));
        assert!(text.contains("  切り替えました。これからは、送る前に atlas を新しい版にしません"));
        // TS 版で登録したタスクは、時刻と自動更新はそのままで atlas.exe を動かす形に登録し直す(node のパスは確かめない)
        let s = FakeScheduler {
            state: RefCell::new(TaskState {
                exists: true,
                state: "Ready".into(),
                times: vec!["09:00".into()],
                arguments: "--headless \"C:\\gone\\node.exe\" \"C:\\r\\packages\\cli\\src\\upload-auto.ts\" --no-update".into(),
                ..Default::default()
            }),
            calls: RefCell::new(vec![]),
            on_start: Box::new(|| {}),
        };
        let io = Scripted::new(&[""]);
        let mut o = ScheduleOptions::new(&s, &cfg_ok, out.clone());
        o.exists = &gone;
        run_schedule(&io, &o).unwrap();
        assert_eq!(*s.calls.borrow(), vec!["register 09:00 false"]);
        let text = io.printed();
        assert!(text.contains("  前の版(Node.js で動かす版)で登録したタスクだったので、atlas.exe で動くように登録し直しました"));
        assert!(!text.contains("見つかりません"));
    }
}
