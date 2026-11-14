//! プロジェクトのセッションをまとめて送る(packages/cli/src/upload-project.ts の移植。upload-project.bat から `atlas upload-project` で呼ぶ。
//! 最新のログを集計し直してから、送る操作に進む)。
//! 集計のプロジェクト(プロジェクト別の表と同じ単位)のセッションの生ログを、<送り先>/<プロジェクト名>/<セッション id>/ に写す。
//! 送るプロジェクトは、画面の「プロジェクト別」で「まとめて送る」に印を付けたもの(atlas.config.json の uploadProjects)。
//! 印が無ければ、その場で番号を選ぶ(1 3 5-8 のように複数選べる)。印の無い新しいプロジェクトは送らず、最近更新したものの名前を出して知らせる。
//! 送り先は一度選んだら atlas.config.json の uploadRoot に覚える(画面のグループのアップロードと共通)。まだ無ければエクスプローラーで選ぶ。
//! 送る前に毎回、送り先・セッション数・大きさ・秘密らしい文字列を見せて確認する(y で送る / n で今回だけ番号で選び直す / c で送り先を選び直す / それ以外はやめる)。
//!
//! 黒い窓に出す文の決まり(読み飛ばされないように):
//!  - 場面ごとに見出し(== … ==)で区切り、前に空行を 1 つ置く。中身は 2 文字下げる
//!  - 1 行に 1 つのことだけを書く。一覧は名前の列をそろえる
//!  - 調べている・写している途中の様子は、行を増やさずに 1 行を書き換えて出す(io.status。端末でなければ出さない)

use crate::group_upload::{check_target, list_projects, open_upload_context, project_target, read_sessions, upload_target, GroupUploadPaths, GroupUploadResult, ProjectSummary, UploadChangedError, UploadCheck, UploadOptions, UploadRecord, UploadTarget};
use crate::upload_auto_files::SentProject;
use anyhow::{anyhow, Result};
use atlas_core::js;
use atlas_report::groups::safe_dir_name;
use regex::Regex;
use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use unicode_normalization::UnicodeNormalization;

/// 黒い窓とのやりとり(テストでは偽物を渡す)。集計の経過を受け取る口から呼ぶので、別のスレッドからも呼べること
pub trait ConsoleIo: Sync {
    /// 1 行を尋ねる(前後の空白は取り除いて返す。入力が終わっていれば空)
    fn ask(&self, q: &str) -> String;
    fn print(&self, line: &str);
    /// 送り先のフォルダを選んでもらう(取り消しは None)
    fn pick(&self, _initial: Option<&str>) -> Result<Option<String>> {
        Ok(None)
    }
    /// 今の様子(調べている・写している)を、行を増やさずに 1 行で見せる。次の print・ask で消える。端末でなければ出さない
    fn status(&self, _text: &str) {}
    /// status を出せるか(端末か)
    fn has_status(&self) -> bool {
        false
    }
}

/// 送れなかったプロジェクトがある(どれが送れなかったかと理由は、もう画面に出してある)
#[derive(Debug, Clone)]
pub struct UploadIncompleteError(pub String);

impl std::fmt::Display for UploadIncompleteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for UploadIncompleteError {}

/// 自動で送るときに、人に尋ねないと進めない場面。理由は message に書く(何も送っていない)
#[derive(Debug, Clone)]
pub struct AutoUploadBlockedError(pub String);

impl std::fmt::Display for AutoUploadBlockedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for AutoUploadBlockedError {}

fn size(b: u64) -> String {
    const MB: u64 = 1024 * 1024;
    if b < MB {
        format!("{} KB", (b as f64 / 1024.0).ceil())
    } else {
        format!("{} MB", atlas_core::jsnum::to_fixed(b as f64 / MB as f64, if b < 10 * MB { 1 } else { 0 }))
    }
}

fn day(iso: Option<&str>) -> String {
    match iso.filter(|s| !s.is_empty()) {
        Some(s) => js::head(s, 10).into_owned(),
        None => "日付不明".into(),
    }
}

/// 幅を取らない文字(結合する記号・異体字セレクタ・ZWJ などの書式の文字)
static ZERO_WIDTH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{Mn}\p{Me}\p{Cf}]$").unwrap());
/// 端末で絵文字として 2 桁で出る文字
static EMOJI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\p{Emoji_Presentation}$").unwrap());
/// 肌の色の修飾を後ろに受けて、1 つの絵文字として出る文字
static SKIN_BASE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\p{Emoji_Modifier_Base}$").unwrap());

fn is_re(re: &Regex, ch: char) -> bool {
    let mut b = [0u8; 4];
    re.is_match(ch.encode_utf8(&mut b))
}

/// 画面での幅(全角の文字と絵文字は 2、結合する記号などは 0、ほかは 1)。一覧の列をそろえるのと、1 行に収めるのに使う。
/// 後ろに U+FE0F(絵文字で出す指定)が付いた文字は 2 と数える。1 つの絵文字として出るもの(ZWJ でつないだもの、国旗、肌の色の修飾が付いたもの)は、全体で 2 と数える
pub fn width(s: &str) -> usize {
    let mut n = 0usize;
    let mut prev = 0usize;
    let mut joined = false;
    let mut flag_half = false;
    let mut base = false;
    for ch in s.chars() {
        let c = ch as u32;
        // ZWJ の次の文字は、前の絵文字とつながって 1 つに出る
        if joined {
            joined = false;
            if !is_re(&ZERO_WIDTH, ch) {
                base = is_re(&SKIN_BASE, ch);
                continue;
            }
        }
        if c == 0x200d {
            joined = prev == 2;
            continue;
        }
        // 地域指示記号は 2 つで 1 つの国旗になる
        if (0x1f1e6..=0x1f1ff).contains(&c) {
            if flag_half {
                flag_half = false;
                continue;
            }
            flag_half = true;
            n += 2;
            prev = 2;
            base = false;
            continue;
        }
        flag_half = false;
        // 肌の色の修飾は、修飾を受ける絵文字の後ろでは重なって出る(合わせて 2)
        if (0x1f3fb..=0x1f3ff).contains(&c) && base {
            base = false;
            if prev == 1 {
                n += 1;
                prev = 2;
            }
            continue;
        }
        if c != 0xad && is_re(&ZERO_WIDTH, ch) {
            if c == 0xfe0f && prev == 1 {
                n += 1;
                prev = 2;
            }
            continue;
        }
        let wide = is_re(&EMOJI, ch)
            || (0x1100..=0x115f).contains(&c)
            || (0x2e80..=0xa4cf).contains(&c)
            || (0xac00..=0xd7a3).contains(&c)
            || (0xf900..=0xfaff).contains(&c)
            || (0xfe30..=0xfe4f).contains(&c)
            || (0xff00..=0xff60).contains(&c)
            || (0xffe0..=0xffe6).contains(&c)
            || (0x1f300..=0x1faff).contains(&c)
            || (0x20000..=0x3fffd).contains(&c);
        prev = if wide { 2 } else { 1 };
        n += prev;
        base = is_re(&SKIN_BASE, ch);
    }
    n
}

