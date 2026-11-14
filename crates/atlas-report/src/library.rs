//! Phase 11: 指示文(AGENTS.md 等の注入)と skill の本文の閲覧ページ(packages/report/src/library.ts の移植)。
//! 重複なしで版ごと(contentHash)に out/library/<hash>.md に本文を置き、out/instructions.html に
//! 見出しごとの版一覧(使われたセッション、初回と最終の利用日、前の版との差分)を出す。伏せ字版では作らない。

use crate::format::{date_n, date_time_n, int_n};
use crate::html::{byte_length, esc, write_text};
use crate::insights::{clean_heading, series_key};
use crate::page_nav::{page_head, render_rail, render_top, NavGroup, NavItem, NavLink, PageNavOptions, NAV_JS};
use crate::summarize::detail_file_name;
use crate::transcript::redact_secrets;
use atlas_core::collate::locale_compare;
use atlas_core::instructions::{char_count, content_hash, extract_instruction_blocks};
use atlas_core::js;
use atlas_core::project_keys::{HOME_PROJECT, TEMP_PROJECT};
use indexmap::{IndexMap, IndexSet};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub const INSTRUCTIONS_FILE: &str = "instructions.html";
pub const LIBRARY_DIR: &str = "library";

static NOT_ALNUM: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"[^A-Za-z0-9_-]").unwrap());

/// skill の節の id(詳細ページから instructions.html#s-… で飛ぶ)。英数字以外を置き換えたうえで短いハッシュを付ける
pub fn skill_anchor(name: &str) -> String {
    let replaced = NOT_ALNUM.replace_all(name, |c: &regex::Captures| "_".repeat(c[0].encode_utf16().count()));
    format!("s-{}-{}", js::utf16_slice(&replaced, 0, 40), &content_hash(name)[..6])
}

#[derive(Debug, Clone)]
pub struct LibraryVersion {
    pub hash: String,
    pub body: String,
    pub chars: i64,
    pub sessions: IndexSet<String>,
    pub first_at: Option<String>,
    pub last_at: Option<String>,
    /// system.message に現れた回数(全セッションの合計)
    pub injections: i64,
    /// 出所のパス(分かったものだけ、重複なし)
    pub source_paths: Vec<String>,
    /// セッションごとの、その版を最初に読み込んだ日時
    pub first_by_session: IndexMap<String, Option<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LibraryKind {
    Instruction,
    Skill,
}

#[derive(Debug, Clone)]
pub struct LibraryGroup {
    pub kind: LibraryKind,
    /// 指示文は先頭の見出し(無ければファイル種別)、skill は名前
    pub key: String,
    /// 指示文のファイル種別(InstructionFile の名前)か "skill"
    pub file: String,
    pub versions: Vec<LibraryVersion>,
}

/// JS の `a && b ? (a > b ? a : b) : (a ?? b)`
fn later(a: Option<String>, b: Option<&str>) -> Option<String> {
    match (a.as_deref().filter(|s| !s.is_empty()), b.filter(|s| !s.is_empty())) {
        (Some(x), Some(y)) => Some(if js::cmp_utf16(x, y) == Ordering::Greater { x } else { y }.to_string()),
        _ => a.or(b.map(str::to_string)),
    }
}
fn earlier(a: Option<String>, b: Option<&str>) -> Option<String> {
    match (a.as_deref().filter(|s| !s.is_empty()), b.filter(|s| !s.is_empty())) {
        (Some(x), Some(y)) => Some(if js::cmp_utf16(x, y) == Ordering::Less { x } else { y }.to_string()),
        _ => a.or(b.map(str::to_string)),
    }
}

/// 閲覧ページに集める本文(1 セッションのイベントを読んだ順。指示ブロックは system.message から取り出したもの)。
/// 本文は内容のハッシュごとに 1 つを共有する(同じ指示文が全セッションに注入されるため)
#[derive(Debug, Clone, PartialEq)]
pub enum LibraryEvent {
    Instruction { key: String, file: &'static str, hash: String, body: Arc<str>, at: Option<String>, source_path: Option<String> },
    Skill { name: String, hash: String, body: Arc<str>, at: Option<String>, path: Option<String> },
}

/// 本文を内容のハッシュで共有する置き場(並べて読むときに使う)
#[derive(Default)]
pub struct BodyInterner(Mutex<HashMap<String, Vec<Arc<str>>>>);

impl BodyInterner {
    /// 同じ本文(バイト単位で同じもの)なら同じ Arc を返す。内容のハッシュは改行を LF にそろえてから取るので、
    /// 同じハッシュでも CRLF と LF の違う本文がありうる(版の本文は TS 版と同じく、最初に集めたセッションのものを使う)
    pub fn get(&self, hash: &str, body: &str) -> Arc<str> {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let list = m.entry(hash.to_string()).or_default();
        if let Some(x) = list.iter().find(|x| ***x == *body) {
            return x.clone();
        }
        let a: Arc<str> = Arc::from(body);
        list.push(a.clone());
        a
    }
}

/// system.message の本文から、閲覧ページに集める指示ブロックを取り出す(LibraryCollector::add_system_message と同じ順)
pub fn instruction_events(content: &str, at: Option<&str>, interner: &BodyInterner) -> Vec<LibraryEvent> {
    extract_instruction_blocks(content)
        .into_iter()
        .map(|b| LibraryEvent::Instruction {
            key: series_key(&b.heading, b.file.as_str()),
            file: b.file.as_str(),
            body: interner.get(&b.content_hash, &b.body),
            hash: b.content_hash,
            at: at.map(str::to_string),
            source_path: b.source_path,
        })
        .collect()
}

#[derive(Debug, Default)]
pub struct LibraryCollector {
    groups: IndexMap<(bool, String), LibraryGroup>,
    sessions: std::collections::HashSet<String>,
}

impl LibraryCollector {
    pub fn new() -> Self {
        Self::default()
    }

