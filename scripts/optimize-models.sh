#!/usr/bin/env bash
# Optimize the raw AI-generated GLBs (assets/models/) into lightweight runtime
# models (public/models/).
#
# IMPORTANT — learned the hard way: gltf-transform's `optimize` with webp
# texture compression (and the `palette` step) CORRUPTS character face textures
# — the face renders as a black box at distance. So we deliberately use only
# `resize` (downscale textures, keep original format) + `meshopt` (geometry
# compression). Bigger than webp but visually correct.
#
# Usage: scripts/optimize-models.sh [texture_size]   (default 1024)
set -euo pipefail

SRC=assets/models
OUT=public/models
SIZE="${1:-1024}"
GT="npx --yes @gltf-transform/cli@latest"

mkdir -p "$OUT"
total_before=0
for f in "$SRC"/*.glb; do
  name=$(basename "$f")
  tmp="$(mktemp --suffix=.glb)"
  $GT resize "$f" "$tmp" --width "$SIZE" --height "$SIZE" >/dev/null 2>&1
  $GT meshopt "$tmp" "$OUT/$name" >/dev/null 2>&1
  rm -f "$tmp"
  printf "  %-26s -> %7s\n" "$name" "$(du -h "$OUT/$name" | cut -f1)"
done
echo "total: $(du -sh "$OUT" | cut -f1)"
