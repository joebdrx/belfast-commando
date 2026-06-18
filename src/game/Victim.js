import * as THREE from "three";

/** Radius within which the player can press E to rescue. */
const INTERACT_RADIUS = 3.5;
/** Flee speed (m/s) after rescue. Kept brisk-but-modest: the victim is a static
 *  mesh (the rigged run clip wouldn't bind), so a slower glide reads better. */
const FLEE_SPEED = 3.5;
/** Despawn when this far from the player (AND behind/peripheral camera). */
const DESPAWN_DIST = 24;
/** Hard fallback: despawn after this long fleeing even if cornered/in-view. */
const FLEE_TIMEOUT = 9;
/** Collision half-width used against level colliders while fleeing. */
const RADIUS = 0.4;

// Module-scope temps — never allocate on the hot path.
const _tmp = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * Victim
 * ------
 * A rescuable civilian held captive by enemies. The player rescues them by
 * approaching within INTERACT_RADIUS and pressing E; she thanks the player and
 * flees away (static model — the rigged victim's run clip never bound to its
 * skeleton, so it stayed frozen/"broken"), colliding with buildings + the
 * boundary walls (so she stays in the map and never phases through geometry),
 * then despawns once she is far and out of the player's view.
 *
 * IMPORTANT: Victims are stored in `level.victims`, never in `level.enemies`.
 * The weapon raycast and kick loop only iterate `level.enemies`, so victims are
 * inherently immune to player fire — no `takeDamage` method exists here.
 */
export class Victim {
  /**
   * @param {THREE.Vector3} position  World-space spawn position (y=0).
   * @param {{ rig?: {object3D:THREE.Object3D, clips:object}, model?: THREE.Object3D }} [opts]
   */
  constructor(position, opts = {}) {
    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.group.rotation.y = Math.random() * Math.PI * 2; // varied facing

    this.rescued = false;
    this.removed = false;
    this._promptActive = false;
    this._fleeing = false;
    this._fleeTime = 0;
    this._fleeDir = new THREE.Vector3();

    // Animation (rigged victim) state.
    this.mixer = null;
    this.actions = null;
    this._anim = null;

    if (opts.rig) {
      this.group.add(opts.rig.object3D);
      this.mixer = new THREE.AnimationMixer(opts.rig.object3D);
      this.actions = {};
      for (const [name, clip] of Object.entries(opts.rig.clips || {})) {
        this.actions[name] = this.mixer.clipAction(clip);
      }
      this._setAnim("walk"); // gentle idle-ish motion while captive (no T-pose)
    } else if (opts.model) {
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

  /** Crossfade to a named clip (walk/run); falls back to whatever exists. */
  _setAnim(name) {
    if (!this.actions || this._anim === name) return;
    const next = this.actions[name] || this.actions.walk || this.actions.run;
    if (!next) return;
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.fadeIn(0.2);
    next.play();
    if (this._anim && this.actions[this._anim] && this.actions[this._anim] !== next) {
      this.actions[this._anim].fadeOut(0.2);
    }
    this._anim = name;
  }

  /** True if a horizontal point would intersect a (non-flat) level collider. */
  _blocked(ctx, x, z) {
    const cols = ctx.level && ctx.level.getColliders ? ctx.level.getColliders() : null;
    if (!cols) return false;
    for (const b of cols) {
      if (b.max.y < 0.2) continue; // flat ground slabs — ignore
      if (x > b.min.x - RADIUS && x < b.max.x + RADIUS && z > b.min.z - RADIUS && z < b.max.z + RADIUS) {
        return true;
      }
    }
    return false;
  }

  /**
   * Per-frame update: animation, interact prompt, E-press rescue, then flee +
   * collide + despawn.
   * @param {number} dt
   * @param {object} ctx { level, player:{position,keys}, state?, score?, hud?, camera }
   */
  update(dt, ctx) {
    if (this.removed) return;
    if (this.mixer) this.mixer.update(dt);

    // --- Post-rescue: RUN away, colliding with buildings + boundary walls. ---
    if (this._fleeing) {
      this._setAnim("run");
      this._fleeTime += dt;
      const p = this.group.position;
      const sx = this._fleeDir.x * FLEE_SPEED * dt;
      const sz = this._fleeDir.z * FLEE_SPEED * dt;
      const px = p.x, pz = p.z;
      p.x += sx; if (this._blocked(ctx, p.x, p.z)) p.x = px; // resolve X
      p.z += sz; if (this._blocked(ctx, p.x, p.z)) p.z = pz; // resolve Z
      if (p.x === px && p.z === pz) {
        // Fully blocked (corner) — turn 90° and try to slide along next frame.
        const a = Math.atan2(this._fleeDir.x, this._fleeDir.z) + Math.PI / 2;
        this._fleeDir.set(Math.sin(a), 0, Math.cos(a));
      } else {
        this.group.rotation.y = Math.atan2(this._fleeDir.x, this._fleeDir.z);
      }

      // Despawn: far + behind/peripheral camera, OR after a hard timeout.
      let gone = this._fleeTime > FLEE_TIMEOUT;
      if (!gone && p.distanceToSquared(ctx.player.position) > DESPAWN_DIST * DESPAWN_DIST) {
        ctx.camera.getWorldDirection(_fwd);
        _tmp.copy(p).sub(ctx.camera.position).normalize();
        if (_fwd.dot(_tmp) < 0.25) gone = true;
      }
      if (gone) {
        if (this._promptActive && ctx.hud) { ctx.hud.setInteractPrompt(null); this._promptActive = false; }
        this.removed = true;
      }
      return;
    }

    // --- Pre-rescue: interact prompt + E-press rescue. ----------------------
    const dist = _tmp.copy(ctx.player.position).distanceTo(this.group.position);
    const inRange = dist < INTERACT_RADIUS;
    if (inRange && !this._promptActive) {
      this._promptActive = true;
      if (ctx.hud) ctx.hud.setInteractPrompt("Press E to free the civilian");
    } else if (!inRange && this._promptActive) {
      this._promptActive = false;
      if (ctx.hud) ctx.hud.setInteractPrompt(null);
    }
    if (inRange && ctx.player.keys && ctx.player.keys["KeyE"]) this._rescue(ctx);
  }

  /** Trigger the rescue: rewards, dialogue, begin fleeing. @private */
  _rescue(ctx) {
    this.rescued = true;
    if (this._promptActive && ctx.hud) { ctx.hud.setInteractPrompt(null); this._promptActive = false; }
    if (ctx.state) {
      if (ctx.state.addCurrency) ctx.state.addCurrency(15);
      if (ctx.state.emit) ctx.state.emit("victimRescued", { position: this.group.position.clone() });
    }
    if (ctx.score) ctx.score.add(500, "CIVILIAN SAVED!");
    if (ctx.hud) ctx.hud.showDialogue("Thank you! God bless ye — now get them out of the Falls!");
    this._fleeDir.copy(this.group.position).sub(ctx.player.position).setY(0);
    if (this._fleeDir.lengthSq() < 0.0001) this._fleeDir.set(0, 0, -1);
    this._fleeDir.normalize();
    this._fleeing = true;
    this._fleeTime = 0;
  }

  /** Remove the victim's GPU resources. @param {THREE.Scene} [_scene] */
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