    #[allow(clippy::too_many_arguments)]
    fn version(&mut self, kind: LibraryKind, key: String, file: &str, hash: &str, body: &str, session_id: &str, at: Option<&str>, source_path: Option<&str>) {
        let g = self.groups.entry((kind == LibraryKind::Skill, key.clone())).or_insert_with(|| LibraryGroup { kind, key, file: file.to_string(), versions: vec![] });
        // 同じ見出しでもファイルの種別が推定できなかった注入がある。分かったものを項目の種別にする
        if g.file == "unknown" && file != "unknown" {
            g.file = file.to_string();
        }
        let idx = match g.versions.iter().position(|x| x.hash == hash) {
            Some(i) => i,
            None => {
                // 字数は CRLF を LF にしてから数える
                let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
                g.versions.push(LibraryVersion {
                    hash: hash.to_string(),
                    body: body.to_string(),
                    chars: char_count(&normalized),
                    sessions: IndexSet::new(),
                    first_at: None,
                    last_at: None,
                    injections: 0,
                    source_paths: vec![],
                    first_by_session: IndexMap::new(),
                });
                g.versions.len() - 1
            }
        };
        let v = &mut g.versions[idx];
        if let Some(sp) = source_path.filter(|s| !s.is_empty())
            && !v.source_paths.iter().any(|x| x == sp)
        {
            v.source_paths.push(sp.to_string());
        }
        v.sessions.insert(session_id.to_string());
        self.sessions.insert(session_id.to_string());
        let next = match v.first_by_session.get(session_id) {
            Some(cur) => earlier(cur.clone(), at),
            None => at.map(str::to_string),
        };
        v.first_by_session.insert(session_id.to_string(), next);
        v.injections += 1;
        v.first_at = earlier(v.first_at.take(), at);
        v.last_at = later(v.last_at.take(), at);
    }

    /// system.message の本文から指示ブロックを取り出して版に束ねる
    pub fn add_system_message(&mut self, session_id: &str, content: &str, at: Option<&str>) {
        for b in extract_instruction_blocks(content) {
            // 項目は整えた見出しだけで決める(seriesKey。改善点の「版 N」と揃える)
            self.version(LibraryKind::Instruction, series_key(&b.heading, b.file.as_str()), b.file.as_str(), &b.content_hash, &b.body, session_id, at, b.source_path.as_deref());
        }
    }

    /// skill.invoked の本文
    pub fn add_skill(&mut self, session_id: &str, name: &str, content: &str, hash: &str, at: Option<&str>, path: Option<&str>) {
        self.version(LibraryKind::Skill, name.to_string(), "skill", hash, content, session_id, at, path);
    }

