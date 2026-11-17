//! 初期設定(packages/cli/src/setup.ts の移植。setup.bat から `atlas setup` で呼ぶ): llm-wiki の vault と普段の工程名、アップロード先を対話で尋ね、
//! リポジトリ直下の atlas.config.json を書く。フォルダはエクスプローラー(フォルダを選ぶ画面)で選べる。黒い窓へのドラッグとパスの入力でも決められる。
//! 書く前に parse_config で検査し、既存の設定は atlas.config.json.bak に退避する。集計はしない(atlas.bat で行う)。

use crate::config::{load_config, parse_config, parse_upload_root, AtlasConfig, CONFIG_FILE};
use anyhow::Result;
use atlas_core::js;
use atlas_core::nodepath::platform;
use atlas_core::project::os_homedir;
use atlas_core::wiki::WikiSpec;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, IsTerminal, Write};
use std::path::Path;
use std::sync::LazyLock;

pub trait SetupIo {
    /// 1 行を尋ねる(前後の空白は取り除いて返す)。入力が終わっていれば失敗
    fn ask(&self, question: &str) -> Result<String>;
    fn print(&self, line: &str);
    /// フォルダを選ぶ画面(エクスプローラー)を出せるか。出せないとき(Windows 以外、入力を流し込んでいるとき、出せなかった後)はドラッグかパスの入力で尋ねる
    fn can_pick(&self) -> bool;
    /// フォルダを選ぶ画面を出して選んでもらう(取り消しは None)
    fn pick(&self, title: &str, initial: Option<&str>) -> Result<Option<String>>;
    /// 選ぶ画面を以後出さない(出せない理由は押し直しても変わらないため)
    fn disable_pick(&self);
}

/// フォルダを選ぶ画面を出して、選んだフォルダを返す。取り消し・出せなかったときは理由を出して None
fn pick_with(io: &dyn SetupIo, title: &str, initial: Option<&str>) -> Option<String> {
    if !io.can_pick() {
        return None;
    }
    io.print("  フォルダを選ぶ画面(エクスプローラー)を開きます。見えないときはタスクバーを確かめてください。");
    match io.pick(title, initial) {
        Ok(r) => {
            if r.is_none() {
                io.print("  選びませんでした。");
            }
            r
        }
        Err(e) => {
            // 出せない理由(PowerShell が止められているなど)は押し直しても変わらないので、以後は出さずにドラッグかパスの入力で尋ねる
            io.disable_pick();
            io.print(&format!("  {e}。以後は、フォルダをこの窓にドラッグするか、パスを入力して決めてください。"));
            None
        }
    }
}

pub struct SetupOptions {
    /// 書く設定ファイル
    pub config_path: String,
    /// Copilot のデータの場所(インストール済み skill の候補を出すのに使う)
    pub copilot_home: String,
}

/// 書く設定の中身(atlas.config.json と同じ形)
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigJson {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wikis: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phases: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_root: Option<String>,
    /// upload-project.bat がまとめて送るプロジェクト(setup.bat では尋ねず、今の設定を残す)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_projects: Option<Vec<String>>,
}

static YES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?:y|yes|はい|ｙ)$").unwrap());
static NO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?:n|no|いいえ|ｎ)$").unwrap());
static LIST_SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("(?:[,、/／]|{})+", js::RE_S)).unwrap());
static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r#"^"({}*)"$"#, js::RE_DOT)).unwrap());
static TRAILING_SEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\\/]+$").unwrap());
static DRIVE_ONLY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:$").unwrap());
static TILDE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^~[\\/]").unwrap());
static HAS_SEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\\/:]").unwrap());
static VAULT_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"[^./\\~{}]", &js::RE_S[1..js::RE_S.len() - 1])).unwrap());
static WIKI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)wiki").unwrap());

fn yes(a: &str, def: bool) -> bool {
    if a.is_empty() { def } else { YES.is_match(a) }
}

fn list(a: &str) -> Vec<String> {
    LIST_SPLIT.split(a).map(|x| js::trim(x).to_string()).filter(|x| !x.is_empty()).collect()
}

