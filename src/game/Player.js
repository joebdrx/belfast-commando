import * as THREE from "three";

const EYE_HEIGHT = 1.7;
const SLIDE_HEIGHT = 0.95;
const RADIUS = 0.4;

const WALK_SPEED = 5.5;
const SPRINT_SPEED = 9.5;
const SLIDE_SPEED = 15.0;
const ACCEL = 60;
const AIR_ACCEL = 12;
const FRICTION = 10;
const GRAVITY = 26;
const JUMP_VELOCITY = 9.0;

const KICK_RANGE = 2.8;
const KICK_CONE = 0.55; // dot threshold (~56°)
const KICK_COOLDOWN = 0.45;

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/**
 * Player
 * ------
 * First-person controller: pointer-lock mouse look, WASD + sprint, gravity,
 * jumping, a momentum slide, and the signature forward KICK that breaches
 * doors and boots enemies. Collides against the level's AABB colliders.
 *
 * Treats the player as a vertical capsule (point + RADIUS). `this.pos` is the
 * FEET position; the camera sits at feet + current eye height.
 */
export class Player {
  /** @param {THREE.Camera} camera @param {HTMLElement} domElement */
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;

    this.pos = new THREE.Vector3(0, 0, 4); // feet
    this.vel = new THREE.Vector3(); // horizontal velocity (x,z) + vy in .y
    this.onGround = true;

    this.yaw = 0; // face -Z, down the street into the level
    this.pitch = 0;
    this.sensitivity = 0.0022;

    this.eyeHeight = EYE_HEIGHT;
    this.sliding = false;
    this.slideTimer = 0;

    this.kickCooldown = 0;
    this.kickAnim = 0; // 0..1 visual kick punch
    this.kicking = false;

    this.maxHealth = 100;
    this.health = 100;
    this.alive = true;

    this.bobPhase = 0;

    /** @type {object} game context, set by main */
    this.ctx = null;

