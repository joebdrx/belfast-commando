#!/usr/bin/env bash
# Optimize raw reference building GLBs into web-shippable templates
# (public/models/bldg_*.glb), mirroring scripts/optimize-map.sh's proven recipe:
# specGloss->metalRough, webp textures, meshopt, geometry simplify. NO --palette
# (palette corrupts textures — recorded lesson).
#
# Usage: scripts/optimize-buildings.sh [texture_size]   (default 512)
set -euo pipefail
SIZE="${1:-512}"
GT="npx --yes @gltf-transform/cli@latest"
REF="../asset-reference"          # raw sources live alongside the repo
OUT="public/models"
mkdir -p "$OUT"

# slug -> source filename. Edit this list as the audit selects/drops candidates.
# bldg_pub (betsey_trotwood) removed per request; bldg_street replaces it.
# bldg_skyline is the city backdrop ringed around the map edges (not a block).
declare -A SRC=(
  [bldg_terrace]="old_building.glb"
  [bldg_collapsed]="collapsed_uk_terraced_house.glb"
  [bldg_shop]="angers_shop_2_france.glb"
  [bldg_street]="street_exterior_dead_end.glb"
  [bldg_skyline]="belfast_city.glb"
)

for slug in "${!SRC[@]}"; do
  src="$REF/${SRC[$slug]}"
  if [ ! -f "$src" ]; then echo "SKIP $slug (missing $src)"; continue; fi
  t="$(mktemp --suffix=.glb)"
  echo "[$slug] specGloss -> metalRough…"
  $GT metalrough "$src" "$t" 2>/dev/null || cp "$src" "$t"
  echo "[$slug] optimize webp@${SIZE} + meshopt + simplify…"
  $GT optimize "$t" "$OUT/$slug.glb" \
    --texture-compress webp --texture-size "$SIZE" \
    --compress meshopt --palette false --simplify true \
    --simplify-ratio 0.6 --simplify-error 0.01
  rm -f "$t"
  echo "  -> $(du -h "$OUT/$slug.glb" | cut -f1)"
done
echo "done."
