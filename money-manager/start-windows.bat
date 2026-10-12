@echo off
rem ダブルクリックで「お金の見える化」を起動する（Windows 用）。
rem 初回だけ必要な部品を自動でインストールする。止めるときはこのウィンドウを閉じる。
chcp 65001 >nul
cd /d "%~dp0"

set "PY="
where py >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  where python >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  echo Python が見つかりません。https://www.python.org/downloads/ からインストールしてください。
  echo インストール時に「Add Python to PATH」にチェックを入れてください。
  pause & exit /b 1
)
%PY% -c "import sys; sys.exit(sys.version_info < (3, 10))" || (
  echo Python 3.10 以上が必要です。新しい Python をインストールしてください。
  pause & exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo 初回の準備をしています（1〜2 分かかります）…
  %PY% -m venv .venv || (echo 準備に失敗しました。 & pause & exit /b 1)
)
if not exist ".venv\.installed" (
  ".venv\Scripts\python.exe" -m pip install -q --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt || (echo インストールに失敗しました。 & pause & exit /b 1)
  type nul > ".venv\.installed"
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo 設定ファイル .env を作りました。Gmail のアドレスとアプリ パスワードを書いて保存してください。
  echo （書かなくても起動できます。Gmail 自動取り込みが使えないだけです）
  start /wait notepad ".env"
)

echo 起動しました → http://localhost:8000 （止めるときはこのウィンドウを閉じてください）
start "" "http://localhost:8000"
".venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000
pause
