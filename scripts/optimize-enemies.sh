#!/usr/bin/env bash
# Optimize the rigged+animated Meshy enemy models + the victim into runtime GLBs.
#
# Uses resize + meshopt (NO webp/palette) — webp corrupts character FACE textures
# (the black-box-at-distance lesson from optimize-models.sh). Each enemy uses its
# `walking.glb` (mesh + walk animation) as the base model, plus the tiny
# `running_armature.glb` as a run clip on the same skeleton (copied as-is).
# Victim is a static mesh.
#
# Usage: scripts/optimize-enemies.sh [texture_size]   (default 512)
set -euo pipefail
SIZE="${1:-512}"
GT="npx --yes @gltf-transform/cli@latest"
REF="../asset-reference"
OUT="public/models"
mkdir -p "$OUT"

# archetype -> "<rig-dir>|<walking.glb>|<running_armature.glb>"
declare -A RIG=(
  [grunt]="stabber-meshy-rigging-multi-animation|yb1bVR-wxEvWyFRGuKqgE_walking.glb|w9RN9K-sFzXgy7Z0-PTBX_running_armature.glb"
  [gunner]="invader2-meshy-rigging-multi-animation|2c5tp7E7pvv4SgEarnxvt_walking.glb|7TWxLU9gWd0fQWNOJHUcf_running_armature.glb"
  [breacher]="invader1-meshy-rigging-multi-animation|K9EUkznCIi16_SBxmjLmB_walking.glb|u3XVW5IREF7fT8pA83SqY_running_armature.glb"
  [enforcer]="groomer-meshy-rigging-multi-animation|pV5-Lh2JrUFeOQnH7ON6o_walking.glb|MtthVIfoBOpx1fRWylvZz_running_armature.glb"
)

optimize_mesh() { # src out
  local src="$1" out="$2" tmp
  tmp="$(mktemp --suffix=.glb)"
  $GT resize "$src" "$tmp" --width "$SIZE" --height "$SIZE" >/dev/null 2>&1 || cp "$src" "$tmp"
  $GT meshopt "$tmp" "$out" >/dev/null 2>&1 || cp "$tmp" "$out"
  rm -f "$tmp"
  echo "  -> $out ($(du -h "$out" | cut -f1))"
}

# Strip a full-mesh "_animation.glb" down to an ANIMATION-ONLY GLB: the runtime
# only ever reads animations[0] (the mesh is discarded at load), so we drop every
# mesh/skin/material/texture and keep just the bone nodes + the clip — a ~32KB
# file instead of ~35MB. Uses the @gltf-transform/core API that npx already
# fetched for the CLI; returns non-zero (→ caller falls back) if unavailable.
strip_anim_only() { # src out
  local src="$1" out="$2" core_dir nm tmp script
  core_dir="$(find "$HOME/.npm/_npx" -type d -path '*node_modules/@gltf-transform/core' 2>/dev/null | head -1 || true)"
  [ -n "$core_dir" ] || return 1
  nm="$(dirname "$(dirname "$core_dir")")"
  tmp="$(mktemp --suffix=.glb)"
  script="$(mktemp --suffix=.cjs)"
  cat > "$script" <<'NODE'
const nm = process.argv[2], src = process.argv[3], out = process.argv[4];
const core = require(nm + '/@gltf-transform/core/dist/index.cjs');
let ALL = [];
try { ALL = require(nm + '/@gltf-transform/extensions/dist/index.cjs').ALL_EXTENSIONS || []; } catch (e) { /* fine */ }
(async () => {
  const io = new core.NodeIO().registerExtensions(ALL);
  const doc = await io.read(src);
  const root = doc.getRoot();
  // Detach the skinned mesh from every node, then dispose all mesh-side data.
  // Bone nodes survive (the animation channels still reference them).
  for (const node of root.listNodes()) { node.setMesh(null); node.setSkin(null); }
  for (const m of root.listMeshes()) m.dispose();
  for (const s of root.listSkins()) s.dispose();
  for (const mat of root.listMaterials()) mat.dispose();
  for (const tex of root.listTextures()) tex.dispose();
  for (const acc of root.listAccessors()) {
    if (acc.listParents().filter((p) => p.propertyType !== 'Root').length === 0) acc.dispose();
  }
  if (root.listAnimations().length === 0) throw new Error('no animation survived strip');
  await io.write(out, doc);
})().catch((e) => { console.error(String(e)); process.exit(1); });
NODE
  if node "$script" "$nm" "$src" "$tmp" 2>/dev/null; then
    $GT meshopt "$tmp" "$out" >/dev/null 2>&1 || cp "$tmp" "$out"
    rm -f "$tmp" "$script"
    return 0
  fi
  rm -f "$tmp" "$script"
  return 1
}

