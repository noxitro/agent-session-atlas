@echo off
rem Copilot Session Atlas: atlas.bat と同じく集計と各セッションの記録(out\sessions\<id>.md)を作り、レポートを開く。
rem 違いは、追加の引数を export に渡せること(記録の中身の調整や、伏せ字版の記録 --anonymize)
rem 記録は LLM での振り返り用(依頼や応答がそのまま入る。共有するなら --anonymize)。元データは書き換えません。LLM は呼びません
rem 追加の引数は export にそのまま渡します(例: atlas-export.bat --since 2026-10-01 --tool-output all)
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

node packages\cli\src\main.ts snapshot
if errorlevel 1 goto :fail
node packages\cli\src\main.ts extract
if errorlevel 1 goto :fail
node packages\cli\src\main.ts export %*
if errorlevel 1 goto :fail

node packages\cli\src\main.ts serve
exit /b 0

:fail
echo.
echo 失敗しました。上のメッセージを確認してください。
pause
exit /b 1