/// ドラッグで入る引用符と、末尾の区切りを取る。Windows ではドライブの直下(C:\)は区切りを残す
/// (「C:」だけにすると「C ドライブの今のフォルダ」の意味になるため)。Windows 以外では「x:」は普通のフォルダ名なので変えない
pub fn unquote(a: &str, windows: bool) -> String {
    let s = QUOTED.replace(a, "$1");
    let s = TRAILING_SEP.replace(&s, "").into_owned();
    if windows && DRIVE_ONLY.is_match(&s) { format!("{s}\\") } else { s }
}

fn unq(a: &str) -> String {
    unquote(a, cfg!(windows))
}

/// vault を調べた結果
#[derive(Debug, Clone, PartialEq)]
pub struct VaultInfo {
    pub name: String,
    pub dir: Option<String>,
    pub has_index: bool,
    pub pages_dir: Option<String>,
}

fn is_dir(p: &str) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_dir())
}

/// 入力された vault を、設定に書く指定にする。実在するフォルダならフォルダ名だけにし、
/// 中を見て索引(index.md)と個別ページのフォルダ(wiki/)の有無を返す。実在しなければ入力をそのまま名前として使う
pub fn describe_vault(input: &str) -> VaultInfo {
    let raw = unq(js::trim(input));
    let full = if TILDE.is_match(&raw) { platform::join(&[&os_homedir(), &raw[2..]]) } else { raw.clone() };
    let dir = (HAS_SEP.is_match(&full) && is_dir(&full)).then(|| platform::resolve(&[&full]));
    let Some(dir) = dir else { return VaultInfo { name: raw.replace('\\', "/"), dir: None, has_index: false, pages_dir: None } };
    let has_index = Path::new(&platform::join(&[&dir, "index.md"])).exists();
    let pages_dir = is_dir(&platform::join(&[&dir, "wiki"])).then(|| "wiki".to_string());
    VaultInfo { name: platform::basename(&dir), dir: Some(dir), has_index, pages_dir }
}

/// インストール済みの skill のうち、名前に wiki を含むもの(wiki の skill として数える候補)
pub fn wiki_skill_candidates(copilot_home: &Path) -> Vec<String> {
    let inv = atlas_core::snapshot::read_inventory(copilot_home);
    let mut names: Vec<String> = Vec::new();
    for n in inv.skills.iter().chain(inv.plugins.iter().flat_map(|p| p.skills.iter())) {
        if !names.contains(n) {
            names.push(n.clone());
        }
    }
    let mut out: Vec<String> = names.into_iter().filter(|n| WIKI.is_match(n)).collect();
    out.sort_by(|a, b| js::cmp_utf16(a, b));
    out
}