/// 右を空白で埋めて、画面での幅を n にそろえる(長ければそのまま)
fn pad_end(s: &str, n: usize) -> String {
    format!("{s}{}", " ".repeat(n.saturating_sub(width(s))))
}

/// `String(x).padStart(n)`
fn pad_start(s: &str, n: usize) -> String {
    format!("{}{s}", " ".repeat(n.saturating_sub(js::utf16_len(s))))
}

/// 画面での幅が max に収まるところで切る(書き換える 1 行が折り返すと、消し残るため)
pub fn fit(s: &str, max: usize) -> String {
    let mut out = String::new();
    // 1 文字ずつではなく、ここまでの全体の幅で見る(U+FE0F のように、前の文字の幅を変えるものがあるため)
    for ch in s.chars() {
        let mut next = out.clone();
        next.push(ch);
        if width(&next) > max {
            break;
        }
        out = next;
    }
    out
}

/// 名前の列の幅(いちばん長い名前に合わせる。長すぎる名前があっても、ほかの行まで間延びしないよう上限を置く)
const NAME_MAX: usize = 40;
fn name_width<'a>(list: impl IntoIterator<Item = &'a str>) -> usize {
    NAME_MAX.min(list.into_iter().map(width).max().unwrap_or(0))
}

/// 送り先を選んでもらい、設定に覚える。取り消したら None
fn choose_root(io: &dyn ConsoleIo, config_path: &str, current: Option<&str>) -> Result<Option<String>> {
    io.print("  送り先のフォルダを選ぶ画面を開きます。見えないときはタスクバーを確かめてください。");
    let Some(r) = io.pick(current)? else { return Ok(None) };
    if !std::fs::metadata(&r).is_ok_and(|m| m.is_dir()) {
        anyhow::bail!("フォルダが見つかりません: {r}");
    }
    crate::config::update_config(config_path, "uploadRoot", Some(serde_json::Value::String(r.clone())))?;
    io.print(&format!("  送り先を覚えました(次からは聞きません): {r}"));
    Ok(Some(r))
}

/// 名前の一覧を短く(多ければ最初の数件と「ほか N 件」)
fn names(list: &[String], max: usize) -> String {
    let head: Vec<&str> = list.iter().take(max).map(String::as_str).collect();
    format!("{}{}", head.join("、"), if list.len() > max { format!(" ほか {} 件", list.len() - max) } else { String::new() })
}

static DASH_SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{s}*([-~〜]){s}*", s = js::RE_S)).unwrap());
static NUM_SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("(?:{}|[,、])+", js::RE_S)).unwrap());
static NUM_PART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]+)(?:[-~〜]([0-9]+))?$").unwrap());

/// 番号の指定(「1 3 5-8」「1,3」「5 - 8」。全角の数字も可)を、選んだ番号(1 始まり・入力の順・重複なし)にする。
/// 番号として読めない・範囲の外なら None
pub fn parse_numbers(answer: &str, max: usize) -> Option<Vec<usize>> {
    let n: String = answer.nfkc().collect();
    let joined = DASH_SPACE.replace_all(&n, "$1").into_owned();
    let parts: Vec<&str> = NUM_SPLIT.split(&joined).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for part in parts {
        let m = NUM_PART.captures(part)?;
        // 大きすぎる数は範囲の外(JS の Number は Infinity になる)
        let a: u128 = m[1].parse().unwrap_or(u128::MAX);
        let b: u128 = m.get(2).map_or(a, |x| x.as_str().parse().unwrap_or(u128::MAX));
        if a < 1 || b > max as u128 || a > b {
            return None;
        }
        for i in a as usize..=b as usize {
            if !out.contains(&i) {
                out.push(i);
            }
        }
    }
    Some(out)
}

/// 番号つきの行の頭(番号は右にそろえる)
fn numbered(i: usize, count: usize) -> String {
    format!("  {}. ", pad_start(&(i + 1).to_string(), count.to_string().len() + 1))
}

/// 番号で選んでもらう。当たらなければ尋ね直す。やめたら None
fn ask_projects(io: &dyn ConsoleIo, projects: &[ProjectSummary]) -> Option<Vec<ProjectSummary>> {
    let w = name_width(projects.iter().map(|p| p.name.as_str()));
    let sw = projects.iter().map(|p| p.sessions).max().unwrap_or(0).to_string().len();
    io.print("");
    io.print("== 送るプロジェクトを選ぶ ==");
    for (i, p) in projects.iter().enumerate() {
        io.print(&format!(
            "{}{}  {} セッション   最終更新 {}{}",
            numbered(i, projects.len()),
            pad_end(&p.name, w),
            pad_start(&p.sessions.to_string(), sw),
            day(p.updated_at.as_deref()),
            if p.no_log > 0 { format!("(ほかに、ログが無くて送れないもの {} 件)", p.no_log) } else { String::new() }
        ));
    }
    io.print("");
    loop {
        let answer = io.ask("  番号を入れて Enter(例: 1 3 5-8。やめるなら Enter だけ)\n  > ");
        if answer.is_empty() {
            return None;
        }
        let chosen: Vec<ProjectSummary> = match parse_numbers(&answer, projects.len()) {
            Some(nums) => nums.into_iter().map(|n| projects[n - 1].clone()).collect(),
            None => projects.iter().filter(|p| p.name == answer).cloned().collect(),
        };
        if !chosen.is_empty() {
            return Some(chosen);
        }
        io.print(&format!("  「{answer}」に当たるプロジェクトがありません。一覧の番号(1〜{})か名前を入れ直してください。", projects.len()));
    }
}