    this.keys = Object.create(null);
    this._bind();
  }

  setContext(ctx) {
    this.ctx = ctx;
  }

  _bind() {
    this._onKeyDown = (e) => {
      this.keys[e.code] = true;
      if (e.code === "Space") e.preventDefault();
    };
    this._onKeyUp = (e) => {
      this.keys[e.code] = false;
    };
    this._onMouseMove = (e) => {
      if (document.pointerLockElement !== this.dom) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      const lim = Math.PI / 2 - 0.02;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    };
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("mousemove", this._onMouseMove);
    // Note: firing input is owned by Weapon (mousedown/up).
  }

  get locked() {
    return document.pointerLockElement === this.dom;
  }

  /** Eye/aim position — used by weapon ray + enemy targeting. */
  get position() {
    return this.camera.position;
  }

  damage(amount) {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) {
      this.alive = false;
      this.ctx && this.ctx.onPlayerDeath();
    }
  }

  reset(spawn, yaw = 0) {
    this.pos.copy(spawn);
    this.pos.y = 0;
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.health = this.maxHealth;
    this.alive = true;
    this.sliding = false;
    this.eyeHeight = EYE_HEIGHT;
  }

  _basisFromYaw() {
    _forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  update(dt) {
    if (!this.alive) {
      this._applyCamera(dt);
      return;
    }
    this._basisFromYaw();

    // --- Desired movement direction (camera-relative, flattened) ----------
    _wish.set(0, 0, 0);
    if (this.keys["KeyW"]) _wish.add(_forward);
    if (this.keys["KeyS"]) _wish.sub(_forward);
    if (this.keys["KeyD"]) _wish.add(_right);
    if (this.keys["KeyA"]) _wish.sub(_right);
    const wishing = _wish.lengthSq() > 0;
    if (wishing) _wish.normalize();

    const sprinting = this.keys["ShiftLeft"] || this.keys["ShiftRight"];

    // --- Slide: crouch while sprinting + grounded + moving ----------------
    const crouchKey = this.keys["ControlLeft"] || this.keys["KeyC"];
    if (crouchKey && sprinting && this.onGround && !this.sliding && this.vel.lengthSq() > 16) {
      this._startSlide();
    }
    if (this.sliding) {
      this.slideTimer -= dt;
      if (this.slideTimer <= 0 || !this.onGround || this.keys["Space"]) this._endSlide();
    }

    // --- Horizontal acceleration / friction -------------------------------
    let targetSpeed = sprinting ? SPRINT_SPEED : WALK_SPEED;
    if (this.sliding) targetSpeed = SLIDE_SPEED * (this.slideTimer / 0.7);

    const accel = this.onGround ? ACCEL : AIR_ACCEL;
    const horiz = _tmp.set(this.vel.x, 0, this.vel.z);

    if (this.onGround && !this.sliding) {
      // Ground friction
      const speed = horiz.length();
      if (speed > 0) {
        const drop = speed * FRICTION * dt;
        const ns = Math.max(0, speed - drop) / speed;
        this.vel.x *= ns;
        this.vel.z *= ns;
      }
    }
    if (wishing && !this.sliding) {
      this.vel.x += _wish.x * accel * dt;
      this.vel.z += _wish.z * accel * dt;
      // Clamp to target speed
      const sp = Math.hypot(this.vel.x, this.vel.z);
      if (sp > targetSpeed) {
        const k = targetSpeed / sp;
        this.vel.x *= k;
        this.vel.z *= k;
      }
    } else if (this.sliding) {
      // Maintain slide direction, gentle decay
      this.vel.x *= 1 - dt * 1.2;
      this.vel.z *= 1 - dt * 1.2;
    }

    // --- Jump + gravity ---------------------------------------------------
    if (this.keys["Space"] && this.onGround) {
      this.vel.y = JUMP_VELOCITY;
      this.onGround = false;
    }
    this.vel.y -= GRAVITY * dt;

    // --- Integrate + collide ---------------------------------------------
    const colliders = this.ctx ? this.ctx.level.getColliders() : [];
    // X axis
    this.pos.x += this.vel.x * dt;
    this._resolveAxis(colliders, "x");
    // Z axis
    this.pos.z += this.vel.z * dt;
    this._resolveAxis(colliders, "z");
    // Y axis (vertical)
    this.pos.y += this.vel.y * dt;
    if (this.pos.y <= 0) {
      this.pos.y = 0;
      this.vel.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    // --- Kick -------------------------------------------------------------
    if (this.kickCooldown > 0) this.kickCooldown -= dt;
    if ((this.keys["KeyF"]) && this.kickCooldown <= 0) {
      this._kick();
    }
    if (this.kickAnim > 0) this.kickAnim = Math.max(0, this.kickAnim - dt * 4);

    // --- Head bob ---------------------------------------------------------
    const moveSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && moveSpeed > 0.5) {
      this.bobPhase += dt * moveSpeed * 1.1;
    }

    // Ease eye height (slide crouch)
    const targetEye = this.sliding ? SLIDE_HEIGHT : EYE_HEIGHT;
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(1, dt * 12);

    this._applyCamera(dt);
  }

  /** Resolve one axis of movement against AABB colliders (player as capsule). */
  _resolveAxis(colliders, axis) {
    const footY = this.pos.y;
    const headY = this.pos.y + this.eyeHeight;
    for (const b of colliders) {
      // Re-read each iteration: an earlier box may have already pushed us out,
      // so later boxes must test against the corrected position (tight corners).
      const px = this.pos.x;
      const pz = this.pos.z;
      // Vertical overlap test (skip things fully above head / below feet)
      if (b.max.y < footY + 0.05 || b.min.y > headY) continue;
      // Expand box by radius on the horizontal plane
      const minX = b.min.x - RADIUS;
      const maxX = b.max.x + RADIUS;
      const minZ = b.min.z - RADIUS;
      const maxZ = b.max.z + RADIUS;
      if (px > minX && px < maxX && pz > minZ && pz < maxZ) {
        if (axis === "x") {
          // Push out along X (toward nearest face)
          if (this.vel.x > 0) this.pos.x = minX;
          else if (this.vel.x < 0) this.pos.x = maxX;
          this.vel.x = 0;
        } else {
          if (this.vel.z > 0) this.pos.z = minZ;
          else if (this.vel.z < 0) this.pos.z = maxZ;
          this.vel.z = 0;
        }
      }
    }
  }

  _startSlide() {
    this.sliding = true;
    this.slideTimer = 0.7;
    // Boost forward in current movement direction.
    const sp = Math.hypot(this.vel.x, this.vel.z) || 1;
    this.vel.x = (this.vel.x / sp) * SLIDE_SPEED;
    this.vel.z = (this.vel.z / sp) * SLIDE_SPEED;
    this.ctx && this.ctx.audio.slide();
  }

  _endSlide() {
    this.sliding = false;
    // Trim speed back to sprint cap on exit.
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp > SPRINT_SPEED) {
      const k = SPRINT_SPEED / sp;
      this.vel.x *= k;
      this.vel.z *= k;
    }
  }

  _kick() {
    this.kickCooldown = KICK_COOLDOWN;
    this.kickAnim = 1;
    this.kicking = true;
    this._basisFromYaw();
    const eye = this.camera.position;
    let connected = false;

    // Doors
    for (const door of this.ctx.level.doors) {
      if (door.open) continue;
      _tmp.copy(door.center).sub(eye);
      _tmp.y = 0;
      const dist = _tmp.length();
      if (dist > KICK_RANGE) continue;
      _tmp.normalize();
      if (_tmp.dot(_forward) > KICK_CONE) {
        door.kick();
        this.ctx.score.add(150, "BREACH!");
        this.ctx.weapon.kickFx(door.center);
        this.ctx.audio.kick();
        this.ctx.steamFirstKick();
        connected = true;
      }
    }

    // Enemies
    for (const e of this.ctx.level.enemies) {
      if (e.dead) continue;
      _tmp.copy(e.position).sub(eye);
      _tmp.y = 0;
      const dist = _tmp.length();
      if (dist > KICK_RANGE) continue;
      _tmp.normalize();
      if (_tmp.dot(_forward) > KICK_CONE) {
        e.takeKick(_tmp);
        this.ctx.score.add(250, "BOOT KILL!");
        this.ctx.weapon.kickFx(e.position);
        this.ctx.audio.kick();
        this.ctx.steamFirstKick();
        connected = true;
      }
    }

    if (!connected) this.ctx.audio.kickWhiff();
  }

  _applyCamera(dt) {
    // Position camera at feet + eye height, plus subtle bob.
    const bobY = Math.sin(this.bobPhase * 2) * 0.045;
    const bobX = Math.cos(this.bobPhase) * 0.03;
    this._basisFromYaw();
    this.camera.position.set(
      this.pos.x + _right.x * bobX,
      this.pos.y + this.eyeHeight + bobY,
      this.pos.z + _right.z * bobX,
    );

    // Orientation from yaw + pitch, plus a little kick "punch" dip + roll.
    const kickDip = this.kickAnim * 0.12;
    const slideRoll = this.sliding ? 0.08 : 0;
    const euler = new THREE.Euler(this.pitch - kickDip, this.yaw, slideRoll, "YXZ");
    this.camera.quaternion.setFromEuler(euler);
  }

  dispose() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("mousemove", this._onMouseMove);
  }
}
