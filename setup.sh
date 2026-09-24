#!/bin/bash
# 初回セットアップ(Mac)。Homebrew で ffmpeg と whisper.cpp、Node.js を入れ、アプリをビルドします。
set -e
cd "$(dirname "$0")"
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$($b shellenv)"; done
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew が見つかりません。https://brew.sh の手順でインストールしてから、もう一度実行してください。"
  exit 1
fi
command -v node >/dev/null 2>&1 || brew install node
command -v ffmpeg >/dev/null 2>&1 || brew install ffmpeg
command -v whisper-cli >/dev/null 2>&1 || brew install whisper-cpp
node -e 'const [a]=process.versions.node.split(".").map(Number); if (a < 20) { console.error("Node.js 20 以上が必要です (brew upgrade node)"); process.exit(1) }'
npm ci
npm run build
echo ""
echo "セットアップが完了しました。start.command をダブルクリックすると起動します。"
