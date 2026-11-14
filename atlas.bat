@echo off
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-atlas.ps1
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

bin\atlas.exe all %*
if errorlevel 1 (
  echo.
  echo 集計に失敗しました。上のメッセージを確認してください。
  pause
  exit /b 1
)

bin\atlas.exe serve
exit /b %errorlevel%

rem ここから下は説明で、実行しません。cmd は chcp 65001 の後、日本語の行を読んだ分だけ bat を読み直す位置がずれることがあり、続きを前の行の途中から実行してしまうため、説明は最後の exit /b の後に置きます
rem Copilot Session Atlas: ~/.copilot を集計して out\atlas.html と各セッションの記録(out\sessions\<id>.md)を作り、ローカルサーバ(127.0.0.1)で開く
rem この窓はブラウザを閉じるまで残ります(閉じるとサーバも止まります)。共有するときは atlas.bat --anonymize で作った伏せ字版を渡します
rem 動かすのは bin\atlas.exe です。無いか版が違えば、最初に scripts\ensure-atlas.ps1 がリリースから取ってくるか、Node.js と Rust があればこの PC でビルドします
rem 元データは書き換えません(out\snapshot に複製してから読みます)
rem 起動後の操作(集計し直す・工数の判定・記録と全文記録の表示)は画面から行います。起動用の bat はこれと、選んだフォルダを集計して開く open-folder.bat です(wiki などの初期設定は setup.bat)