/// skills はまだ尋ねていない skill の候補(尋ねたら空にする。skill は vault をまたいで数えるので、同じ候補を何度も尋ねない)
fn ask_vault(io: &dyn SetupIo, skills: &mut Vec<String>) -> Result<Option<WikiSpec>> {
    loop {
        // vault を数えない人が多いので、Enter は「終わる」のまま。エクスプローラーは y で開く
        let a = if io.can_pick() {
            io.ask("vault を数えるなら y でエクスプローラーが開きます(フォルダをこの窓にドラッグするか、フォルダ名を入力しても決められます。終わるときは何も入れずに Enter): ")?
        } else {
            io.ask("vault のフォルダをこの窓にドラッグするか、フォルダ名を入力して Enter(終わるときは何も入れずに Enter): ")?
        };
        if a.is_empty() {
            return Ok(None);
        }
        let mut input = a.clone();
        if io.can_pick() && yes(&a, false) {
            match pick_with(io, "llm-wiki の vault のフォルダを選んでください", None) {
                Some(p) => input = p,
                None => continue,
            }
        }
        let v = describe_vault(&input);
        if !VAULT_NAME.is_match(&v.name) {
            io.print("  フォルダ名を読めませんでした。もう一度入力してください。");
            continue;
        }
        let mut spec = WikiSpec { path: v.name.clone(), ..Default::default() };
        if v.dir.is_some() {
            io.print(&format!("  → フォルダ名「{}」で登録します(フルパスより、エージェントの書き方の違いに強いため)", v.name));
        } else {
            io.print(&format!("  → 「{}」で登録します(フォルダが見つからないので、中の確認はしません)", v.name));
        }
        if v.dir.is_some() && !v.has_index {
            let idx = io.ask("  index.md がありません。索引のファイル名を入力してください(vault からの相対。無ければ Enter): ")?;
            if !idx.is_empty() {
                spec.index = Some(list(&idx));
            }
        }
        let pages_default = v.pages_dir.clone().unwrap_or_else(|| ".".into());
        let pages = io.ask(&format!("  個別ページを置くフォルダ(vault からの相対。. は vault 全体。Enter で {pages_default}): "))?;
        let p = if pages.is_empty() { vec![pages_default] } else { list(&pages) };
        if !(p.len() == 1 && p[0] == ".") {
            spec.pages = Some(p);
        }
        if !skills.is_empty() {
            io.print(&format!("  インストール済みの skill に、名前に wiki を含むものがあります: {}", skills.join(", ")));
            if yes(&io.ask("  これらを wiki の skill として数えますか？ [Y/n]: ")?, true) {
                spec.skills = Some(skills.clone());
            }
            skills.clear();
        }
        let more = io.ask("  ほかに wiki の skill として数える名前があれば入力してください(, 区切り。無ければ Enter): ")?;
        if !more.is_empty() {
            let mut all = spec.skills.clone().unwrap_or_default();
            for n in list(&more) {
                if !all.contains(&n) {
                    all.push(n);
                }
            }
            spec.skills = Some(all);
        }
        return Ok(Some(spec));
    }
}

/// 指定を設定ファイルに書く形にする(path だけなら文字列)
fn compact(s: &WikiSpec) -> Value {
    if s.index.is_none() && s.pages.is_none() && s.extensions.is_none() && s.skills.is_none() {
        Value::String(s.path.clone())
    } else {
        serde_json::to_value(s).expect("JSON に書ける")
    }
}

/// 対話の結果
#[derive(Debug, Clone, PartialEq)]
pub struct SetupResult {
    pub written: bool,
    pub config: ConfigJson,
}

