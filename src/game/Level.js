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
  constructor(hingePos, width, openDir = 1, facing = 0, slabMat = null, slabModel = null) {
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
      slabMat || new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.85 }),
    );
    slab.position.set(width / 2, 1.3, 0);
    this.pivot.add(slab);

    // Collider/LOS proxy is ALWAYS the thin slab (model-independent). Compute
    // it from the slab only, before adding the GLB. The pivot's world matrix
    // MUST be updated first — Box3.expandByObject doesn't update parents, so
    // without this the box lands at the slab's LOCAL position (~0.75,1.3,0)
    // instead of the real doorway, making doors un-kickable.
    this.pivot.updateMatrixWorld(true);
    this._closedBox = new THREE.Box3().setFromObject(slab).expandByScalar(0.02);
    this.center = this._closedBox.getCenter(new THREE.Vector3());

    if (slabModel) {
      // Use the AI door leaf for visuals; the slab becomes an invisible proxy.
      slab.visible = false;
      slabModel.position.set(width / 2, 0, 0);
      this.pivot.add(slabModel);
    } else {
      // Handle accent (placeholder door only)
      const handle = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.6, roughness: 0.3 }),
      );
      handle.position.set(width - 0.18, 1.25, 0.1);
      this.pivot.add(handle);
    }
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
  constructor(scene, index = 0, assets = null) {
    this.scene = scene;
    this.index = index;
    this.assets = assets;
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
    /** @type {Array<{root:THREE.Object3D, hitbox:THREE.Box3, collider:THREE.Box3, pos:THREE.Vector3, exploded:boolean}>} */
    this.barrels = [];

    this.spawn = new THREE.Vector3(0, 1.7, 4);
    this.exit = null;

    // Pull shared, textured materials from the AssetManager when present;
    // otherwise fall back to flat colours so the level still builds.
    this._materials = {
      brick: this._mat("brick", 0x8a4b3a, 0.95),
      brickDark: this._mat("brick_dark", 0x6e3b2e, 0.95),
      tarmac: this._mat("tarmac", 0x33373b, 1.0),
      concrete: this._mat("concrete", 0x6b6f72, 0.9),
      crate: this._mat("crate", 0x7a5a30, 0.8),
      barrel: this._mat("barrel", 0x355e3b, 0.6, 0.3),
      door: this._mat("door", 0x5a3a22, 0.85),
    };

    this._build();
  }

  // ---- construction helpers ------------------------------------------------

  /** Shared textured material from AssetManager, or a flat-colour fallback. */
  _mat(slug, color, roughness = 0.9, metalness = 0.0) {
    if (this.assets) return this.assets.getMaterial(slug);
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
  }

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
        this._prop("crate_supply", x, z, 1.1, 1.1, 1.1, () => {
          const m = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), this._materials.crate);
          m.position.set(x, 0.55, z);
          this.group.add(m);
        });
      } else {
        this._addBarrel(x, z);
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

    // --- Set-dressing props (AI GLBs) ------------------------------------
    this._setDressing(length, halfW, rng);

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
    const doorModel = this.assets ? this.assets.getModel("door_kickable") : null;
    const door = new Door(hinge, doorW, side, facing, this._materials.door, doorModel);
    door._baseFacing = facing;
    this.group.add(door.pivot);
    this.doors.push(door);
    this.colliders.push(door._closedBox);
    this.losBlockers.push(door._closedBox);

    // Enemy guarding the room
    this._addEnemy(new THREE.Vector3(roomX + side * 1.0, 0, zCenter), {});
  }

  /**
   * Place a prop using its AI-generated GLB when available (ground-anchored at
   * x,z), else run the fallback geometry builder. Always registers an AABB
   * collider of the given footprint so gameplay collision is model-independent.
   */
  _prop(slug, x, z, w, h, d, makeFallback) {
    const model = this.assets && this.assets.getModel(slug);
    if (model) {
      model.position.set(x, 0, z);
      this.group.add(model);
    } else {
      makeFallback();
    }
    this.colliders.push(
      new THREE.Box3(
        new THREE.Vector3(x - w / 2, 0, z - d / 2),
        new THREE.Vector3(x + w / 2, h, z + d / 2),
      ),
    );
  }

  /** Scatter purely-visual AI props along the street (big ones get colliders). */
  _setDressing(length, halfW, rng) {
    if (!this.assets) return;
    const place = (slug, x, z, ry, footprint) => {
      const m = this.assets.getModel(slug);
      if (!m) return;
      m.position.set(x, 0, z);
      m.rotation.y = ry;
      this.group.add(m);
      if (footprint) {
        const [hw, hd, h] = footprint;
        this.colliders.push(
          new THREE.Box3(
            new THREE.Vector3(x - hw, 0, z - hd),
            new THREE.Vector3(x + hw, h, z + hd),
          ),
        );
      }
    };

    // Phone booth against a wall (cover collider).
    place("prop_phone_booth", -halfW + 0.7, -length * 0.25, Math.PI / 2, [0.5, 0.5, 2.4]);
    // Sandbag barricades as occasional cover.
    for (let i = 0; i < 1 + this.index; i++) {
      const z = -8 - rng() * (length - 16);
      const x = (rng() - 0.5) * (halfW * 1.2);
      place("sandbag_barricade", x, z, rng() * Math.PI, [0.9, 0.55, 1.0]);
    }
    // Small gutter clutter — walk-through decoration (no collider).
    const clutter = ["prop_wheelie_bin", "prop_traffic_cone", "prop_bicycle"];
    for (let i = 0; i < 6 + this.index * 2; i++) {
      const slug = clutter[(rng() * clutter.length) | 0];
      const side = rng() < 0.5 ? -1 : 1;
      const x = side * (halfW - 0.6 - rng() * 0.7);
      const z = -4 - rng() * (length - 10);
      place(slug, x, z, rng() * Math.PI * 2, null);
    }
  }

  /** A shootable/kickable explosive barrel (tracked for the explosion system). */
  _addBarrel(x, z) {
    const w = 0.9, h = 1.2, d = 0.9;
    let root;
    const model = this.assets && this.assets.getModel("barrel_explosive");
    if (model) {
      model.position.set(x, 0, z);
      this.group.add(model);
      root = model;
    } else {
      root = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, h, 12), this._materials.barrel);
      root.position.set(x, h / 2, z);
      this.group.add(root);
    }
    const collider = new THREE.Box3(
      new THREE.Vector3(x - w / 2, 0, z - d / 2),
      new THREE.Vector3(x + w / 2, h, z + d / 2),
    );
    this.colliders.push(collider);
    const hitbox = new THREE.Box3(
      new THREE.Vector3(x - 0.5, 0, z - 0.5),
      new THREE.Vector3(x + 0.5, 1.35, z + 0.5),
    );
    this.barrels.push({ root, hitbox, collider, pos: new THREE.Vector3(x, 0.6, z), exploded: false });
  }

  /** Detonate a barrel: VFX + sound, radial damage to enemies/player, chain. */
  explodeBarrel(barrel, ctx) {
    if (this._disposed || !barrel || barrel.exploded) return;
    barrel.exploded = true;

    // Remove visual + movement collider.
    this.group.remove(barrel.root);
    const ci = this.colliders.indexOf(barrel.collider);
    if (ci >= 0) this.colliders.splice(ci, 1);
    this._activeColliders = null; // invalidate getColliders() cache

    ctx.weapon.explosionFx(barrel.pos);
    ctx.audio.explosion(barrel.pos, ctx.camera.position);
    ctx.score.add(40, "BOOM!");

    const R = 5.0;
    const _v = new THREE.Vector3();
    for (const e of this.enemies) {
      if (e.dead) continue;
      const dist = e.position.distanceTo(barrel.pos);
      if (dist < R) {
        _v.copy(e.position).sub(barrel.pos).setY(0).normalize();
        const falloff = 1 - dist / R;
        e.takeDamage(200 * falloff, _v, 12 * falloff);
      }
    }
    // Splash the player if too close.
    const pd = ctx.player.position.distanceTo(barrel.pos);
    if (pd < R * 0.7) {
      ctx.player.damage(Math.round(35 * (1 - pd / (R * 0.7))));
      ctx.hud.flashDamage();
    }
    // Chain nearby barrels with a small delay.
    for (const other of this.barrels) {
      if (!other.exploded && other.pos.distanceTo(barrel.pos) < R * 0.8) {
        setTimeout(() => this.explodeBarrel(other, ctx), 90);
      }
    }
  }

  _addEnemy(pos, opts = {}) {
    // ALL enemies use the rigged + animated invader; fall back to the static
    // invader GLB, then placeholder geometry.
    if (this.assets) {
      opts = { ...opts, flashTex: this.assets.getSprite("muzzle_flash") };
      const rigged = this.assets.getRiggedEnemy();
      if (rigged) {
        opts.rigged = rigged;
      } else {
        const model = this.assets.getModel("invader");
        if (model) opts.model = model;
      }
    }
    const e = new Enemy(pos, opts);
    this.group.add(e.group);
    this.enemies.push(e);
  }

  _buildCar(x, z) {
    const model = this.assets && this.assets.getModel("prop_car");
    if (model) {
      model.position.set(x, 0, z);
      model.rotation.y = 0; // broadside across the street (roadblock; length runs along X)
      this.group.add(model);
      // Model-independent collider + LOS footprint (cover), matching the broadside footprint.
      const box = new THREE.Box3(
        new THREE.Vector3(x - 2.1, 0, z - 1.0),
        new THREE.Vector3(x + 2.1, 1.5, z + 1.0),
      );
      this.colliders.push(box);
      this.losBlockers.push(box);
    } else {
      // Placeholder: axis-aligned chassis + head-height cabin.
      this._box(2.0, 0.9, 4.2, new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.9 }), x, 0.7, z, { los: true });
      this._box(1.8, 0.7, 2.0, new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 }), x, 1.45, z, { los: true });
    }
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
    this._disposed = true;
    this.scene.remove(this.group);
    // `_materials` may be owned by the AssetManager and reused across levels —
    // only dispose them if THIS level created its own flat-colour fallbacks.
    const shared = new Set(Object.values(this._materials));
    if (!this.assets) shared.forEach((m) => m.dispose());
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
