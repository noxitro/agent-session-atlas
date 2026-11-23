//! 設定のフォルダ(本番の置き方。README の「本番の置き方(SessionLog と AtlasSettings)」と docs/cli.md の open)。
//! チームは共有の場所に、セッションの送り先(SessionLog)と並べて設定のフォルダ(AtlasSettings)を置き、中に集計の設定(atlas.config.json)と、
//! 管理ツールが書き出したタスクの XML を置く。集計する人が atlas open で送り先(か、その中の人やプロジェクトのフォルダ)を開くと:
//! - 集計(extract・vcs・metrics・build・export と、画面から動かす処理)は、設定のフォルダの atlas.config.json を設定として読む
//! - その設定に tasks があれば、タスクの状態(tasks.json)と紐づけ(task-links.json)を設定のフォルダに置き、集計する人が紐づける
//!   (集計のたびに XML を読み、機械の紐づけを決め直す。LLM の紐づけと手動の紐づけもできる)。送った人が添えたタスクの記録は使わない
//!
//! 使う設定のフォルダは open で決め(settings_for_open)、開いたフォルダの記録(folder.json の settings)に覚える。
//! 開いたフォルダの出力先(--out)に向けたほかのコマンド(画面のジョブ・CLI)は、その記録か --settings から同じものを使う(apply_settings)。

use crate::args::CliOptions;
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

/// コマンドに設定のフォルダを当てる。--settings か、開いたフォルダの出力先の記録から決め(--config より先に使う)、
/// あれば設定ファイルをそのフォルダの atlas.config.json にし、その設定に tasks があればタスクの状態と紐づけの場所を設定のフォルダにする。
/// 設定ファイルが無い・読めないときは止める(黙って送った人の記録に戻さない)
pub fn apply_settings(o: &CliOptions, p: &mut Paths) -> Result<CliOptions> {
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
    p.settings = Some(dir.clone());
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
        let o = apply_settings(&opts(&[]), &mut p).unwrap();
        assert_eq!((o.config, p.tasks_dir.clone(), p.central_tasks), (None, d.path().join("notes"), false));
        // 設定ファイルが無ければ止める
        let mut p = paths();
        assert!(apply_settings(&opts(&["--settings", &s(&st)]), &mut p).unwrap_err().to_string().contains("atlas.config.json がありません"));
        // tasks が無ければ、設定ファイルだけを使う
        put_config(&st, "{}");
        let mut p = paths();
        let o = apply_settings(&opts(&["--settings", &s(&st)]), &mut p).unwrap();
        assert_eq!((o.config.as_deref(), p.central_tasks, p.settings.clone()), (Some(s(&settings_config(&st)).as_str()), false, Some(st.clone())));
        assert_eq!(central_task_stamp(&p, o.config.as_deref().unwrap()), None);
        // tasks があれば、タスクの置き場も設定のフォルダ
        put_config(&st, r#"{ "tasks": { "file": "export.xml" } }"#);
        let mut p = paths();
        let o = apply_settings(&opts(&["--settings", &s(&st)]), &mut p).unwrap();
        assert_eq!((p.tasks_dir.clone(), p.central_tasks), (st.clone(), true));
        let stamp = central_task_stamp(&p, o.config.as_deref().unwrap()).unwrap();
        assert!(stamp.contains("export.xml=none") && stamp.contains("task-links.json=none"), "{stamp}");
        // 読めない設定は止める
        put_config(&st, "{");
        let mut p = paths();
        assert!(apply_settings(&opts(&["--settings", &s(&st)]), &mut p).unwrap_err().to_string().contains("読めません"));
    }
}
