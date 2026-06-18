import * as THREE from "three";

/** Radius within which the player can press E to rescue. */
const INTERACT_RADIUS = 3.5;
/** Run speed (m/s) the victim flees at after rescue. */
const FLEE_SPEED = 6;
/** Despawn when this far from the player (AND behind/peripheral camera). */
const DESPAWN_DIST = 28;

// Module-scope temps — never allocate on the hot path.
const _tmp = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * Victim
 * ------
 * A rescuable civilian held captive by enemies. The player rescues them by
 * approaching within INTERACT_RADIUS and pressing E.
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
    /** Whether this victim currently owns the interact prompt on the HUD. @private */
    this._promptActive = false;
    /** Whether the victim is currently fleeing after rescue. @private */
    this._fleeing = false;
    /** Flee direction (world XZ, normalised). @private */
    this._fleeDir = new THREE.Vector3();
    /** Set true once the victim has despawned off-screen; Level checks this. */
    this.removed = false;

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
   * Per-frame update. Handles interact prompt, E-press rescue, flee, and despawn.
   * @param {number} dt
   * @param {{ level: object, player: { position: THREE.Vector3, keys: object },
   *           state?: object, score?: object, hud?: object, camera: THREE.Camera }} ctx
   */
  update(dt, ctx) {
    if (this.removed) return;

    // --- Post-rescue: flee and despawn when far + out of view ---------------
    if (this._fleeing) {
      this.group.position.addScaledVector(this._fleeDir, FLEE_SPEED * dt);
      this.group.rotation.y = Math.atan2(this._fleeDir.x, this._fleeDir.z);

      // Play run/walk clip if the victim model has a mixer (defensive guard).
      if (this.mixer && this.actions) {
        const clip = this.actions.run || this.actions.walk;
        if (clip && !clip.isRunning()) { clip.reset(); clip.play(); }
      }

      // Despawn: far AND behind/peripheral camera (dot < 0.25).
      if (this.group.position.distanceToSquared(ctx.player.position) > DESPAWN_DIST * DESPAWN_DIST) {
        ctx.camera.getWorldDirection(_fwd);
        _tmp.copy(this.group.position).sub(ctx.camera.position).normalize();
        if (_fwd.dot(_tmp) < 0.25) {
          if (this._promptActive && ctx.hud) {
            ctx.hud.setInteractPrompt(null);
            this._promptActive = false;
          }
          this.removed = true;
        }
      }
      return;
    }

    // --- Pre-rescue: interact prompt + E-press rescue -----------------------
    const dist = _tmp.copy(ctx.player.position).distanceTo(this.group.position);
    const inRange = dist < INTERACT_RADIUS;

    if (inRange && !this._promptActive) {
      this._promptActive = true;
      if (ctx.hud) ctx.hud.setInteractPrompt("Press E to free the civilian");
    } else if (!inRange && this._promptActive) {
      this._promptActive = false;
      if (ctx.hud) ctx.hud.setInteractPrompt(null);
    }

    if (inRange && ctx.player.keys && ctx.player.keys["KeyE"]) {
      this._rescue(ctx);
    }
  }

  /**
   * Trigger the rescue sequence: rewards, dialogue, begin fleeing.
   * @private
   */
  _rescue(ctx) {
    this.rescued = true;

    // Clear interact prompt.
    if (this._promptActive && ctx.hud) {
      ctx.hud.setInteractPrompt(null);
      this._promptActive = false;
    }

    // Rewards.
    if (ctx.state) {
      if (ctx.state.addCurrency) ctx.state.addCurrency(15);
      if (ctx.state.emit) ctx.state.emit("victimRescued", { position: this.group.position.clone() });
    }
    if (ctx.score) ctx.score.add(500, "CIVILIAN SAVED!");

    // Thanks dialogue (Belfast civilian flavour).
    if (ctx.hud) ctx.hud.showDialogue("Thank you! God bless ye — now get them out of the Falls!");

    // Pick flee direction: away from the player in XZ.
    this._fleeDir.copy(this.group.position).sub(ctx.player.position).setY(0);
    if (this._fleeDir.lengthSq() < 0.0001) this._fleeDir.set(0, 0, -1);
    this._fleeDir.normalize();
    this._fleeing = true;
  }

  /**
   * Remove the victim from the scene and free GPU resources.
   * @param {THREE.Scene} [_scene]  (unused — caller removes from level.group)
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
