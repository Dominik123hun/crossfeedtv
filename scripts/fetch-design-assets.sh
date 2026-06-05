#!/usr/bin/env bash
# Download the generated Higgsfield brand assets and optimize them into
# public/assets/ as web-sized WebP (+ a PNG favicon). Run on a machine that can
# reach the CDN (the build sandbox cannot). See DESIGN_ASSETS.md.
#
# Requires: curl + ImageMagick (`brew install imagemagick` / `apt-get install imagemagick`).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="public/assets"
mkdir -p "$OUT"

# ImageMagick v7 uses `magick`; v6 uses `convert`.
if command -v magick >/dev/null 2>&1; then IM="magick"; elif command -v convert >/dev/null 2>&1; then IM="convert"; else
  echo "ERROR: ImageMagick not found. Install it (brew install imagemagick / apt-get install imagemagick)." >&2
  exit 1
fi

CDN="https://d8j0ntlcm91z4.cloudfront.net/user_3D0Il7JgYWTFGs1800Z26K2HBcy"
HERO="$CDN/hf_20260605_151045_d288c14c-c260-424b-8aa4-d4e47ae85810.png"
HERO_M="$CDN/hf_20260605_152552_a7c63cf3-1b76-47f5-85c7-66e6ee067414.png"
SCENE="$CDN/hf_20260605_152545_63a268f1-0036-4eb2-8a4a-0f7857339f1c.png"
GLYPH="$CDN/hf_20260605_152536_8a03fdf0-79a0-432d-b347-52f0ed0d9035.jpeg"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
dl() { echo "↓ $1"; curl -fsSL "$1" -o "$2" || { echo "FAILED to download $1 (URL may have expired — regenerate via Higgsfield, see DESIGN_ASSETS.md)"; exit 1; }; }

dl "$HERO"   "$tmp/hero.png"
dl "$HERO_M" "$tmp/hero-m.png"
dl "$SCENE"  "$tmp/scene.png"
dl "$GLYPH"  "$tmp/glyph.png"

echo "→ optimizing into $OUT"
$IM "$tmp/hero.png"   -resize 1600x   -quality 80 "$OUT/hero.webp"
$IM "$tmp/hero-m.png" -resize 900x    -quality 80 "$OUT/hero-mobile.webp"
$IM "$tmp/scene.png"  -resize 1600x   -quality 78 "$OUT/stream-scene.webp"
$IM "$tmp/glyph.png"  -resize 512x512 -quality 90 "$OUT/glyph.webp"
$IM "$tmp/glyph.png"  -resize 256x256 "$OUT/icon.png"
# OG / social card derived from the hero (1200x630 center crop)
$IM "$tmp/hero.png"   -resize 1200x630^ -gravity center -extent 1200x630 -quality 82 "$OUT/og.webp"

echo "✓ Done. Bundled:"; ls -la "$OUT"
echo "Next: git add public/assets && git commit -m 'assets: bundle generated brand imagery'"
