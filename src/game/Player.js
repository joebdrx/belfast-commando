import * as THREE from "three";

const EYE_HEIGHT = 1.7;
const SLIDE_HEIGHT = 0.95;
const RADIUS = 0.4;

const WALK_SPEED = 5.5;
const SPRINT_SPEED = 9.5;
const SLIDE_SPEED = 15.0;
// Ground top speed is capped by the accel/friction equilibrium (ACCEL/FRICTION),
// NOT by targetSpeed alone. At 60/10 = 6 m/s the SPRINT target (9.5) was
// unreachable, so sprint felt identical to walk. Keep the ratio above the
// fastest ground target (slide 15 is set directly, so sprint 9.5 governs).
const ACCEL = 120;
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

    // Per-run modifier knobs (1 = unmodified). Run modifiers (e.g. "Rainy
    // Night") scale these; reset to 1 each level, re-applied after spawn.
    this.speedMul = 1;
    this.frictionMul = 1;

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
    // Clear all held keys when focus/pointer-lock is lost, so movement keys
    // never get "stuck" (and never block look) after tabbing away.
    this._onBlur = () => {
      this.keys = Object.create(null);
    };
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("mousemove", this._onMouseMove);
    window.addEventListener("blur", this._onBlur);
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== this.dom) this._onBlur();
    });
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
    // Bridge to the run state: track damage for the FLAWLESS bonus + emit a
    // bus event for any juice/UI that reacts to taking hits. Guarded so the
    // core combat keeps working even before Wave-3 systems are wired.
    if (this.ctx && this.ctx.state) {
      this.ctx.state.bumpStat("damageTaken", amount);
      this.ctx.state.recordStat("noDamage", false);
      this.ctx.state.emit("damage", { amount, health: this.health });
    }
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
    this.speedMul = 1;
    this.frictionMul = 1;
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

    // --- Slide: crouch/slide key while grounded + moving fast -------------
    // Decoupled from the sprint key: requiring Shift+Ctrl simultaneously made
    // the slide undiscoverable. Now any fast movement (speed > 4) + the crouch
    // key triggers a slide, so Ctrl/C reliably does something while running.
    const crouchKey = this.keys["ControlLeft"] || this.keys["KeyC"];
    if (crouchKey && this.onGround && !this.sliding && this.vel.lengthSq() > 16) {
      this._startSlide();
    }
    if (this.sliding) {
      this.slideTimer -= dt;
      if (this.slideTimer <= 0 || !this.onGround || this.keys["Space"]) this._endSlide();
    }

    // --- Horizontal acceleration / friction -------------------------------
    const ab = this.ctx && this.ctx.abilities;
    const sprintMul = sprinting ? (ab ? ab.sprintSpeedMul : 1) : (ab ? ab.walkSpeedMul : 1);
    let targetSpeed = (sprinting ? SPRINT_SPEED : WALK_SPEED) * this.speedMul * sprintMul;
    if (this.sliding) targetSpeed = SLIDE_SPEED * (ab ? ab.slideSpeedMul : 1) * (this.slideTimer / 0.7);

    const accel = this.onGround ? ACCEL : AIR_ACCEL;
    const horiz = _tmp.set(this.vel.x, 0, this.vel.z);

    if (this.onGround && !this.sliding) {
      // Ground friction
      const speed = horiz.length();
      if (speed > 0) {
        const drop = speed * FRICTION * this.frictionMul * dt;
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
    const ab = this.ctx && this.ctx.abilities;
    this.slideTimer = 0.7 * (ab ? ab.slideDurationMul : 1);
    // Boost forward in current movement direction.
    const sp = Math.hypot(this.vel.x, this.vel.z) || 1;
    const slideSpeed = SLIDE_SPEED * (ab ? ab.slideSpeedMul : 1);
    this.vel.x = (this.vel.x / sp) * slideSpeed;
    this.vel.z = (this.vel.z / sp) * slideSpeed;
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
    const cone = this.ctx.abilities && this.ctx.abilities.kickFullRadius ? -1.1 : KICK_CONE;
    let kickPoint = null;
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
      if (_tmp.dot(_forward) > cone) {
        door.kick();
        if (!kickPoint) kickPoint = door.center.clone();
        this.ctx.score.add(150, "BREACH!");
        this.ctx.weapon.kickFx(door.center);
        this.ctx.audio.kick();
        this.ctx.steamFirstKick();
        // Bus event (position-carrying) for floating text + door-breach stat.
        this.ctx.state && this.ctx.state.emit("breach", { position: door.center.clone() });
        if (this.ctx.juice) {
          this.ctx.juice.shake(0.12, 120);
          this.ctx.juice.spawnImpact(door.center, "spark");
        }
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
      if (_tmp.dot(_forward) > cone) {
        e.takeKick(_tmp);
        kickPoint = e.position.clone();
        if (e.dead) this.ctx.abilities && this.ctx.abilities.onKickKill({ distance: dist });
        this.ctx.score.add(250, "BOOT KILL!");
        this.ctx.weapon.kickFx(e.position);
        this.ctx.audio.kick();
        this.ctx.steamFirstKick();
        // Bridge a boot-kill to the run state (kills/bootKills + "kill" event
        // with isKick so achievements + floating text light up) and add juice.
        this.ctx.state && this.ctx.state.addKill({ position: e.position.clone(), isKick: true });
        if (this.ctx.juice) {
          this.ctx.juice.hitStop(70);
          this.ctx.juice.shake(0.2, 180);
          this.ctx.juice.spawnImpact(e.position, "kick");
        }
        connected = true;
      }
    }

    // Barrels — a boot to a barrel detonates it.
    for (const bl of this.ctx.level.barrels) {
      if (bl.exploded) continue;
      _tmp.copy(bl.pos).sub(eye);
      _tmp.y = 0;
      const dist = _tmp.length();
      if (dist > KICK_RANGE + 0.4) continue;
      _tmp.normalize();
      if (_tmp.dot(_forward) > cone) {
        this.ctx.level.explodeBarrel(bl, this.ctx);
        connected = true;
      }
    }

    if (connected) {
      const pt = kickPoint || this.camera.position.clone().addScaledVector(_forward, KICK_RANGE * 0.6);
      this.ctx.abilities && this.ctx.abilities.onKick({ point: pt });
    } else {
      this.ctx.audio.kickWhiff();
    }
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
    window.removeEventListener("blur", this._onBlur);
  }
}
