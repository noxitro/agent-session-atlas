@echo off
rem agent-session-atlas の初期設定: 依存を入れ、llm-wiki の vault・普段の工程名・グループのアップロード先を尋ねて atlas.config.json を書きます
rem 集計はしません(終わったら atlas.bat をダブルクリックします)。もう一度実行すると、今の設定を見ながら直せます
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

node packages\cli\src\setup.ts
if errorlevel 1 (
  echo.
  echo 初期設定に失敗しました。上のメッセージを確認してください。
  pause
  exit /b 1
)

echo.
pause
