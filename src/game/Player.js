import * as THREE from "three";
import { DEFAULT_SETTINGS } from "../utils/constants.js";

const EYE_HEIGHT = 1.7;
const SLIDE_HEIGHT = 0.95;
const RADIUS = 0.4;

const WALK_SPEED = 5.5;
const SPRINT_SPEED = 8.0;
const SLIDE_SPEED = 15.0;

// Sprint stamina: drains while actually running, regenerates otherwise. Hitting
// zero forces an "exhausted" walk until it recovers past STAMINA_RECOVER — that
// recovery window is the cooldown, and stops on/off stutter-sprinting.
const MAX_STAMINA = 100;
const STAMINA_DRAIN = 30; // per second while sprinting (~3.3s of sprint)
const STAMINA_REGEN = 22; // per second while not sprinting (~4.5s full refill)
const STAMINA_RECOVER = 30; // exhausted clears once stamina climbs back to this
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

// Slow health regeneration: a reward for disengaging, NOT a fast combat heal.
// After REGEN_DELAY seconds without taking damage, health trickles back at
// REGEN_RATE HP/sec up to maxHealth (which the "thick_skin" upgrade may raise
// above 100 — we always cap at the live maxHealth, never a hardcoded 100).
const REGEN_DELAY = 5; // seconds of no damage before healing begins
const REGEN_RATE = 6; // HP per second once healing has kicked in

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _euler = new THREE.Euler();

const LAND_TOL = 0.01; // feet may be a hair below a box top and still land on it

/**
 * Vertical collision resolve. Finds the highest support surface under the player's
 * feet — the world floor (y=0) or the top of any AABB they're standing/landing on
 * — and the head-bump ceiling when rising into a box from below. Pure: takes the
 * pre/post-integration vertical state and returns the corrected one.
 *
 * Support only latches a box when the feet were already at/above its top
 * (`prevY >= top`), so at ground level no box ever yanks the player upward — the
 * street plays exactly as before; box tops only matter once you've jumped onto one.
 *
 * @param {THREE.Box3[]} boxes  active movement colliders
 * @param {number} px @param {number} pz  player horizontal (feet) position
 * @param {number} prevY  feet Y before this frame's vertical integration
 * @param {number} posY   feet Y after integration
 * @param {number} vy     vertical velocity
 * @param {number} eyeHeight  feet→head distance (camera height)
 * @returns {{ y:number, vy:number, onGround:boolean }}
 */
