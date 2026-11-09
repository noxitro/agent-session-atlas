@echo off
rem プロジェクトのセッションをまとめて送る: 集計し直してからプロジェクトの一覧を出し、番号で選んだプロジェクトのセッションの生ログを
rem <送り先>\<プロジェクト名>\<セッション ID>\ に写します。送り先は一度選ぶと覚えます(atlas.config.json の uploadRoot。画面のアップロードと共通)
rem 送る前に毎回、送り先・件数・大きさ・秘密らしい文字列を見せて確かめます。送り先はエクスプローラーで選びます
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

echo 最新のログを集計しています...
node packages\cli\src\main.ts all
if errorlevel 1 (
  echo.
  rem 囲みの中の echo と rem には半角の括弧を書かない。cmd が囲みの終わりと読み、集計が成功しても止まるため
  echo 集計に失敗しました。上のメッセージを確認してください。atlas.bat の画面で集計し直している最中なら、終わってからもう一度実行してください。
  pause
  exit /b 1
)

echo.
node packages\cli\src\upload-project.ts
echo.
pause
