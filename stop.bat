@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-atlas.ps1 %*
set "code=%errorlevel%"
echo.
pause
exit /b %code%

rem ここから下は説明で、実行しません。説明を最後の exit /b の後に置く理由は atlas.bat と同じです
rem このフォルダの atlas をすべて止める: 画面のサーバ(どこかのブラウザのタブが開いたままのもの、別のフォルダを開いた窓の無いもの)と、集計・判定・送る操作
rem 止めるのは、このフォルダの bin\atlas.exe のプロセスとその子孫だけです。集計などが動いていれば、止める前に尋ねます。stop.bat -Yes で尋ねずに止めます
rem atlas.bat が更新されない・前の版の画面が開くときに使います。止めた後に atlas.bat を開くと、新しい版にしてから開き直します
rem 実行ファイルの用意と更新はしません(実行ファイルが壊れていても止められるように、PowerShell だけで動きます。scripts\stop-atlas.ps1)
