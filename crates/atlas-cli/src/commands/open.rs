//! atlas open <フォルダ>(packages/cli/src/commands.ts の runOpen の移植): いつもの集計とは別に、指定したフォルダ
//! (アップロード先・人ごとのフォルダ・プロジェクトのフォルダ)を集計して、別のサーバで開く。
//! 出力先とメモはフォルダごとに分ける(folders.rs)。そのフォルダのサーバが動いていれば、ブラウザで開くだけ。
//! 状態(集計中・表示中・失敗)は <置き場>/<キー>/folder.json に書き、画面の「別のフォルダを開く…」の一覧が読む。
//! 設定のフォルダ(settings_dir.rs。共有の AtlasSettings)を決め、あればその atlas.config.json で集計し、folder.json に覚える。

use super::all::run_all_or_reuse;
use super::serve::{run_serve, ServeCli};
use super::{Log, RunResult};
use crate::args::CliOptions;
use crate::folders::{check_folder, folder_paths, folders_root_of, list_folder_states, read_folder_state, write_folder_state, FolderRun, FolderState};
use crate::jobs::{acquire_out_lock, OutBusyError};
use crate::paths::{resolve_paths, PathInputs};
use crate::serve::{find_running_server, ReportsOptions};
use anyhow::Result;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// フォルダを選ぶ画面(題名と最初に開く場所。取り消したら None)。テストで差し替える
pub type PickDep<'a> = &'a dyn Fn(&str, Option<&str>) -> Result<Option<String>>;

