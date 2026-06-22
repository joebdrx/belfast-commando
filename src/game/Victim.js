import * as THREE from "three";

/** Radius within which the player can press E to rescue. */
const INTERACT_RADIUS = 3.5;
/** Flee speed (m/s) after rescue. Brisk run to match the rigged run animation
 *  (the new Meshy victim binds its run clip, so she sprints rather than glides). */
const FLEE_SPEED = 4.2;
/** Pre-rescue panic speed (m/s): a scared backpedal away from a menacing captor,
 *  deliberately slower than the post-rescue sprint so captors can close in. */
const FLEE_SCARED = 3.0;
/** How far a captive may flee from where they're held before the captors herd them
 *  back. Keeps the hostage inside the captors' ring (so they can't escape outright
 *  and the urgency holds) while still visibly fleeing/circling = "run away & hide". */
const FLEE_TETHER = 5.0;
/** Despawn when this far from the player (AND behind/peripheral camera). */
const DESPAWN_DIST = 24;
/** Hard fallback: despawn after this long fleeing even if cornered/in-view. */
const FLEE_TIMEOUT = 9;
/** Collision half-width used against level colliders while fleeing. */
const RADIUS = 0.4;
/**
 * Civilian harm comes ONLY from a captor's taunt-strike (EnemyBehavior.menaceVictim
 * → takeMenaceHit). The player can NEVER damage a civilian — victims live in
 * `level.victims`, never `level.enemies`, so weapon fire / kick / barrels (which all
 * iterate `level.enemies`) cannot touch them, and there is no `takeDamage` here.
 * Each landed hit shoves the civilian back; a short refractory window stops two
 * captors double-striking on the same beat.
 */
const KNOCK_IMPULSE = 4.0; // m/s backward shove per landed hit (decays)
// Minimum time between ANY two landed hits on one civilian — this is the real rate
// limiter: even with two flanking captors, a civilian can only be struck this often,
// so wearing one down is slow (≈20-40s) and the player has time to intervene.
const MENACE_MIN_GAP = 1.5;