pub fn run_setup(io: &dyn SetupIo, o: &SetupOptions) -> Result<SetupResult> {
    io.print("");
    io.print("== agent-session-atlas の初期設定 ==");
    io.print(&format!("設定ファイル: {}", o.config_path));
    let current: Option<AtlasConfig> = match load_config(&o.config_path, false) {
        Ok(c) => Some(c),
        Err(e) => {
            io.print(&format!("今の設定ファイルを読めません({e})。作り直します。"));
            None
        }
    };
    let mut config = ConfigJson::default();

    io.print("");
    io.print("[1/3] llm-wiki の vault(参照を数える wiki のフォルダ。指定しないと wiki の参照は 0 件のままです)");
    let mut keep_wikis = false;
    if let Some(w) = current.as_ref().and_then(|c| c.wikis.as_ref()).filter(|w| !w.is_empty()) {
        io.print(&format!("  今の設定: {}", w.iter().map(|x| x.path.as_str()).collect::<Vec<_>>().join(", ")));
        keep_wikis = yes(&io.ask("  このままにしますか？ [Y/n]: ")?, true);
        if keep_wikis {
            config.wikis = Some(w.iter().map(compact).collect());
        }
    }
    if !keep_wikis {
        let mut skills = wiki_skill_candidates(Path::new(&o.copilot_home));
        let mut wikis: Vec<WikiSpec> = Vec::new();
        while let Some(w) = ask_vault(io, &mut skills)? {
            wikis.push(w);
            io.print("  別の vault も数えるなら続けて入力してください。");
        }
        if wikis.is_empty() {
            io.print("  vault は指定しません(wiki の参照は数えません)。");
        } else {
            config.wikis = Some(wikis.iter().map(compact).collect());
        }
    }

    io.print("");
    io.print("[2/3] 普段の工程名(依頼ごとの採用の判定で、LLM に選ばせる工程)");
    let cur_phases = current.as_ref().and_then(|c| c.phases.clone());
    let def: Vec<String> = cur_phases.clone().unwrap_or_else(|| atlas_core::turns::DEFAULT_PHASE_NAMES.iter().map(|s| s.to_string()).collect());
    io.print(&format!("  {}: {}", if cur_phases.is_some() { "今の設定" } else { "既定" }, def.join(" / ")));
    loop {
        let a = io.ask("  このままなら Enter。変えるときは工程名を / か , 区切りで入力(2 つ以上): ")?;
        if a.is_empty() {
            if cur_phases.is_some() {
                config.phases = cur_phases.clone();
            }
            break;
        }
        let phases = list(&a);
        match parse_config(&serde_json::json!({ "phases": phases })) {
            Ok(_) => {
                config.phases = Some(phases);
                break;
            }
            Err(e) => io.print(&format!("  {e}。もう一度入力してください。")),
        }
    }

    io.print("");
    io.print("[3/3] アップロード先(画面のタスクタグの「アップロード」と upload-project.bat が、<この場所>\\<タスクタグ名かプロジェクト名>\\<セッション ID>\\ に写します)");
    let cur = current.as_ref().and_then(|c| c.upload_root.clone());
    if let Some(c) = &cur {
        io.print(&format!("  今の設定: {c}"));
    }
    // エクスプローラーを出せるときは、まだ決めていなければ Enter で開く(決めてあれば Enter はこのまま、y で開く)。
    // 出せないとき(入力を流し込んでいるとき・出せなかった後)は、ドラッグかパスの入力だけで尋ねる
    let question = || -> String {
        if !io.can_pick() {
            format!("  フォルダをこの窓にドラッグするか、フルパスを入力して Enter({}何も入れずに Enter。画面からも決められます): ", if cur.is_some() { "このままなら" } else { "決めないなら" })
        } else if cur.is_some() {
            "  このままなら Enter。変えるなら y でエクスプローラーが開きます(フォルダをこの窓にドラッグするか、フルパスを入力しても決められます): ".into()
        } else {
            "  Enter でエクスプローラーが開きます(フォルダをこの窓にドラッグするか、フルパスを入力しても決められます。決めないなら n。画面からも決められます): ".into()
        }
    };
    loop {
        let mut a = unq(&io.ask(&question())?);
        let open = io.can_pick() && if cur.is_some() { yes(&a, false) } else { a.is_empty() };
        if open {
            match pick_with(io, "アップロード先のフォルダを選んでください(この中にタスクタグ名・プロジェクト名のフォルダを作ります)", cur.as_deref()) {
                Some(p) => a = p,
                None => continue,
            }
        } else if a.is_empty() || (io.can_pick() && NO.is_match(&a)) {
            if cur.is_some() {
                config.upload_root = cur.clone();
            }
            break;
        }
        match parse_upload_root(&Value::String(a)) {
            Ok(root) => {
                if !is_dir(&root) {
                    io.print(&format!("  フォルダが見つかりません: {root}(先にフォルダを作ってから入力してください)"));
                    continue;
                }
                config.upload_root = Some(root);
                break;
            }
            Err(e) => io.print(&format!("  {e}。もう一度入力してください。")),
        }
    }

    // まとめて送るプロジェクトは画面で選ぶものなので尋ねず、今の設定をそのまま残す
    if let Some(p) = current.as_ref().and_then(|c| c.upload_projects.clone()) {
        io.print("");
        io.print(&format!("upload-project.bat でまとめて送るプロジェクト({} 件)は、今の設定のまま残します(変えるときは atlas.bat の画面の「プロジェクト別」で)。", p.len()));
        config.upload_projects = Some(p);
    }

    let value = serde_json::to_value(&config)?;
    parse_config(&value).map_err(anyhow::Error::msg)?; // 書く前に、集計が読むのと同じ検査を通す
    let text = format!("{}\n", atlas_core::json::to_js_string_pretty(&value)?);
    io.print("");
    io.print("書き込む内容:");
    for l in js::trim_end(&text).split('\n') {
        io.print(&format!("  {l}"));
    }
    if !yes(&io.ask(&format!("{CONFIG_FILE} に書きますか？ [Y/n]: "))?, true) {
        io.print("書きませんでした。");
        return Ok(SetupResult { written: false, config });
    }
    if Path::new(&o.config_path).exists() {
        std::fs::copy(&o.config_path, format!("{}.bak", o.config_path))?;
        io.print(&format!("前の設定を {}.bak に退避しました。", o.config_path));
    }
    std::fs::write(&o.config_path, text)?;
    io.print(&format!("{} を書きました。atlas.bat をダブルクリックすると、この設定で集計します。", o.config_path));
    Ok(SetupResult { written: true, config })
}

