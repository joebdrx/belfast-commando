import * as THREE from "three";

/**
 * The PS1 "stylized hybrid" look. Two effects:
 *   1) Nearest-filter textures (crunchy, no bilinear smoothing).
 *   2) Vertex snapping — clip-space xy quantised to a low-res grid in the vertex
 *      shader (authentic PS1 wiggle) WITHOUT touching JS positions, so collision
 *      and pooling are unaffected.
 * ACES tone-mapping + PMREM/HDRI lighting are intentionally KEPT (hybrid).
 */

/** Effective snap grid for a viewport. Lower target => chunkier wiggle. Pure. */
export function computeResolution(width, height, targetHeight = 240) {
  const h = Math.max(1, targetHeight);
  const aspect = width > 0 && height > 0 ? width / height : 1;
  return { x: Math.max(1, Math.round(h * aspect)), y: h };
}

export class RetroMaterial {
  constructor({ targetHeight = 240 } = {}) {
    this.targetHeight = targetHeight;
    this.uniforms = { uSnap: { value: new THREE.Vector2(426, 240) } };
    this._patched = new Set();
  }

  setViewport(width, height) {
    const r = computeResolution(width, height, this.targetHeight);
    this.uniforms.uSnap.value.set(r.x, r.y);
  }

  /**
   * Crunchy PS1 texture filtering: NEAREST magnification (crisp blocky texels up
   * close) but MIPMAPPED minification so distant tiled surfaces don't shimmer.
   * Mipmaps stay ON — disabling them made far textures sparkle/"flash".
   */
  applyTextureFilter(tex) {
    if (!tex) return tex;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Vertex snapping is intentionally DISABLED. Quantising clip-space xy made
   * coplanar layered surfaces (murals/facades/road paint/decals) flip their
   * depth-test winner frame-to-frame, which read as textures flashing. The
   * nearest-filter crunch + claustrophobic fog carry the PS1 look without it.
   * Kept as no-ops so existing call sites (AssetManager) need no changes.
   */
  patchMaterial(mat) {
    return mat;
  }

  patchObject(obj) {
    return obj;
  }
}