/// 送る前の確認。1 プロジェクトなら送り先はそのフォルダ、何プロジェクトかならプロジェクトごとの 1 行と合計
fn describe(io: &dyn ConsoleIo, checks: &[UploadCheck], root: &str) {
    let many = checks.len() > 1;
    let one = &checks[0];
    let sum = |f: &dyn Fn(&UploadCheck) -> u64| -> u64 { checks.iter().map(f).sum() };
    if many {
        io.print(&format!("  送り先: {root}(この中にプロジェクトごとのフォルダを作ります)"));
        let total = "合計";
        let w = name_width(checks.iter().map(|c| c.name.as_str())).max(width(total));
        let all_sessions = sum(&|c| c.sessions as u64);
        let sw = all_sessions.to_string().len();
        let sizes: Vec<String> = checks.iter().map(|c| size(c.bytes)).collect();
        let all = size(sum(&|c| c.bytes));
        let bw = sizes.iter().map(|s| js::utf16_len(s)).max().unwrap_or(0).max(js::utf16_len(&all));
        for (i, c) in checks.iter().enumerate() {
            io.print(&format!(
                "{}{}  {} セッション  {}{}",
                numbered(i, checks.len()),
                pad_end(&c.name, w),
                pad_start(&c.sessions.to_string(), sw),
                pad_start(&sizes[i], bw),
                if c.secrets.count > 0 { format!("   秘密らしい文字列 {} 件", c.secrets.count) } else { String::new() }
            ));
        }
        io.print(&format!("{}{}  {} セッション  {}", " ".repeat(js::utf16_len(&numbered(0, checks.len()))), pad_end(total, w), pad_start(&all_sessions.to_string(), sw), pad_start(&all, bw)));
    } else {
        io.print(&format!("  送り先: {}", one.dir));
        io.print(&format!("  {}: {} セッション・{}", one.name, one.sessions, size(one.bytes)));
    }
    let replace = sum(&|c| c.replace as u64);
    if replace > 0 {
        io.print(&format!("  うち {replace} セッションは、前に送ったものを置き換えます。"));
    }
    let unchanged = sum(&|c| c.unchanged as u64);
    if unchanged > 0 {
        io.print(&format!("  前に送ったときから変わっていない {unchanged} セッションは、送り先にあるものをそのまま使います(送りません)。"));
    }
    let secrets = sum(&|c| c.secrets.count as u64);
    if secrets > 0 {
        let mut kinds: Vec<(String, usize)> = Vec::new();
        for c in checks {
            for k in &c.secrets.kinds {
                match kinds.iter_mut().find(|x| x.0 == k.label) {
                    Some(x) => x.1 += k.count,
                    None => kinds.push((k.label.clone(), k.count)),
                }
            }
        }
        io.print("");
        io.print(&format!("  注意: 秘密らしい文字列が {secrets} 件あります({}。偽陽性もありえます)", kinds.iter().map(|(k, n)| format!("{k} {n}")).collect::<Vec<_>>().join("・")));
        // 点検はプロジェクトごとに多い順 10 ファイルまで返す。並べ直して全体の多い順 5 ファイルを出す
        let mut files: Vec<(&str, &crate::group_upload::SecretFile)> = checks.iter().flat_map(|c| c.secrets.files.iter().map(move |f| (c.name.as_str(), f))).collect();
        files.sort_by(|a, b| b.1.count.cmp(&a.1.count));
        for (name, f) in files.iter().take(5) {
            io.print(&format!("    {}{}/{}: {} 件", if many { format!("{name}: ") } else { String::new() }, f.id, f.path, f.count));
        }
        if files.len() > 5 {
            io.print("    ほかのファイルにもあります");
        }
        io.print("  ログはそのまま写ります。送り先を見られる人を確かめてください。");
        io.print("  本物の鍵なら、送る・送らないに関わらず作り直してください。");
    }
}

/// 集計の作業中を示すロック(out/.job.json)を取って f を動かす。入力を待つ間は持たない。取れなければ note(ここまでに送ったもの)を添えて止まる
fn with_out_lock<T>(out_dir: &Path, note: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let lock = match crate::jobs::acquire_out_lock(out_dir, "project upload", "cli") {
        Ok(l) => l,
        Err(e) => return Err(anyhow!("{}({note})", e.0)),
    };
    let r = f();
    lock.release();
    r
}

/// 自動で送るときに、確かめ直しが続いてもあきらめずに送り直す回数
const AUTO_RECHECKS: usize = 3;

fn recent_names(others: &[&ProjectSummary]) -> Vec<String> {
    let mut v: Vec<&ProjectSummary> = others.to_vec();
    // (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
    v.sort_by(|a, b| atlas_core::collate::locale_compare(b.updated_at.as_deref().unwrap_or(""), a.updated_at.as_deref().unwrap_or("")));
    v.into_iter().map(|p| p.name.clone()).collect()
}

