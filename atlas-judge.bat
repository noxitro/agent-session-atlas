@echo off
rem Copilot Session Atlas: LLM による工数判定(推定人手工数)を回してレポートを作り直す
rem 集計(all)→ 評価バンドル(bundle)→ 判定(judge run、既定は copilot -p)→ レポート(build)
rem 判定は GitHub Copilot の AI クレジットを消費します。元データは書き換えません
rem 追加の引数は judge run にそのまま渡します(例: atlas-judge.bat --limit 5)
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

echo 未判定のセッションを LLM で判定します。GitHub Copilot の AI クレジットを消費します(1 セッション 1 回以上)。
choice /c YN /m "続けますか"
if errorlevel 2 exit /b 0

node packages\cli\src\main.ts all
if errorlevel 1 (
  echo.
  echo 集計に失敗しました。上のメッセージを確認してください。
  pause
  exit /b 1
)

node packages\cli\src\judge-flow.ts %*
if errorlevel 1 (
  echo.
  echo 判定に失敗したセッションがあるか、判定を実行できませんでした。上のメッセージを確認してください。
  echo 判定済みの分はレポートに反映しています。もう一度実行すると失敗した分を再試行します。
  pause
)

if exist "%~dp0out\atlas.html" start "" "%~dp0out\atlas.html"
