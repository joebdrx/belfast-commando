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
 *  - fires weak hitscan shots on a cooldown
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
    this.health = arch.health;
    this.sightRange = arch.sightRange;
    this.meleeRange = arch.meleeRange;
    this.damage = arch.meleeDamage;

    // Patrol / chase
    this.patrol = opts.patrol || null;
    this.patrolIndex = 0;
    this.speed = 1.8;
    this.runSpeed = 5.4; // fast enough to run a walking player down
    this._strafeDir = Math.random() < 0.5 ? -1 : 1; // circles the player in melee
    this._lunge = 0; // forward jab offset, eases back to rest
    this._rigRoot = null; // the visual model, lunged on each strike

    // Skeletal animation (rigged enemies)
    this.mixer = null;
    this.actions = null;
    this._anim = null;

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

    // Muzzle flash sprite (hidden until firing)
    this.flash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.5),
      new THREE.MeshBasicMaterial({
        color: 0xffcc55,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
      }),
    );
    this.flash.position.set(0.25, 1.1, 0.72);
    if (opts.flashTex) {
      this.flash.material.map = opts.flashTex;
      this.flash.material.color.set(0xffffff);
      this.flash.material.blending = THREE.AdditiveBlending;
    }
    this.group.add(this.flash);
    this._flashTime = 0;
    this._hitFlash = 0;

    // Collider half-extents for the player's bullet raycasts & body block
    this.radius = 0.45;
    this.height = 1.9;
    if (arch.scale && arch.scale !== 1) {
      this.group.scale.setScalar(arch.scale);
      this.radius *= arch.scale;
      this.height *= arch.scale;
    }
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
    // Muzzle flash decay
    if (this._flashTime > 0) {
      this._flashTime -= dt;
      this.flash.material.opacity = Math.max(0, this._flashTime / 0.06);
      // Billboard toward camera in WORLD space (flash is a child of the yawed
      // group, so undo the parent rotation before applying the camera's).
      this.flash.quaternion
        .copy(this.group.quaternion)
        .invert()
        .premultiply(ctx.camera.quaternion);
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
        // Charge.
        this.group.position.addScaledVector(_flat, this.runSpeed * dt);
        this._setAnim("run");
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

  _meleeAttack(ctx) {
    // Quick forward jab (visual), then connect if still in reach.
    this._lunge = 0.5;
    ctx.audio.enemyMelee(this.group.position, ctx.camera.position);
    _flat.copy(ctx.player.position).sub(this.group.position).setY(0);
    if (_flat.length() <= this.meleeRange + 0.5) {
      ctx.player.damage(this.damage);
      ctx.hud.flashDamage();
    }
  }

  dispose(scene) {
    scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}