/// 送るプロジェクトを決める(画面の印があればそれ、無ければ番号で選ぶ)。やめたら None
fn choose_projects(io: &dyn ConsoleIo, projects: &[ProjectSummary], marked: Option<&[String]>, auto: bool) -> Result<Option<Vec<ProjectSummary>>> {
    if auto {
        // 自動のときは番号を尋ねられないので、印のあるものだけを送る
        let Some(marked) = marked else {
            return Err(AutoUploadBlockedError("まとめて送るプロジェクトに印がありません。atlas.bat の画面の「プロジェクト別」で「まとめて送る」に印を付けてください(何も送っていません)".into()).into());
        };
        let chosen: Vec<ProjectSummary> = projects.iter().filter(|p| marked.contains(&p.name)).cloned().collect();
        if chosen.is_empty() {
            return Err(AutoUploadBlockedError(format!("印を付けたプロジェクト({})に、今送れるセッションがありません(何も送っていません)", names(marked, 3))).into());
        }
        let others: Vec<&ProjectSummary> = projects.iter().filter(|p| !marked.contains(&p.name)).collect();
        io.print("");
        io.print("== 送るプロジェクト ==");
        io.print(&format!("  印を付けた {} プロジェクトを送ります: {}", chosen.len(), names(&chosen.iter().map(|p| p.name.clone()).collect::<Vec<_>>(), 10)));
        let no_log: usize = chosen.iter().map(|p| p.no_log).sum();
        if no_log > 0 {
            io.print(&format!("  このほかに、ログが無くて送れないセッションが {no_log} 件あります(送りません)。"));
        }
        let gone: Vec<String> = marked.iter().filter(|n| !projects.iter().any(|p| &p.name == *n)).cloned().collect();
        if !gone.is_empty() {
            io.print(&format!("  印はあるが、送れるセッションが無いもの: {}", names(&gone, 3)));
        }
        if !others.is_empty() {
            io.print(&format!("  印の無い {} プロジェクトは送りません(最近更新: {})。", others.len(), names(&recent_names(&others), 3)));
        }
        return Ok(Some(chosen));
    }
    if let Some(marked) = marked {
        // 画面で印を付けたプロジェクトを、番号を聞かずに送る(並びは一覧と同じ多い順)
        let chosen: Vec<ProjectSummary> = projects.iter().filter(|p| marked.contains(&p.name)).cloned().collect();
        let gone: Vec<String> = marked.iter().filter(|n| !projects.iter().any(|p| &p.name == *n)).cloned().collect();
        let others: Vec<&ProjectSummary> = projects.iter().filter(|p| !marked.contains(&p.name)).collect();
        io.print("");
        io.print("== 送るプロジェクト ==");
        io.print(&if chosen.is_empty() { "  印を付けたプロジェクトに、今送れるものがありません。番号で選んでください。".to_string() } else { format!("  画面で印を付けた {} プロジェクトを送ります。", chosen.len()) });
        // 一覧を出さないので、ログが無くて送れないセッションの数はここで知らせる
        let no_log: usize = chosen.iter().map(|p| p.no_log).sum();
        if no_log > 0 {
            io.print(&format!("  このほかに、ログが無くて送れないセッションが {no_log} 件あります(送りません)。"));
        }
        if !gone.is_empty() {
            io.print(&format!("  印はあるが、送れるセッションが無いもの: {}", names(&gone, 3)));
        }
        if !chosen.is_empty() && !others.is_empty() {
            // 全部の名前は並べない。新しく始めたプロジェクトを見落とさないよう、最近更新したものだけ出す
            io.print(&format!("  印の無い {} プロジェクトは送りません(最近更新: {})。", others.len(), names(&recent_names(&others), 3)));
            io.print("  印は、atlas.bat の画面の「プロジェクト別」で付け外しできます。");
        }
        if !chosen.is_empty() {
            return Ok(Some(chosen));
        }
    }
    Ok(ask_projects(io, projects))
}

/// 選んだプロジェクトを、写すまとまりにする。フォルダ名が同じになるもの(owner/app と owner_app など)を一度に選んだら、2 つめが混ざるので止める
fn targets_of(snapshot: &Path, chosen: &[ProjectSummary], records: &[UploadRecord]) -> Result<Vec<UploadTarget>> {
    let mut by_folder: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for p in chosen {
        let key = js::to_lower(&safe_dir_name(&p.name));
        if let Some(prev) = by_folder.get(&key) {
            anyhow::bail!(
                "プロジェクト「{prev}」と「{}」は、送り先のフォルダ名が同じ「{}」になります。混ざるので、片方ずつ別の送り先に送ってください(何も送っていません)",
                p.name,
                safe_dir_name(&p.name)
            );
        }
        by_folder.insert(key, p.name.clone());
    }
    chosen.iter().map(|p| project_target(snapshot, &p.name, records)).collect()
}

/// 自動で送った結果(schedule-upload.bat の状態の表示に使う)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UploadSummary {
    /// 送ったプロジェクトと、送ったセッションの数(unchanged は前に送ったときから変わっていないので送らなかった数)
    pub sent: Vec<SentProject>,
    /// 送ったものにあった秘密らしい文字列の数(偽陽性もありうる)
    pub secrets: usize,
    pub root: Option<String>,
}

pub struct UploadProjectOptions<'a> {
    pub paths: GroupUploadPaths,
    pub config_path: String,
    pub auto: bool,
    pub summary: Option<&'a Mutex<UploadSummary>>,
}

