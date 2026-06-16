import * as THREE from "three";

const _toPlayer = new THREE.Vector3();
const _flat = new THREE.Vector3();

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

    this.fireCooldown = 1.4 + Math.random() * 0.8;
    this.fireTimer = this.fireCooldown * (0.5 + Math.random());
    this.sightRange = 32;
    this.damage = 6; // weak — they chip you, momentum is king

    // Patrol / chase
    this.patrol = opts.patrol || null;
    this.patrolIndex = 0;
    this.speed = 1.6;
    this.runSpeed = 3.6;
    this.chaseRange = 7; // run at the player until this close, then stop & shoot

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
      this.mixer = new THREE.AnimationMixer(opts.rigged.object3D);
      this.actions = {};
      for (const [name, clip] of Object.entries(opts.rigged.clips)) {
        this.actions[name] = this.mixer.clipAction(clip);
      }
      this._setAnim("idle");
    } else if (opts.model) {
      this.group.add(opts.model);
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
    this.knock.addScaledVector(dir, 16);
    this.takeDamage(this.health + 50, dir, 0); // guaranteed kill
  }

  _die(dir) {
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
    if (this.mixer && !this.dead) this.mixer.update(dt);
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
      // Ragdoll-lite: topple to the ground over ~0.5s, then settle.
      if (this._toppleAmt < Math.PI / 2) {
        this._toppleAmt = Math.min(Math.PI / 2, this._toppleAmt + dt * 6);
        this.group.setRotationFromAxisAngle(this._toppleAxis, this._toppleAmt);
      }
      return;
    }

    const playerPos = ctx.player.position;
    _toPlayer.copy(playerPos).sub(this.group.position);
    const dist = _toPlayer.length();

    // Patrol when the player is far / out of sight.
    const canSee = dist < this.sightRange && ctx.level.lineOfSight(this.eyePosition(), playerPos);

    if (canSee) {
      // Face the player (yaw only).
      this.group.rotation.y = Math.atan2(_toPlayer.x, _toPlayer.z);
      if (dist > this.chaseRange) {
        // Charge the player.
        _flat.copy(_toPlayer).setY(0).normalize();
        this.group.position.addScaledVector(_flat, this.runSpeed * dt);
        this._setAnim("run");
      } else {
        // In range — stand and shoot.
        this._setAnim("idle");
        this.fireTimer -= dt;
        if (this.fireTimer <= 0) {
          this.fireTimer = this.fireCooldown;
          this._shoot(ctx);
        }
      }
    } else if (this.patrol && this.patrol.length > 1) {
      this._doPatrol(dt, ctx);
      this._setAnim("walk");
    } else {
      this._setAnim("idle");
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

  _shoot(ctx) {
    this._flashTime = 0.06;
    this.flash.material.opacity = 1;
    ctx.audio.enemyShot(this.group.position, ctx.camera.position);
    // Inaccurate by design — they're cannon fodder.
    if (Math.random() < 0.55) {
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
