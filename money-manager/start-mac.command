#!/bin/bash
# ダブルクリックで「お金の見える化」を起動する（Mac 用）。
# 初回だけ必要な部品を自動でインストールする。止めるときはこのウィンドウを閉じる。
cd "$(dirname "$0")" || exit 1

PY=python3
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "Python が見つかりません。https://www.python.org/downloads/ からインストールしてください。"
  read -r -p "Enter キーで閉じます"; exit 1
fi
if ! "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
  echo "Python 3.10 以上が必要です（今は $("$PY" --version)）。"
  read -r -p "Enter キーで閉じます"; exit 1
fi

# 部品はこのフォルダの .venv に入れる（PC 全体の Python は汚さない）
if [ ! -x .venv/bin/python ]; then
  echo "初回の準備をしています（1〜2 分かかります）…"
  "$PY" -m venv .venv || { read -r -p "準備に失敗しました。Enter キーで閉じます"; exit 1; }
fi
if [ ! -f .venv/.installed ] || [ requirements.txt -nt .venv/.installed ]; then
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q -r requirements.txt || { read -r -p "インストールに失敗しました。Enter キーで閉じます"; exit 1; }
  touch .venv/.installed
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "設定ファイル .env を作りました。Gmail のアドレスとアプリ パスワードを書いて保存してください。"
  echo "（書かなくても起動できます。Gmail 自動取り込みが使えないだけです）"
  open -e .env 2>/dev/null
  read -r -p "書き終わったら Enter キーを押してください"
fi

PORT=8000
( sleep 2; open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null ) &
echo "起動しました → http://localhost:$PORT （止めるときはこのウィンドウを閉じてください）"
exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT"
