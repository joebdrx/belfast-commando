#!/usr/bin/env bash
# Convert the mobili/ apartment furniture (2006-era Blender .blend files) into
# optimized runtime GLBs for the game's interiors.
#
# Pipeline per piece: headless Blender exports the .blend → a raw .glb, then
# gltf-transform resizes textures + meshopt-compresses → public/models/furn_*.glb.
#
# Blender is the Flatpak build (org.blender.Blender). Flatpak resolves relative
# paths against its OWN sandbox CWD, so EVERY path handed to Blender is absolute,
# and --filesystem=host exposes the project tree. A piece that fails to export is
# logged and skipped (the game falls back to a box proxy for a missing GLB).
#
# Usage: scripts/convert-furniture.sh [texture_size]   (default 512)
set -euo pipefail
SIZE="${1:-512}"
GT="npx --yes @gltf-transform/cli@latest"
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # absolute repo root
MOB="$(cd "$PROJ/../asset-reference/mobili" && pwd)"       # absolute mobili dir
OUT="$PROJ/public/models"
FLAT="flatpak run --filesystem=host org.blender.Blender"
# Flatpak's sandbox can't read/write /tmp, so stage Blender's script + raw output
# inside the project tree (which --filesystem=host exposes) and clean it up after.
TMP="$PROJ/.furn-tmp"
mkdir -p "$OUT" "$TMP"
trap 'rm -rf "$TMP"' EXIT

# furn slug -> source .blend basename. These 2006-era models are VERTEX-PAINTED
# (COLOR_0), not UV-textured (no TEXCOORD), so the .png "textures" can't map onto
# them — we export the geometry + its baked vertex colours, which three.js renders
# directly. That gives the authored look at a few KB per piece.
declare -A PIECE=(
  [furn_bed]="letto"
  [furn_wardrobe]="armadio"
  [furn_nightstand]="comodino"
  [furn_table]="Tavolo1"
  [furn_chair]="sedia1"
  [furn_bookshelf]="libreria2"
  [furn_desk]="scrivania1"
  [furn_armchair]="poltroncina"
)

export_one() { # <blend-abs> <glb-abs>   (both must be inside the project tree)
  local blend="$1" glb="$2" script="$TMP/export.py"
  cat > "$script" <<PY
import bpy
bpy.ops.wm.open_mainfile(filepath="$blend")
# Drop cameras/lights so only the furniture mesh ends up in the GLB.
for o in list(bpy.data.objects):
    if o.type in {"CAMERA", "LIGHT"}:
        bpy.data.objects.remove(o, do_unlink=True)
# Export geometry + vertex colours (COLOR_0); these models carry no UVs.
bpy.ops.export_scene.gltf(
    filepath="$glb", export_format="GLB", use_selection=False,
    export_vertex_color="MATERIAL",
)
PY
  $FLAT --background --python "$script" >/dev/null 2>&1
}

for slug in "${!PIECE[@]}"; do
  name="${PIECE[$slug]}"
  src="$MOB/$name.blend"
  if [ ! -f "$src" ]; then echo "[$slug] MISSING $src — skip"; continue; fi
  echo "[$slug] $name.blend -> GLB"
  raw="$TMP/$slug.raw.glb"
  if export_one "$src" "$raw" && [ -s "$raw" ]; then
    $GT resize "$raw" "$TMP/$slug.r.glb" --width "$SIZE" --height "$SIZE" >/dev/null 2>&1 || cp "$raw" "$TMP/$slug.r.glb"
    $GT meshopt "$TMP/$slug.r.glb" "$OUT/$slug.glb" >/dev/null 2>&1 || cp "$TMP/$slug.r.glb" "$OUT/$slug.glb"
    echo "  -> $OUT/$slug.glb ($(du -h "$OUT/$slug.glb" | cut -f1))"
  else
    echo "  -> EXPORT FAILED for $slug (game will box-proxy it)"
  fi
done
echo "done."