/// 対話の本体。すべて送ったら true、やめたら false。送れなかったプロジェクトがあれば、送れたものを知らせてから止まる(UploadIncompleteError)。
/// auto なら尋ねない(schedule-upload.bat で登録したタスクから動かすとき): 印のあるプロジェクトを、覚えた送り先へ、送る前の確認を出さずに送る。
/// 印や送り先が無いなど、尋ねないと進めないときは AutoUploadBlockedError で止まる(何も送らない)。summary を渡すと、送ったものを書き込む
pub fn run_upload_project(io: &dyn ConsoleIo, o: &UploadProjectOptions<'_>) -> Result<bool> {
    let auto = o.auto;
    let snapshot = o.paths.snapshot.clone();
    let out_dir = snapshot.parent().map(Path::to_path_buf).unwrap_or_default();
    // sessions.json は 1 回だけ読み、一覧・送るまとまり・README で使い回す
    let sessions_path = o.paths.sessions.clone().unwrap_or_default();
    let records = read_sessions(&sessions_path)?;
    let projects = list_projects(&records, Some(&snapshot));
    if projects.is_empty() {
        if auto {
            return Err(AutoUploadBlockedError("送れるセッションがありません(空のセッションと、ログのフォルダが無いものは送りません)".into()).into());
        }
        io.print("");
        io.print("送れるセッションがありません(空のセッションと、ログのフォルダが無いものは送りません)。");
        return Ok(false);
    }
    let config = crate::config::load_config(&o.config_path, false)?;
    let Some(chosen) = choose_projects(io, &projects, config.upload_projects.as_deref(), auto)? else {
        io.print("  やめました(何も送っていません)。");
        return Ok(false);
    };
    let mut pending = targets_of(&snapshot, &chosen, &records)?;

    let mut root = config.upload_root.clone();
    // 覚えた送り先が無い(ネットワークドライブの切断・フォルダの削除)ときも、ここで選び直せるようにする
    let lost = root.as_deref().is_some_and(|r| !std::fs::metadata(r).is_ok_and(|m| m.is_dir()));
    if auto && root.is_none() {
        return Err(AutoUploadBlockedError("送り先がまだ決まっていません。upload-project.bat か atlas.bat の画面の「設定…」で決めてください(何も送っていません)".into()).into());
    }
    if auto && lost {
        return Err(AutoUploadBlockedError(format!("覚えている送り先が見つかりません: {}(ドライブがつながっているか確かめてください。何も送っていません)", root.as_deref().unwrap_or(""))).into());
    }
    if root.is_none() || lost {
        io.print("");
        io.print("== 送り先 ==");
        if lost {
            io.print(&format!("  覚えている送り先が見つかりません: {}", root.as_deref().unwrap_or("")));
            io.print("  ドライブがつながっているか確かめるか、選び直してください。");
        }
        root = choose_root(io, &o.config_path, None)?;
        if root.is_none() {
            io.print("  送り先を選ばなかったので、やめました(何も送っていません)。");
            return Ok(false);
        }
    }
    let mut root = root.unwrap_or_default();
    // 送る前に毎回確かめる。入力を待つ間はロックを放すので、写すときに確かめた中身と同じかを見直し、変わっていたら残りをもう一度確かめる
    let mut sent: Vec<GroupUploadResult> = Vec::new();
    let mut failed: Vec<(String, String)> = Vec::new();
    if let Some(s) = o.summary {
        s.lock().unwrap().root = Some(root.clone());
    }
    let mut rechecks = 0;
    let mut stopped = false;
    let sent_note = |sent: &[GroupUploadResult]| -> String {
        if sent.is_empty() {
            "何も送っていません".into()
        } else {
            format!("ここまでに {} プロジェクトを送りました({})。残りは送っていません", sent.len(), names(&sent.iter().map(|r| r.name.clone()).collect::<Vec<_>>(), 10))
        }
    };
    let quit = |sent: &[GroupUploadResult], failed: &[(String, String)]| io.print(if !sent.is_empty() || !failed.is_empty() { "  やめました。" } else { "  やめました(何も送っていません)。" });
    let body = (|| -> Result<()> {
        while !pending.is_empty() {
            // 自動のときは確かめ直しが続いても尋ねられないので、決まった回数で止める
            if auto {
                let over = rechecks > AUTO_RECHECKS;
                rechecks += 1;
                if over {
                    anyhow::bail!("確かめる間にログが変わり続けたので、残りの {} プロジェクトは送っていません。次の回に送ります", pending.len());
                }
            }
            let todo = pending.clone();
            let many = todo.len() > 1;
            io.print("");
            io.print("== 送る前の確認 ==");
            io.status("  調べています...");
            let r0 = PathBuf::from(&root);
            // session-store.db などは 1 回だけ開き、プロジェクトの間で使い回す
            let checks = with_out_lock(&out_dir, &sent_note(&sent), || {
                let ctx = open_upload_context(&o.paths)?;
                todo.iter().map(|t| check_target(&o.paths, t, &r0, Some(&ctx), false)).collect::<Result<Vec<_>>>()
            })?;
            describe(io, &checks, &root);
            io.print("");
            // 前に送ったときから何も変わっていなければ、写すものは無い(y なら送り先の一覧と添えた記録だけを書き直す)
            let nothing = checks.iter().all(|c| c.sessions == 0);
            if nothing {
                io.print("  前に送ったときから変わったセッションはありません。");
            }
            // 自動のときは、登録したときに「確認を出さずに送る」と承知してもらっている(schedule-upload.bat)
            let a = if auto {
                "y".to_string()
            } else {
                js::to_lower(&io.ask(&format!(
                    "  {}   n = 番号で選び直す   c = 送り先を変える   Enter = やめる\n  > ",
                    if nothing { "y = 送り先の一覧(README.md)だけ書き直す" } else { "y = 送る" }
                )))
            };
            if a == "c" {
                if let Some(picked) = choose_root(io, &o.config_path, Some(&root))? {
                    root = picked;
                }
                continue;
            }
            if a == "n" {
                // 印は変えずに、今回送るものだけを選び直す
                let Some(picked) = ask_projects(io, &projects) else {
                    quit(&sent, &failed);
                    break;
                };
                pending = targets_of(&snapshot, &picked, &records)?;
                continue;
            }
            if a != "y" {
                quit(&sent, &failed);
                break;
            }
            io.print("");
            io.print("== 送っています ==");
            let w = name_width(todo.iter().map(|t| t.name.as_str()));
            let sw = checks.iter().map(|c| c.sessions).max().unwrap_or(0).to_string().len();
            // まとめて送る間はロックを持ち続ける(途中で集計し直されて、残りが確かめた中身と変わらないように)
            let note = sent_note(&sent);
            pending = with_out_lock(&out_dir, &note, || {
                let ctx = open_upload_context(&o.paths)?;
                for (i, t) in todo.iter().enumerate() {
                    let tag = if many { format!("[{}/{}] ", i + 1, todo.len()) } else { String::new() };
                    let shown: Mutex<(Instant, Option<usize>)> = Mutex::new((Instant::now() - Duration::from_secs(1), None));
                    let on_progress = |p: &crate::group_upload::UploadProgress| {
                        // 写すたびに呼ばれるので、セッションを 1 件写し終えたときと、間が空いたときだけ書き換える
                        if !io.has_status() {
                            return;
                        }
                        let mut s = shown.lock().unwrap();
                        if s.1 == Some(p.done) && s.0.elapsed() < Duration::from_millis(200) {
                            return;
                        }
                        *s = (Instant::now(), Some(p.done));
                        io.status(&format!("  {tag}{}  {} / {} セッション({} / {})", t.name, p.done, p.sessions, size(p.copied), size(p.bytes)));
                    };
                    let opts = UploadOptions {
                        expect: Some(checks[i].fingerprint.clone()),
                        check: Some(&checks[i]),
                        sessions: Some(&records),
                        context: Some(&ctx),
                        on_progress: Some(&on_progress),
                        ..Default::default()
                    };
                    match upload_target(&o.paths, t, &r0, &|_| {}, &opts) {
                        Ok(r) => {
                            if let Some(s) = o.summary {
                                let mut s = s.lock().unwrap();
                                s.sent.push(SentProject { name: r.name.clone(), sessions: r.uploaded as f64, unchanged: Some(r.unchanged as f64) });
                                s.secrets += checks[i].secrets.count;
                            }
                            let extra: Vec<String> = [
                                if r.replaced > 0 { format!("置き換え {} セッション", r.replaced) } else { String::new() },
                                if r.unchanged > 0 { format!("変わっていない {} セッションはそのまま", r.unchanged) } else { String::new() },
                                if r.memos > 0 { format!("メモ {} 件", r.memos) } else { String::new() },
                            ]
                            .into_iter()
                            .filter(|x| !x.is_empty())
                            .collect();
                            io.print(&format!(
                                "  {tag}{}  {} セッションを送りました{}",
                                pad_end(&t.name, w),
                                pad_start(&r.uploaded.to_string(), sw),
                                if extra.is_empty() { String::new() } else { format!("({})", extra.join("・")) }
                            ));
                            if !r.leftovers.is_empty() {
                                io.print(&format!("      置き換えた前のフォルダを {} 件消せませんでした。閉じてから手で消してください:", r.leftovers.len()));
                                for l in r.leftovers.iter().take(3) {
                                    io.print(&format!("        {l}"));
                                }
                                if r.leftovers.len() > 3 {
                                    io.print(&format!("        ほか {} 件", r.leftovers.len() - 3));
                                }
                            }
                            if !r.stale_meta.is_empty() {
                                io.print(&format!(
                                    "      タスクタグや題名の記録(atlas-session.json)を書き直せなかったセッションが {} 件あります(送り先で開かれているなど。次に送るときにもう一度書き直します): {}",
                                    r.stale_meta.len(),
                                    names(&r.stale_meta, 3)
                                ));
                            }
                            sent.push(r);
                        }
                        Err(e) if e.is::<UploadChangedError>() => {
                            // 確かめた後にログやメモが変わった: これと残りを確かめ直す(送ったものはそのまま)
                            io.print(&format!("  {e}"));
                            return Ok(todo[i..].to_vec());
                        }
                        Err(e) => {
                            // 1 つ送れなくても残りは送る
                            failed.push((t.name.clone(), e.to_string()));
                            io.print(&format!("  {tag}{}  送れませんでした: {e}", pad_end(&t.name, w)));
                        }
                    }
                }
                Ok(Vec::new())
            })?;
        }
        Ok(())
    })();
    if body.is_err() {
        stopped = true;
    }
    // 途中で止まっても(ロックが取れないなど)、送ったもの・送れなかったものを知らせる
    if !sent.is_empty() || !failed.is_empty() {
        io.print("");
        io.print(if !failed.is_empty() {
            "== 送れなかったものがあります =="
        } else if stopped {
            "== 途中で止まりました =="
        } else if !pending.is_empty() {
            "== 途中でやめました =="
        } else {
            "== 終わりました =="
        });
        if !sent.is_empty() {
            let kept: usize = sent.iter().map(|r| r.unchanged).sum();
            io.print(&format!(
                "  {} プロジェクト・{} セッションを送りました{}。",
                sent.len(),
                sent.iter().map(|r| r.uploaded).sum::<usize>(),
                if kept > 0 { format!("(変わっていない {kept} セッションはそのまま)") } else { String::new() }
            ));
            let dest = if sent.len() > 1 {
                let mut parents: Vec<String> = Vec::new();
                for r in &sent {
                    let p = Path::new(&r.dir).parent().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
                    if !parents.contains(&p) {
                        parents.push(p);
                    }
                }
                parents.join("、")
            } else {
                sent[0].dir.clone()
            };
            io.print(&format!("  送り先: {dest}"));
            io.print(if sent.len() > 1 { "  説明とセッションの一覧は、それぞれのフォルダの README.md にあります。" } else { "  説明とセッションの一覧は、そのフォルダの README.md にあります。" });
        }
        if !pending.is_empty() && !stopped {
            io.print(&format!("  残りの {} プロジェクト({})は送っていません。", pending.len(), names(&pending.iter().map(|t| t.name.clone()).collect::<Vec<_>>(), 3)));
        }
        if !failed.is_empty() {
            io.print(&format!("  送れなかったプロジェクト({} 件): {}", failed.len(), names(&failed.iter().map(|f| f.0.clone()).collect::<Vec<_>>(), 10)));
            io.print("  理由を確かめてから、もう一度実行してください(送れたものは、送り直しても置き換えるだけです)。");
        }
        if !sent.is_empty() && config.upload_projects.is_none() && !auto {
            io.print("  毎回同じものを送るなら、atlas.bat の画面の「プロジェクト別」で「まとめて送る」に印を付けると、番号を聞かずに送ります。");
        }
    }
    body?;
    if !failed.is_empty() {
        return Err(UploadIncompleteError(format!("{} プロジェクトを送れませんでした(送れたのは {} プロジェクトです)", failed.len(), sent.len())).into());
    }
    Ok(!sent.is_empty() && pending.is_empty())
}

