@echo off
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

if not "%~1"=="" goto given
node packages\cli\src\main.ts open --pick
set "code=%errorlevel%"
goto done

:given
node packages\cli\src\main.ts open %*
set "code=%errorlevel%"

:done
if not "%code%"=="0" (
  echo.
  echo フォルダを開けませんでした。上のメッセージを確認してください。
  pause
)
exit /b %code%

rem ここから下は説明で、実行しません。cmd は chcp 65001 の後、日本語の行を読んだ分だけ bat を読み直す位置がずれることがあり、続きを前の行の途中から実行してしまうため、説明は最後の exit /b の後に置きます
rem Copilot Session Atlas: この PC のセッションではなく、選んだフォルダ(アップロード先・人ごとのフォルダ・プロジェクトのフォルダ)を集計して開く
rem ダブルクリックすると、フォルダを選ぶ画面が出ます。フォルダをこの bat に重ねて離す(ドラッグ アンド ドロップ)と、そのフォルダを開きます
rem 中身は atlas open --pick(または atlas open <フォルダ>)です。出力は out-folders\<フォルダごとの名前>\out に書き、いつもの out\ には触れません
rem この窓はブラウザを閉じるまで残ります(閉じるとサーバも止まります)
