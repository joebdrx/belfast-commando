import * as THREE from "three";
import * as EnemyBehavior from "./EnemyBehavior.js";
import ENEMY_TYPES from "../data/enemies.json";

const ENEMY_BY_ID = Object.fromEntries(ENEMY_TYPES.map((e) => [e.id, e]));

const _toPlayer = new THREE.Vector3();
const _flat = new THREE.Vector3();
const _tangent = new THREE.Vector3();

/**
 * Enemy
 * -----
 * A placeholder low-poly soldier (red capsule + head). Lightweight AI:
 *  - stands/patrols, turns to face the player when in sight
 *  - charges in and swings a blade on a melee cooldown (no ranged fire)
 *  - reacts to bullet damage (flinch + knockback) and kicks (big knockback)
 *  - "ragdolls" on death by toppling over, then is scored.
 */
export class Enemy {
  /**
   * @param {THREE.Vector3} position
   * @param {object} opts { patrol?: THREE.Vector3[] }
   */
  constructor(position, opts = {}) {
    this.health = 100;
    this.alive = true;
    this.dead = false;
    this.scored = false; // consumed by the game loop for scoring

    // Melee attacker: no ranged fire — they charge in and swing on a cooldown.
    this.meleeRange = 1.7;
    this.meleeCooldown = 1.0;
    this.meleeTimer = 0.5 + Math.random() * 0.8;
    this.sightRange = 42;
    this.damage = 9; // a swing hurts — keep moving or get swarmed

    // --- Archetype config (data-driven; defaults to "grunt" baseline) -------
    const arch = ENEMY_BY_ID[opts.archetype] || ENEMY_BY_ID.grunt;
    this.archetype = arch.id;
    this.archetypeCfg = arch;
    this.attack = arch.attack || "melee";
    this.knockbackImmune = !!arch.knockbackImmune;
    this.animFps = arch.animFps || 11;
    this._animAccum = 0;
    this._pendingDetonate = false;
    this._guardingVictim = null; // set by Level._spawnVictims on captor enemies
    this._alerted = false;       // woken by player proximity or taking damage
    this.health = arch.health;
    this.sightRange = arch.sightRange;
    this.meleeRange = arch.meleeRange;
    this.damage = arch.meleeDamage;
    this.speed = arch.speed || 1.8;
    this.runSpeed = arch.runSpeed || 5.4;

    // Patrol / chase
    this.patrol = opts.patrol || null;
    this.patrolIndex = 0;
    this._strafeDir = Math.random() < 0.5 ? -1 : 1; // circles the player in melee
    this._lunge = 0; // forward jab offset, eases back to rest
    this._rigRoot = null; // the visual model, lunged on each strike

    // Skeletal animation (rigged enemies)
    this.mixer = null;
    this.actions = null;
    this._anim = null;
    this._attacking = false;     // attack clip playing as a one-shot (suppresses locomotion anim)
    this._attackAction = null;   // the LoopOnce melee-swing action, if a clip was provided
    this._onAttackFinished = null;

    // Knockback velocity (decays each frame)
    this.knock = new THREE.Vector3();
    // Death topple animation state
    this._toppleAxis = new THREE.Vector3(1, 0, 0);
    this._toppleAmt = 0;

    this.group = new THREE.Group();
    this.group.position.copy(position);

    // Prefer the rigged + animated invader; then a static GLB; then placeholder.
    // `_bodyMat` drives the hit-flash and only exists for the placeholder.
    this._bodyMat = null;
    if (opts.rigged) {
      this.group.add(opts.rigged.object3D);
      this._rigRoot = opts.rigged.object3D;
      this.mixer = new THREE.AnimationMixer(opts.rigged.object3D);
      this.actions = {};
      for (const [name, clip] of Object.entries(opts.rigged.clips)) {
        this.actions[name] = this.mixer.clipAction(clip);
      }
      // The melee attack is a ONE-SHOT (not a looping locomotion clip): play it
      // once on a swing, clamp on the last frame, then resume walk/run/idle.
      if (this.actions.attack) {
        this._attackAction = this.actions.attack;
        this._attackAction.setLoop(THREE.LoopOnce, 1);
        this._attackAction.clampWhenFinished = true;
        // "Double_Combo_Attack" is ~3s; speed it up so a swing reads as a quick jab.
        this._attackAction.setEffectiveTimeScale(1.6);
        this._onAttackFinished = (e) => {
          if (e.action !== this._attackAction) return;
          this._attacking = false;
          this._attackAction.fadeOut(0.15);
          this._anim = null; // force the next update() to re-apply locomotion
        };
        this.mixer.addEventListener("finished", this._onAttackFinished);
      }
      this._setAnim("idle");
    } else if (opts.model) {
      this.group.add(opts.model);
      this._rigRoot = opts.model;
    } else {
      const bodyMat = new THREE.MeshStandardMaterial({
        color: 0xc0392b,
        roughness: 0.7,
        metalness: 0.05,
      });
      this._bodyMat = bodyMat;

      // Body (capsule)
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.9, 4, 8), bodyMat);
      body.position.y = 0.95;
      this.group.add(body);

