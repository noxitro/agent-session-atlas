//! 設定のフォルダ(本番の置き方。README の「本番の置き方(SessionLog と AtlasSettings)」と docs/cli.md の open)。
//! チームは共有の場所に、セッションの送り先(SessionLog)と並べて設定のフォルダ(AtlasSettings)を置き、中に集計の設定(atlas.config.json)と、
//! 管理ツールが書き出したタスクの XML を置く。集計する人が atlas open で送り先(か、その中の人やプロジェクトのフォルダ)を開くと:
//! - 集計(extract・vcs・metrics・build・export と、画面から動かす処理)は、設定のフォルダの atlas.config.json を設定として読む
//! - その設定に tasks があれば、タスクの状態(tasks.json)と紐づけ(task-links.json)を設定のフォルダに置き、集計する人が紐づける
//!   (集計のたびに XML を読み、機械の紐づけを決め直す。LLM の紐づけと手動の紐づけもできる)。送った人が添えたタスクの記録は使わない
//!
//! - 工数と依頼ごとの判定(judgments.json・turn-judgments.json)は、設定のフォルダを使うときはいつも設定のフォルダに置く
//!   (集計する人や開いたパスが違っても、同じ判定を使う。取り込みはファイルのロックの中で読み直して、セッションごとに混ぜて書く)。
//!   前に開いたフォルダの出力先にあった判定は、初めて使うときに混ぜて移す(共有の側にあるものを優先する。move_judgments)
//!
//! 使う設定のフォルダは open で決め(settings_for_open)、開いたフォルダの記録(folder.json の settings)に覚える。
//! 開いたフォルダの出力先(--out)に向けたほかのコマンド(画面のジョブ・CLI)は、その記録か --settings から同じものを使う(apply_settings)。

use crate::args::CliOptions;
use crate::commands::Log;
use crate::config::CONFIG_FILE;
use crate::folders::{is_opened_folder_out, read_folder_state, FOLDER_STATE_FILE};
use crate::paths::{resolve, Paths};
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

/// 設定のフォルダの名前(開いたフォルダから上へ探すときの名前)
pub const SETTINGS_DIR_NAME: &str = "AtlasSettings";

/// 設定のフォルダの設定ファイル
pub fn settings_config(dir: &Path) -> PathBuf {
    dir.join(CONFIG_FILE)
}

fn has_config(dir: &Path) -> bool {
    settings_config(dir).is_file()
}

/// 開いたフォルダ F から、F・F の親・その親…と上がり、どこかの段 D に <D>/AtlasSettings/atlas.config.json があれば、その AtlasSettings。
/// ドライブや共有の根まで上がる(\\server\share\SessionLog\alice なら \\server\share\AtlasSettings まで見る)
pub fn find_upward(folder: &Path) -> Option<PathBuf> {
    folder.ancestors().map(|d| d.join(SETTINGS_DIR_NAME)).find(|s| has_config(s))
}

/// 使う設定のフォルダをどう決めたか
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsFrom {
    /// --settings で指した
    Given,
    /// そのフォルダを前に開いたときに使ったもの(folder.json の settings)
    Remembered,
    /// 開いたフォルダから上へ探して見つけたもの
    Found,
}

impl SettingsFrom {
    /// 画面の答え(api/folders/check)に入れる名前
    pub fn key(self) -> &'static str {
        match self {
            SettingsFrom::Given => "given",
            SettingsFrom::Remembered => "remembered",
            SettingsFrom::Found => "found",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            SettingsFrom::Given => "--settings で指したもの",
            SettingsFrom::Remembered => "前にこのフォルダを開いたときに使ったもの",
            SettingsFrom::Found => "開いたフォルダから上へ探して見つけたもの",
        }
    }
}

/// open で使う設定のフォルダ(無ければ dir は None)と、知らせ(前に使ったものが見つからないなど)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OpenSettings {
    pub dir: Option<(PathBuf, SettingsFrom)>,
    pub notes: Vec<String>,
}

