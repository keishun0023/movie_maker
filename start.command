#!/bin/bash
# ダブルクリックで起動(Mac)。ブラウザで http://127.0.0.1:5178/ を開きます。
cd "$(dirname "$0")"
for b in /opt/homebrew/bin /usr/local/bin; do [ -d "$b" ] && PATH="$b:$PATH"; done
export PATH
if [ ! -d node_modules ]; then
  ./setup.sh || { echo "セットアップに失敗しました。"; read -r -p "Enter で閉じます"; exit 1; }
fi
npm run build --silent || { read -r -p "ビルドに失敗しました。Enter で閉じます"; exit 1; }
PORT="${PORT:-5178}"
( sleep 1.5; open "http://127.0.0.1:${PORT}/" ) &
PORT="$PORT" node dist/server/main.js