/// 集計の各段階(ログの行の頭)を、途中の様子に出す言葉にする
fn stage_label(stage: &str) -> &'static str {
    match stage {
        "snapshot" => "ログを写しています",
        "extract" => "ログを読んでいます",
        "metrics" => "数えています",
        "build" => "レポートを作っています",
        "export" => "セッション記録を作っています",
        "all" => "仕上げています",
        _ => "集計しています",
    }
}

static CTRL_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\r\n\t\x0B\x0C]+").unwrap());
static NOTICE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^snapshot: 注意 ((?s:.)+)").unwrap());
static STAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([a-z-]+)[ :]").unwrap());

/// 改行やタブを空白にして 1 行にする
fn one_line(s: &str) -> String {
    js::trim(&CTRL_RUN.replace_all(s, " ")).to_string()
}

/// 集計を動かす口(集計の経過を 1 行ずつ渡す)
pub type AggregateRun<'a> = &'a dyn Fn(&(dyn Fn(&str) + Sync)) -> Result<()>;

/// 送る前に、最新のログを集計し直す(upload-project.bat から、送る操作の前に呼ぶ)。
/// 経過の行(長いパスが続く)は窓に出さずに log_path に書き、途中の様子は 1 行の書き換えで出す。
/// 窓に出す注意は、ログを写す段階の注意だけ(ほかの段階の注意は経過のファイルにだけ書く)。失敗したら理由と log_path を出して false
pub fn refresh_aggregate(io: &dyn ConsoleIo, log_path: &Path, run: AggregateRun<'_>) -> bool {
    io.print("");
    io.print("== 集計 ==");
    io.print("  最新のログを集計しています。少し待ってください。");
    // 経過は 1 行ごとにその場でファイルに書く(途中で窓を閉じても、そこまでの経過が残るように)。書けなくても集計は続ける
    let file = Mutex::new(std::fs::File::create(log_path).ok());
    let keep = |m: &str| {
        if let Some(f) = file.lock().unwrap().as_mut() {
            let _ = writeln!(f, "{m}");
        }
    };
    let log = |m: &str| {
        keep(m);
        // 行の頭が「snapshot: 注意」のものだけ(文の途中に「注意」とある行や、ほかの段階の注意は出さない)
        if let Some(c) = NOTICE.captures(m) {
            io.print(&format!("  注意: {}", one_line(&c[1])));
            return;
        }
        // 段階の頭が無い行は、その文のまま出す
        if let Some(c) = STAGE.captures(m) {
            io.status(&format!("  {}...", stage_label(&c[1])));
        } else if !js::trim(m).is_empty() {
            io.status(&format!("  {}", one_line(m)));
        }
    };
    // TS 版は console と標準出力に直に書かれたものも経過のファイルに回していた。Rust 版の集計は経過をすべて log に渡すので、回すものは無い
    match run(&log) {
        Err(e) => {
            keep(&format!("失敗しました: {e}"));
            keep(&format!("{e:?}"));
            io.print(&format!("  集計に失敗しました: {}", one_line(&e.to_string())));
            io.print("  atlas.bat の画面で集計し直している最中なら、終わってからもう一度実行してください。");
            io.print(&format!("  集計の経過: {}", log_path.display()));
            false
        }
        Ok(()) => {
            io.print("  集計しました。");
            true
        }
    }
}