/// atlas open が使う設定のフォルダを、次の順で決める。
/// 1. --settings で指したもの(atlas.config.json が無ければ止める)
/// 2. そのフォルダを前に開いたときに使ったもの(atlas.config.json が無くなっていれば、知らせて次へ)
/// 3. 開いたフォルダから上へ探して見つけたもの(find_upward)
/// 4. どれでもなければ使わない(今までどおり。--config があればそれを読む)
pub fn settings_for_open(given: Option<&str>, remembered: Option<&str>, folder: &Path) -> Result<OpenSettings> {
    if let Some(g) = given {
        let dir = resolve(g);
        if !dir.is_dir() {
            bail!("設定のフォルダが見つかりません: {}", dir.display());
        }
        if !has_config(&dir) {
            bail!("設定のフォルダに {CONFIG_FILE} がありません: {}", dir.display());
        }
        return Ok(OpenSettings { dir: Some((dir, SettingsFrom::Given)), notes: vec![] });
    }
    let mut notes = Vec::new();
    if let Some(r) = remembered.filter(|r| !r.is_empty()) {
        let dir = resolve(r);
        if has_config(&dir) {
            return Ok(OpenSettings { dir: Some((dir, SettingsFrom::Remembered)), notes });
        }
        notes.push(format!("前にこのフォルダを開いたときの設定のフォルダ {} に {CONFIG_FILE} が見つからないので、探し直します(つながっていない共有かもしれません)", dir.display()));
    }
    Ok(OpenSettings { dir: find_upward(folder).map(|d| (d, SettingsFrom::Found)), notes })
}

/// 開いたフォルダの出力先(<置き場>/<キー>/out)なら、その記録(folder.json)にある設定のフォルダ
pub fn remembered_for_out(out: &Path) -> Option<String> {
    let out_s = out.to_string_lossy();
    if !is_opened_folder_out(&out_s) {
        return None;
    }
    let state = out.parent()?.join(FOLDER_STATE_FILE);
    read_folder_state(&state.to_string_lossy())?.settings.filter(|s| !s.is_empty())
}

/// 設定のフォルダに置く、工数の判定と依頼ごとの判定のファイル
pub fn shared_judgment_files(dir: &Path) -> (PathBuf, PathBuf) {
    (dir.join(atlas_judge::rubric::RESULT_FILE), dir.join(atlas_judge::turn_bundle::TURN_RESULT_FILE))
}

type MoveFn = fn(&Path, &Path) -> Result<Option<atlas_judge::judgments_io::Moved>>;

/// 前に出力先(out)にあった判定を、設定のフォルダの共有の置き場に混ぜて移す(共有の側にあるものを優先する)。移したら 1 行ずつ知らせる。
/// 前の判定が読めないときは移さずに注意を出す(前のファイルはそのまま残す)
fn move_judgments(p: &Paths, dir: &Path, log: Log<'_>) {
    let pairs: [(&str, PathBuf, &Path, MoveFn, &str); 2] = [
        ("工数の判定", p.out.join(atlas_judge::rubric::RESULT_FILE), &p.judgments, atlas_judge::judgments_io::move_judgments_into, "セッション"),
        ("依頼ごとの判定", p.out.join(atlas_judge::turn_bundle::TURN_RESULT_FILE), &p.turn_judgments, atlas_judge::turn_schema::move_turn_judgments_into, "依頼"),
    ];
    for (what, from, to, mv, unit) in pairs {
        // 共有の置き場に移すだけ(--judgments で指したファイルには移さない)
        if from == to || !to.starts_with(dir) {
            continue;
        }
        match mv(&from, to) {
            Ok(None) => {}
            Ok(Some(m)) => log(&format!(
                "settings: 出力先にあった{what}を、設定のフォルダの共有の置き場 {} に移しました(足した{unit} {} 件。共有の側にあったものはそのまま。前のファイルは {} に名前を変えました)",
                to.display(),
                m.added,
                m.renamed_to.display()
            )),
            Err(e) => log(&format!("settings: 注意 出力先にあった{what} {} を共有の置き場に移せませんでした({e:#})。前のファイルはそのまま残し、共有の置き場の判定を使います", from.display())),
        }
    }
}

