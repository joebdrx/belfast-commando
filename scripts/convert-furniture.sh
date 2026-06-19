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

# furn slug -> "<blend-basename>|<texture-png-or-empty>". These 2006-era models
# carry no UV map (their textures mapped via generated coords that don't export to
# glTF), so we Smart-UV-unwrap each mesh and wire the matching .png as the base
# colour. Pieces with no .png (armadio) keep their baked vertex colours instead.
declare -A PIECE=(
  [furn_bed]="letto|lettoO.png"
  [furn_wardrobe]="armadio|comodino.png"
  [furn_nightstand]="comodino|comodino.png"
  [furn_table]="Tavolo1|tavolo1.png"
  [furn_chair]="sedia1|sedia1.png"
  [furn_bookshelf]="libreria2|libreria2.png"
  [furn_desk]="scrivania1|scrivania1.png"
  [furn_armchair]="poltroncina|poltroncina.png"
)

export_one() { # <blend-abs> <glb-abs> <texture-abs-or-empty>
  local blend="$1" glb="$2" tex="${3:-}" script="$TMP/export.py"
  cat > "$script" <<PY
import bpy, os
bpy.ops.wm.open_mainfile(filepath="$blend")
# Drop cameras/lights so only the furniture mesh ends up in the GLB.
for o in list(bpy.data.objects):
    if o.type in {"CAMERA", "LIGHT"}:
        bpy.data.objects.remove(o, do_unlink=True)

TEX = "$tex"
img = bpy.data.images.load(TEX, check_existing=True) if (TEX and os.path.exists(TEX)) else None

if img is not None:
    # These meshes have no UV map, and Blender's smart_project crashes in
    # --background (no 3D viewport). So build a crude but crash-safe box/triplanar
    # UV via the mesh API: project each face onto the plane of its dominant normal
    # axis. Good enough to tile a wood/fabric texture across the furniture.
    SCALE = 0.5  # texture repeats every ~2 model units
    for o in [o for o in bpy.data.objects if o.type == "MESH"]:
        me = o.data
        uvl = me.uv_layers.new(name="UVMap") if not me.uv_layers else (me.uv_layers.active or me.uv_layers[0])
        uvd = uvl.data
        for poly in me.polygons:
            n = poly.normal
            ax = max(range(3), key=lambda i: abs(n[i]))  # dominant axis
            for li in poly.loop_indices:
                co = me.vertices[me.loops[li].vertex_index].co
                if ax == 0:   u, v = co.y, co.z
                elif ax == 1: u, v = co.x, co.z
                else:         u, v = co.x, co.y
                uvd[li].uv = (u * SCALE, v * SCALE)
    # Wire the texture as base colour on each material. Vertex colours dropped.
    for mat in bpy.data.materials:
        mat.use_nodes = True
        nt = mat.node_tree
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
            out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None) or nt.nodes.new("ShaderNodeOutputMaterial")
            nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        tx = nt.nodes.new("ShaderNodeTexImage")
        tx.image = img
        nt.links.new(tx.outputs["Color"], bsdf.inputs["Base Color"])
    VCOL = "NONE"
else:
    VCOL = "MATERIAL"  # no texture → keep the baked vertex colours

bpy.ops.export_scene.gltf(filepath="$glb", export_format="GLB", use_selection=False, export_vertex_color=VCOL)
PY
  $FLAT --background --python "$script" >/dev/null 2>&1
}

for slug in "${!PIECE[@]}"; do
  IFS='|' read -r name texfile <<< "${PIECE[$slug]}"
  src="$MOB/$name.blend"
  tex=""; [ -n "$texfile" ] && tex="$MOB/$texfile"
  if [ ! -f "$src" ]; then echo "[$slug] MISSING $src — skip"; continue; fi
  echo "[$slug] $name.blend ${texfile:+(+$texfile)} -> GLB"
  raw="$TMP/$slug.raw.glb"
  if export_one "$src" "$raw" "$tex" && [ -s "$raw" ]; then
    $GT resize "$raw" "$TMP/$slug.r.glb" --width "$SIZE" --height "$SIZE" >/dev/null 2>&1 || cp "$raw" "$TMP/$slug.r.glb"
    $GT meshopt "$TMP/$slug.r.glb" "$OUT/$slug.glb" >/dev/null 2>&1 || cp "$TMP/$slug.r.glb" "$OUT/$slug.glb"
    echo "  -> $OUT/$slug.glb ($(du -h "$OUT/$slug.glb" | cut -f1))"
  else
    echo "  -> EXPORT FAILED for $slug (game will box-proxy it)"
  fi
done
echo "done."
