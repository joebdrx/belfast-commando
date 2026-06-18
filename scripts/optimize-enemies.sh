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
  [grunt]="invader1-meshy-rigging-multi-animation|K9EUkznCIi16_SBxmjLmB_walking.glb|u3XVW5IREF7fT8pA83SqY_running_armature.glb"
  [gunner]="invader2-meshy-rigging-multi-animation|2c5tp7E7pvv4SgEarnxvt_walking.glb|7TWxLU9gWd0fQWNOJHUcf_running_armature.glb"
  [breacher]="stabber-meshy-rigging-multi-animation|yb1bVR-wxEvWyFRGuKqgE_walking.glb|w9RN9K-sFzXgy7Z0-PTBX_running_armature.glb"
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

for arch in "${!RIG[@]}"; do
  IFS='|' read -r dir walk run <<< "${RIG[$arch]}"
  echo "[enemy_$arch] mesh+walk from $walk"
  optimize_mesh "$REF/$dir/$walk" "$OUT/enemy_$arch.glb"
  echo "[enemy_$arch] run clip from $run"
  $GT meshopt "$REF/$dir/$run" "$OUT/anim_${arch}_run.glb" >/dev/null 2>&1 || cp "$REF/$dir/$run" "$OUT/anim_${arch}_run.glb"
  echo "  -> $OUT/anim_${arch}_run.glb ($(du -h "$OUT/anim_${arch}_run.glb" | cut -f1))"
done

echo "[victim] static mesh"
optimize_mesh "$REF/victim-model.glb" "$OUT/enemy_victim.glb"
echo "done."