/// コマンドに設定のフォルダを当てる。--settings か、開いたフォルダの出力先の記録から決め(--config より先に使う)、
/// あれば設定ファイルをそのフォルダの atlas.config.json にし、その設定に tasks があればタスクの状態と紐づけの場所を設定のフォルダにする。
/// 工数と依頼ごとの判定は、いつも設定のフォルダに置く(--judgments で指したときは、工数の判定だけそのファイル)。前に出力先にあった判定は移す。
/// 設定ファイルが無い・読めないときは止める(黙って送った人の記録に戻さない)
pub fn apply_settings(o: &CliOptions, p: &mut Paths, log: Log<'_>) -> Result<CliOptions> {
    let dir = match &o.settings {
        Some(s) => Some(resolve(s)),
        None => remembered_for_out(&p.out).map(resolve),
    };
    let Some(dir) = dir else { return Ok(o.clone()) };
    let cfg = settings_config(&dir);
    if !cfg.is_file() {
        bail!(
            "設定のフォルダに {CONFIG_FILE} がありません: {}(つながっていない共有かもしれません。別の場所を使うときは --settings で指すか、atlas open で開き直してください)",
            dir.display()
        );
    }
    let cfg_s = cfg.to_string_lossy().into_owned();
    let tc = crate::commands::tasks::load_task_config(Some(&cfg_s));
    if let Some(e) = &tc.error {
        bail!("設定のフォルダの {CONFIG_FILE} を読めません: {e}");
    }
    if tc.source.is_some() {
        p.tasks_dir = dir.clone();
        p.central_tasks = true;
    }
    let (judgments, turn_judgments) = shared_judgment_files(&dir);
    if o.judgments.is_none() {
        p.judgments = judgments;
    }
    p.turn_judgments = turn_judgments;
    p.shared_judgments = true;
    p.settings = Some(dir.clone());
    move_judgments(p, &dir, log);
    Ok(CliOptions { config: Some(cfg_s), settings: Some(dir.to_string_lossy().into_owned()), ..o.clone() })
}

