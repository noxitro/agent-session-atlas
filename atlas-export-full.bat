@echo off
rem Copilot Session Atlas: 解析用の完全出力。snapshot → extract → export --full で、集計・詳細ページ・セッション記録に加えて
rem 全文記録(out\full\<id>.md、上限なし)と網羅の検査(out\coverage.json)、指示文と skill の閲覧ページ(out\instructions.html)を書く。
rem out\ には原本の文字列と秘密情報が含まれうるので共有しないこと(共有には atlas-export.bat --anonymize の伏せ字版を使う)。
rem 追加の引数は export にそのまま渡します(例: atlas-export-full.bat --since 2026-10-01 --snapshot-all)
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

node packages\cli\src\main.ts snapshot %*
if errorlevel 1 goto :fail
node packages\cli\src\main.ts extract
if errorlevel 1 goto :fail
node packages\cli\src\main.ts export --full %*
if errorlevel 1 goto :fail

node packages\cli\src\main.ts serve
exit /b 0

:fail
echo.
echo 失敗しました。上のメッセージを確認してください。
pause
exit /b 1
