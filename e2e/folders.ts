// 「別のフォルダを開く」の置き場の場所(テストが出力を探すのに使う)。決め方は本体(packages/cli/src/folders.ts)のものをそのまま使う:
// <いつもの出力先>-folders/<フォルダ名(40 文字まで)>-<パスのハッシュの先頭 8 桁>/{out, folder.json, open.log, built.json}、
// メモは <メモの置き場>/folders/<同じキー>/
export { folderPaths, foldersRootOf, type FolderPaths } from '../packages/cli/src/folders.ts';
