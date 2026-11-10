@echo off
rem プロジェクトのセッションをまとめて送る: 集計し直してから、画面の「プロジェクト別」で「まとめて送る」に印を付けたプロジェクト
rem (印が無ければ番号で選んだプロジェクト。複数選べる)のセッションの生ログを
rem <送り先>\<プロジェクト名>\<セッション ID>\ に写します。送り先は一度選ぶと覚えます(atlas.config.json の uploadRoot。画面のアップロードと共通)
rem 送る前に毎回、送り先・セッション数・大きさ・秘密らしい文字列を見せて確かめます。送り先はエクスプローラーで選びます
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。Node.js 24 以上をインストールしてください。
  pause
  exit /b 1
)

node scripts\deps-fresh.mjs
if errorlevel 1 (
  echo 依存を入れます: npm install を実行します...
  call npm install
  if errorlevel 1 (
    echo npm install に失敗しました。
    pause
    exit /b 1
  )
)

rem 集計の経過(長いパスの行が続く)は窓に出さずにファイルに書く。失敗の理由はエラー出力なので、窓に残る
set "ATLAS_UPLOAD_LOG=%TEMP%\atlas-upload-project.log"
echo 最新のログを集計しています。少し待ってください...
node packages\cli\src\main.ts all > "%ATLAS_UPLOAD_LOG%"
rem 失敗したときの文は囲みの外に書く(囲みの中の echo に半角の括弧があると、cmd が囲みの終わりと読んで止まるため)
if errorlevel 1 goto all_failed

node packages\cli\src\upload-project.ts
echo.
pause
exit /b

:all_failed
echo.
echo 集計に失敗しました。上のメッセージを確認してください。
echo atlas.bat の画面で集計し直している最中なら、終わってからもう一度実行してください。
echo 集計の経過: %ATLAS_UPLOAD_LOG%
pause
exit /b 1
