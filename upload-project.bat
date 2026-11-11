@echo off
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

node packages\cli\src\upload-project.ts & echo. & pause & exit /b

rem ここから下は説明で、実行しません。cmd は chcp 65001 の後、日本語の行を読んだ分だけ bat を読み直す位置がずれることがあり、続きを前の行の途中から実行してしまうため、説明は最後の exit /b の後に置きます
rem プロジェクトのセッションをまとめて送る: 集計し直してから、画面の「プロジェクト別」で「まとめて送る」に印を付けたプロジェクト
rem (印が無ければ番号で選んだプロジェクト。複数選べる)のセッションの生ログを
rem <送り先>\<プロジェクト名>\<セッション ID>\ に写します。送り先は一度選ぶと覚えます(atlas.config.json の uploadRoot。画面のアップロードと共通)
rem 送る前に毎回、送り先・セッション数・大きさ・秘密らしい文字列を見せて確かめます。送り先はエクスプローラーで選びます
rem 集計と送る操作は upload-project.ts が続けて行う。集計の経過はファイルに書き、注意と失敗の理由だけを窓に出す
rem 集計を別のプログラムにすると、集計を待つ間に押した Enter が、送る操作の最初の答えになるため