pub fn run_open(o: &CliOptions, log: Log<'_>, pick: Option<PickDep<'_>>) -> Result<RunResult> {
    let local = resolve_paths(PathInputs { home: None, out: o.out.as_deref(), judgments: None, bundle: None, notes_dir: o.notes_dir.as_deref() });
    let local_out = local.out.to_string_lossy().into_owned();
    let local_notes = local.notes.to_string_lossy().into_owned();
    let root = folders_root_of(&local_out);
    let mut target = o.target.clone();
    if o.pick {
        // --pick(open-folder.bat): 選ぶ画面を、前に開いたフォルダの場所で出す。取り消したら何も書かずに終わる
        let initial = list_folder_states(&root).first().map(|(_, s)| s.path.clone());
        log("open: フォルダを選ぶ画面を出します(タスクバーに隠れていたら、そこから開いてください)");
        let title = "集計して開くフォルダを選んでください(アップロード先・人ごとのフォルダ・プロジェクトのフォルダ)";
        target = match pick {
            Some(f) => f(title, initial.as_deref())?,
            None => crate::folder_picker::pick_folder(title, initial.as_deref())?,
        };
        if target.is_none() {
            log("open: フォルダを選ばなかったので、何もしません");
            return Ok(RunResult::default());
        }
    }
    let info = check_folder(&target.map_or(Value::Null, Value::String))?;
    let fp = folder_paths(&root, &local_notes, &info.path);
    let mut p = resolve_paths(PathInputs { home: Some(&info.path), out: Some(&fp.out), judgments: None, bundle: None, notes_dir: Some(&fp.notes) });
    let prev = read_folder_state(&fp.state);
    // 設定のフォルダ: --settings → 前に開いたときのもの → 上へ探す。見つかれば --config より先に使う
    let found = crate::settings_dir::settings_for_open(o.settings.as_deref(), prev.as_ref().and_then(|s| s.settings.as_deref()), Path::new(&info.path))?;
    for n in &found.notes {
        log(&format!("open: 注意 {n}"));
    }
    if let (Some(c), Some((d, _))) = (&o.config, &found.dir) {
        log(&format!("open: 注意 --config の {c} は読みません(設定のフォルダ {} の {} を読みます)", d.display(), crate::config::CONFIG_FILE));
    }
    let settings = found.dir.as_ref().map(|(d, _)| d.to_string_lossy().into_owned());
    // 集計(と、この後の画面のジョブ)が読む設定。タスクの置き場もここで決まる
    let all_base = CliOptions { settings: settings.clone(), config: if settings.is_some() { None } else { o.config.clone() }, ..o.clone() };
    // (使わないと決めたときは当てない。folder.json に残る前の記録は、このあと書き直す)
    let all_base = if settings.is_some() { crate::settings_dir::apply_settings(&all_base, &mut p, log)? } else { all_base };
    let p = p;
    let now = atlas_core::jsdate::now_iso;
    let base = FolderState {
        version: 1,
        path: info.path.clone(),
        name: info.name.clone(),
        added_at: prev.as_ref().map(|s| s.added_at.clone()).filter(|a| !a.is_empty()).unwrap_or_else(now),
        opened_at: now(),
        listed: true,
        run: None,
        settings: settings.clone(),
    };
    // 一覧から外す操作(画面)が途中で入っていたら、それを残す
    let save = |run: Option<FolderRun>, relist: bool| -> Result<()> {
        let listed = relist || read_folder_state(&fp.state).map_or(true, |s| s.listed);
        Ok(write_folder_state(&fp.state, &FolderState { listed, run, ..base.clone() })?)
    };
    let run_of = |state: &str| FolderRun { state: state.into(), pid: std::process::id(), at: now(), error: None };
    let serve = || ServeCli {
        port: o.port,
        open: o.open,
        config: all_base.config.clone(),
        settings: p.settings.clone(),
        home: Some(info.path.clone()),
        reports: Some(ReportsOptions { root: Some(PathBuf::from(&root)), notes_base: Some(local.notes.clone()), local_out: Some(local.out.clone()), current: Some(info.path.clone()), launch: None }),
    };
    log(&format!("open: {}({})", info.path, info.summary));
    if let Some((d, from)) = &found.dir {
        log(&format!(
            "open: 設定のフォルダ {}({})の {} を読みます。{}",
            d.display(),
            from.label(),
            crate::config::CONFIG_FILE,
            if p.central_tasks { "タスクの紐づけは、ここで集計する人が行い、設定のフォルダに書きます(送った人が添えたタスクの記録は使いません)" } else { "設定に tasks が無いので、タスクは送った人が添えた記録から出します" }
        ));
        log(&format!(
            "open: 工数と依頼ごとの判定は、設定のフォルダの {} と {} を使います(集計する人のあいだで共有します。判定には依頼の要約と理由が入ります)",
            p.judgments.display(),
            p.turn_judgments.display()
        ));
    }
    log(&format!(
        "open: 出力先 {}(読むだけの画面です。メモは送った人が付けたものを出し、この画面では書き換えません{})",
        fp.out,
        if p.central_tasks { "。タスクの紐づけは、この画面と CLI(--out にこの出力先)で変えられます" } else { "" }
    ));
    let all_opts = CliOptions { command: "all".into(), home: Some(info.path.clone()), out: Some(fp.out.clone()), notes_dir: Some(fp.notes.clone()), ..all_base.clone() };
    let built = PathBuf::from(&fp.built);
    let aggregate = || -> Result<Option<super::BuildResult>> {
        let lock = acquire_out_lock(&p.out, "all", "cli")?;
        let r = run_all_or_reuse(&all_opts, &p, Path::new(&built), log);
        lock.release();
        r
    };
    if find_running_server(&p.out).is_some() {
        // 前に開いたサーバがまだ動いている(タブを開いたままなど)。送り先を読み直してから(何も変わっていなければ前のレポートを使う)、
        // 動いているサーバの画面を開く。サーバは出力先のファイルを開くたびに読むので、新しく開いたタブには新しい集計が出る(画面の「集計し直す」と同じ)。
        // 前から開いていたタブは再読み込みが要る
        let build = match aggregate() {
            Ok(b) => {
                log("open: 前から開いていたタブは、再読み込みすると新しい集計が出ます");
                b
            }
            Err(e) => {
                // 画面で集計し直している最中(出力先の印がある)なら、それに任せる。読み直せなかったときも、動いているサーバの画面は開く
                // (状態は動いているサーバのものなので書き換えない)
                log(&match e.downcast_ref::<OutBusyError>() {
                    Some(b) => format!("open: 画面で集計し直している最中なので、読み直さずに開きます。終わると画面に「新しい集計ができました」と出ます({b})"),
                    None => format!("open: 注意 送り先を読み直せなかったので、前の集計のまま開きます({e:#})"),
                });
                None
            }
        };
        save(prev.and_then(|s| s.run), true)?;
        run_serve(&p, serve(), log)?;
        return Ok(RunResult { build });
    }
    let r = (|| -> Result<Option<super::BuildResult>> {
        // 同じフォルダを別のプロセスが集計していれば、ここで止まる(その状態は書き換えない)
        let lock = acquire_out_lock(&p.out, "all", "cli")?;
        let b = save(Some(run_of("aggregating")), true).and_then(|()| run_all_or_reuse(&all_opts, &p, Path::new(&built), log));
        lock.release();
        let build = b?;
        save(Some(run_of("serving")), false)?;
        run_serve(&p, serve(), log)?;
        save(None, false)?;
        Ok(build)
    })();
    match r {
        Ok(build) => Ok(RunResult { build }),
        Err(e) => {
            if e.downcast_ref::<OutBusyError>().is_none() {
                let m = format!("{e:#}");
                let _ = save(Some(FolderRun { error: Some(atlas_core::js::utf16_slice(&m, 0, 600).into_owned()), ..run_of("failed") }), false);
            }
            Err(e)
        }
    }
}
