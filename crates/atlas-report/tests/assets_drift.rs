// ページに埋め込む JS と CSS(assets/)が、TS の定数(page-nav.ts の NAV_JS など)と同じか。
// assets/ は scripts/gen-report-assets.ts が TS から書き出したもの。TS 側を変えたのに書き直していなければ失敗する。
// node が無い環境では ATLAS_SKIP_NODE_TESTS=1 で飛ばせる(黙っては飛ばさない)。

use std::path::Path;
use std::process::Command;

#[test]
fn assets_match_ts_constants() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    let script = root.join("scripts").join("gen-report-assets.ts");
    let out = Command::new("node").arg(&script).arg("--check").current_dir(&root).output();
    match out {
        Ok(o) => assert!(o.status.success(), "assets/ が TS の定数と違います(node scripts/gen-report-assets.ts で書き直してください)\n{}", String::from_utf8_lossy(&o.stderr)),
        Err(e) => {
            if std::env::var_os("ATLAS_SKIP_NODE_TESTS").is_some() {
                eprintln!("node を起動できないので assets/ と TS の突き合わせを飛ばしました(ATLAS_SKIP_NODE_TESTS): {e}");
            } else {
                panic!("node を起動できません({e})。node が無い環境では ATLAS_SKIP_NODE_TESTS=1 を付けてください");
            }
        }
    }
}
