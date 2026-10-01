#!/bin/bash
# Mac アプリ(.app)と .dmg を作る(macOS 上で実行。GitHub Actions から呼ぶ)。
#   使い方: scripts/mac/build-app.sh <arm64|x64> <whisper-cli のパス>
# 事前に: npm ci && npm run build && npm prune --omit=dev(node_modules は実行に必要なものだけにしておく)
set -euo pipefail
ARCH="$1"
WHISPER_BIN="$2"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUT="$ROOT/out/$ARCH"
WORK="$OUT/work"
rm -rf "$OUT"
mkdir -p "$WORK"

case "$ARCH" in
  arm64) FF_ARCH=arm64; LIPO_ARCH=arm64 ;;
  x64) FF_ARCH=amd64; LIPO_ARCH=x86_64 ;;
  *) echo "ARCH は arm64 か x64"; exit 1 ;;
esac

NODE_VER="${NODE_VER:-$(node -v)}"
APP_NAME="TateDougaMaker"
DISPLAY_NAME="縦型動画メーカー"
APP="$OUT/$APP_NAME.app"

echo "== アプリの殻(AppleScript)"
osacompile -s -o "$APP" scripts/mac/applet.applescript
RES="$APP/Contents/Resources"
mkdir -p "$RES/bin" "$RES/app/src/web"

echo "== Node.js $NODE_VER ($ARCH)"
curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-$ARCH.tar.gz" | tar xz -C "$WORK"
cp "$WORK/node-$NODE_VER-darwin-$ARCH/bin/node" "$RES/bin/node"

echo "== ffmpeg / ffprobe ($FF_ARCH)"
for t in ffmpeg ffprobe; do
  curl -fsSL -o "$WORK/$t.zip" "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$FF_ARCH/release/$t.zip"
  mkdir -p "$WORK/$t"
  unzip -o -q "$WORK/$t.zip" -d "$WORK/$t"
  cp "$(find "$WORK/$t" -type f -name "$t" | head -1)" "$RES/bin/$t"
done

echo "== whisper-cli"
cp "$WHISPER_BIN" "$RES/bin/whisper-cli"
chmod +x "$RES/bin/"*

echo "== アプリ本体"
cp -R dist assets package.json "$RES/app/"
cp -R src/web/static "$RES/app/src/web/static"
cp -R node_modules "$RES/app/node_modules"
cp scripts/mac/launcher.sh "$RES/launcher.sh"
chmod +x "$RES/launcher.sh"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
DATE="$(date -u +%Y-%m-%d)"
printf '{"commit":"%s","date":"%s","arch":"%s"}\n' "$COMMIT" "$DATE" "$ARCH" > "$RES/app/build-info.json"

echo "== 名前・情報"
PL="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $DISPLAY_NAME" "$PL" || /usr/libexec/PlistBuddy -c "Add :CFBundleName string $DISPLAY_NAME" "$PL"
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $DISPLAY_NAME" "$PL" || true
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.tatedougamaker.app" "$PL" || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.tatedougamaker.app" "$PL"
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $(node -p 'require("./package.json").version')" "$PL" || true
/usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $DATE-$COMMIT" "$PL" || true
/usr/libexec/PlistBuddy -c "Add :LSMinimumSystemVersion string 12.0" "$PL" || true

echo "== 中身の確認(アーキテクチャ)"
for b in node ffmpeg ffprobe whisper-cli; do
  archs="$(lipo -archs "$RES/bin/$b")"
  echo "$b: $archs"
  case " $archs " in *" $LIPO_ARCH "*) ;; *) echo "$b が $LIPO_ARCH 用ではありません"; exit 1 ;; esac
done

echo "== 中身の確認(macOS 標準以外のライブラリに頼っていないか)"
for b in node ffmpeg ffprobe whisper-cli; do
  bad="$(otool -L "$RES/bin/$b" | tail -n +2 | awk '{print $1}' | grep -vE '^(/System/|/usr/lib/)' || true)"
  if [ -n "$bad" ]; then echo "$b が同梱していないライブラリを使っています:"; echo "$bad"; exit 1; fi
done

echo "== 署名(アドホック。Apple Silicon は署名のない実行ファイルを動かせないため)"
for b in "$RES/bin/"*; do codesign --force --sign - "$b"; done
find "$RES/app/node_modules" -name "*.node" -exec codesign --force --sign - {} \; || true
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

echo "== .dmg"
STAGE="$OUT/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/はじめにお読みください.txt" <<TXT
縦型動画メーカー(Mac アプリ版 $DATE $COMMIT / $ARCH)

1. 「${APP_NAME}」を「Applications」フォルダへドラッグしてください。
2. 初回は「開発元を確認できない」と表示されます。
   システム設定 → プライバシーとセキュリティ → 下の方の「このまま開く」を押してください
   (または Finder でアプリを右クリック →「開く」)。1回許可すれば次からは出ません。
3. 起動するといつものブラウザで画面が開きます。Dock のアイコンをクリックすると開き直せます。
   終了は Dock のアイコンを右クリック →「終了」。

データ(プロジェクト・設定・APIキー)は ~/TateDougaMaker に保存され、ターミナルから起動する版と共通です。
動作の記録は ~/TateDougaMaker/app.log にあります。

同梱: Node.js, FFmpeg(https://ffmpeg.org / ビルド: https://ffmpeg.martin-riedl.de・GPL), whisper.cpp(MIT)
TXT
DMG="$ROOT/out/TateDougaMaker-$ARCH.dmg"
rm -f "$DMG"
hdiutil create -volname "$DISPLAY_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
ls -la "$DMG"
