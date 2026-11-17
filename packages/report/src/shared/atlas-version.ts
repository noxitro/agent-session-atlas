// atlas 自身の版の形。アップロードしたフォルダに添える(atlas-index.json・atlas-session.json の atlas)。
// 版の新旧は git のコミットの日時で決める(package.json の version は上げていないので使えない)。
// git で取得していないフォルダでも、コードの目印(実行ファイルを作ったときに決まる。crates/atlas-cli/build.rs)で「同じコードか」は分かる。
// ここにあるのは、画面とテストが読む型だけ。送り先から集計したときに、送った人ごとに数えて言葉にするのは
// crates/atlas-core/src/atlas_version.rs(結果は、ページのデータの atlasBuilds に入る)。git から読むのは crates/atlas-core/src/atlas_build.rs
export interface AtlasBuild {
  /** git のコミット(全桁)。git で取得したフォルダでない・git を使えないときは null */
  commit: string | null;
  /** そのコミットの日時(ISO、UTC)。版の新旧はこれで決める。commit が null なら null */
  committedAt: string | null;
  /** git が管理しているファイルを手で変えていた(package-lock.json だけの変更は数えない。npm が書き換えるため)。分からなければ null */
  dirty: boolean | null;
  /** コードの目印(同じなら同じ実行ファイルのコード) */
  code: string;
}

/** フォルダごとの、最後に送ったときの記録(送り先の atlas-index.json の uploadedAt と atlas。snapshot が manifest の uploads に入れる) */
export interface FolderUpload {
  uploadedAt: string | null;
  /** 版の記録が無い(この記録を書く前の版で送った)なら null */
  atlas: AtlasBuild | null;
  /**
   * 索引はあるが読めなかった(書きかけ・壊れている・形が違う)。送っている最中に集計すると、書きかけを読むことがある。
   * 読めなかったフォルダは黙って外さず、知らせる(外すと、ほかが最新なら「すべて最新」と出てしまう)
   */
  unreadable?: boolean;
}