      // Head
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xe2b07a, roughness: 0.8 }),
      );
      head.position.y = 1.7;
      this.group.add(head);

      // A little "rifle" so it reads as a soldier
      const gun = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.08, 0.7),
        new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5 }),
      );
      gun.position.set(0.25, 1.1, 0.35);
      this.group.add(gun);
    }

    // No muzzle flash — every enemy is melee now (no ranged fire).
    this._hitFlash = 0;

    // Collider half-extents for the player's bullet raycasts & body block
    this.radius = 0.45;
    this.height = 1.9;
    if (arch.scale && arch.scale !== 1) {
      this.group.scale.setScalar(arch.scale);
      this.radius *= arch.scale;
      this.height *= arch.scale;
    }

    // Per-archetype colour tint so the types read at a glance: gunner steel-blue,
    // breacher volatile-orange, enforcer dark-iron (also big), grunt rusty. The
    // rigged model materials are shared across enemy clones, so clone each
    // material before tinting (otherwise one enemy's tint bleeds onto all).
    if (arch.tint) {
      const tint = new THREE.Color(arch.tint);
      this.group.traverse((o) => {
        if (!o.material) return;
        const tintMat = (m) => {
          const c = m.clone();
          if (c.color) c.color.copy(tint);
          if (m === this._bodyMat) this._bodyMat = c; // keep hit-flash on the live material
          return c;
        };
        o.material = Array.isArray(o.material) ? o.material.map(tintMat) : tintMat(o.material);
      });
    }

    // Held weapon (a blade for every archetype now) — parented to the visual
    // root so it rides the body and the melee lunge.
    this._weapon = null;
    if (opts.weapon) this._attachWeapon(opts.weapon);
  }

  /**
   * Attach a held weapon to the RIGHT-HAND bone so it rides the skeleton through
   * walk / run / attack (instead of being pinned to the body root at a fixed
   * offset). The hand bone has a tiny world scale (~0.011, from the Armature's
   * 0.01 scale × the wrap), so a naive `hand.add()` would shrink the weapon ~90x.
   * We compensate with the same world→local matrix technique as
   * AssetManager._attachFace(): build the weapon's desired WORLD transform (hand
   * position + a small grip offset, oriented forward, at the weapon's real-world
   * scale) and express it in the bone's local space.
   *
   * Falls back to the old body-root fixed offset if there is no rig / no hand
   * bone, so static-fallback enemies keep working.
   * @param {{ object3D: THREE.Object3D, kind: "pistol"|"blade" }} weapon
   */
  _attachWeapon(weapon) {
    const mount = weapon.object3D;
    const isBlade = weapon.kind === "blade";

    // Real-world size + current scale. The weapon is unparented here, so its
    // world transform equals its local one.
    mount.updateWorldMatrix(true, false);
    const size = new THREE.Box3().setFromObject(mount).getSize(new THREE.Vector3());
    const worldScale = mount.getWorldScale(new THREE.Vector3());

    // Find the right-hand bone beneath the cloned skeleton.
    let hand = null;
    if (this._rigRoot) {
      this._rigRoot.traverse((o) => { if (o.isBone && o.name === "RightHand") hand = o; });
    }

    // Safety net: no rig / no hand bone → preserve the old fixed body-root offset.
    if (!hand) {
      if (size.y >= size.x && size.y >= size.z) mount.rotation.x = -Math.PI / 2; // +Y → +Z
      else if (size.x >= size.z) mount.rotation.y = Math.PI / 2;                 // +X → +Z
      if (isBlade) mount.rotation.z += 0.15; // slight grip tilt
      const parent = this._rigRoot || this.group;
      parent.add(mount);
      mount.position.set(0.26, isBlade ? 1.0 : 1.05, 0.28);
      this._weapon = mount;
      return;
    }

    // Orient the model's longest axis to +Z (the enemy's forward) as a starting pose.
    const qAxis = new THREE.Quaternion();
    if (size.y >= size.x && size.y >= size.z) qAxis.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2); // +Y → +Z
    else if (size.x >= size.z) qAxis.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);                 // +X → +Z

    // Per-kind grip, tuned in the enemy's local frame (+Z forward, +Y up). Pistol:
    // barrel forward, slight muzzle-up, sat in the palm. Blade: tip forward/up and
    // rolled into the grip for a lunging stab.
    const grip = isBlade
      ? { euler: new THREE.Euler(-0.35, 0.0, 0.25), offset: new THREE.Vector3(0.0, 0.03, 0.10), scale: 1.0 }
      : { euler: new THREE.Euler(0.12, 0.0, 0.0), offset: new THREE.Vector3(0.0, 0.0, 0.07), scale: 1.0 };
    const desiredQuat = new THREE.Quaternion().setFromEuler(grip.euler).multiply(qAxis);
    const desiredScale = worldScale.multiplyScalar(grip.scale);

    // Desired WORLD transform at the hand. At construction the enemy faces +Z with
    // yaw 0, so world axes coincide with the enemy's local frame; once baked into
    // the bone's local space the weapon rides the hand through any later yaw/anim.
    this.group.updateMatrixWorld(true);
    const handPos = new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld).add(grip.offset);
    const desired = new THREE.Matrix4().compose(handPos, desiredQuat, desiredScale);

    // world → bone-local (compensates the bone's tiny ~0.011 world scale).
    const local = new THREE.Matrix4().copy(hand.matrixWorld).invert().multiply(desired);
    local.decompose(mount.position, mount.quaternion, mount.scale);
    hand.add(mount);
    this._weapon = mount;
  }

  get position() {
    return this.group.position;
  }

  /** Bounding box used for hitscan tests. Rebuilt each query (cheap). */
  getHitBox() {
    const p = this.group.position;
    return new THREE.Box3(
      new THREE.Vector3(p.x - this.radius, p.y, p.z - this.radius),
      new THREE.Vector3(p.x + this.radius, p.y + this.height, p.z + this.radius),
    );
  }

  /** @param {number} amount @param {THREE.Vector3} dir normalized push direction */
  takeDamage(amount, dir, force = 4) {
    if (this.dead) return;
    this._alerted = true; // attacking a guard wakes it
    this.health -= amount;
    if (dir) this.knock.addScaledVector(dir, force);
    // Flinch flash (placeholder only — mutate emissive in place, no allocation)
    if (this._bodyMat) {
      this._bodyMat.emissive.set(0xff5544);
      this._bodyMat.emissiveIntensity = 0.9;
      this._hitFlash = 0.08;
    }
    if (this.health <= 0) this._die(dir);
  }

  /** A boot to the chest: always lethal, huge knockback (Anger Foot style). */
  takeKick(dir) {
    if (this.dead) return;
    if (this.knockbackImmune) {
      // The "unstoppable" enforcer: a boot staggers it slightly but never
      // one-shots or flings it. Players must shoot it down.
      this.takeDamage(28, dir, 0);
      return;
    }
    this.knock.addScaledVector(dir, 16);
    this.takeDamage(this.health + 50, dir, 0); // guaranteed kill
  }

  _die(dir) {
    if (this.archetype === "breacher") this._pendingDetonate = true;
    this.dead = true;
    this.alive = false;
    if (dir) {
      _flat.set(dir.x, 0, dir.z).normalize();
      // Topple around an axis perpendicular to the push.
      this._toppleAxis.set(-_flat.z, 0, _flat.x);
    }
  }

  /** Crossfade to a named animation clip (walk/run/idle). */
  _setAnim(name) {
    // While a one-shot attack is swinging, don't let locomotion clobber it; the
    // 'finished' handler clears `_attacking` and resumes walk/run/idle.
    if (this._attacking) return;
    if (!this.actions || this._anim === name) return;
    const next = this.actions[name] || this.actions.idle || this.actions.walk;
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

  /**
   * @param {number} dt
   * @param {object} ctx { camera, player, level }
   */
  update(dt, ctx) {
    EnemyBehavior.tickAnim(this, dt);
    // Apply + decay knockback (slides the corpse/enemy back).
    if (this.knock.lengthSq() > 0.0001) {
      this.group.position.addScaledVector(this.knock, dt);
      this.knock.multiplyScalar(Math.max(0, 1 - dt * 6));
    }

    // Hit-flash decay (placeholder only)
    if (this._hitFlash > 0 && this._bodyMat) {
      this._hitFlash -= dt;
      if (this._hitFlash <= 0) this._bodyMat.emissiveIntensity = 0;
    }

    if (this.dead) {
      if (this._pendingDetonate) {
        this._pendingDetonate = false;
        EnemyBehavior.detonate(this, ctx);
      }
      // Ragdoll-lite: topple to the ground over ~0.5s, then settle.
      if (this._toppleAmt < Math.PI / 2) {
        this._toppleAmt = Math.min(Math.PI / 2, this._toppleAmt + dt * 6);
        this.group.setRotationFromAxisAngle(this._toppleAxis, this._toppleAmt);
      }
      return;
    }

    // Victim-guarding enemies menace the victim and ignore the player until the
    // player gets close or attacks them.
    if (this._guardingVictim) {
      if (this._guardingVictim.rescued) {
        this._guardingVictim = null; // freed → resume normal AI
      } else if (!this._alerted) {
        const ALERT = 6;
        if (this.group.position.distanceTo(ctx.player.position) < ALERT) {
          this._alerted = true;
        } else {
          EnemyBehavior.menaceVictim(this, dt, ctx);
          return;
        }
      }
    }

    // Non-grunt archetypes run their own steering/attack, then bail out before
    // the baseline grunt melee AI below.
    if (this.archetype === "gunner") { EnemyBehavior.stepGunner(this, dt, ctx); return; }
    if (this.archetype === "enforcer") { EnemyBehavior.stepEnforcer(this, dt, ctx); return; }
    if (this.archetype === "breacher") { EnemyBehavior.stepBreacher(this, dt, ctx); return; }

    const playerPos = ctx.player.position;
    _toPlayer.copy(playerPos).sub(this.group.position);
    const dist = _toPlayer.length();

    // Patrol when the player is far / out of sight.
    const canSee = dist < this.sightRange && ctx.level.lineOfSight(this.eyePosition(), playerPos);

    if (canSee) {
      // Always face + close on the player.
      this.group.rotation.y = Math.atan2(_toPlayer.x, _toPlayer.z);
      _flat.copy(_toPlayer).setY(0);
      const hdist = _flat.length();
      _flat.normalize();
      if (hdist > this.meleeRange) {
        // Charge — and telegraph the swing once inside wind-up range so the
        // grunt visibly cocks its weapon as it closes (damage-free; the real
        // hit still happens below in the in-range/meleeTimer path).
        this.group.position.addScaledVector(_flat, this.runSpeed * dt);
        this._setAnim("run");
        if (hdist <= this.meleeRange + EnemyBehavior.MELEE_TELEGRAPH_PAD) {
          this._telegraphSwing(ctx, dt);
        }
      } else {
        // In range — circle the player and swing on a cooldown.
        _tangent.set(-_flat.z, 0, _flat.x).multiplyScalar(this._strafeDir);
        this.group.position.addScaledVector(_tangent, this.speed * dt);
        this._setAnim("run");
        this.meleeTimer -= dt;
        if (this.meleeTimer <= 0) {
          this.meleeTimer = this.meleeCooldown;
          this._meleeAttack(ctx);
        }
      }
    } else if (this.patrol && this.patrol.length > 1) {
      this._doPatrol(dt, ctx);
      this._setAnim("walk");
    } else {
      this._setAnim("idle");
    }

    // Ease the melee lunge back to rest (offsets the visual model only).
    if (this._rigRoot) {
      this._lunge = this._lunge > 0.001 ? this._lunge * Math.max(0, 1 - dt * 9) : 0;
      this._rigRoot.position.z = this._lunge;
    }
  }

  eyePosition() {
    return _flat.copy(this.group.position).setY(this.group.position.y + 1.1);
  }

  _doPatrol(dt, ctx) {
    const target = this.patrol[this.patrolIndex];
    _flat.copy(target).sub(this.group.position);
    _flat.y = 0;
    if (_flat.length() < 0.4) {
      this.patrolIndex = (this.patrolIndex + 1) % this.patrol.length;
      return;
    }
    _flat.normalize();
    this.group.rotation.y = Math.atan2(_flat.x, _flat.z);
    this.group.position.addScaledVector(_flat, this.speed * dt);
  }

  /**
   * Play the one-shot melee swing (clip + forward jab + audio) and, unless this
   * is a telegraph wind-up, connect for damage if still in reach.
   *
   * @param {object} ctx
   * @param {boolean} [telegraph=false] when true the swing is purely visual — no
   *   damage and no HUD flash. Used for the approach wind-up and for menacing the
   *   victim NPC, so the wind-up can never double-damage the player (damage stays
   *   in the dedicated melee-range / meleeTimer paths).
   */
  _meleeAttack(ctx, telegraph = false) {
    // Quick forward jab (visual), then connect if still in reach.
    this._lunge = 0.5;
    // Swing the arms (and the hand-anchored weapon) via the one-shot attack clip.
    // Rigged-only; static-fallback enemies (no mixer/action) just do the lunge.
    if (this._attackAction) {
      this._attacking = true;
      this._attackAction.reset();
      this._attackAction.enabled = true;
      this._attackAction.setEffectiveWeight(1);
      this._attackAction.fadeIn(0.08);
      this._attackAction.play();
      // Fade the current locomotion clip out so the swing reads clearly.
      if (this._anim && this.actions[this._anim] && this.actions[this._anim] !== this._attackAction) {
        this.actions[this._anim].fadeOut(0.08);
      }
    }
    ctx.audio.enemyMelee(this.group.position, ctx.camera.position);
    if (telegraph) return; // wind-up swing only — never deals damage
    _flat.copy(ctx.player.position).sub(this.group.position).setY(0);
    if (_flat.length() <= this.meleeRange + 0.5) {
      ctx.player.damage(this.damage);
      ctx.hud.flashDamage();
    }
  }

  /**
   * Effective (time-scaled) duration of the one-shot attack clip, in seconds.
   * Returns 0 for non-rigged enemies / when no attack clip was provided.
   */
  _attackClipDuration() {
    if (!this._attackAction) return 0;
    const clip = this._attackAction.getClip ? this._attackAction.getClip() : null;
    const ts = Math.abs(this._attackAction.timeScale) || 1;
    return clip ? clip.duration / ts : 0;
  }

  /**
   * Telegraph wind-up: replay the one-shot swing on a cooldown while closing in
   * on the player (BEFORE damage range), so the enemy visibly winds up as it
   * advances. The cooldown is ~the attack clip's effective duration (plus the
   * `_attacking` guard) so it never restarts mid-swing. Damage-free — the actual
   * hit stays in the melee-range / meleeTimer paths. Rigged-only: static-fallback
   * enemies have no attack action and simply skip the telegraph (no crash).
   * @param {object} ctx
   * @param {number} dt
   */
  _telegraphSwing(ctx, dt) {
    if (!this._attackAction) return; // static / non-rigged → keep plain locomotion
    this._telegraphT = (this._telegraphT || 0) - dt;
    if (this._telegraphT <= 0 && !this._attacking) {
      this._telegraphT = this._attackClipDuration() || 1.2;
      this._meleeAttack(ctx, true); // swing + lunge + audio, no damage
    }
  }

  dispose(scene) {
    if (this.mixer && this._onAttackFinished) {
      this.mixer.removeEventListener("finished", this._onAttackFinished);
      this._onAttackFinished = null;
    }
    scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}
