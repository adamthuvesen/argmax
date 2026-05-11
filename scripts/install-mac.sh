#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

cd "$ROOT"

# Map uname arch to electron-builder arch and output dir
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  EB_FLAG="--arm64"
  APP_DIR="release/mac-arm64"
else
  EB_FLAG="--x64"
  APP_DIR="release/mac"
fi

echo "→ Building Argmax ($ARCH)..."
npm run build
npx electron-builder --mac "$EB_FLAG"

APP_SRC="$APP_DIR/Argmax.app"
if [ ! -d "$APP_SRC" ]; then
  echo "✗ Build output not found: $APP_SRC"
  exit 1
fi

echo "→ Installing to /Applications..."
rm -rf "/Applications/Argmax.app"
cp -R "$APP_SRC" "/Applications/Argmax.app"

echo "✓ Argmax installed. Open it from /Applications or Spotlight."
