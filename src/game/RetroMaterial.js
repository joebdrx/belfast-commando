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

  /** Nearest-filter a texture in place. */
  applyTextureFilter(tex) {
    if (!tex) return tex;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  /** Inject vertex snapping into a material via onBeforeCompile (idempotent). */
  patchMaterial(mat) {
    if (!mat || this._patched.has(mat)) return mat;
    this._patched.add(mat);
    const uSnap = this.uniforms.uSnap;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader) => {
      if (prev) prev(shader);
      shader.uniforms.uSnap = uSnap;
      shader.vertexShader = "uniform vec2 uSnap;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        {
          vec4 snapPos = gl_Position;
          snapPos.xyz /= snapPos.w;
          snapPos.xy = floor(snapPos.xy * uSnap) / uSnap;
          snapPos.xyz *= snapPos.w;
          gl_Position = snapPos;
        }`,
      );
    };
    mat.needsUpdate = true;
    return mat;
  }

  /** Patch every material under an Object3D (GLB models). */
  patchObject(obj) {
    if (!obj) return obj;
    obj.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => this.patchMaterial(m));
    });
    return obj;
  }
}
