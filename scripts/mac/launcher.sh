#!/bin/bash
# Mac アプリ版の起動処理。同梱の Node.js でサーバーを起動し、ブラウザで開く。
# すでに起動していれば(アプリ版・ターミナル版どちらでも)ブラウザで開くだけにする。
# 標準出力にはサーバーのプロセス番号(すでに起動していた場合は running)を出す。
set -u
RES="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-5178}"
URL="http://127.0.0.1:${PORT}/"
DATA="$HOME/TateDougaMaker"
mkdir -p "$DATA"
LOG="$DATA/app.log"

open_browser() { [ "${TDM_NO_OPEN:-}" = "1" ] || open "$URL"; }

if curl -fsS -m 2 "${URL}api/ping" >/dev/null 2>&1; then
  open_browser
  echo running
  exit 0
fi

# ダウンロードした印(quarantine)が同梱のツールに残っていると実行できないことがあるので外す
xattr -dr com.apple.quarantine "$RES/bin" >/dev/null 2>&1 || true

export FFMPEG_PATH="$RES/bin/ffmpeg"
export FFPROBE_PATH="$RES/bin/ffprobe"
export WHISPER_CLI="$RES/bin/whisper-cli"
export PORT

cd "$RES/app"
echo "---- $(date '+%Y-%m-%d %H:%M:%S') 起動 ----" >>"$LOG"
nohup "$RES/bin/node" dist/server/main.js >>"$LOG" 2>&1 </dev/null &
PID=$!

# 起動を待つ(最大20秒)
for _ in $(seq 1 80); do
  if curl -fsS -m 1 "${URL}api/ping" >/dev/null 2>&1; then
    open_browser
    echo "$PID"
    exit 0
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "サーバーが起動直後に終了しました。$(tail -n 5 "$LOG" | tr '\n' ' ')" >&2
    exit 1
  fi
  sleep 0.25
done
echo "サーバーの起動に時間がかかっています。$(tail -n 5 "$LOG" | tr '\n' ' ')" >&2
kill "$PID" >/dev/null 2>&1 || true
exit 1
