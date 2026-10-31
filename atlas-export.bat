@echo off
rem Copilot Session Atlas: 集計(all)に加えて、各セッションの記録(Markdown)を out\sessions\<id>.md に書き、レポートを開く
rem 記録は共有や LLM での振り返りに使う。元データは書き換えません。LLM は呼びません
rem 追加の引数は export にそのまま渡します(例: atlas-export.bat --since 2026-10-01 --tool-output all)
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。Node.js 24 以上をインストールしてください。
  pause
  exit /b 1
)

if not exist node_modules (
  echo 初回セットアップ: npm install を実行します...
  call npm install
  if errorlevel 1 (
    echo npm install に失敗しました。
    pause
    exit /b 1
  )
)

node packages\cli\src\main.ts snapshot
if errorlevel 1 goto :fail
node packages\cli\src\main.ts extract
if errorlevel 1 goto :fail
node packages\cli\src\main.ts export %*
if errorlevel 1 goto :fail

start "" "%~dp0out\atlas.html"
exit /b 0

:fail
echo.
echo 失敗しました。上のメッセージを確認してください。
pause
exit /b 1
