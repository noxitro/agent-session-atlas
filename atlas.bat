@echo off
rem Copilot Session Atlas: ~/.copilot を集計して out\atlas.html を作り、ブラウザで開く
rem 元データは書き換えません(out\snapshot に複製してから読みます)
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

node packages\cli\src\main.ts all %*
if errorlevel 1 (
  echo.
  echo 集計に失敗しました。上のメッセージを確認してください。
  pause
  exit /b 1
)

start "" "%~dp0out\atlas.html"