/// 黒い窓の出力の様子(Ctrl+C の後始末と共有する)
struct OutState {
    out: Box<dyn Write + Send>,
    /// 書き換える 1 行が出ているか
    shown: bool,
    last_status: String,
}

/// 黒い窓(標準入出力)とやりとりする io。pick は送り先のフォルダを選ぶ画面。
/// 書き換える 1 行(status)は、出力が端末のときだけ使う(ファイルやパイプに流すと、書き換えの制御文字が残るため)。
/// 入力が端末のときは、尋ねる直前に、尋ねていない間に打ったキーを捨てる(集計を待つ間に打った文字や Enter が、まだ見ていない質問の答えにならないように)。
/// 流し込んだ入力(パイプ)では、尋ねる前に届いた行も順に答えに使う
pub struct Console {
    out: Arc<Mutex<OutState>>,
    out_tty: bool,
    columns: usize,
    input: Mutex<Box<dyn BufRead + Send>>,
    in_tty: bool,
    closed: AtomicBool,
    settle: Duration,
    picker: Option<Box<dyn Fn(Option<&str>) -> Result<Option<String>> + Sync + Send>>,
}

impl Console {
    /// 標準入出力の窓
    pub fn new() -> Self {
        let out_tty = std::io::stdout().is_terminal();
        if out_tty {
            crate::sys::enable_vt_output();
        }
        let c = Console::with(
            Box::new(std::io::stdout()),
            out_tty,
            crate::sys::terminal_columns().map_or(80, |c| c as usize),
            Box::new(std::io::BufReader::new(std::io::stdin())),
            std::io::stdin().is_terminal(),
        );
        c
    }

    /// 出力と入力を差し替えて作る(テスト用)
    pub fn with(out: Box<dyn Write + Send>, out_tty: bool, columns: usize, input: Box<dyn BufRead + Send>, in_tty: bool) -> Self {
        Console {
            out: Arc::new(Mutex::new(OutState { out, shown: false, last_status: String::new() })),
            out_tty,
            columns,
            input: Mutex::new(input),
            in_tty,
            closed: AtomicBool::new(false),
            settle: Duration::from_millis(50),
            picker: None,
        }
    }

    /// Ctrl+C で終わるときに、書き換えていた 1 行を消して、中断したことを 1 行で出し、after(作業中の印を外すなど)を済ませてから終わる(終了コード 130)
    pub fn exit_on_ctrl_c(&self, after: impl Fn() + Send + Sync + 'static) {
        let st = self.out.clone();
        crate::sys::on_ctrl_c(move || {
            if let Ok(mut s) = st.try_lock() {
                let had = s.shown;
                if s.shown {
                    let _ = s.out.write_all(b"\x1b[2K\x1b[1G");
                    s.shown = false;
                }
                let _ = s.out.write_all(format!("{}  中断しました。\n", if had { "" } else { "\n" }).as_bytes());
                let _ = s.out.flush();
            }
            after();
        });
    }

    /// 送り先のフォルダを選ぶ画面を出す口を付ける
    pub fn with_picker(mut self, f: impl Fn(Option<&str>) -> Result<Option<String>> + Sync + Send + 'static) -> Self {
        self.picker = Some(Box::new(f));
        self
    }

    fn write(&self, text: &str) {
        let mut s = self.out.lock().unwrap();
        let _ = s.out.write_all(text.as_bytes());
        let _ = s.out.flush();
    }

    /// 書き換えていた 1 行を消す
    pub fn clear(&self) {
        let mut s = self.out.lock().unwrap();
        if !s.shown {
            return;
        }
        let _ = s.out.write_all(b"\x1b[2K\x1b[1G");
        let _ = s.out.flush();
        s.shown = false;
    }

    /// 入力を閉じる(これ以降の ask は空を返す)
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let _ = self.out.lock().unwrap().out.flush();
    }

    /// 書き換えている 1 行(テスト用)
    #[cfg(test)]
    fn last_status(&self) -> String {
        self.out.lock().unwrap().last_status.clone()
    }
}