    pub fn add(&mut self, session_id: &str, e: &LibraryEvent) {
        match e {
            LibraryEvent::Instruction { key, file, hash, body, at, source_path } => self.version(LibraryKind::Instruction, key.clone(), file, hash, body, session_id, at.as_deref(), source_path.as_deref()),
            LibraryEvent::Skill { name, hash, body, at, path } => self.add_skill(session_id, name, body, hash, at.as_deref(), path.as_deref()),
        }
    }

    /// その skill の本文をもう集めたか
    pub fn has_skill(&self, name: &str) -> bool {
        self.groups.contains_key(&(true, name.to_string()))
    }

    /// そのセッションの指示文か skill の本文をもう集めたか
    pub fn has_session(&self, id: &str) -> bool {
        self.sessions.contains(id)
    }

    pub fn result(&self) -> Vec<LibraryGroup> {
        let mut gs: Vec<LibraryGroup> = self.groups.values().cloned().collect();
        for g in &mut gs {
            g.versions.sort_by(|a, b| locale_compare(a.first_at.as_deref().unwrap_or(""), b.first_at.as_deref().unwrap_or("")).then_with(|| locale_compare(&a.hash, &b.hash)));
        }
        let total = |g: &LibraryGroup| g.versions.iter().map(|v| v.sessions.len() as i64).sum::<i64>();
        gs.sort_by(|a, b| {
            if a.kind == b.kind {
                total(b).cmp(&total(a)).then_with(|| locale_compare(&a.key, &b.key))
            } else if a.kind == LibraryKind::Instruction {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        });
        gs
    }
}

/// 行単位の差分(LCS)。+ / - / 空白 の接頭辞で返す。長いときは変化の無い行を省く
pub fn line_diff(a: &str, b: &str, context: i64) -> Vec<String> {
    let a = a.replace("\r\n", "\n");
    let b = b.replace("\r\n", "\n");
    let x: Vec<&str> = a.split('\n').collect();
    let y: Vec<&str> = b.split('\n').collect();
    let (n, m) = (x.len(), y.len());
    if n * m > 4_000_000 {
        return vec![format!("(差分の計算を省略: {n} 行 → {m} 行)")];
    }
    let w = m + 1;
    let mut dp = vec![0u32; (n + 1) * w];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i * w + j] = if x[i] == y[j] { dp[(i + 1) * w + j + 1] + 1 } else { dp[(i + 1) * w + j].max(dp[i * w + j + 1]) };
        }
    }
    let mut ops: Vec<String> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if x[i] == y[j] {
            ops.push(format!(" {}", x[i]));
            i += 1;
            j += 1;
        } else if dp[(i + 1) * w + j] >= dp[i * w + j + 1] {
            ops.push(format!("-{}", x[i]));
            i += 1;
        } else {
            ops.push(format!("+{}", y[j]));
            j += 1;
        }
    }
    while i < n {
        ops.push(format!("-{}", x[i]));
        i += 1;
    }
    while j < m {
        ops.push(format!("+{}", y[j]));
        j += 1;
    }
    // 変化の無い行は前後 context 行だけ残す
    let mut keep = vec![false; ops.len()];
    for (k, o) in ops.iter().enumerate() {
        if o.starts_with(' ') {
            continue;
        }
        for d in -context..=context {
            let p = k as i64 + d;
            if p >= 0 && (p as usize) < ops.len() {
                keep[p as usize] = true;
            }
        }
    }
    let mut out = Vec::new();
    let mut gap = 0;
    for (k, o) in ops.into_iter().enumerate() {
        if keep[k] {
            if gap > 0 {
                out.push(format!("… ({gap} 行同じ)"));
            }
            gap = 0;
            out.push(o);
        } else {
            gap += 1;
        }
    }
    if gap > 0 {
        out.push(format!("… ({gap} 行同じ)"));
    }
    out
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LibraryWritten {
    pub files: u64,
    pub bytes: u64,
    pub secret_hits: u64,
}

