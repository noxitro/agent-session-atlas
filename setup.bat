@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not defined UV_THREADPOOL_SIZE set "UV_THREADPOOL_SIZE=16"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。Node.js 24 以上をインストールしてください。
  pause
  exit /b 1
)

if not "%ATLAS_NO_AUTO_UPDATE%"=="1" if not defined ATLAS_SELF_UPDATED node "%~dp0packages\cli\src\launcher-update.ts" & if errorlevel 10 if not errorlevel 11 set "ATLAS_SELF_UPDATED=1" & cmd /d /c call "%~f0" %* & call exit /b %%errorlevel%%

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

node "%~dp0packages\cli\src\setup.ts"
if errorlevel 1 (
  echo.
  echo 初期設定に失敗しました。上のメッセージを確認してください。
  pause
  exit /b 1
)

echo. & pause & exit /b

rem ここから下は説明で、実行しません。cmd は chcp 65001 の後、日本語の行を読んだ分だけ bat を読み直す位置がずれることがあり、続きを前の行の途中から実行してしまうため、説明は最後の exit /b の後に置きます
rem フォルダはエクスプローラーで選べます。黒い窓へのドラッグやパスの入力でも決められます
rem 集計はしません(終わったら atlas.bat をダブルクリックします)。もう一度実行すると、今の設定を見ながら直せます
