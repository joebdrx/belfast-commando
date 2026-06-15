import * as THREE from "three";
import { Enemy } from "./Enemy.js";

const _ray = new THREE.Ray();
const _dir = new THREE.Vector3();
const _hit = new THREE.Vector3();

/**
 * Door
 * ----
 * A kickable wooden door on a hinge. Closed doors block movement (collider)
 * and line-of-sight. A kick swings it open hard, clears the collider, and
 * awards style points. Placeholder = a slab of "wood".
 */
class Door {
  constructor(hingePos, width, openDir = 1, facing = 0) {
    this.width = width;
    this.open = false;
    this.openProgress = 0;
    this.openDir = openDir; // +1 / -1 swing direction
    this.scored = false;

    // Pivot at the hinge; door slab offset so it swings like a real door.
    this.pivot = new THREE.Group();
    this.pivot.position.copy(hingePos);
    this.pivot.rotation.y = facing;
    this._baseFacing = facing; // swing animation pivots around this

    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(width, 2.6, 0.14),
      new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.85 }),
    );
    slab.position.set(width / 2, 1.3, 0);
    this.pivot.add(slab);

    // Handle accent
    const handle = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.6, roughness: 0.3 }),
    );
    handle.position.set(width - 0.18, 1.25, 0.1);
    this.pivot.add(handle);

    // World-space collider while closed (recomputed once at build).
    this._closedBox = new THREE.Box3().setFromObject(this.pivot).expandByScalar(0.02);
    this.center = this._closedBox.getCenter(new THREE.Vector3());
  }

  getCollider() {
    return this.open ? null : this._closedBox;
  }

  kick() {
    if (this.open) return false;
    this.open = true;
    return true;
  }

  update(dt) {
    if (this.open && this.openProgress < 1) {
      this.openProgress = Math.min(1, this.openProgress + dt * 5);
      // Ease-out swing to ~100 degrees.
      const t = 1 - Math.pow(1 - this.openProgress, 3);
      this.pivot.rotation.y = this._baseFacing + this.openDir * t * 1.75;
    }
  }
}

/**
 * Level
 * -----
 * Procedurally assembles a linear Belfast street segment: tarmac, red-brick
 * buildings with kickable doors into side rooms, street cover, patrolling
 * enemies, and a glowing exit gate. Difficulty scales with the level index.
 */
export class Level {
  constructor(scene, index = 0) {
    this.scene = scene;
    this.index = index;
    this.group = new THREE.Group();
    scene.add(this.group);

    /** @type {THREE.Box3[]} static + door colliders for movement */
    this.colliders = [];
    /** @type {THREE.Box3[]} blockers for line-of-sight (walls, car, doors) */
    this.losBlockers = [];
    /** @type {Door[]} */
    this.doors = [];
    /** @type {Enemy[]} */
    this.enemies = [];

    this.spawn = new THREE.Vector3(0, 1.7, 4);
    this.exit = null;

    this._materials = {
      brick: new THREE.MeshStandardMaterial({ color: 0x8a4b3a, roughness: 0.95 }),
      brickDark: new THREE.MeshStandardMaterial({ color: 0x6e3b2e, roughness: 0.95 }),
      tarmac: new THREE.MeshStandardMaterial({ color: 0x33373b, roughness: 1.0 }),
      concrete: new THREE.MeshStandardMaterial({ color: 0x6b6f72, roughness: 0.9 }),
      crate: new THREE.MeshStandardMaterial({ color: 0x7a5a30, roughness: 0.8 }),
      barrel: new THREE.MeshStandardMaterial({ color: 0x355e3b, roughness: 0.6, metalness: 0.3 }),
    };

    this._build();
  }

  // ---- construction helpers ------------------------------------------------

  _box(w, h, d, mat, x, y, z, { collider = true, los = false } = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    if (collider) {
      const box = new THREE.Box3().setFromObject(mesh);
      this.colliders.push(box);
      if (los) this.losBlockers.push(box);
    }
    return mesh;
  }

  _build() {
    const length = 56 + this.index * 16; // street length grows with progression
    const halfW = 5; // street half-width
    const wallH = 5;

    // --- Tarmac floor -----------------------------------------------------
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(halfW * 2 + 6, length + 8),
      this._materials.tarmac,
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -length / 2 + 4);
    this.group.add(floor);