pub fn write_library(dir: &Path, groups: &[LibraryGroup]) -> std::io::Result<LibraryWritten> {
    std::fs::create_dir_all(dir)?;
    let mut w = LibraryWritten::default();
    for g in groups {
        for v in &g.versions {
            let (red, hits) = redact_secrets(&v.body);
            w.secret_hits += hits;
            let head = format!(
                "<!-- {}: {} / 版 {} / {} セッション / 初回 {} / 最終 {} -->\n",
                if g.kind == LibraryKind::Skill { "skill" } else { "指示文" },
                g.key.replace("-->", ""),
                v.hash,
                int_n(v.sessions.len() as f64),
                v.first_at.as_deref().unwrap_or("—"),
                v.last_at.as_deref().unwrap_or("—")
            );
            let md = format!("{head}{red}{}", if red.ends_with('\n') { "" } else { "\n" });
            write_text(&dir.join(format!("{}.md", v.hash)), &md)?;
            w.files += 1;
            w.bytes += byte_length(&md);
        }
    }
    Ok(w)
}

const LIB_CSS: &str = include_str!("../assets/library.css");
/// #session=<id> で開いたとき、そのセッションで使われた版だけを残す
const FILTER_JS: &str = include_str!("../assets/library-filter.js");

/// resolveInstruction の結果(全セッションを見て特定したファイルと範囲)
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedInstruction {
    pub file: String,
    pub scope: String,
}

pub struct InstructionsPageOptions<'a> {
    pub css: &'a str,
    pub generated_at: &'a str,
    pub code: &'a str,
    pub groups: &'a [LibraryGroup],
    /// セッション名(詳細ページへのリンクの文言)
    pub session_name: &'a dyn Fn(&str) -> String,
    /// セッションのプロジェクト名
    pub session_project: &'a dyn Fn(&str) -> Option<String>,
    /// 指示文の版の、全セッションを見て特定したファイルと範囲
    pub resolve_instruction: &'a dyn Fn(&str) -> Option<ResolvedInstruction>,
}

static PATH_SEP: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"[\\/]+").unwrap());

/// プロジェクトの短い名前(パスの最後の部分。長い名前は 24 字で切る)
fn short_name(p: &str) -> String {
    let s = PATH_SEP.split(p).filter(|x| !x.is_empty()).last().unwrap_or(p);
    if js::utf16_len(s) > 24 { format!("{}…", js::utf16_slice(s, 0, 23)) } else { s.to_string() }
}

/// プロジェクト名を最大 max 件並べ、残りは「他 N」
fn project_list(names: &[String], max: usize) -> String {
    format!(
        "{}{}",
        names.iter().take(max).map(|n| short_name(n)).collect::<Vec<_>>().join("・"),
        if names.len() > max { format!(" 他 {}", int_n((names.len() - max) as f64)) } else { String::new() }
    )
}

#[derive(Debug, Clone)]
struct UsePeriod {
    from: Option<String>,
    to: Option<String>,
}

/// 版の使用期間: 各セッションでその版を最初に読み込んだ日時の、最も早いものと最も遅いもの
fn use_period(v: &LibraryVersion) -> UsePeriod {
    let mut from = None;
    let mut to = None;
    for at in v.first_by_session.values() {
        from = earlier(from, at.as_deref());
        to = later(to, at.as_deref());
    }
    UsePeriod { from, to }
}

fn truthy(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|x| !x.is_empty())
}

/// 使われた期間が重なる(並行して使われた)か
fn overlaps(a: &UsePeriod, b: &UsePeriod) -> bool {
    match (truthy(&a.from), truthy(&a.to), truthy(&b.from), truthy(&b.to)) {
        (Some(af), Some(at), Some(bf), Some(bt)) => js::cmp_utf16(af, bt) != Ordering::Greater && js::cmp_utf16(bf, at) != Ordering::Greater,
        _ => false,
    }
}

