@echo off
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-atlas.ps1
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

bin\atlas.exe setup
if errorlevel 1 (
  echo.
  echo 初期設定に失敗しました。上のメッセージを確認してください。
  pause
  exit /b 1
)

echo. & pause & exit /b

rem ここから下は説明で、実行しません。cmd は chcp 65001 の後、日本語の行を読んだ分だけ bat を読み直す位置がずれることがあり、続きを前の行の途中から実行してしまうため、説明は最後の exit /b の後に置きます
rem agent-session-atlas の初期設定: atlas.exe を用意し、llm-wiki の vault・普段の工程名・アップロード先を尋ねて atlas.config.json を書きます
rem フォルダはエクスプローラーで選べます。黒い窓へのドラッグやパスの入力でも決められます
rem 集計はしません(終わったら atlas.bat をダブルクリックします)。もう一度実行すると、今の設定を見ながら直せます
