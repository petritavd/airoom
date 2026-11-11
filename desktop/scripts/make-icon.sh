#!/bin/zsh
# Render desktop/build/icon.svg → icon.icns using only stock macOS tools.
# Re-run after changing icon.svg; the .icns is committed so normal builds
# don't need this step.
set -euo pipefail
cd "$(dirname "$0")/../build"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Quick Look can rasterize SVG (arrives as icon.svg.png)
qlmanage -t -s 1024 -o "$TMP" icon.svg >/dev/null
SRC="$TMP/icon.svg.png"
[[ -f "$SRC" ]] || { echo "qlmanage failed to rasterize icon.svg" >&2; exit 1; }

ICONSET="$TMP/icon.iconset"
mkdir "$ICONSET"
for size in 16 32 64 128 256 512; do
  sips -z $size $size "$SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o icon.icns
echo "wrote $(pwd)/icon.icns"