/// 設定のフォルダのタスクを使うときの、集計の入力の印に足すもの(XML・tasks.json・task-links.json の大きさと更新日時)。
/// ほかの集計する人の紐づけや、XML の書き出しが変われば、atlas open は作り直す
pub fn central_task_stamp(p: &Paths, config: &str) -> Option<String> {
    if !p.central_tasks {
        return None;
    }
    let tc = crate::commands::tasks::load_task_config(Some(config));
    let mut files: Vec<PathBuf> = tc.source.map(|s| s.file).into_iter().collect();
    files.push(atlas_report::tasks::tasks_path(&p.tasks_dir));
    files.push(atlas_report::tasks::task_links_path(&p.tasks_dir));
    let stat = |f: &Path| match std::fs::metadata(f) {
        Ok(m) if m.is_file() => format!("{}:{}", m.len(), atlas_core::js::num_to_string(atlas_core::jsfs::mtime_ms(&m))),
        _ => "none".into(),
    };
    Some(files.iter().map(|f| format!("{}={}", f.display(), stat(f))).collect::<Vec<_>>().join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put_config(dir: &Path, json: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(settings_config(dir), json).unwrap();
    }

    /// 上へ探す: 開いたフォルダ自身から根まで。AtlasSettings に atlas.config.json が無ければ見つからない
    #[test]
    fn finds_settings_upward() {
        let d = tempfile::tempdir().unwrap();
        let log = d.path().join("SessionLog");
        let alice = log.join("alice").join("proj");
        std::fs::create_dir_all(&alice).unwrap();
        assert_eq!(find_upward(&alice), None);
        // 名前だけのフォルダ(設定ファイルが無い)は使わない
        std::fs::create_dir_all(d.path().join(SETTINGS_DIR_NAME)).unwrap();
        assert_eq!(find_upward(&alice), None);
        put_config(&d.path().join(SETTINGS_DIR_NAME), "{}");
        assert_eq!(find_upward(&alice), Some(d.path().join(SETTINGS_DIR_NAME)));
        assert_eq!(find_upward(d.path()), Some(d.path().join(SETTINGS_DIR_NAME)));
        // 近いものを使う
        put_config(&log.join("alice").join(SETTINGS_DIR_NAME), "{}");
        assert_eq!(find_upward(&alice), Some(log.join("alice").join(SETTINGS_DIR_NAME)));
    }

    /// 決める順: --settings → 前に使ったもの → 上へ探す → 使わない
    #[test]
    fn open_order() {
        let d = tempfile::tempdir().unwrap();
        let folder = d.path().join("SessionLog").join("alice");
        std::fs::create_dir_all(&folder).unwrap();
        let found = d.path().join(SETTINGS_DIR_NAME);
        let other = d.path().join("other-settings");
        let s = |p: &Path| p.to_string_lossy().into_owned();
        assert_eq!(settings_for_open(None, None, &folder).unwrap(), OpenSettings::default());
        put_config(&found, "{}");
        assert_eq!(settings_for_open(None, None, &folder).unwrap().dir, Some((found.clone(), SettingsFrom::Found)));
        // 前に使ったものが無くなっていれば、知らせて探し直す
        let r = settings_for_open(None, Some(&s(&other)), &folder).unwrap();
        assert_eq!(r.dir, Some((found.clone(), SettingsFrom::Found)));
        assert!(r.notes[0].contains("探し直します"), "{:?}", r.notes);
        put_config(&other, "{}");
        assert_eq!(settings_for_open(None, Some(&s(&other)), &folder).unwrap().dir, Some((other.clone(), SettingsFrom::Remembered)));
        assert_eq!(settings_for_open(Some(&s(&found)), Some(&s(&other)), &folder).unwrap().dir, Some((found.clone(), SettingsFrom::Given)));
        // --settings で指した場所に設定ファイルが無ければ止める
        let e = settings_for_open(Some(&s(&folder)), None, &folder).unwrap_err();
        assert!(e.to_string().contains("atlas.config.json がありません"), "{e}");
        assert!(settings_for_open(Some(&s(&d.path().join("nope"))), None, &folder).unwrap_err().to_string().contains("見つかりません"));
    }

    /// コマンドに当てる: tasks があればタスクの置き場を設定のフォルダにする。設定ファイルが無ければ止める
    #[test]
    fn apply_to_command() {
        let d = tempfile::tempdir().unwrap();
        let st = d.path().join(SETTINGS_DIR_NAME);
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let opts = |extra: &[&str]| crate::args::parse_cli(&["tasks", "list"].iter().chain(extra).map(|x| x.to_string()).collect::<Vec<_>>()).unwrap();
        let paths = || crate::paths::resolve_paths(crate::paths::PathInputs { home: None, out: Some(&s(&d.path().join("out"))), judgments: None, bundle: None, notes_dir: Some(&s(&d.path().join("notes"))) });
        // 指さなければ何もしない
        let mut p = paths();
        let o = apply_settings(&opts(&[]), &mut p, &|_| {}).unwrap();
        assert_eq!((o.config, p.tasks_dir.clone(), p.central_tasks), (None, d.path().join("notes"), false));
        // 設定ファイルが無ければ止める
        let mut p = paths();
        assert!(apply_settings(&opts(&["--settings", &s(&st)]), &mut p, &|_| {}).unwrap_err().to_string().contains("atlas.config.json がありません"));
        // tasks が無ければ、設定ファイルだけを使う
        put_config(&st, "{}");
        let mut p = paths();
        let o = apply_settings(&opts(&["--settings", &s(&st)]), &mut p, &|_| {}).unwrap();
        assert_eq!((o.config.as_deref(), p.central_tasks, p.settings.clone()), (Some(s(&settings_config(&st)).as_str()), false, Some(st.clone())));
        assert_eq!(central_task_stamp(&p, o.config.as_deref().unwrap()), None);
        // tasks があれば、タスクの置き場も設定のフォルダ
        put_config(&st, r#"{ "tasks": { "file": "export.xml" } }"#);
        let mut p = paths();
        let o = apply_settings(&opts(&["--settings", &s(&st)]), &mut p, &|_| {}).unwrap();
        assert_eq!((p.tasks_dir.clone(), p.central_tasks), (st.clone(), true));
        let stamp = central_task_stamp(&p, o.config.as_deref().unwrap()).unwrap();
        assert!(stamp.contains("export.xml=none") && stamp.contains("task-links.json=none"), "{stamp}");
        // 読めない設定は止める
        put_config(&st, "{");
        let mut p = paths();
        assert!(apply_settings(&opts(&["--settings", &s(&st)]), &mut p, &|_| {}).unwrap_err().to_string().contains("読めません"));
    }

    /// 判定は、設定のフォルダを使うときはいつも設定のフォルダに置く。前に出力先にあった判定は移し、1 行知らせる
    #[test]
    fn judgments_are_shared_in_the_settings_folder() {
        let d = tempfile::tempdir().unwrap();
        let st = d.path().join(SETTINGS_DIR_NAME);
        put_config(&st, "{}");
        let out = d.path().join("out");
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let opts = |extra: &[&str]| crate::args::parse_cli(&["export"].iter().chain(extra).map(|x| x.to_string()).collect::<Vec<_>>()).unwrap();
        let paths = || crate::paths::resolve_paths(crate::paths::PathInputs { home: None, out: Some(&s(&out)), judgments: None, bundle: None, notes_dir: Some(&s(&d.path().join("notes"))) });
        // 設定のフォルダが無ければ、今までどおり出力先
        let mut p = paths();
        apply_settings(&opts(&[]), &mut p, &|_| {}).unwrap();
        assert_eq!((p.judgments.clone(), p.turn_judgments.clone(), p.shared_judgments), (out.join("judgments.json"), out.join("turn-judgments.json"), false));
        // 前に出力先にあった判定は、共有の置き場に移す
        let item = |id: &str| serde_json::json!({ "sessionId": id, "taskCategory": "feature", "taskSummary": "要約", "humanEffort": { "hours": 2, "low": 1, "high": 4, "confidence": 0.5, "rationale": "r" }, "aiOutcome": { "completed": true, "quality": 4, "rework": 1, "rationale": "r" }, "instructionsEffect": { "score": 0, "evidence": "e" }, "wikiEffect": { "score": 0, "evidence": "e" }, "skillsAgentsEffect": { "score": 0, "evidence": "e" } });
        atlas_judge::judgments_io::import_judgments_text(&serde_json::json!([item("a")]).to_string(), &out.join("judgments.json"), Default::default()).unwrap();
        let logs = std::sync::Mutex::new(Vec::<String>::new());
        let mut p = paths();
        apply_settings(&opts(&["--settings", &s(&st)]), &mut p, &|m| logs.lock().unwrap().push(m.to_string())).unwrap();
        assert_eq!((p.judgments.clone(), p.turn_judgments.clone(), p.shared_judgments), (st.join("judgments.json"), st.join("turn-judgments.json"), true));
        let logs = logs.into_inner().unwrap();
        assert_eq!(logs.len(), 1, "{logs:?}");
        assert!(logs[0].contains("工数の判定を、設定のフォルダの共有の置き場") && logs[0].contains("1 件"), "{logs:?}");
        assert!(st.join("judgments.json").is_file() && !out.join("judgments.json").exists());
        // --judgments で指したときは、工数の判定はそのファイル(依頼ごとの判定は共有)
        let mine = d.path().join("mine.json");
        let o = opts(&["--settings", &s(&st), "--judgments", &s(&mine)]);
        let mut p = crate::commands::paths_of(&o);
        std::fs::write(out.join("judgments.json"), "{}").unwrap();
        apply_settings(&o, &mut p, &|_| {}).unwrap();
        assert_eq!((p.judgments.clone(), p.turn_judgments.clone()), (mine.clone(), st.join("turn-judgments.json")));
        // 指したファイルには、出力先の判定を移さない
        assert!(!mine.exists() && out.join("judgments.json").exists());
    }
}
