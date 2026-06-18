#!/usr/bin/env bash
# Optimize the safehouse (HUB) menu assets into runtime GLBs:
#   - menu_actor.glb     : the animated player model used for the hero + ally NPCs
#                          (mesh + WALK clip "Armature|walking_man|baselayer" = animations[0])
#   - anim_menu_idle.glb : a small standing IDLE/fidget clip ("Armature|Confused_Scratch|baselayer"),
#                          mesh stripped to an animation-only GLB (AssetManager reads animations[0])
#   - landline_phone.glb : the wall landline prop (static mesh)
#
# Uses resize + meshopt (NO webp/palette) — webp corrupts character FACE textures
# (the black-box-at-distance lesson from optimize-models.sh / optimize-enemies.sh).
# The menu actor is the SAME Meshy multi-animation export structure as the enemy
# rigs, so the idle clip's bone tracks retarget onto the actor's skeleton by node
# name (exactly like anim_attack.glb retargets onto every rigged enemy).
#
# Usage: scripts/optimize-menu.sh [texture_size]   (default 512)
set -euo pipefail
SIZE="${1:-512}"
GT="npx --yes @gltf-transform/cli@latest"
REF="../asset-reference"
PLAYER="$REF/player-model-animated"
OUT="public/models"
mkdir -p "$OUT"

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
# mesh/skin/material/texture and keep just the bone nodes + the clip — a tiny file
# instead of ~19MB. Uses the @gltf-transform/core API that npx already fetched for
# the CLI; returns non-zero (→ caller falls back) if unavailable.
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

# Menu actor: mesh + WALK clip (animations[0]) from the walking.glb base.
echo "[menu_actor] mesh+walk from k9Na3bWawEc6EQ7DdzCJO_walking.glb"
optimize_mesh "$PLAYER/k9Na3bWawEc6EQ7DdzCJO_walking.glb" "$OUT/menu_actor.glb"

# Idle fidget clip: "Armature|Confused_Scratch|baselayer" — a gentle standing
# fidget, stripped to an animation-only GLB. Falls back to prune+resize+meshopt.
echo "[anim_menu_idle] idle/fidget clip (Confused_Scratch) from SgCyfHt0xWQ03B6lPAGzQ_animation.glb"
IDLE_SRC="$PLAYER/SgCyfHt0xWQ03B6lPAGzQ_animation.glb"
IDLE_OUT="$OUT/anim_menu_idle.glb"
if strip_anim_only "$IDLE_SRC" "$IDLE_OUT"; then
  echo "  -> $IDLE_OUT ($(du -h "$IDLE_OUT" | cut -f1)) [mesh stripped]"
else
  echo "  -> strip unavailable; falling back to prune+resize+meshopt"
  tmp1="$(mktemp --suffix=.glb)"; tmp2="$(mktemp --suffix=.glb)"
  $GT prune "$IDLE_SRC" "$tmp1" >/dev/null 2>&1 || cp "$IDLE_SRC" "$tmp1"
  $GT resize "$tmp1" "$tmp2" --width 64 --height 64 >/dev/null 2>&1 || cp "$tmp1" "$tmp2"
  $GT meshopt "$tmp2" "$IDLE_OUT" >/dev/null 2>&1 || cp "$tmp2" "$IDLE_OUT"
  rm -f "$tmp1" "$tmp2"
  echo "  -> $IDLE_OUT ($(du -h "$IDLE_OUT" | cut -f1))"
fi

# Landline phone: static wall prop.
echo "[landline_phone] static mesh from landline_phone.glb"
optimize_mesh "$REF/landline_phone.glb" "$OUT/landline_phone.glb"

echo "done."