pub fn render_instructions_html(o: &InstructionsPageOptions<'_>) -> String {
    let inst: Vec<&LibraryGroup> = o.groups.iter().filter(|g| g.kind == LibraryKind::Instruction).collect();
    let skills: Vec<&LibraryGroup> = o.groups.iter().filter(|g| g.kind == LibraryKind::Skill).collect();
    let gid = |g: &LibraryGroup, i: usize| -> String { if g.kind == LibraryKind::Skill { skill_anchor(&g.key) } else { format!("g-{i}") } };
    let item = |g: &LibraryGroup, i: usize| NavItem { href: format!("#{}", gid(g, i)), label: clean_heading(&g.key, Some(40)), count: Some(g.versions.len() as i64), count_label: Some("つの版".into()), show_count_label: true, lead: None };
    let nav_groups: Vec<NavGroup> = [
        NavGroup { title: Some("指示文".into()), items: inst.iter().enumerate().map(|(i, g)| item(g, i)).collect() },
        NavGroup { title: Some("skill".into()), items: skills.iter().enumerate().map(|(i, g)| item(g, inst.len() + i)).collect() },
    ]
    .into_iter()
    .filter(|g| !g.items.is_empty())
    .collect();
    let nav = PageNavOptions { crumb_href: "atlas.html".into(), crumb_label: "← レポートに戻る".into(), toc_label: "指示文と skill".into(), groups: nav_groups, links: vec![NavLink::new("glossary.html", "用語の説明")] };
    let project_of = |id: &str| -> Option<String> { (o.session_project)(id).filter(|s| !s.is_empty()) };
    let not_a_project = |p: &str| p == HOME_PROJECT || p == TEMP_PROJECT;
    let mut seen: std::collections::BTreeSet<Vec<u16>> = std::collections::BTreeSet::new();
    let mut seen_ids: HashMap<Vec<u16>, String> = HashMap::new();

    let mut body = String::new();
    for (i, g) in inst.iter().chain(skills.iter()).enumerate() {
        // 1 つのセッションが複数の版を使うと、版ごとのセッション数の合計が項目の数より多くなる。その差を見出しに書き添える
        let mut uses_by_session: HashMap<&str, i64> = HashMap::new();
        for v in &g.versions {
            for id in &v.sessions {
                *uses_by_session.entry(id.as_str()).or_insert(0) += 1;
            }
        }
        let total = uses_by_session.len();
        let multi = uses_by_session.values().filter(|n| **n > 1).count();
        let per: Vec<UsePeriod> = g.versions.iter().map(use_period).collect();
        let latest_k = (0..per.len()).fold(0, |a, k| if js::cmp_utf16(per[k].to.as_deref().unwrap_or(""), per[a].to.as_deref().unwrap_or("")) == Ordering::Greater { k } else { a });
        // ファイルの種別と範囲は、全セッションを見て特定したものを優先し、無ければ抜き出した時点の推定
        let resolved: Vec<Option<ResolvedInstruction>> = if g.kind == LibraryKind::Instruction { g.versions.iter().map(|v| (o.resolve_instruction)(&v.hash)).collect() } else { vec![] };
        let mut file_votes: IndexMap<&str, i64> = IndexMap::new();
        for r in resolved.iter().flatten() {
            if r.file != "unknown" {
                *file_votes.entry(r.file.as_str()).or_insert(0) += 1;
            }
        }
        let mut votes: Vec<(&str, i64)> = file_votes.into_iter().collect();
        votes.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| locale_compare(a.0, b.0)));
        let file = votes.first().map(|x| x.0.to_string()).unwrap_or_else(|| g.file.clone());
        let mut scopes: IndexSet<&str> = IndexSet::new();
        for r in resolved.iter().flatten() {
            if r.scope != "unknown" {
                scopes.insert(r.scope.as_str());
            }
        }
        // ユーザー単位の 1 ファイルなら、プロジェクトごとに分けても意味が無い
        let user_only = scopes.len() == 1 && scopes.contains("user");
        let scope_label = if scopes.len() == 2 {
            "リポジトリとユーザー"
        } else if user_only {
            "ユーザー"
        } else if scopes.contains("repo") {
            "リポジトリ"
        } else {
            ""
        };
        let kind_label = if g.kind == LibraryKind::Skill {
            "skill".to_string()
        } else if file == "unknown" {
            "指示文(ファイル不明: どのファイルから入ったか特定できなかったもの)".to_string()
        } else {
            format!("{file}{}", if scope_label.is_empty() { String::new() } else { format!("({scope_label})") })
        };
        // 版ごとの、使ったプロジェクトとセッション数(多い順)
        let projects: Vec<IndexMap<String, i64>> = g
            .versions
            .iter()
            .map(|v| {
                let mut m: IndexMap<String, i64> = IndexMap::new();
                for id in &v.sessions {
                    if let Some(p) = project_of(id) {
                        *m.entry(p).or_insert(0) += 1;
                    }
                }
                let mut e: Vec<(String, i64)> = m.into_iter().collect();
                e.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| locale_compare(&a.0, &b.0)));
                e.into_iter().collect()
            })
            .collect();
        // プロジェクトごとの最後の版(そのプロジェクトのセッションで最も遅く読み込み始めた版)
        let mut last_by_project: IndexMap<String, (usize, String)> = IndexMap::new();
        for (k, v) in g.versions.iter().enumerate() {
            for (id, at) in &v.first_by_session {
                let Some(p) = project_of(id) else { continue };
                let Some(at) = at.as_deref().filter(|s| !s.is_empty()) else { continue };
                let replace = match last_by_project.get(&p) {
                    None => true,
                    Some(cur) => js::cmp_utf16(at, &cur.1) == Ordering::Greater,
                };
                if replace {
                    last_by_project.insert(p, (k, at.to_string()));
                }
            }
        }
        // 最後の版ごとにプロジェクトを束ねる。最後に使われた時期の新しい順
        let mut by_last: IndexMap<usize, (Vec<String>, String)> = IndexMap::new();
        for (p, (k, at)) in &last_by_project {
            let cur = by_last.entry(*k).or_insert_with(|| (vec![], at.clone()));
            cur.0.push(p.clone());
            if js::cmp_utf16(at, &cur.1) == Ordering::Greater {
                cur.1 = at.clone();
            }
        }
        let ver_link = |k: usize| format!("<a href=\"#v-{}\">版 {}</a>", esc(&g.versions[k].hash), k + 1);
        let latest_line = if g.versions.len() < 2 {
            String::new()
        } else if by_last.len() > 1 && !user_only {
            let mut entries: Vec<(&usize, &(Vec<String>, String))> = by_last.iter().collect();
            entries.sort_by(|a, b| locale_compare(&b.1 .1, &a.1 .1));
            format!(
                "<p class=\"latest\">プロジェクトごとの最後の版: {}</p>",
                entries.iter().map(|(k, x)| format!("{} は <span title=\"{}\">{}</span>", ver_link(**k), esc(&x.0.join("\n")), esc(&project_list(&x.0, 3)))).collect::<Vec<_>>().join("、")
            )
        } else {
            format!(
                "<p class=\"latest\">最後に使われた版: {}({}{})</p>",
                ver_link(latest_k),
                esc(&date_time_n(per[latest_k].to.as_deref())),
                if !user_only && last_by_project.len() > 1 { format!("。使った {} プロジェクトのすべてで、この版が最後", esc(&int_n(last_by_project.len() as f64))) } else { String::new() }
            )
        };
        let in_session = if g.versions.len() > 1 { "<p class=\"latest in-session\" hidden></p>" } else { "" };
        let mut rows = String::new();
        for (k, v) in g.versions.iter().enumerate() {
            // 差分の元: 同じプロジェクトで前に使われた版(初回日の順で直前のもの)。無ければ初回日の順で 1 つ前の版
            let mut base: Option<usize> = None;
            let mut shared: Vec<String> = Vec::new();
            for j in (0..k).rev() {
                shared = projects[k].keys().filter(|p| !not_a_project(p) && projects[j].contains_key(*p)).cloned().collect();
                if !shared.is_empty() {
                    base = Some(j);
                    break;
                }
            }
            let same_project = base.is_some();
            if !same_project && k > 0 {
                base = Some(k - 1);
            }
            let prev = base.map(|b| &g.versions[b]);
            let parallel: Vec<String> = (0..g.versions.len()).filter(|j| *j != k && overlaps(&per[k], &per[*j])).map(|j| (j + 1).to_string()).collect();
            let names: Vec<String> = projects[k].keys().cloned().collect();
            let vbody = redact_secrets(&v.body).0;
            let diff = match prev {
                Some(p) => line_diff(&redact_secrets(&p.body).0, &vbody, 2)
                    .iter()
                    .map(|l| {
                        let mut cs = l.chars();
                        let sign = cs.next();
                        let rest = cs.as_str();
                        match sign {
                            Some('+') => format!("<span class=\"add\"><span class=\"sign\">+</span>{}</span>", esc(rest)),
                            Some('-') => format!("<span class=\"del\"><span class=\"sign\">−</span>{}</span>", esc(rest)),
                            Some(' ') => format!("<span class=\"sign\"> </span>{}", esc(rest)),
                            _ => esc(l),
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                None => String::new(),
            };
            let mut ids: Vec<&String> = v.sessions.iter().collect();
            ids.sort_by(|a, b| js::cmp_utf16(a, b));
            // 一覧は新しい順(そのセッションでこの版を最初に読み込んだ日時)
            let at = |id: &str| -> String { v.first_by_session.get(id).cloned().flatten().unwrap_or_default() };
            let mut by_new = ids.clone();
            by_new.sort_by(|a, b| locale_compare(&at(b), &at(a)).then_with(|| locale_compare(a, b)));
            let uses: String = by_new
                .iter()
                .take(50)
                .map(|id| format!("<li>{} <a href=\"sessions/{}\">{}</a></li>", esc(&date_n(v.first_by_session.get(id.as_str()).cloned().flatten().as_deref())), esc(&detail_file_name(id)), esc(&(o.session_name)(id))))
                .collect();
            let is_latest = k == latest_k;
            for id in &ids {
                let key: Vec<u16> = id.encode_utf16().collect();
                seen_ids.entry(key.clone()).or_insert_with(|| (*id).clone());
                seen.insert(key);
            }
            // 同じ分に丸まる日時は 1 つだけ出す
            let from = date_time_n(per[k].from.as_deref());
            let to = date_time_n(per[k].to.as_deref());
            let period = if from == to { from } else { format!("{from} 〜 {to}") };
            let cap = match base {
                None => String::new(),
                Some(b) if same_project => format!("版 {} → 版 {} の差分({} で前に使われた版 {} との行の比較)", b + 1, k + 1, project_list(&shared, 2), b + 1),
                Some(b) => format!(
                    "版 {} → 版 {} の差分(初回日の順で 1 つ前の版との行の比較{})",
                    b + 1,
                    k + 1,
                    if !names.is_empty() && !projects[b].is_empty() { "。同じプロジェクトで前に使われた版が無いので、別のプロジェクトの版と比べています" } else { "" }
                ),
            };
            rows.push_str(&format!(
                "<details class=\"ver\" id=\"v-{hash}\" data-n=\"{n}\" data-sessions=\"{sess}\"{latest_attr}><summary><b>版 {n}</b>{latest_tag}{parallel} <span>使用 {period}</span> <span>{nsess} セッション</span> <span>{chars} 字</span>{names} <span class=\"hash\" title=\"内容のハッシュ\">{hash}</span></summary>{diff_block}<p class=\"cap\">版 {n} の本文</p><pre class=\"body\" tabindex=\"0\">{body}</pre><div class=\"links\"><a href=\"{dir}/{hash}.md\">本文 (.md) を開く</a>{sources}</div><div class=\"uses\">使われたセッション({nids}): <ul>{uses}</ul>{more}</div></details>",
                hash = esc(&v.hash),
                n = k + 1,
                sess = esc(&ids.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" ")),
                latest_attr = if is_latest { " open data-latest" } else { "" },
                latest_tag = if is_latest && g.versions.len() > 1 { " <span class=\"tag latest\">最後に使われた版</span>" } else { "" },
                parallel = if parallel.is_empty() { String::new() } else { format!(" <span class=\"tag\">版 {} と並行して使用</span>", parallel.join("・")) },
                period = esc(&period),
                nsess = esc(&int_n(v.sessions.len() as f64)),
                chars = esc(&int_n(v.chars as f64)),
                names = if names.is_empty() { String::new() } else { format!(" <span title=\"{}\">{}</span>", esc(&names.join("\n")), esc(&project_list(&names, 3))) },
                diff_block = if prev.is_some() {
                    format!("<p class=\"cap\"{}>{}</p><pre class=\"body diff\" tabindex=\"0\">{diff}</pre>", if same_project { format!(" title=\"{}\"", esc(&shared.join("\n"))) } else { String::new() }, esc(&cap))
                } else {
                    String::new()
                },
                body = esc(&vbody),
                dir = LIBRARY_DIR,
                sources = if v.source_paths.is_empty() { String::new() } else { format!(" · 出所 {}", v.source_paths.iter().map(|sp| format!("<code>{}</code>", esc(sp))).collect::<Vec<_>>().join("、")) },
                nids = esc(&int_n(ids.len() as f64)),
                more = if ids.len() > 50 { format!(" …他 {} 件", esc(&int_n((ids.len() - 50) as f64))) } else { String::new() },
            ));
        }
        let id = gid(g, i);
        body.push_str(&format!(
            "<section class=\"section lib-group\" data-kind=\"{}\" id=\"{id}\" aria-labelledby=\"h-{id}\"><div class=\"section-head\"><h2 id=\"h-{id}\">{}</h2><p>{} · {} つの版 · {} セッションで使用{}</p>{latest_line}{in_session}</div><div class=\"versions\">{rows}</div></section>",
            if g.kind == LibraryKind::Skill { "skill" } else { "instruction" },
            esc(&clean_heading(&g.key, Some(120))),
            esc(&kind_label),
            esc(&int_n(g.versions.len() as f64)),
            esc(&int_n(total as f64)),
            if multi > 0 { format!("(うち {} セッションは 2 つ以上の版を使用)", esc(&int_n(multi as f64))) } else { String::new() }
        ));
    }
    // #session= の絞り込みで出す名前と詳細ページ(</script> で閉じないよう < を逃がす)
    let mut sessions_map: IndexMap<String, (String, String)> = IndexMap::new();
    for key in &seen {
        let id = &seen_ids[key];
        sessions_map.insert(id.clone(), ((o.session_name)(id), detail_file_name(id)));
    }
    let sessions_json = atlas_core::json::to_js_string(&sessions_map).unwrap_or_default().replace('<', "\\u003c");
    format!(
        "{head}<body>\n{top}\n<div class=\"shell\">\n{rail}\n<div class=\"content\">\n<main class=\"wrap\">\n<div class=\"title\"><h1>指示文と skill</h1><p class=\"lib-note\">セッションに注入された指示文(AGENTS.md / CLAUDE.md / copilot-instructions.md 等)と、呼ばれた skill の本文を、重複なしで版ごとに置いたものです。版は内容のハッシュで区別し、見出しが同じものを 1 つの項目にまとめています。「版 N」は初回の利用日の順の通し番号で、別のリポジトリの同じ見出しのファイルも同じ項目に入るため、番号が大きい版が今の版とは限りません。最後に使われた版に印を付けて開いた状態にし、使われた期間が重なる版には「並行して使用」と付けています(期間は、各セッションでその版を最初に読み込んだ日時)。差分は、同じプロジェクトで前に使われた版との行単位の比較です。生成 {at}。{none}</p><div class=\"lib-filter\" id=\"lib-filter\" role=\"status\" data-testid=\"lib-filter\" hidden></div></div>\n{body}\n</main>\n<footer class=\"wrap page-foot\"><p>本文は <code>{dir}/&lt;版&gt;.md</code> にも置いてあります。秘密情報の形式検査で伏せた箇所は <code>[伏せました: 種類]</code> です。</p></footer>\n</div>\n</div>\n<script type=\"application/json\" id=\"lib-sessions\">{sessions_json}</script>\n<script>{NAV_JS}</script>\n<script>{FILTER_JS}</script>\n</body>\n</html>\n",
        head = page_head(o.code, "指示文と skill | Copilot Session Atlas", &format!("{}{LIB_CSS}", o.css)),
        top = render_top(&nav),
        rail = render_rail(&nav),
        at = esc(&date_time_n(Some(o.generated_at))),
        none = if o.groups.is_empty() { "指示文も skill の本文も記録にありませんでした。" } else { "" },
        dir = LIBRARY_DIR,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_keeps_context() {
        let a = (1..=10).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let b = a.replace("5", "five");
        assert_eq!(line_diff(&a, &b, 2), vec!["… (2 行同じ)", " 3", " 4", "-5", "+five", " 6", " 7", "… (3 行同じ)"]);
        assert_eq!(line_diff("a", "a", 2), vec!["… (1 行同じ)"]);
    }

    #[test]
    fn anchors() {
        // TS 版の skillAnchor と同じ値(UTF-16 の単位ごとに _ にする)
        assert_eq!(skill_anchor("日本語の skill"), "s-_____skill-a17984");
        assert_eq!(skill_anchor(&"x".repeat(50)), format!("s-{}-c3f0ee", "x".repeat(40)));
        assert_eq!(skill_anchor("a😀b"), "s-a__b-d8f2ab");
    }
}