// Module-scope temps — never allocate on the hot path.
const _tmp = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * Victim
 * ------
 * A rescuable civilian held captive by enemies. The player rescues them by
 * approaching within INTERACT_RADIUS and pressing E; she thanks the player and
 * flees away (rigged + animated — walk while captive, run on flee), colliding
 * with buildings + the boundary walls (so she stays in the map and never phases
 * through geometry), then despawns once she is far and out of the player's view.
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
    this._anchor = new THREE.Vector3().copy(position); // captivity spot; flee is tethered to it
    this._scream = null; // looping distress-scream controller while captive

    // Civilian life — stepped down by discrete captor taunt-strikes (takeMenaceHit),
    // NOT a continuous drain. At 0 the civilian dies (lost, no penalty) and topples.
    this.maxLife = 100;
    this.life = 100;
    this.dead = false;
    // Short countdown refreshed each frame by an active captor (menaceVictim);
    // > 0 means "currently being menaced". A timer (vs a per-frame flag) survives
    // the enemies→victims update order so the HUD/locator can read it afterward,
    // and it drives the pre-rescue flee (run away from `_threatPos`).
    this._menacedTimer = 0;
    this._threatPos = new THREE.Vector3(); // last menacing captor's position (flee away from it)
    this._knock = new THREE.Vector3(); // decaying knockback impulse from a landed hit
    this._hitGap = 0; // refractory timer so two captors can't double-strike on one beat
    // Death topple (the rig has only walk/run clips — no death clip), mirrors Enemy.
    this._toppleAxis = new THREE.Vector3(1, 0, 0);
    this._toppleAmt = 0;

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

    // --- Dead: topple to the ground and rest there (no death clip in the rig). ---
    if (this.dead) { this._updateDeath(dt); return; }

    if (this.mixer) this.mixer.update(dt);

    // --- Post-rescue: RUN to safety, colliding with buildings + boundary walls. ---
    if (this._fleeing) {
      this._setAnim("run");
      this._fleeTime += dt;
      const blocked = this._moveAvoiding(ctx, this._fleeDir.x * FLEE_SPEED, this._fleeDir.z * FLEE_SPEED, dt);
      if (blocked) {
        // Fully blocked (corner) — turn 90° and try to slide along next frame.
        const a = Math.atan2(this._fleeDir.x, this._fleeDir.z) + Math.PI / 2;
        this._fleeDir.set(Math.sin(a), 0, Math.cos(a));
      } else {
        this.group.rotation.y = Math.atan2(this._fleeDir.x, this._fleeDir.z);
      }

      // Despawn: far + behind/peripheral camera, OR after a hard timeout.
      const p = this.group.position;
      let gone = this._fleeTime > FLEE_TIMEOUT;
      if (!gone && p.distanceToSquared(ctx.player.position) > DESPAWN_DIST * DESPAWN_DIST) {
        ctx.camera.getWorldDirection(_fwd);
        _tmp.copy(p).sub(ctx.camera.position).normalize();
        if (_fwd.dot(_tmp) < 0.25) gone = true;
      }
      if (gone) {
        if (this._promptActive && ctx.hud) {
          ctx.hud.setInteractPrompt(null);
          ctx.hud.setInteractCallback(null);
          this._promptActive = false;
        }
        this.removed = true;
      }
      return;
    }

    // --- Pre-rescue: captive. Loop her distress scream, attenuated by distance
    // (starts as soon as the sample is decoded; retried each frame until ready). --
    if (ctx.audio) {
      if (!this._scream && ctx.audio.startLoop) {
        this._scream = ctx.audio.startLoop("victim_scream", { gain: 0.001 });
      }
      if (this._scream) {
        const d = this.group.position.distanceTo(ctx.player.position);
        this._scream.setVolume(Math.max(0.06, Math.min(0.7, 10 / (d + 6))));
      }
    }

    // --- Timers: the menace signal (refreshed each frame by a live captor in
    // EnemyBehavior.menaceVictim) + the landed-hit refractory window. -----------
    this._menacedTimer = Math.max(0, this._menacedTimer - dt);
    this._hitGap = Math.max(0, this._hitGap - dt);

    const playerDist = _tmp.copy(ctx.player.position).distanceTo(this.group.position);
    // The player is the rescuer, not a threat: once they're close the civilian
    // stops fleeing and waits to be freed (this also guarantees rescuability).
    const safeWithPlayer = playerDist < INTERACT_RADIUS;
    const threatened = this._menacedTimer > 0 && !safeWithPlayer;

    // --- Knockback: a landed hit shoves the civilian back (collision-clamped). ---
    if (this._knock.lengthSq() > 1e-4) {
      this._moveAvoiding(ctx, this._knock.x, this._knock.z, dt);
      this._knock.multiplyScalar(Math.max(0, 1 - dt * 6));
      if (this._knock.lengthSq() < 1e-4) this._knock.set(0, 0, 0);
    }

    // --- Pre-rescue: flee + HIDE from the menacing captor (run away from it,
    // ducking around buildings via the collision-aware slide). ------------------
    if (threatened) {
      this._fleeDir.copy(this.group.position).sub(this._threatPos).setY(0);
      if (this._fleeDir.lengthSq() < 1e-4) {
        this._fleeDir.set(Math.sin(this.group.rotation.y), 0, Math.cos(this.group.rotation.y));
      }
      this._fleeDir.normalize();
      // Tether: once near the edge of the pen, bias back toward the anchor so the
      // captive circles/cowers within the captors' ring instead of escaping.
      _tmp.copy(this.group.position).sub(this._anchor).setY(0);
      if (_tmp.length() > FLEE_TETHER) {
        this._fleeDir.addScaledVector(_tmp.normalize(), -1.4);
        if (this._fleeDir.lengthSq() < 1e-4) this._fleeDir.copy(_tmp).multiplyScalar(-1);
        this._fleeDir.normalize();
      }
      const blocked = this._moveAvoiding(ctx, this._fleeDir.x * FLEE_SCARED, this._fleeDir.z * FLEE_SCARED, dt);
      if (blocked) {
        const a = Math.atan2(this._fleeDir.x, this._fleeDir.z) + Math.PI / 2;
        this._fleeDir.set(Math.sin(a), 0, Math.cos(a)); // slide along the wall = hide
      } else {
        this.group.rotation.y = Math.atan2(this._fleeDir.x, this._fleeDir.z);
      }
      this._setAnim("run");
      if (this._promptActive && ctx.hud) {
        ctx.hud.setInteractPrompt(null);
        ctx.hud.setInteractCallback(null);
        this._promptActive = false;
      }
      return;
    }

    // --- Calm (no active captor, or the player is right here): offer rescue. ----
    this._setAnim("walk");
    const inRange = playerDist < INTERACT_RADIUS;
    if (inRange && !this._promptActive) {
      this._promptActive = true;
      if (ctx.hud) {
        ctx.hud.setInteractPrompt("Press E / tap to free the civilian");
        ctx.hud.setInteractCallback(() => this._rescue(ctx));
      }
    } else if (!inRange && this._promptActive) {
      this._promptActive = false;
      if (ctx.hud) {
        ctx.hud.setInteractPrompt(null);
        ctx.hud.setInteractCallback(null);
      }
    }
    if (inRange && ctx.player.keys && ctx.player.keys["KeyE"]) this._rescue(ctx);
  }

  /**
   * Move by a velocity (vx,vz m/s) for `dt`, reverting any axis that would enter a
   * collider (per-axis slide). Returns true if FULLY blocked, so the caller can turn
   * to slide/hide along the wall. Shared by post-rescue flee, pre-rescue flee, and
   * knockback. @private
   */
  _moveAvoiding(ctx, vx, vz, dt) {
    const p = this.group.position;
    const px = p.x, pz = p.z;
    p.x += vx * dt; if (this._blocked(ctx, p.x, p.z)) p.x = px;
    p.z += vz * dt; if (this._blocked(ctx, p.x, p.z)) p.z = pz;
    return p.x === px && p.z === pz;
  }

  /**
   * Take a discrete hit from a menacing captor — the ONLY way a civilian is harmed
   * (the player can never damage them). Applies damage + a backward knockback shove
   * away from the captor; a refractory window (MENACE_MIN_GAP) stops two captors
   * striking on the same beat. At 0 life the civilian dies (lost, no penalty).
   * @param {number} dmg
   * @param {THREE.Vector3} fromPos  the captor's position (shove direction = away)
   * @param {object} [ctx]           passed through to _die for emit/HUD cleanup
   */
  takeMenaceHit(dmg, fromPos, ctx) {
    if (this.rescued || this.dead || this._hitGap > 0) return;
    this._hitGap = MENACE_MIN_GAP;
    this.life -= dmg;
    _tmp.copy(this.group.position).sub(fromPos).setY(0);
    if (_tmp.lengthSq() < 1e-4) {
      _tmp.set(Math.sin(this.group.rotation.y), 0, Math.cos(this.group.rotation.y));
    }
    _tmp.normalize();
    this._knock.addScaledVector(_tmp, KNOCK_IMPULSE);
    if (this.life <= 0) this._die(ctx);
  }

  /**
   * Death topple: lay the corpse flat over ~0.5s, then rest. The body is NEVER
   * removed (so the sector shows the civilian lying where they fell); the mixer is
   * left frozen on its last pose. @private
   */
  _updateDeath(dt) {
    if (this._toppleAmt < Math.PI / 2) {
      this._toppleAmt = Math.min(Math.PI / 2, this._toppleAmt + dt * 6);
      this.group.setRotationFromAxisAngle(this._toppleAxis, this._toppleAmt);
    }
    if (this.group.position.y < 0) this.group.position.y = 0;
  }

  /** Civilian killed by their captors (life depleted). Lost, no penalty — forfeits
   *  the rescue bonus. The body is NOT removed: it topples and stays lying on the
   *  ground for the rest of the sector (death animation via _updateDeath). @private */
  _die(ctx) {
    if (this.dead || this.rescued) return;
    this.dead = true;
    this.life = 0;
    this._stopScream();
    if (this._promptActive && ctx && ctx.hud) {
      ctx.hud.setInteractPrompt(null);
      ctx.hud.setInteractCallback(null);
      this._promptActive = false;
    }
    if (ctx && ctx.state && ctx.state.emit) {
      ctx.state.emit("victimDied", { position: this.group.position.clone() });
    }
    // Begin the death topple ⊥ to the civilian's facing (rig has no death clip).
    // NOT removed → Level.update keeps the corpse in the scene; victimsRemaining /
    // victimLifeTotal already exclude `dead`, so the HUD + locator update correctly.
    const ry = this.group.rotation.y;
    this._toppleAxis.set(-Math.cos(ry), 0, Math.sin(ry));
    this._toppleAmt = 0;
  }

  /** Stop the looping distress scream if it's playing. @private */
  _stopScream() {
    if (this._scream) { this._scream.stop(); this._scream = null; }
  }

  /** Trigger the rescue: rewards, dialogue, begin fleeing. @private */
  _rescue(ctx) {
    if (this.rescued || this.dead) return;
    this.rescued = true;
    if (ctx.hud) ctx.hud.setInteractCallback(null);
    this._stopScream(); // she's safe now — the screaming stops
    if (ctx.audio && ctx.audio.rescueJingle) ctx.audio.rescueJingle();
    // A spoken dialogue line (voice bus) so there's an audible "guy talking" beat
    // the player can actually make out — slightly delayed so it follows the jingle.
    if (ctx.audio && ctx.audio.dialogueVO) setTimeout(() => ctx.audio.dialogueVO(), 650);
    if (this._promptActive && ctx.hud) { ctx.hud.setInteractPrompt(null); this._promptActive = false; }
    if (ctx.state) {
      if (ctx.state.addCurrency) ctx.state.addCurrency(15);
      if (ctx.state.bumpStat) ctx.state.bumpStat("civiliansSaved"); // feeds end-of-sector £
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
    this._stopScream(); // never leave a captive scream looping after teardown
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m && m.dispose) m.dispose();
      }
    });
  }
}