for arch in "${!RIG[@]}"; do
  IFS='|' read -r dir walk run <<< "${RIG[$arch]}"
  echo "[enemy_$arch] mesh+walk from $walk"
  optimize_mesh "$REF/$dir/$walk" "$OUT/enemy_$arch.glb"
  echo "[enemy_$arch] run clip from $run"
  $GT meshopt "$REF/$dir/$run" "$OUT/anim_${arch}_run.glb" >/dev/null 2>&1 || cp "$REF/$dir/$run" "$OUT/anim_${arch}_run.glb"
  echo "  -> $OUT/anim_${arch}_run.glb ($(du -h "$OUT/anim_${arch}_run.glb" | cut -f1))"
done

# Victim: STATIC mesh. The rigged victim's separate run clip never bound to its
# skeleton (mesh stayed frozen → "broken"), so we use the static civilian model.
echo "[victim] static mesh"
optimize_mesh "$REF/victim-model.glb" "$OUT/enemy_victim.glb"

# Enemy hand weapons: ranged enemies hold a pistol (existing weapon_pistol);
# melee enemies hold a blade (knife / machete) they lunge with.
echo "[weapons] enemy blades"
optimize_mesh "$REF/kitchen_knife.glb" "$OUT/enemy_knife.glb"
optimize_mesh "$REF/kukri_machete.glb" "$OUT/enemy_machete.glb"

# Shared melee attack ANIMATION clip. One Meshy "_animation.glb" carries the
# `Armature|Double_Combo_Attack|baselayer` clip on the standard bone names, so it
# retargets onto EVERY rigged enemy (AssetManager loads it once and adds it to
# each rig's clips as `attack`). The source is ~35MB full-mesh; we strip it to an
# animation-only ~32KB GLB. If the strip step is unavailable, fall back to a
# prune + tiny-texture-resize + meshopt of the full file (a few MB, still works).
echo "[attack] shared melee animation clip (Double_Combo_Attack)"
ATTACK_SRC="$REF/stabber-meshy-rigging-multi-animation/dl4dFyocSWydthtwwGTaS_animation.glb"
ATTACK_OUT="$OUT/anim_attack.glb"
if strip_anim_only "$ATTACK_SRC" "$ATTACK_OUT"; then
  echo "  -> $ATTACK_OUT ($(du -h "$ATTACK_OUT" | cut -f1)) [mesh stripped]"
else
  echo "  -> strip unavailable; falling back to prune+resize+meshopt"
  tmp1="$(mktemp --suffix=.glb)"; tmp2="$(mktemp --suffix=.glb)"
  $GT prune "$ATTACK_SRC" "$tmp1" >/dev/null 2>&1 || cp "$ATTACK_SRC" "$tmp1"
  $GT resize "$tmp1" "$tmp2" --width 64 --height 64 >/dev/null 2>&1 || cp "$tmp1" "$tmp2"
  $GT meshopt "$tmp2" "$ATTACK_OUT" >/dev/null 2>&1 || cp "$tmp2" "$ATTACK_OUT"
  rm -f "$tmp1" "$tmp2"
  echo "  -> $ATTACK_OUT ($(du -h "$ATTACK_OUT" | cut -f1))"
fi
echo "done."