export function verticalSupport(boxes, px, pz, prevY, posY, vy, eyeHeight) {
  let support = 0; // world floor
  let y = posY;
  let v = vy;
  for (const b of boxes) {
    // Horizontal overlap, expanded by the player's radius (matches _resolveAxis).
    if (px <= b.min.x - RADIUS || px >= b.max.x + RADIUS) continue;
    if (pz <= b.min.z - RADIUS || pz >= b.max.z + RADIUS) continue;
    // Land on top: feet were at/above this top and are descending onto it.
    if (v <= 0 && prevY >= b.max.y - LAND_TOL && b.max.y > support) support = b.max.y;
    // Head bump: rising into a box from underneath (raised walkways/ceilings).
    if (v > 0 && prevY + eyeHeight <= b.min.y && y + eyeHeight > b.min.y) {
      y = b.min.y - eyeHeight;
      v = 0;
    }
  }
  if (y <= support) return { y: support, vy: 0, onGround: true };
  return { y, vy: v, onGround: false };
}

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
    this.sensitivity = DEFAULT_SETTINGS.sensitivity;

    this.eyeHeight = EYE_HEIGHT;
    this.sliding = false;
    this.slideTimer = 0;

    this.kickCooldown = 0;
    this.kickAnim = 0; // 0..1 visual kick punch
    this.kicking = false;
    this.kickPowerMul = 1; // raised by the "Kick Master" upgrade (set per-run by main)

    this.maxHealth = 100;
    this.health = 100;
    this.alive = true;
    // Seconds since the last hit; once it passes REGEN_DELAY, health regens.
    // Start "rested" — the player spawns at full HP so this is a no-op anyway.
    this._timeSinceDamage = REGEN_DELAY;

    // Per-run modifier knobs (1 = unmodified). Run modifiers (e.g. "Rainy
    // Night") scale these; reset to 1 each level, re-applied after spawn.
    this.speedMul = 1;
    this.frictionMul = 1;

    // Sprint stamina (0..MAX). `exhausted` locks sprint out until it recovers.
    this.stamina = MAX_STAMINA;
    this.exhausted = false;

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
      this.applyLook(e.movementX, e.movementY);
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

  /**
   * Rotate the view by a pointer/touch delta (in pixels). `sens` defaults to the
   * mouse sensitivity; the on-screen touch look-pad passes its own. Pitch is
   * clamped so the camera never flips. Shared by mouse-look and touch-look so the
   * clamp lives in exactly one place.
   */
  applyLook(dx, dy, sens = this.sensitivity) {
    this.yaw -= dx * sens;
    this.pitch -= dy * sens;
    const lim = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  /** Eye/aim position — used by weapon ray + enemy targeting. */
  get position() {
    return this.camera.position;
  }

  damage(amount) {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    // Pause health regen: the full REGEN_DELAY must elapse again after each hit.
    this._timeSinceDamage = 0;
    // Bridge to the run state: track damage for the FLAWLESS bonus + emit a
    // bus event for any juice/UI that reacts to taking hits. Guarded so the
    // core combat keeps working even before Wave-3 systems are wired.
    if (this.ctx && this.ctx.state) {
      this.ctx.state.bumpStat("damageTaken", amount);
      this.ctx.state.recordStat("noDamage", false);
      this.ctx.state.emit("damage", { amount, health: this.health });
    }
    this._spawnPlayerBlood();
    if (this.health <= 0) {
      this.alive = false;
      this.ctx && this.ctx.onPlayerDeath();
    }
  }

  /** Restore health (crate loot), clamped to the live maxHealth. Refreshes the HUD. */
  heal(amount) {
    if (!this.alive) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
    if (this.ctx && this.ctx.hud) this.ctx.hud.setHealth(this.health, this.maxHealth);
  }

  /**
   * First-person blood burst when the player is hit. The player has no visible
   * body, so we spray gore just in front of / below the camera where it reads as
   * the player being wounded (pairs with the HUD red vignette). Short cooldown so
   * rapid fire doesn't drown the screen.
   */
  _spawnPlayerBlood() {
    if (!this.ctx || !this.ctx.juice) return;
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    if (now - (this._lastBloodFx || 0) < 220) return;
    this._lastBloodFx = now;
    this.camera.getWorldDirection(_tmp);
    _wish.copy(this.camera.position).addScaledVector(_tmp, 0.85);
    _wish.y -= 0.22; // slightly below the eye line so the player sees the gore
    this.ctx.juice.spawnImpact(_wish, "blood");
  }

  reset(spawn, yaw = 0) {
    this.pos.copy(spawn);
    this.pos.y = 0;
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.health = this.maxHealth;
    this.alive = true;
    this._timeSinceDamage = REGEN_DELAY;
    this.sliding = false;
    this.eyeHeight = EYE_HEIGHT;
    this.speedMul = 1;
    this.frictionMul = 1;
    this.stamina = MAX_STAMINA;
    this.exhausted = false;
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

    // --- Slow health regeneration -----------------------------------------
    // Only after a quiet spell (no damage for REGEN_DELAY) does health trickle
    // back, capped at the live maxHealth (raised by "thick_skin"). The HUD is
    // pull-based — main's loop reads player.health each frame — but we also push
    // setHealth here (mirroring setStamina) so the bar stays exact. Dead players
    // never reach this code (early return above). No per-frame allocations.
    this._timeSinceDamage += dt;
    if (this._timeSinceDamage >= REGEN_DELAY && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + REGEN_RATE * dt);
      if (this.ctx && this.ctx.hud) this.ctx.hud.setHealth(this.health, this.maxHealth);
    }

    // --- Desired movement direction (camera-relative, flattened) ----------
    _wish.set(0, 0, 0);
    if (this.keys["KeyW"]) _wish.add(_forward);
    if (this.keys["KeyS"]) _wish.sub(_forward);
    if (this.keys["KeyD"]) _wish.add(_right);
    if (this.keys["KeyA"]) _wish.sub(_right);
    const wishing = _wish.lengthSq() > 0;
    if (wishing) _wish.normalize();

    // Sprint is stamina-gated: drains while running, regenerates otherwise,
    // and locks out ("exhausted") at zero until it recovers past the threshold.
    const wantSprint = this.keys["ShiftLeft"] || this.keys["ShiftRight"];
    const movingFast = this.vel.x * this.vel.x + this.vel.z * this.vel.z > 1;
    const sprinting = wantSprint && !this.exhausted && this.stamina > 0;
    if (sprinting && movingFast) {
      this.stamina = Math.max(0, this.stamina - STAMINA_DRAIN * dt);
      if (this.stamina <= 0) this.exhausted = true;
    } else {
      this.stamina = Math.min(MAX_STAMINA, this.stamina + STAMINA_REGEN * dt);
      if (this.exhausted && this.stamina >= STAMINA_RECOVER) this.exhausted = false;
    }
    if (this.ctx && this.ctx.hud) this.ctx.hud.setStamina(this.stamina, MAX_STAMINA, this.exhausted);

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
    // Y axis (vertical): land on the world floor OR the top of any box the player
    // is descending onto; head-bump on box undersides when rising.
    const prevY = this.pos.y;
    this.pos.y += this.vel.y * dt;
    const vr = verticalSupport(colliders, this.pos.x, this.pos.z, prevY, this.pos.y, this.vel.y, this.eyeHeight);
    this.pos.y = vr.y;
    this.vel.y = vr.vy;
    this.onGround = vr.onGround;

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
    const mul = this.kickPowerMul || 1; // Kick Master: scales range, knockback, damage
    const range = KICK_RANGE * mul;
    let kickPoint = null;
    const eye = this.camera.position;
    let connected = false;

    // Doors
    for (const door of this.ctx.level.doors) {
      if (door.open) continue;
      _tmp.copy(door.center).sub(eye);
      _tmp.y = 0;
      const dist = _tmp.length();
      if (dist > range) continue;
      _tmp.normalize();
      if (_tmp.dot(_forward) > cone) {
        door.kick();
        if (!kickPoint) kickPoint = door.center.clone();
        // Breaching a door is neither an elimination nor a rescue — no points.
        this.ctx.weapon.kickFx(door.center);
        this.ctx.audio.doorKick();
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
      if (dist > range) continue;
      _tmp.normalize();
      if (_tmp.dot(_forward) > cone) {
        const wasAlive = !e.dead;
        e.takeKick(_tmp, mul);
        kickPoint = e.position.clone();
        // Kill credit ONLY when the boot actually downs the enemy — the kick is
        // fixed-damage now, so a tanky/scaled enemy can survive it.
        if (wasAlive && e.dead) {
          this.ctx.abilities && this.ctx.abilities.onKickKill({ distance: dist });
          this.ctx.score.add(250, "BOOT KILL!");
          // Bridge a boot-kill to the run state (kills/bootKills + "kill" event
          // with isKick so achievements + floating text light up).
          this.ctx.state && this.ctx.state.addKill({ position: e.position.clone(), isKick: true });
        }
        // Boot connects (FX + juice) whether or not it kills.
        this.ctx.weapon.kickFx(e.position);
        this.ctx.audio.kick();
        this.ctx.steamFirstKick();
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
      if (dist > range + 0.4) continue;
      _tmp.normalize();
      if (_tmp.dot(_forward) > cone) {
        this.ctx.level.explodeBarrel(bl, this.ctx);
        connected = true;
      }
    }

    // Supply crates — a boot breaks one open for loot.
    for (const cr of this.ctx.level.crates || []) {
      if (cr.opened) continue;
      _tmp.copy(cr.pos).sub(eye);
      _tmp.y = 0;
      const dist = _tmp.length();
      if (dist > range + 0.4) continue;
      _tmp.normalize();
      if (_tmp.dot(_forward) > cone) {
        this.ctx.level.openCrate(cr, this.ctx);
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
    _euler.set(this.pitch - kickDip, this.yaw, slideRoll, "YXZ");
    this.camera.quaternion.setFromEuler(_euler);
  }

  dispose() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("mousemove", this._onMouseMove);
    window.removeEventListener("blur", this._onBlur);
  }
}