    // --- Side buildings with periodic door gaps ---------------------------
    // We lay each side as a series of brick segments; gaps become doorways
    // leading into a small room (with an enemy).
    const segLen = 8;
    const doorEveryN = 2; // a door roughly every 2 segments
    const segments = Math.floor(length / segLen);

    for (let side = -1; side <= 1; side += 2) {
      const x = side * halfW;
      for (let s = 0; s < segments; s++) {
        const zCenter = 2 - s * segLen;
        const isDoor = s > 0 && s % doorEveryN === 0 && s < segments - 1;
        if (isDoor) {
          const doorW = 1.5;
          // Two short wall stubs flanking the doorway.
          const stub = (segLen - doorW) / 2;
          this._box(0.6, wallH, stub, this._materials.brick, x, wallH / 2, zCenter + (segLen / 2 - stub / 2), { los: true });
          this._box(0.6, wallH, stub, this._materials.brick, x, wallH / 2, zCenter - (segLen / 2 - stub / 2), { los: true });
          // Lintel above the door
          this._box(0.6, wallH - 2.7, doorW, this._materials.brickDark, x, 2.7 + (wallH - 2.7) / 2, zCenter, { collider: false });
          this._spawnRoom(side, x, zCenter, doorW);
        } else {
          this._box(0.6, wallH, segLen, side === -1 ? this._materials.brick : this._materials.brickDark, x, wallH / 2, zCenter, { los: true });
        }
      }
    }

    // End walls (start cap + far cap with exit gap handled below)
    this._box(halfW * 2 + 0.6, wallH, 0.6, this._materials.brickDark, 0, wallH / 2, 5.5, { los: true });

    // --- Street cover -----------------------------------------------------
    const rng = mulberry32(1234 + this.index * 97);
    const coverCount = 5 + this.index * 2;
    for (let i = 0; i < coverCount; i++) {
      const z = -2 - rng() * (length - 12);
      const x = (rng() - 0.5) * (halfW * 1.4);
      if (rng() < 0.5) {
        // Crate
        this._box(1.1, 1.1, 1.1, this._materials.crate, x, 0.55, z, { los: false });
      } else {
        // Barrel
        const b = new THREE.Mesh(
          new THREE.CylinderGeometry(0.45, 0.45, 1.2, 12),
          this._materials.barrel,
        );
        b.position.set(x, 0.6, z);
        this.group.add(b);
        const box = new THREE.Box3().setFromObject(b);
        this.colliders.push(box);
      }
    }

    // Burnt-out car roadblock partway down (good cover + LOS blocker)
    this._buildCar(0.8, -length * 0.45);

    // --- Street enemies (patrolling) --------------------------------------
    const streetEnemies = 3 + this.index;
    for (let i = 0; i < streetEnemies; i++) {
      const z = -10 - (i / streetEnemies) * (length - 16) - rng() * 4;
      const x = (rng() - 0.5) * (halfW * 1.2);
      const pos = new THREE.Vector3(x, 0, z);
      const patrol = [
        new THREE.Vector3(-halfW + 1.5, 0, z),
        new THREE.Vector3(halfW - 1.5, 0, z),
      ];
      this._addEnemy(pos, { patrol });
    }

