import * as THREE from "three";

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _box = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _spread = new THREE.Vector3();

/** Weapon definitions — placeholder low-poly viewmodels, distinct feel. */
const WEAPONS = [
  { name: "Sidearm", color: 0x2b2b2b, damage: 34, rpm: 360, auto: false, pellets: 1, spread: 0.004, size: [0.12, 0.16, 0.4] },
  { name: "SMG", color: 0x3a3f44, damage: 18, rpm: 850, auto: true, pellets: 1, spread: 0.018, size: [0.1, 0.18, 0.55] },
  { name: "Boomstick", color: 0x4a3520, damage: 16, rpm: 95, auto: false, pellets: 8, spread: 0.07, size: [0.16, 0.18, 0.6] },
];

const MAX_EFFECTS = 64;

/**
 * Weapon
 * ------
 * Hitscan gunplay. Raycasts from screen-center against enemy hitboxes and
 * level geometry, then spawns juice: muzzle flash, tracer, sparks on walls,
 * blood on enemies, and fading bullet decals. Viewmodel bobs with movement
 * and sways with mouse-look. 1/2/3 (or Q) switch weapons.
 */
export class Weapon {
  /** @param {THREE.Camera} camera */
  constructor(camera, scene) {
    this.camera = camera;
    this.scene = scene;
    this.ctx = null;

    this.raycaster = new THREE.Raycaster();
    this.cooldown = 0;
    this.triggerHeld = false;
    this.index = 0;

    this.effects = []; // {mesh, life, maxLife, fade}

    // --- Viewmodel (child of camera so it tracks the view) ---------------
    this.viewmodel = new THREE.Group();
    this.camera.add(this.viewmodel);
    this._buildViewmodel();

    // Muzzle flash
    this.muzzle = new THREE.Mesh(
      new THREE.PlaneGeometry(0.35, 0.35),
      new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false }),
    );
    this.muzzle.position.set(0.22, -0.2, -0.75);
    this.muzzle.renderOrder = 999;
    this.viewmodel.add(this.muzzle);
    this._muzzleTime = 0;

    this._swayTarget = new THREE.Vector2();
    this._sway = new THREE.Vector2();

    this._bind();
  }

  setContext(ctx) {
    this.ctx = ctx;
  }

  get current() {
    return WEAPONS[this.index];
  }

  _buildViewmodel() {
    if (this._gun) this.viewmodel.remove(this._gun);
    const w = this.current;
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(...w.size),
      new THREE.MeshStandardMaterial({ color: w.color, roughness: 0.5, metalness: 0.3 }),
    );
    g.add(body);
    // little barrel
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.3, 8),
      new THREE.MeshStandardMaterial({ color: 0x111111 }),
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.02, -w.size[2] / 2 - 0.12);
    g.add(barrel);
    g.position.set(0.22, -0.2, -0.5);
    this.viewmodel.add(g);
    this._gun = g;
    this._gunRest = g.position.clone();
  }

  _bind() {
    this._onDown = (e) => {
      if (!this._canAct() || e.button !== 0) return;
      this.triggerHeld = true;
      this.tryFire(); // immediate shot on click
    };
    this._onUp = (e) => {
      if (e.button === 0) this.triggerHeld = false;
    };
    this._onKey = (e) => {
      if (!this.ctx || !this.ctx.active) return;
      if (e.code === "Digit1") this.setWeapon(0);
      else if (e.code === "Digit2") this.setWeapon(1);
      else if (e.code === "Digit3") this.setWeapon(2);
      else if (e.code === "KeyQ") this.setWeapon((this.index + 1) % WEAPONS.length);
    };
    window.addEventListener("mousedown", this._onDown);
    window.addEventListener("mouseup", this._onUp);
    window.addEventListener("keydown", this._onKey);
  }

  _canAct() {
    return this.ctx && this.ctx.active && document.pointerLockElement === this.ctx.dom;
  }

  setWeapon(i) {
    if (i === this.index) return;
    this.index = i;
    this._buildViewmodel();
    this.ctx && this.ctx.hud.setWeapon(this.current.name);
    this.ctx && this.ctx.audio.switchWeapon();
  }

  tryFire() {
    if (this.cooldown > 0 || !this._canAct()) return;
    const w = this.current;
    this.cooldown = 60 / w.rpm;

    this._muzzleTime = 0.05;
    this.muzzle.material.opacity = 1;
    this.muzzle.rotation.z = Math.random() * Math.PI;
    this._kick = 0.06; // viewmodel recoil

    this.ctx.audio.gunshot(w.name);
    this.ctx.score.add(5, "", true); // small points + combo bump for shooting

    // Fetch the active collider list once for the whole shot (not per pellet).
    const colliders = this.ctx.level.getColliders();
    for (let p = 0; p < w.pellets; p++) {
      this._fireRay(w, colliders);
    }
  }

  _fireRay(w, colliders) {
    this.camera.getWorldPosition(_origin);
    this.camera.getWorldDirection(_dir);
    if (w.spread > 0) {
      _spread.set(
        (Math.random() - 0.5) * w.spread,
        (Math.random() - 0.5) * w.spread,
        (Math.random() - 0.5) * w.spread,
      );
      _dir.add(_spread).normalize();
    }
    this.raycaster.set(_origin, _dir);
    this.raycaster.far = 200;

    // Closest enemy hit
    let bestDist = Infinity;
    let bestEnemy = null;
    for (const e of this.ctx.level.enemies) {
      if (e.dead) continue;
      const r = this.raycaster.ray.intersectBox(e.getHitBox(), _hit);
      if (r) {
        const d = _origin.distanceTo(_hit);
        if (d < bestDist) {
          bestDist = d;
          bestEnemy = e;
          _box.copy(_hit);
        }
      }
    }

    // Closest wall hit
    let wallDist = Infinity;
    let wallPoint = null;
    for (const b of colliders) {
      const r = this.raycaster.ray.intersectBox(b, _hit);
      if (r) {
        const d = _origin.distanceTo(_hit);
        if (d < wallDist) {
          wallDist = d;
          wallPoint = _hit.clone();
        }
      }
    }

    if (bestEnemy && bestDist <= wallDist) {
      const wasAlive = !bestEnemy.dead;
      _dir.copy(_box).sub(_origin).normalize();
      bestEnemy.takeDamage(w.damage, _dir, 3);
      this._spawnImpact(_box, 0xb01818, true); // blood
      this._tracer(_origin, _box);
      this.ctx.score.add(30, "HIT");
      if (wasAlive && bestEnemy.dead) {
        this.ctx.score.add(120, "KILL");
        this.ctx.audio.kill();
      }
    } else if (wallPoint) {
      this._spawnImpact(wallPoint, 0xffcc66, false); // sparks
      this._tracer(_origin, wallPoint);
    } else {
      _hit.copy(_origin).addScaledVector(_dir, 60);
      this._tracer(_origin, _hit);
    }
  }

  _tracer(from, to) {
    const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0.8, fog: false }),
    );
    this.scene.add(line);
    this._track(line, 0.06);
  }

  _spawnImpact(point, color, isBlood) {
    // A small camera-facing quad that fades — cheap "decal"/spark puff.
    const size = isBlood ? 0.4 : 0.22;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, fog: false }),
    );
    mesh.position.copy(point);
    mesh.quaternion.copy(this.camera.quaternion);
    this.scene.add(mesh);
    this._track(mesh, isBlood ? 0.8 : 0.25);

    // A few spark/blood specks flying out
    for (let i = 0; i < (isBlood ? 4 : 3); i++) {
      const speck = new THREE.Mesh(
        new THREE.SphereGeometry(0.03, 4, 4),
        new THREE.MeshBasicMaterial({ color, transparent: true, fog: false }),
      );
      speck.position.copy(point);
      speck.userData.vel = new THREE.Vector3(
        (Math.random() - 0.5) * 4,
        Math.random() * 3,
        (Math.random() - 0.5) * 4,
      );
      this.scene.add(speck);
      this._track(speck, 0.4, true);
    }
  }

  _track(mesh, life, gravity = false) {
    if (this.effects.length >= MAX_EFFECTS) {
      const old = this.effects.shift();
      this._destroy(old.mesh);
    }
    this.effects.push({ mesh, life, maxLife: life, gravity });
  }

  _destroy(mesh) {
    this.scene.remove(mesh);
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) mesh.material.dispose();
  }

  update(dt) {
    if (this.cooldown > 0) this.cooldown -= dt;

    // Full-auto fire
    if (this.triggerHeld && this.current.auto && this.cooldown <= 0 && this._canAct()) {
      this.tryFire();
    }

    // Muzzle flash decay
    if (this._muzzleTime > 0) {
      this._muzzleTime -= dt;
      this.muzzle.material.opacity = Math.max(0, this._muzzleTime / 0.05);
    }

    // --- Viewmodel bob + sway --------------------------------------------
    const player = this.ctx ? this.ctx.player : null;
    if (player && this._gun) {
      const speed = Math.hypot(player.vel.x, player.vel.z);
      const bob = player.bobPhase;
      const bobAmt = Math.min(speed / 9, 1) * 0.02;
      // Sway eases toward recent look delta (approx via yaw/pitch velocity).
      this._swayTarget.set(
        THREE.MathUtils.clamp(-(this.camera.rotation.y - this._lastYaw || 0) * 6, -0.05, 0.05),
        0,
      );
      this._sway.lerp(this._swayTarget, Math.min(1, dt * 8));

      const recoil = this._kick || 0;
      this._gun.position.set(
        this._gunRest.x + Math.cos(bob) * bobAmt + this._sway.x,
        this._gunRest.y + Math.abs(Math.sin(bob)) * bobAmt - recoil * 0.5,
        this._gunRest.z + recoil,
      );
      if (this._kick > 0) this._kick = Math.max(0, this._kick - dt * 0.6);
      this._lastYaw = this.camera.rotation.y;
    }

    // --- Effects lifetime -------------------------------------------------
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.life -= dt;
      if (fx.gravity && fx.mesh.userData.vel) {
        fx.mesh.userData.vel.y -= 14 * dt;
        fx.mesh.position.addScaledVector(fx.mesh.userData.vel, dt);
      }
      const t = Math.max(0, fx.life / fx.maxLife);
      if (fx.mesh.material) fx.mesh.material.opacity = t;
      if (fx.life <= 0) {
        this._destroy(fx.mesh);
        this.effects.splice(i, 1);
      }
    }
  }

  reset() {
    for (const fx of this.effects) this._destroy(fx.mesh);
    this.effects.length = 0;
    this.cooldown = 0;
    this.triggerHeld = false;
  }

  dispose() {
    window.removeEventListener("mousedown", this._onDown);
    window.removeEventListener("mouseup", this._onUp);
    window.removeEventListener("keydown", this._onKey);
    this.reset();
  }
}
