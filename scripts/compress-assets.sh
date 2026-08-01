#!/usr/bin/env bash
# Final compression pass over the runtime assets in public/: KTX2 (Basis)
# textures + Draco geometry. Run AFTER the optimize-*.sh scripts, which turn the
# raw AI-generated GLBs in assets/ into runtime models.
#
# Two knobs, and the reason for each:
#
#   ETC1S  — tiny (~8:1 vs PNG), blocky on smooth gradients. Props and
#            environment surfaces.
#   UASTC  — ~2x ETC1S, near-lossless. Anything with a FACE on it. The webp pass
#            in optimize-models.sh corrupted character faces into black boxes;
#            ETC1S is a different codec but faces are the known-fragile surface
#            here, so they get the safe one. Geometry dominates those files
#            anyway — UASTC costs ~200KB per character over ETC1S.
#
#   Draco  — replaces EXT_meshopt_compression. Measured ~34% smaller than meshopt
#            on these meshes. Needs DRACOLoader wired in AssetManager.
#
# Mipmaps are baked at encode time: the GPU cannot generate them for a
# compressed texture, and RetroMaterial asks for LinearMipmapLinearFilter.
#
# Idempotent-ish but LOSSY — re-running re-encodes already-encoded data. The
# inputs are tracked in git; `git checkout public/` to start over.
#
# Requires: ktx (KTX-Software v4+). https://github.com/KhronosGroup/KTX-Software/releases
# Usage: scripts/compress-assets.sh
set -euo pipefail
cd "$(dirname "$0")/.."

command -v ktx >/dev/null || {
  echo "error: 'ktx' not found. Install KTX-Software v4+:" >&2
  echo "  https://github.com/KhronosGroup/KTX-Software/releases" >&2
  exit 1
}

GT="npx --yes @gltf-transform/cli@latest"
# ImageMagick 7 ships `magick`; 6 ships `convert`.
IM=$(command -v magick || command -v convert) || {
  echo "error: ImageMagick not found (need 'magick' or 'convert')" >&2; exit 1
}
# ponytail: substring match, not a manifest. Rename a character file and it
# silently drops to ETC1S — the PSNR check in scripts/check-assets.mjs
# is what catches that.
FACES='enemy_|player2_|menu_actor|viewmodel_|fp_arms_|invader'

before=$(du -sb public | cut -f1)

echo "== models (KTX2 + Draco) =="
for f in public/models/*.glb; do
  name=$(basename "$f")
  orig=$(stat -c%s "$f")
  if [[ "$name" =~ $FACES ]]; then mode=uastc; opts="--level 2 --rdo 4"; else mode=etc1s; opts="--quality 200"; fi
  # Both temp paths MUST end in .glb — gltf-transform picks binary vs separate-file
  # glTF from the output extension, and any other suffix silently explodes the
  # model into a JSON stub plus sidecar .bin/.ktx2 files.
  tmp=$(mktemp --suffix=.glb) out=$(mktemp --suffix=.glb)
  # shellcheck disable=SC2086
  $GT "$mode" "$f" "$tmp" $opts >/dev/null 2>&1 || cp "$f" "$tmp"
  # --quantize-position 16: Draco's 14-bit default re-quantizes geometry that
  # meshopt already quantized once, and on city_map (a whole city in one mesh)
  # that second pass is where seams start cracking. 16 bits costs nothing
  # measurable in file size here.
  #
  # The anim_*.glb clips stay on meshopt: Draco's vertex dedup was halving their
  # placeholder mesh's triangle count for no size win. They must still be
  # RE-compressed — the KTX2 step above decodes meshopt on the way in, so
  # "leave them alone" actually means shipping raw vertex buffers (1.1MB -> 2.8MB).
  if [[ "$name" == anim_* ]]; then
    $GT meshopt "$tmp" "$out" >/dev/null 2>&1 || true
  else
    $GT draco "$tmp" "$out" --quantize-position 16 >/dev/null 2>&1 || true
  fi
  if [ -s "$out" ]; then
    mv "$out" "$f"
  else
    echo "  WARN $name — compression failed, left as-is"
  fi
  rm -f "$tmp" "$out"
  printf "  %-26s %6s -> %6s  (%s)\n" "$name" \
    "$(numfmt --to=iec "$orig")" "$(numfmt --to=iec "$(stat -c%s "$f")")" "$mode"
done

echo "== standalone textures (KTX2/ETC1S) =="
# srgb for colour maps, linear for normal/rough — wrong transfer function on a
# normal map bakes a lighting bug that only shows up on curved surfaces.
encode_tex() {
  local src="$1" out="${1%.*}.ktx2" enc="$2" tf=("${@:3}")
  # Decode to PNG first. ktx's built-in JPEG reader rejects some chroma
  # subsampling factors (JPGD_UNSUPPORTED_SAMP_FACTORS) — several hub_*.jpg hit
  # it. Going through ImageMagick sidesteps every decoder quirk at once.
  local png; png=$(mktemp --suffix=.png)
  "$IM" "$src" -alpha on "PNG32:$png" 2>/dev/null || {
    echo "  FAIL $src (decode)"; rm -f "$png"; return
  }
  if ktx create --format "$enc" --encode basis-lz --clevel 4 --qlevel 200 \
      --generate-mipmap "${tf[@]}" "$png" "$out" >/dev/null 2>&1 && [ -s "$out" ]; then
    rm -f "$src"
    printf "  %-40s -> %6s\n" "${src#public/}" "$(numfmt --to=iec "$(stat -c%s "$out")")"
  else
    echo "  FAIL $src (encode)"
  fi
  rm -f "$png"
}

# ONLY textures that AssetManager._loadTexture is the sole loader of may become
# .ktx2. Hub.js, Level.js and Decals.js each build their own THREE.TextureLoader,
# and TextureLoader.load() returns a Texture synchronously while KTX2Loader.load()
# does not — so those call sites cannot consume a .ktx2 without a rewrite, and
# deleting their .jpg/.png out from under them just 404s the texture away.
# Anything shared with those files is handled by the plain-image pass below.
for f in public/textures/*/diffuse.jpg public/non-1.png public/house_side.png; do
  [ -e "$f" ] || continue
  encode_tex "$f" R8G8B8A8_SRGB --assign-tf srgb
done
for f in public/textures/*/normal.jpg public/textures/*/rough.jpg; do
  [ -e "$f" ] || continue
  encode_tex "$f" R8G8B8A8_UNORM --assign-tf linear
done

echo "== shared textures (kept in-format for the plain TextureLoader call sites) =="
# Murals are opaque 1024² photos shipped as 2.4MB PNGs — JPEG is the right
# container. The .png -> .jpg rename is mirrored in AssetManager's MURALS list
# and Hub._buildMurals.
for f in public/murals/*.png; do
  [ -e "$f" ] || continue
  before_f=$(stat -c%s "$f")
  "$IM" "$f" -quality 88 -interlace Plane "${f%.png}.jpg" && rm -f "$f"
  printf "  %-40s %6s -> %6s\n" "${f#public/}" \
    "$(numfmt --to=iec "$before_f")" "$(numfmt --to=iec "$(stat -c%s "${f%.png}.jpg")")"
done
# hub_*.jpg and vfx/*.png are deliberately left alone. Both are loaded by plain
# TextureLoader call sites so they can't go KTX2, and re-encoding them as JPEG
# was measured as a wash (several came out LARGER — they're already small and
# well-compressed). ~1.3MB total; not worth the quality loss.

after=$(du -sb public | cut -f1)
echo
printf "public/: %s -> %s\n" "$(numfmt --to=iec "$before")" "$(numfmt --to=iec "$after")"