    // --- Exit gate at the far end ----------------------------------------
    const exitZ = -length + 6;
    const gate = new THREE.Mesh(
      new THREE.BoxGeometry(halfW * 2, 0.2, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x2ecc71, emissive: 0x144d2b, emissiveIntensity: 1 }),
    );
    gate.position.set(0, 2.6, exitZ);
    this.group.add(gate);
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x2ecc71, emissive: 0x0e7a3a, emissiveIntensity: 0.8 });
    for (const sx of [-halfW + 0.3, halfW - 0.3]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.3, 5, 0.3), pillarMat);
      p.position.set(sx, 2.5, exitZ);
      this.group.add(p);
    }
    this.exit = {
      mesh: gate,
      box: new THREE.Box3(
        new THREE.Vector3(-halfW, 0, exitZ - 1.5),
        new THREE.Vector3(halfW, 4, exitZ + 1.5),
      ),
    };
  }

  /** Small room behind a doorway with a kickable door + one enemy. */
  _spawnRoom(side, wallX, zCenter, doorW) {
    const depth = 5;
    const roomX = wallX + side * (depth / 2 + 0.3);
    const wallH = 4;
    const mat = this._materials.concrete;

    // Back + two side walls of the room
    this._box(0.4, wallH, doorW + 4, mat, wallX + side * (depth + 0.6), wallH / 2, zCenter, { los: true });
    this._box(depth + 0.6, wallH, 0.4, mat, roomX, wallH / 2, zCenter + (doorW + 4) / 2, { los: true });
    this._box(depth + 0.6, wallH, 0.4, mat, roomX, wallH / 2, zCenter - (doorW + 4) / 2, { los: true });
    // Floor patch
    const f = new THREE.Mesh(new THREE.PlaneGeometry(depth + 0.6, doorW + 4), this._materials.concrete);
    f.rotation.x = -Math.PI / 2;
    f.position.set(roomX, 0.01, zCenter);
    this.group.add(f);

    // The kickable door, hinged on one side of the opening, swinging inward.
    const hinge = new THREE.Vector3(wallX, 0, zCenter - doorW / 2);
    const facing = side === -1 ? Math.PI / 2 : -Math.PI / 2;
    const door = new Door(hinge, doorW, side, facing);
    door._baseFacing = facing;
    this.group.add(door.pivot);
    this.doors.push(door);
    this.colliders.push(door._closedBox);
    this.losBlockers.push(door._closedBox);

    // Enemy guarding the room
    this._addEnemy(new THREE.Vector3(roomX + side * 1.0, 0, zCenter), {});
  }

  _addEnemy(pos, opts) {
    const e = new Enemy(pos, opts);
    this.group.add(e.group);
    this.enemies.push(e);
  }

  _buildCar(x, z) {
    // Kept axis-aligned so the AABB colliders match the visible mesh. Both the
    // chassis and the head-height cabin block movement + line-of-sight (cover).
    this._box(2.0, 0.9, 4.2, new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.9 }), x, 0.7, z, { los: true });
    this._box(1.8, 0.7, 2.0, new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 }), x, 1.45, z, { los: true });
  }

  // ---- runtime API ---------------------------------------------------------

  /** Active movement colliders (open-door boxes removed). Cached per frame. */
  getColliders() {
    // Rebuild only when the set of open doors changes (kicks are rare).
    let openCount = 0;
    for (const d of this.doors) if (d.open) openCount++;
    if (this._activeColliders && openCount === this._openCount) {
      return this._activeColliders;
    }
    this._openCount = openCount;
    const openBoxes = new Set();
    for (const d of this.doors) if (d.open) openBoxes.add(d._closedBox);
    this._activeColliders = this.colliders.filter((b) => !openBoxes.has(b));
    return this._activeColliders;
  }

  /** True if nothing blocks the segment a→b (used by enemy AI). */
  lineOfSight(a, b) {
    _dir.copy(b).sub(a);
    const maxDist = _dir.length();
    _dir.normalize();
    _ray.set(a, _dir);
    for (const box of this.losBlockers) {
      // Skip opened doors.
      let skip = false;
      for (const d of this.doors) {
        if (d._closedBox === box && d.open) { skip = true; break; }
      }
      if (skip) continue;
      if (_ray.intersectBox(box, _hit)) {
        if (a.distanceTo(_hit) < maxDist) return false;
      }
    }
    return true;
  }

  checkExit(playerPos) {
    return this.exit ? this.exit.box.containsPoint(playerPos) : false;
  }

  get enemiesRemaining() {
    return this.enemies.filter((e) => !e.dead).length;
  }

  update(dt, ctx) {
    for (const d of this.doors) d.update(dt);
    for (const e of this.enemies) e.update(dt, ctx);
    // Pulse the exit gate.
    if (this.exit) {
      this.exit.mesh.material.emissiveIntensity = 1 + Math.sin(ctx.time * 4) * 0.4;
    }
  }

  dispose() {
    this.scene.remove(this.group);
    // Dispose the shared material registry exactly once.
    const shared = new Set(Object.values(this._materials));
    shared.forEach((m) => m.dispose());
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      // Inline (per-mesh) materials still need disposing; skip the shared ones.
      if (o.material && o.material.dispose && !shared.has(o.material)) {
        o.material.dispose();
      }
    });
  }
}

/** Tiny deterministic PRNG so levels are stable across reloads. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
