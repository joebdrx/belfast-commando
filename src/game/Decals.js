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
  constructor(scene, cap = 100) {
    this.cap = cap;
    this.group = new THREE.Group();
    this.group.name = "decals";
    scene.add(this.group);
    this._slots = new Array(cap).fill(null);
    this._cursor = 0;
    this.ctx = null;
    this._unsub = [];

    this.bloodMat = new THREE.MeshBasicMaterial({
      color: 0x6e0b0b, transparent: true, opacity: 0.92,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, fog: true,
    });
    this.holeMat = new THREE.MeshBasicMaterial({
      color: 0x141414, transparent: true, opacity: 0.85,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, fog: true,
    });
    this._geo = new THREE.PlaneGeometry(1, 1);
  }

  setContext(ctx) { this.ctx = ctx; }

  attach() {
    const bus = this.ctx.state;
    this._unsub.push(bus.on("kill", (p) => p && p.position && this.bloodPool(p.position)));
    this._unsub.push(bus.on("explosion", (p) => p && p.position && this.bloodPool(p.position, 2.0)));
    this._unsub.push(bus.on("surfaceHit", (p) => p && p.position && this.bulletHole(p.position, p.normal)));
  }

  /** Flat blood pool on the ground under a death/explosion. */
  bloodPool(position, scale = 1) {
    const s = (0.7 + Math.random() * 0.8) * scale;
    const m = this._place(this.bloodMat, position.x, 0.02, position.z, _up, s);
    m.rotateZ(Math.random() * Math.PI); // spin in the ground plane (local +Z = up)
  }

  /** Bullet hole oriented to a surface normal. */
  bulletHole(position, normal) {
    const n = normal || _up;
    const s = 0.18 + Math.random() * 0.12;
    this._place(this.holeMat, position.x, position.y, position.z, n, s, 0.02);
  }

  _place(mat, x, y, z, normal, scale, lift = 0) {
    let mesh = this._slots[this._cursor];
    if (!mesh) {
      mesh = new THREE.Mesh(this._geo, mat);
      this.group.add(mesh);
      this._slots[this._cursor] = mesh;
    } else {
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
    this.bloodMat.dispose();
    this.holeMat.dispose();
  }
}