impl Default for Console {
    fn default() -> Self {
        Console::new()
    }
}

impl ConsoleIo for Console {
    fn ask(&self, q: &str) -> String {
        self.clear();
        self.write(q);
        if self.closed.load(Ordering::SeqCst) {
            return String::new();
        }
        if self.in_tty {
            // 集計などで手が離せなかった間に打たれたキーは、まだ届いていないことがある。届き切るのを少し待って捨ててから受け取る
            std::thread::sleep(self.settle);
            crate::sys::discard_pending_input();
        }
        let mut buf = Vec::new();
        match self.input.lock().unwrap().read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => {
                self.closed.store(true, Ordering::SeqCst);
                String::new()
            }
            Ok(_) => js::trim(&String::from_utf8_lossy(&buf)).to_string(),
        }
    }
    fn print(&self, line: &str) {
        self.clear();
        self.write(&format!("{line}\n"));
    }
    fn pick(&self, initial: Option<&str>) -> Result<Option<String>> {
        match &self.picker {
            Some(p) => p(initial),
            None => Ok(None),
        }
    }
    fn status(&self, text: &str) {
        if !self.out_tty {
            return;
        }
        self.clear();
        // 折り返すと 1 行では消えないので、改行やタブは空白にして、窓の幅に収める
        let line = fit(&CTRL_RUN.replace_all(text, " "), self.columns.max(1) - 1);
        let mut s = self.out.lock().unwrap();
        let _ = s.out.write_all(line.as_bytes());
        let _ = s.out.flush();
        s.last_status = line;
        s.shown = true;
    }
    fn has_status(&self) -> bool {
        self.out_tty
    }
}

/// Node の os.tmpdir()(Windows は TEMP、TMP、%SystemRoot%\temp の順。末尾の区切りは取る)
pub fn node_tmpdir() -> PathBuf {
    if cfg!(windows) {
        let t = std::env::var("TEMP").ok().filter(|s| !s.is_empty()).or_else(|| std::env::var("TMP").ok().filter(|s| !s.is_empty())).unwrap_or_else(|| {
            format!("{}\\temp", std::env::var("SystemRoot").or_else(|_| std::env::var("windir")).unwrap_or_else(|_| "C:\\Windows".into()))
        });
        let t = if t.len() > 1 && t.ends_with('\\') && !t.ends_with(":\\") { t[..t.len() - 1].to_string() } else { t };
        PathBuf::from(t)
    } else {
        let t = std::env::var("TMPDIR").ok().filter(|s| !s.is_empty()).or_else(|| std::env::var("TMP").ok()).or_else(|| std::env::var("TEMP").ok()).unwrap_or_else(|| "/tmp".into());
        let t = if t.len() > 1 && t.ends_with('/') { t[..t.len() - 1].to_string() } else { t };
        PathBuf::from(t)
    }
}

/// 集計の経過を書くファイル(集計に失敗したときに場所を出す)
pub fn upload_log() -> PathBuf {
    node_tmpdir().join("atlas-upload-project.log")
}

/// 突き合わせ(scripts/parity-cli.ts)のときだけ、集計し直さずに送る操作に進む(環境変数 ATLAS_PARITY_SKIP_AGGREGATE=1)。
/// TS 版の同じ入口を、集計を空の処理に替えて動かしたものと比べるため
pub fn parity_skip_aggregate() -> bool {
    std::env::var("ATLAS_PARITY_SKIP_AGGREGATE").is_ok_and(|v| v == "1")
}

/// `atlas all`(既定の出力先か out)を動かす
pub fn run_all(out: Option<&str>, log: &(dyn Fn(&str) + Sync)) -> Result<()> {
    if parity_skip_aggregate() {
        return Ok(());
    }
    let mut argv = vec!["all".to_string()];
    if let Some(o) = out {
        argv.extend(["--out".to_string(), o.to_string()]);
    }
    let opts = crate::args::parse_cli(&argv).map_err(|e| anyhow!("{e}"))?;
    crate::commands::run(&opts, log).map(|_| ())
}

/// upload-project.bat から(`atlas upload-project`)
pub fn main(_argv: &[String]) -> u8 {
    // 置き場は atlas.bat と同じ既定(out/ と atlas-notes/)
    let paths = crate::paths::resolve_paths(crate::paths::PathInputs { home: None, out: None, judgments: None, bundle: None, notes_dir: None });
    let c = Console::new().with_picker(|initial| crate::folder_picker::pick_folder("プロジェクトのセッションを送る先のフォルダを選んでください", initial));
    // Ctrl+C で終わるときも、集計の作業中の印(out/.job.json)は外す(自分の印だけを消す)
    let out = paths.out.clone();
    c.exit_on_ctrl_c(move || crate::jobs::release_out_lock(&out));
    let gp = GroupUploadPaths::of(&paths);
    let r = (|| -> Result<u8> {
        // 集計もここで動かす(別のプログラムにすると、集計を待つ間に押した Enter が、送る操作の最初の答えになるため)
        if !refresh_aggregate(&c, &upload_log(), &|log| run_all(None, log)) {
            return Ok(1);
        }
        let sent = run_upload_project(&c, &UploadProjectOptions { paths: gp, config_path: crate::config::default_config_path(), auto: false, summary: None })?;
        // 毎回手で送らずに済むよう、自動で送る登録がまだなら知らせる(調べられなければ何も出さない)
        if sent && cfg!(windows) {
            use crate::upload_schedule::Scheduler;
            if let Ok(task) = crate::upload_schedule::task_scheduler().query() {
                if !task.exists {
                    c.print("  毎日決まった時刻に自動で送るなら、schedule-upload.bat で登録できます。");
                }
            }
        }
        Ok(0)
    })();
    let code = match r {
        Ok(code) => code,
        Err(e) => {
            c.clear();
            // 送れなかったプロジェクトと理由は、もう画面に出してある(同じことを 2 度書かない)
            if !e.is::<UploadIncompleteError>() {
                eprint!("\n止まりました: {e}\n");
            }
            1
        }
    };
    crate::jobs::release_out_lock(&paths.out);
    c.close();
    code
}

#[cfg(test)]
pub(crate) mod tests;
