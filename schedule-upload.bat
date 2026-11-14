@echo off
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-atlas.ps1
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

bin\atlas.exe upload-schedule
set "code=%errorlevel%"
echo. & pause & exit /b %code%

rem ここから下は説明で、実行しません。cmd は chcp 65001 の後、日本語の行を読んだ分だけ bat を読み直す位置がずれることがあり、続きを前の行の途中から実行してしまうため、説明は最後の exit /b の後に置きます
rem 毎日決まった時刻に、プロジェクトのセッションを自動で送る登録をする: Windows のタスク スケジューラに、自分のユーザーで動くタスクを 1 つ登録します
rem タスクは窓を出さずに集計し直してから、画面の「プロジェクト別」で「まとめて送る」に印を付けたプロジェクトを、覚えた送り先 uploadRoot へ送ります
rem 登録してあれば、次に送る時刻と前回の結果を見せ、時刻を変える・今すぐ 1 回送る・やめる を選べます。結果は out\auto-upload.json、経過は out\auto-upload.log
