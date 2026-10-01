#!/bin/bash
# ダブルクリックで起動(Mac)。ブラウザで http://127.0.0.1:5178/ を開きます。
cd "$(dirname "$0")"
for b in /opt/homebrew/bin /usr/local/bin; do [ -d "$b" ] && PATH="$b:$PATH"; done
export PATH
if [ ! -d node_modules ]; then
  bash ./setup.sh || { echo "セットアップに失敗しました。"; read -r -p "Enter で閉じます"; exit 1; }
elif [ ! -d node_modules/@anthropic-ai/sdk ]; then
  # 更新で追加されたライブラリを入れる
  npm install --no-fund --no-audit || { read -r -p "npm install に失敗しました。Enter で閉じます"; exit 1; }
fi
npm run build --silent || { read -r -p "ビルドに失敗しました。Enter で閉じます"; exit 1; }
PORT="${PORT:-5178}"
# すでに起動している(Mac アプリ版を含む)ならブラウザで開くだけ
if curl -fsS -m 2 "http://127.0.0.1:${PORT}/api/ping" >/dev/null 2>&1; then
  echo "すでに起動しています(アプリ版が動いている場合は、そちらを終了してから起動すると最新の版になります)。ブラウザで開きます。"
  open "http://127.0.0.1:${PORT}/"
  exit 0
fi
( sleep 1.5; open "http://127.0.0.1:${PORT}/" ) &
PORT="$PORT" node dist/server/main.js
