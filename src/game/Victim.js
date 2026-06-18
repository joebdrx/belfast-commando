import * as THREE from "three";

/** Radius within which live enemies suppress rescue. */
const RESCUE_RADIUS = 10;
/** Radius within which the player must approach before rescue can trigger. */
const PLAYER_SEEN_RADIUS = 18;

// Module-scope temp vector so update() never allocates on the hot path.
const _tmp = new THREE.Vector3();

/**
 * Victim
 * ------
 * A rescuable civilian held captive by enemies. The player rescues them by
 * clearing all nearby enemies and then approaching within PLAYER_SEEN_RADIUS.
 *
 * IMPORTANT: Victims are stored in `level.victims`, never in `level.enemies`.
 * The weapon raycast and kick loop only iterate `level.enemies`, so victims
 * are inherently immune to player fire — no `takeDamage` method exists here.
 */
export class Victim {
  /**
   * @param {THREE.Vector3} position  World-space spawn position (y=0).
   * @param {{ model?: THREE.Object3D }} [opts]
   */
  constructor(position, opts = {}) {
    this.group = new THREE.Group();
    this.group.position.copy(position);
    // Slight random yaw so victims face varied directions.
    this.group.rotation.y = Math.random() * Math.PI * 2;

    this.rescued = false;
    /** @private — whether the player has come close enough to enable rescue. */
    this._seen = false;

    if (opts.model) {
      this.group.add(opts.model);
    } else {
      // Fallback: visible capsule so the victim shows without the GLB.
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.28, 1.0, 4, 8),
        new THREE.MeshStandardMaterial({ color: 0xe8c87a, roughness: 0.85, metalness: 0 }),
      );
      body.position.y = 0.78;
      this.group.add(body);
    }
  }

  /** World-space position (delegates to group). */
  get position() {
    return this.group.position;
  }

  /**
   * Per-frame update. Checks rescue conditions; awards reward once.
   * @param {number} dt
   * @param {{ level: { enemies: Array }, player: { position: THREE.Vector3 }, state?: object, score?: object }} ctx
   */
  update(dt, ctx) {
    if (this.rescued) return;

    // Track whether the player has come close enough to "see" this victim.
    if (!this._seen) {
      _tmp.copy(ctx.player.position);
      if (_tmp.distanceTo(this.group.position) < PLAYER_SEEN_RADIUS) {
        this._seen = true;
      }
    }

    if (!this._seen) return; // not yet approached — can't be auto-rescued at spawn

    // Count live enemies within rescue radius.
    let nearbyLive = 0;
    for (const e of ctx.level.enemies) {
      if (e.dead) continue;
      _tmp.copy(e.position);
      if (_tmp.distanceTo(this.group.position) < RESCUE_RADIUS) {
        nearbyLive++;
      }
    }

    if (nearbyLive > 0) return; // captors still present

    // --- Rescue! -----------------------------------------------------------
    this.rescued = true;

    if (ctx.state) ctx.state.addCurrency && ctx.state.addCurrency(15);
    if (ctx.score) ctx.score.add(500, "CIVILIAN SAVED!");
    if (ctx.state) ctx.state.emit && ctx.state.emit("victimRescued", { position: this.group.position.clone() });

    // Lift and turn the model slightly to signal "freed" (no per-frame alloc).
    this.group.position.y += 0.05;
    this.group.rotation.y += Math.PI * 0.25;
  }

  /**
   * Remove the victim from the scene and free GPU resources.
   * @param {THREE.Scene} scene  (unused — caller already removed from scene via
   *   level.group; kept for symmetry with other disposable objects)
   */
  dispose(_scene) {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m && m.dispose) m.dispose();
      }
    });
  }
}
