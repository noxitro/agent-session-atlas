@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not "%ATLAS_NO_AUTO_UPDATE%"=="1" if not defined ATLAS_SELF_UPDATED powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-atlas.ps1 -ViewersOnly
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-atlas.ps1 -KeepOlder
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

if not "%ATLAS_NO_AUTO_UPDATE%"=="1" if not defined ATLAS_SELF_UPDATED bin\atlas.exe self-update 2>nul & if errorlevel 10 if not errorlevel 11 set "ATLAS_SELF_UPDATED=1" & cmd /d /c call "%~f0" %* & call exit /b %%errorlevel%%

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
rem この窓はブラウザを閉じるまで残ります(閉じるとサーバも止まります)。out\ の中身には名前やパスがそのまま入るので、渡すときは中身を確かめます
rem 開くと最初に、前に開いた画面のサーバ(黒い窓やタブが残っているもの)を止めてから、新しい版を取り込み、集計して開き直します(scripts\stop-atlas.ps1 -ViewersOnly)
rem 集計・判定・送る操作などが動いていれば、何も止めずに続けます(そのときは新しい版になりません)。ATLAS_NO_AUTO_UPDATE=1 なら止めず、更新もしません
rem 動かすのは bin\atlas.exe です。無いか今のソースから作ったものでなければ、最初に scripts\ensure-atlas.ps1 がこの PC でビルドします(atlas.exe は配っていません)
rem ビルドには Node.js と Rust と、Windows では Visual Studio の C++ のビルドツールが要ります。初めてのときは数分から十数分かかります
rem 元データは書き換えません(out\snapshot に複製してから読みます)
rem 起動後の操作(集計し直す・工数の判定・記録と全文記録の表示)は画面から行います。起動用の bat はこれと、選んだフォルダを集計して開く open-folder.bat です(wiki などの初期設定は setup.bat)