/// 黒い窓とのやりとり(入力は 1 行ずつ。流し込んだ入力も、尋ねる前に届いた行を落とさない)
struct StdSetupIo {
    input: std::sync::Mutex<Box<dyn BufRead + Send>>,
    can_pick: std::cell::Cell<bool>,
}

impl SetupIo for StdSetupIo {
    fn ask(&self, q: &str) -> Result<String> {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(q.as_bytes());
        let _ = out.flush();
        let mut buf = Vec::new();
        let n = self.input.lock().unwrap().read_until(b'\n', &mut buf)?;
        if n == 0 {
            anyhow::bail!("入力が途中で終わりました(何も書いていません)");
        }
        Ok(js::trim(&String::from_utf8_lossy(&buf)).to_string())
    }
    fn print(&self, line: &str) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
    fn can_pick(&self) -> bool {
        self.can_pick.get()
    }
    fn pick(&self, title: &str, initial: Option<&str>) -> Result<Option<String>> {
        crate::folder_picker::pick_folder(title, initial)
    }
    fn disable_pick(&self) {
        self.can_pick.set(false);
    }
}

/// setup.bat から(`atlas setup`)
pub fn main(_argv: &[String]) -> u8 {
    let io = StdSetupIo {
        input: std::sync::Mutex::new(Box::new(std::io::BufReader::new(std::io::stdin()))),
        // エクスプローラーは、黒い窓で答えているときだけ出す(入力を流し込んでいるときに出すと、閉じる人がいなくて止まるため)
        can_pick: std::cell::Cell::new(crate::folder_picker::CAN_PICK_FOLDER && std::io::stdin().is_terminal()),
    };
    let config_path = crate::paths::REPO_ROOT.join(CONFIG_FILE).to_string_lossy().into_owned();
    if let Some(e) = std::env::var("ATLAS_CONFIG").ok().filter(|s| !s.is_empty()) {
        io.print(&format!("注意: 環境変数 ATLAS_CONFIG({e})が設定されています。集計はそちらを読むので、ここで書く {config_path} は使われません。"));
    }
    let copilot_home = match std::env::var("ATLAS_COPILOT_HOME").ok() {
        Some(h) => platform::resolve(&[&h]),
        None => platform::join(&[&os_homedir(), ".copilot"]),
    };
    match run_setup(&io, &SetupOptions { config_path, copilot_home }) {
        Ok(_) => 0,
        Err(e) => {
            eprint!("setup: {e}\n");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::fs;

    /// 答えを順に返す io(尋ねた文と表示した行を残す)。picks があれば選ぶ画面を出せる
    struct Scripted {
        answers: RefCell<Vec<String>>,
        asked: RefCell<Vec<String>>,
        printed: RefCell<Vec<String>>,
        picks: Option<RefCell<Vec<Result<Option<String>, String>>>>,
        picked_from: RefCell<Vec<(String, Option<String>)>>,
        can: Cell<bool>,
    }

    impl Scripted {
        fn new(answers: &[&str]) -> Self {
            Scripted {
                answers: RefCell::new(answers.iter().rev().map(|s| s.to_string()).collect()),
                asked: RefCell::default(),
                printed: RefCell::default(),
                picks: None,
                picked_from: RefCell::default(),
                can: Cell::new(false),
            }
        }
        fn with_picks(answers: &[&str], picks: Vec<Result<Option<String>, String>>) -> Self {
            let mut s = Scripted::new(answers);
            s.picks = Some(RefCell::new(picks.into_iter().rev().collect()));
            s.can.set(true);
            s
        }
        fn text(&self) -> String {
            self.printed.borrow().join("\n")
        }
    }

    impl SetupIo for Scripted {
        fn ask(&self, q: &str) -> Result<String> {
            self.asked.borrow_mut().push(q.into());
            self.answers.borrow_mut().pop().ok_or_else(|| anyhow::anyhow!("答えが足りません: {q}"))
        }
        fn print(&self, l: &str) {
            self.printed.borrow_mut().push(l.into());
        }
        fn can_pick(&self) -> bool {
            self.can.get()
        }
        fn pick(&self, title: &str, initial: Option<&str>) -> Result<Option<String>> {
            self.picked_from.borrow_mut().push((title.into(), initial.map(str::to_string)));
            match self.picks.as_ref().and_then(|p| p.borrow_mut().pop()) {
                Some(Ok(r)) => Ok(r),
                Some(Err(e)) => Err(anyhow::anyhow!(e)),
                None => Ok(None),
            }
        }
        fn disable_pick(&self) {
            self.can.set(false);
        }
    }

    struct Env {
        _d: tempfile::TempDir,
        d: String,
        config_path: String,
        home: String,
        vault: String,
    }

    fn env() -> Env {
        let t = tempfile::tempdir().unwrap();
        let d = t.path().to_string_lossy().into_owned();
        let home = format!("{d}/.copilot");
        fs::create_dir_all(format!("{home}/skills/wiki-query")).unwrap();
        fs::create_dir_all(format!("{home}/skills/other")).unwrap();
        let vault = platform::join(&[&d, "my vault"]);
        fs::create_dir_all(platform::join(&[&vault, "wiki"])).unwrap();
        fs::write(platform::join(&[&vault, "index.md"]), "# index").unwrap();
        Env { config_path: platform::join(&[&d, "atlas.config.json"]), home, vault, d, _d: t }
    }

    fn opts(e: &Env) -> SetupOptions {
        SetupOptions { config_path: e.config_path.clone(), copilot_home: e.home.clone() }
    }

    fn written(e: &Env) -> Value {
        js::parse_json(&fs::read_to_string(&e.config_path).unwrap()).unwrap()
    }

    #[test]
    fn vault_and_unquote() {
        let e = env();
        let v = describe_vault(&format!("\"{}\\\"", e.vault));
        assert_eq!((v.name.as_str(), v.has_index, v.pages_dir.as_deref()), ("my vault", true, Some("wiki")));
        assert_eq!(describe_vault("work/notes"), VaultInfo { name: "work/notes".into(), dir: None, has_index: false, pages_dir: None });
        for (i, w) in [("C:\\", "C:\\"), ("C:", "C:\\"), ("\"C:\\\"", "C:\\"), ("c:/", "c:\\")] {
            assert_eq!(unquote(i, true), w, "{i}");
        }
        assert_eq!(unquote("\"D:\\logs\\\"", true), "D:\\logs");
        assert_eq!(unquote("x:", false), "x:");
        assert_eq!(unquote("/home/me/notes/", false), "/home/me/notes");
    }

    #[test]
    fn asks_and_writes() {
        let e = env();
        let logs = platform::join(&[&e.d, "atlas logs"]);
        fs::create_dir(&logs).unwrap();
        let none = platform::join(&[&e.d, "none"]);
        let vault_q = format!("\"{}\"", e.vault);
        let logs_q = format!("\"{logs}\\\"");
        let io = Scripted::new(&[&vault_q, "", "y", "my-wiki-skill", "second", "", "", "", "設計 / 実装 / テスト", &none, "relative", &logs_q, ""]);
        let r = run_setup(&io, &opts(&e)).unwrap();
        assert!(r.written);
        assert_eq!(
            written(&e),
            serde_json::json!({ "wikis": [{ "path": "my vault", "pages": ["wiki"], "skills": ["wiki-query", "my-wiki-skill"] }, "second"], "phases": ["設計", "実装", "テスト"], "uploadRoot": logs })
        );
        assert!(io.text().contains("フォルダが見つかりません"));
        assert!(io.text().contains("フルパスで指定してください"));
        let c = load_config(&e.config_path, true).unwrap();
        assert_eq!(c.upload_root.as_deref(), Some(logs.as_str()));
    }

    #[test]
    fn keeps_current_and_backs_up() {
        let e = env();
        fs::write(&e.config_path, serde_json::json!({ "wikis": [{ "path": "old", "pages": ["wiki"] }], "phases": ["a", "b"], "uploadRoot": e.d, "uploadProjects": ["owner/app"] }).to_string()).unwrap();
        let io = Scripted::new(&["", "1つだけ", "x / x", "x / y", "", ""]);
        run_setup(&io, &opts(&e)).unwrap();
        assert_eq!(written(&e), serde_json::json!({ "wikis": [{ "path": "old", "pages": ["wiki"] }], "phases": ["x", "y"], "uploadRoot": e.d, "uploadProjects": ["owner/app"] }));
        assert!(io.text().contains("まとめて送るプロジェクト(1 件)は、今の設定のまま残します"));
        let bak = js::parse_json(&fs::read_to_string(format!("{}.bak", e.config_path)).unwrap()).unwrap();
        assert_eq!(bak["phases"], serde_json::json!(["a", "b"]));
        assert!(io.text().contains("phases は 2 つ以上指定してください"));
        assert!(io.text().contains("phases に同じ名前が 2 回あります"));
    }

    #[test]
    fn picker_flow() {
        let e = env();
        let logs = platform::join(&[&e.d, "atlas logs"]);
        fs::create_dir(&logs).unwrap();
        let io = Scripted::with_picks(&["y", "", "n", "", "", "", "", "", ""], vec![Ok(Some(e.vault.clone())), Ok(None), Ok(Some(logs.clone()))]);
        let r = run_setup(&io, &opts(&e)).unwrap();
        assert!(r.written);
        assert_eq!(written(&e), serde_json::json!({ "wikis": [{ "path": "my vault", "pages": ["wiki"] }], "uploadRoot": logs }));
        let from: Vec<(String, Option<String>)> = io.picked_from.borrow().iter().map(|(t, i)| (t.chars().take(6).collect(), i.clone())).collect();
        assert_eq!(from, vec![("llm-wi".to_string(), None), ("アップロード".to_string(), None), ("アップロード".to_string(), None)]);
        assert!(io.text().contains("選びませんでした。"));
        // 出せなかったら、以後は入力で尋ねる
        let e = env();
        let logs = platform::join(&[&e.d, "logs"]);
        fs::create_dir(&logs).unwrap();
        let io = Scripted::with_picks(&["y", "", "", "", &logs, ""], vec![Ok(None), Err("フォルダを選ぶ画面を出せませんでした(テスト)".into())]);
        run_setup(&io, &opts(&e)).unwrap();
        assert_eq!(written(&e), serde_json::json!({ "uploadRoot": logs }));
        assert!(io.text().contains("フォルダを選ぶ画面を出せませんでした(テスト)。以後は、フォルダをこの窓にドラッグするか、パスを入力して決めてください。"));
        let asked = io.asked.borrow();
        assert!(asked[asked.len() - 2].starts_with("  フォルダをこの窓にドラッグするか、フルパスを入力して Enter"));
    }

    #[test]
    fn nothing_and_decline() {
        let e = env();
        let io = Scripted::new(&["", "", "", "n"]);
        let r = run_setup(&io, &SetupOptions { config_path: e.config_path.clone(), copilot_home: platform::join(&[&e.d, "none"]) }).unwrap();
        assert_eq!(r, SetupResult { written: false, config: ConfigJson::default() });
        assert!(!Path::new(&e.config_path).exists());
    }
}
