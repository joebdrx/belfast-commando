#!/usr/bin/env bash
# Optimize the large Sketchfab city GLB (assets/models/british-city-map.glb,
# ~206MB) into a web-shippable map (public/models/city_map.glb).
#
# This model is TEXTURE-heavy (172 textures), so a plain resize+meshopt only
# reaches ~140MB. We compress textures to WebP (native browser/webview decode,
# no extra loader) and simplify geometry with meshoptimizer.
#
# NOTE on the past "webp corrupts faces" lesson: that was the PALETTE step on
# small character FACE textures. We DISABLE --palette and only apply webp to
# this environment model, then verify visually. Faces (characters) still use
# the conservative resize+meshopt recipe in optimize-models.sh.
#
# Usage: scripts/optimize-map.sh [texture_size]   (default 512)
set -euo pipefail

SRC=assets/models/british-city-map.glb
OUT=public/models/city_map.glb
SIZE="${1:-512}"
GT="npx --yes @gltf-transform/cli@latest"

mkdir -p "$(dirname "$OUT")"

# Sketchfab exports this model with KHR_materials_pbrSpecularGlossiness, which
# three.js no longer supports (textures would render as plain white). Convert it
# to standard metallic-roughness FIRST so the diffuse maps land in baseColor.
t1="$(mktemp --suffix=.glb)"
trap 'rm -f "$t1"' EXIT
echo "[1/2] specGloss -> metalRough…"
$GT metalrough "$SRC" "$t1"

echo "[2/2] optimize: webp@${SIZE}px + meshopt + simplify…"
$GT optimize "$t1" "$OUT" \
  --texture-compress webp \
  --texture-size "$SIZE" \
  --compress meshopt \
  --palette false \
  --simplify true \
  --simplify-ratio 0.6 \
  --simplify-error 0.01

echo "done: $OUT -> $(du -h "$OUT" | cut -f1)"
