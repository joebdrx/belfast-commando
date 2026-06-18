import * as THREE from "three";

/** Ring-buffer slot after `i` for capacity `cap`. Pure. */
export function ringNext(i, cap) {
  return (i + 1) % cap;
}

/**
 * Decals — persistent, flat, retro blood pools + bullet holes.
 *
 * The world uses AABB colliders (no per-hit mesh/face), so THREE.DecalGeometry
 * isn't applicable. We lay flat quads on the surface and keep them for the
 * level's lifetime, ring-buffered at a hard cap. Matches the PS1 look (flat,
 * aliased decals) and fits the existing pooling discipline.
 */
const _q = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _up = new THREE.Vector3(0, 1, 0);

export class Decals {
  // Default cap bumped (each kill now emits several overlapping splats); the
  // caller may still pass a smaller cap. Whatever the cap, the ring buffer keeps
  // the live decal count strictly bounded.
  constructor(scene, cap = 160) {
    this.cap = cap;
    this.group = new THREE.Group();
    this.group.name = "decals";
    scene.add(this.group);
    this._slots = new Array(cap).fill(null);
    this._cursor = 0;
    this.ctx = null;
    this._unsub = [];

    const inBrowser = typeof document !== "undefined";

    // Soft radial-alpha sprite for blood: a white core fading to transparent,
    // tinted dark-red per-material. Gives circular splats with soft edges that
    // overlap into an organic pool. Null under Node (tests) → flat circle quads.
    this._bloodTex = inBrowser ? this._makeRadialTex() : null;
    const shades = [0x6e0b0b, 0x5a0808, 0x7d1212, 0x480505];
    this.bloodMats = shades.map((col, i) => new THREE.MeshBasicMaterial({
      color: col, map: this._bloodTex || null,
      transparent: true, opacity: 0.7 + (i % 2) * 0.16,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, fog: true,
    }));
    this.bloodMat = this.bloodMats[0]; // back-compat handle

    // Bullet holes use the real keyed-out scorch sprite (transparent surround)
    // with alphaTest so no black square/halo shows. Loaded directly from /public
    // (Decals has no AssetManager handle); falls back to a dark quad under Node.
    let holeTex = null;
    if (inBrowser) {
      const base = (import.meta.env && import.meta.env.BASE_URL) || "/";
      holeTex = new THREE.TextureLoader().load(`${base}vfx/bullet_hole.png`);
      holeTex.colorSpace = THREE.SRGBColorSpace;
    }
    this._holeTex = holeTex;
    this.holeMat = new THREE.MeshBasicMaterial({
      map: holeTex || null,
      color: holeTex ? 0xffffff : 0x141414,
      transparent: true, opacity: holeTex ? 0.95 : 0.85,
      alphaTest: holeTex ? 0.5 : 0,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, fog: true,
    });

    this._geo = new THREE.PlaneGeometry(1, 1);       // bullet holes
    this._bloodGeo = new THREE.CircleGeometry(1, 20); // blood splats (round)
  }

  /** Build a soft radial white→transparent alpha sprite (browser-only). */
  _makeRadialTex() {
    const size = 64;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.6, "rgba(255,255,255,0.85)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  setContext(ctx) { this.ctx = ctx; }

  attach() {
    const bus = this.ctx.state;
    this._unsub.push(bus.on("kill", (p) => p && p.position && this.bloodPool(p.position)));
    this._unsub.push(bus.on("explosion", (p) => p && p.position && this.bloodPool(p.position, 2.0)));
    this._unsub.push(bus.on("surfaceHit", (p) => p && p.position && this.bulletHole(p.position, p.normal)));
  }

  /**
   * Asymmetric blood pool on the ground: several overlapping circular splats at
   * small random offsets, with varied radius, rotation, and dark-red tint, so a
   * kill reads as an organic blob rather than one square. Bounded by the ring
   * buffer (each splat consumes one slot).
   */
  bloodPool(position, scale = 1) {
    const n = 3 + Math.floor(Math.random() * 4); // 3–6 splats
    for (let i = 0; i < n; i++) {
      const s = (0.4 + Math.random() * 0.7) * scale;
      const ox = (Math.random() - 0.5) * 0.7 * scale;
      const oz = (Math.random() - 0.5) * 0.7 * scale;
      const mat = this.bloodMats[(Math.random() * this.bloodMats.length) | 0];
      // Tiny y stagger reduces z-fighting between stacked transparent splats.
      const m = this._place(mat, this._bloodGeo, position.x + ox, 0.02 + i * 0.001, position.z + oz, _up, s);
      m.rotateZ(Math.random() * Math.PI * 2); // spin in the ground plane
    }
  }

  /** Bullet hole oriented to a surface normal. */
  bulletHole(position, normal) {
    const n = normal || _up;
    const s = 0.18 + Math.random() * 0.12;
    this._place(this.holeMat, this._geo, position.x, position.y, position.z, n, s, 0.02);
  }

  _place(mat, geo, x, y, z, normal, scale, lift = 0) {
    let mesh = this._slots[this._cursor];
    if (!mesh) {
      mesh = new THREE.Mesh(geo, mat);
      this.group.add(mesh);
      this._slots[this._cursor] = mesh;
    } else {
      mesh.geometry = geo;
      mesh.material = mat;
      mesh.visible = true;
    }
    _q.setFromUnitVectors(_zAxis, normal); // orient quad +Z to the surface normal
    mesh.quaternion.copy(_q);
    mesh.position.set(x + normal.x * lift, y + normal.y * lift, z + normal.z * lift);
    mesh.scale.set(scale, scale, scale);
    this._cursor = ringNext(this._cursor, this.cap);
    return mesh;
  }

  clear() {
    for (const m of this._slots) if (m) m.visible = false;
    this._cursor = 0;
  }

  dispose(scene) {
    this._unsub.forEach((u) => u && u());
    this._unsub.length = 0;
    scene.remove(this.group);
    this._geo.dispose();
    this._bloodGeo.dispose();
    this.bloodMats.forEach((m) => m.dispose());
    this.holeMat.dispose();
    if (this._bloodTex) this._bloodTex.dispose();
    if (this._holeTex) this._holeTex.dispose();
  }
}
