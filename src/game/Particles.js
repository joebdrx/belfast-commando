import * as THREE from "three";

// One scratch vector reused for all velocity maths — NEVER `new` inside a loop
// that runs per-frame (update) or per-burst (emit). 60 FPS demands zero churn.
const _vel = new THREE.Vector3();

// Pooled mesh count. ~120 covers a couple of overlapping explosions (20 each)
// plus a scatter of blood/sparks without ever growing the pool at runtime.
const POOL_SIZE = 120;

// Downward acceleration (m/s²) applied to particle types flagged `gravity`.
const GRAVITY = 11;

/**
 * Per-type burst recipe. `count` particles are spawned per emit, coloured and
 * launched per these numbers. `up` biases the random launch direction upward;
 * `gravity` pulls them back down; `shrink` scales them toward zero over life.
 * Keys are the contract's documented set: "kick"|"explosion"|"blood"|"spark".
 */
const TYPES = {
  kick: { count: 10, color: 0xffd27f, speed: 4.0, up: 1.4, life: 0.42, gravity: true, shrink: false, scale: 1.0 },
  explosion: { count: 20, color: 0xffaa44, speed: 8.5, up: 1.6, life: 0.55, gravity: true, shrink: true, scale: 1.3 },
  blood: { count: 18, color: 0x7a0d0d, speed: 4.6, up: 1.25, life: 0.55, gravity: true, shrink: false, scale: 0.95 },
  spark: { count: 6, color: 0xffee66, speed: 6.0, up: 0.7, life: 0.32, gravity: false, shrink: true, scale: 0.8 },
};

/**
 * Particles
 * ---------
 * A fixed-size pool of small billboard-free debris meshes for impact bursts
 * (kick dust, explosion sparks, blood, ricochet sparks). Preallocates every
 * mesh + material up front and recycles them round-robin, so `emit` and
 * `update` allocate NOTHING on the hot path (only the shared scratch `_vel` is
 * mutated in place). Mirrors Weapon.js's effect-pooling discipline.
 *
 * Owned + composed by Juice (CONTRACTS.md §6). Juice forwards `emit`/`update`/
 * `dispose`; the orchestrator never touches this directly.
 */
export class Particles {
  /** @param {THREE.Scene} scene scene to attach the (hidden) particle group to */
  constructor(scene) {
    this.scene = scene;

    // One tiny shared geometry for every particle — a spiky tetra reads well as
    // both a spark and a debris chip. Disposed once in dispose().
    this._geo = new THREE.TetrahedronGeometry(0.06);

    // Group keeps the 120 meshes off the scene's top-level child list and lets
    // us add/remove the whole pool in one call.
    this.group = new THREE.Group();
    this.group.name = "particlePool";
    this.scene.add(this.group);

    // Pool of particle records. Each holds its own mesh + material (so colour /
    // opacity are independent) and a persistent velocity vector reused across
    // its whole lifetime — these objects are created ONCE, here, never in emit.
    this.pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        fog: false,
      });
      const mesh = new THREE.Mesh(this._geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false; // bursts are brief + camera-local; skip the cull cost
      this.group.add(mesh);
      this.pool.push({
        mesh,
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        active: false,
        gravity: false,
        shrink: false,
        baseScale: 1,
      });
    }

    // Round-robin cursor: activating walks forward through the pool, so when the
    // pool is exhausted we naturally overwrite the OLDEST-spawned particle.
    this._cursor = 0;
  }

  /**
   * Spawn a burst of `type` at `position`. Reuses pooled meshes (recycling the
   * oldest active when full). No allocation: only mutates pooled records and the
   * shared scratch vector.
   * @param {THREE.Vector3} position world-space burst origin
   * @param {"kick"|"explosion"|"blood"|"spark"} type
   */
  emit(position, type) {
    const cfg = TYPES[type];
    if (!cfg || !position) return;

    for (let i = 0; i < cfg.count; i++) {
      const p = this.pool[this._cursor];
      this._cursor = (this._cursor + 1) % POOL_SIZE;

      // Random launch direction with an upward bias, scaled to a per-particle
      // speed. normalize() + multiplyScalar() both mutate in place (no `new`).
      _vel.set(
        Math.random() * 2 - 1,
        Math.random() * cfg.up + 0.15,
        Math.random() * 2 - 1,
      );
      _vel.normalize().multiplyScalar(cfg.speed * (0.6 + Math.random() * 0.6));
      p.vel.copy(_vel);

      p.life = cfg.life * (0.8 + Math.random() * 0.4);
      p.maxLife = p.life;
      p.gravity = cfg.gravity;
      p.shrink = cfg.shrink;
      p.baseScale = cfg.scale;
      p.active = true;

      p.mesh.position.copy(position);
      p.mesh.scale.setScalar(cfg.scale);
      p.mesh.material.color.setHex(cfg.color);
      p.mesh.material.opacity = 1;
      p.mesh.visible = true;
    }
  }

  /**
   * Advance all active particles. Integrates velocity (+ gravity), fades opacity
   * by remaining life, optionally shrinks, and retires dead particles back to the
   * pool. Strictly allocation-free — mutates pooled records in place.
   * @param {number} dt seconds since last frame
   */
  update(dt) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const p = this.pool[i];
      if (!p.active) continue;

      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }

      if (p.gravity) p.vel.y -= GRAVITY * dt;
      p.mesh.position.addScaledVector(p.vel, dt);

      const t = p.life / p.maxLife; // 1 → 0 over lifetime
      p.mesh.material.opacity = t;
      if (p.shrink) p.mesh.scale.setScalar(Math.max(0.05, t) * p.baseScale);
    }
  }

  /** Hide every particle (e.g. on level reset) without disposing the pool. */
  clear() {
    for (let i = 0; i < POOL_SIZE; i++) {
      this.pool[i].active = false;
      this.pool[i].mesh.visible = false;
    }
  }

  /** Tear down: remove the group, dispose the shared geometry + every material. */
  dispose() {
    if (this.group && this.scene) this.scene.remove(this.group);
    for (let i = 0; i < this.pool.length; i++) {
      const m = this.pool[i].mesh.material;
      if (m) m.dispose();
    }
    if (this._geo) this._geo.dispose();
    this.pool.length = 0;
  }
}
