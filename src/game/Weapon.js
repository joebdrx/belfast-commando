import * as THREE from "three";

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _box = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _spread = new THREE.Vector3();

/** Weapon definitions — placeholder low-poly viewmodels, distinct feel. */
const WEAPONS = [
  // vmRotY yaws the GLB so the barrel points forward (-Z). The two gun meshes
  // happen to face opposite directions, hence opposite signs.
  { name: "Sidearm", model: "weapon_pistol", vmRotY: -Math.PI / 2, color: 0x2b2b2b, damage: 34, rpm: 360, auto: false, pellets: 1, spread: 0.004, size: [0.12, 0.16, 0.4], mag: 12, reloadTime: 1.1 },
  { name: "SMG", model: "weapon_ak", vmRotY: Math.PI / 2, color: 0x3a3f44, damage: 18, rpm: 850, auto: true, pellets: 1, spread: 0.018, size: [0.1, 0.18, 0.55], mag: 30, reloadTime: 1.6 },
  { name: "Boomstick", model: "weapon_shotgun", vmRotY: -Math.PI / 2, color: 0x4a3520, damage: 16, rpm: 95, auto: false, pellets: 8, spread: 0.07, size: [0.16, 0.18, 0.6], mag: 6, reloadTime: 2.0 },
];

// Shared viewmodel offset — seats the gun in the FP arms' grip.
const VM = { pos: [0.13, -0.2, -0.5] };

// Dedicated first-person arms viewmodel (AI-generated `fp_arms_grip`): two
// gloved forearms with green armbands gripping forward. `rot` pitches the model
// so the grip/gun points forward (-Z); `pos`/`scale` seat it in the lower view.
const SHOW_FP_ARMS = true;
const ARMS = {
  scale: 0.75,
  pos: [0.15, -0.17, -0.28],
  rot: [-Math.PI / 2 + 0.55, 0, 0],
};

const MAX_EFFECTS = 80;

/**
 * Weapon
 * ------
 * Hitscan gunplay. Raycasts from screen-center against enemy hitboxes, explosive
 * barrels, and level geometry, then spawns juice: muzzle flash, tracer, sparks,
 * blood, bullet decals, and explosions. First-person hands hold the gun and a
 * boot swings in on kick. Magazine ammo + reload. 1/2/3 (or Q) switch weapons.
 */
export class Weapon {
  /** @param {THREE.Camera} camera */
  constructor(camera, scene, assets = null) {
    this.camera = camera;
    this.scene = scene;
    this.assets = assets;
    this.ctx = null;

    this.raycaster = new THREE.Raycaster();
    this.cooldown = 0;
    this.triggerHeld = false;
    this.index = 0;

    // Magazine ammo per weapon (reserve is effectively infinite for the MVP).
    this.ammo = WEAPONS.map((w) => w.mag);
    this.reloading = false;
    this.reloadTimer = 0;

    this.effects = []; // {mesh, life, maxLife, fade}

    // --- Viewmodel (child of camera so it tracks the view) ---------------
    this.viewmodel = new THREE.Group();
    this.camera.add(this.viewmodel);

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

    this._buildViewmodel();
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

    const model = this.assets && w.model ? this.assets.getModel(w.model) : null;
    if (model) {
      model.rotation.y = w.vmRotY || 0;
      g.add(model);
      g.position.set(...VM.pos);
    } else {
      // Placeholder box gun.
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(...w.size),
        new THREE.MeshStandardMaterial({ color: w.color, roughness: 0.5, metalness: 0.3 }),
      );
      g.add(body);
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, 0.3, 8),
        new THREE.MeshStandardMaterial({ color: 0x111111 }),
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.02, -w.size[2] / 2 - 0.12);
      g.add(barrel);
      g.position.set(0.22, -0.2, -0.5);
    }

    this.viewmodel.add(g);
    this._gun = g;
    this._gunRest = g.position.clone();

    this._ensureHands();
    this._ensureBoot();
    this._applySprites();
  }

  /** Dedicated first-person arms viewmodel (built once, persists). */
  _ensureHands() {
    if (!SHOW_FP_ARMS) return;
    if (this._hands || !this.assets) return;
    const arms = this.assets.getModel("fp_arms_grip");
    if (!arms) return;
    arms.rotation.set(...ARMS.rot);
    this._hands = new THREE.Group();
    this._hands.add(arms);
    this._hands.scale.setScalar(ARMS.scale);
    this._hands.position.set(...ARMS.pos);
    this._handsRest = this._hands.position.clone();
    this.viewmodel.add(this._hands);
  }

  /** The kick boot, hidden until a kick swings it into view (Anger-Foot style). */
  _ensureBoot() {
    if (this._boot || !this.assets) return;
    const b = this.assets.getModel("kick_boot");
    if (!b) return;
    b.rotation.y = Math.PI / 2; // toe forward (-Z)
    this._boot = new THREE.Group();
    this._boot.add(b);
    this._boot.scale.setScalar(0.85);
    this._boot.visible = false;
    this.viewmodel.add(this._boot);
  }

  /** Apply AI VFX/decal textures once the AssetManager has loaded them. */
  _applySprites() {
    if (!this.assets) return;
    const mf = this.assets.getSprite("muzzle_flash");
    if (mf && this.muzzle) {
      this.muzzle.material.map = mf;
      this.muzzle.material.color.set(0xffffff);
      this.muzzle.material.blending = THREE.AdditiveBlending;
      this.muzzle.material.needsUpdate = true;
    }
    this._bloodTex = this.assets.getSprite("blood");
    this._holeTex = this.assets.getSprite("bullet_hole");
    this._kickTex = this.assets.getSprite("kick_impact");
  }

  /** Additive kick-impact burst at a world point (called by Player on connect). */
  kickFx(point) {
    this._billboard(point, this._kickTex, 1.5, 0.28, THREE.AdditiveBlending, 0xffd27f, 0.9);
  }

  /** Big additive explosion flash + expanding shell (barrels). */
  explosionFx(point) {
    this._billboard(point, this._kickTex, 3.2, 0.4, THREE.AdditiveBlending, 0xffaa44, 1.3);
    // Expanding shockwave shell.
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffb060, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    shell.position.copy(point);
    shell.userData.grow = true;
    this.scene.add(shell);
    this._track(shell, 0.4);
  }

  _billboard(point, tex, size, life, blending, fallbackColor, yMin) {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, depthWrite: false, fog: false, blending });
    if (tex) mat.map = tex;
    else mat.color.set(fallbackColor);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    m.position.set(point.x, Math.max(point.y, yMin), point.z);
    m.quaternion.copy(this.camera.quaternion);
    this.scene.add(m);
    this._track(m, life);
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
      else if (e.code === "KeyR") this.reload();
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
    this.reloading = false;
    this.reloadTimer = 0;
    this._buildViewmodel();
    if (this.ctx) {
      this.ctx.hud.setWeapon(this.current.name);
      this.ctx.hud.setAmmo(this.ammo[this.index], this.current.mag, this.reloading);
      this.ctx.audio.switchWeapon();
    }
  }

  reload() {
    const w = this.current;
    if (this.reloading || this.ammo[this.index] >= w.mag || !this._canAct()) return;
    this.reloading = true;
    this.reloadTimer = w.reloadTime;
    this.ctx.audio.reload();
    this.ctx.hud.setAmmo(this.ammo[this.index], w.mag, true);
  }

  /** Top up the current magazine (Scavenger's Refund). Clamped to mag size. */
  addAmmo(n) {
    const w = this.current;
    this.ammo[this.index] = Math.min(w.mag, this.ammo[this.index] + n);
    if (this.ctx) this.ctx.hud.setAmmo(this.ammo[this.index], w.mag, this.reloading);
  }

  tryFire() {
    if (this.cooldown > 0 || this.reloading || !this._canAct()) return;
    const w = this.current;
    if (this.ammo[this.index] <= 0) {
      this.ctx.audio.dryFire();
      this.reload(); // auto-reload on empty
      return;
    }
    this.cooldown = 60 / w.rpm;
    this.ammo[this.index]--;
    this.ctx.hud.setAmmo(this.ammo[this.index], w.mag, false);

    this._muzzleTime = 0.05;
    this.muzzle.material.opacity = 1;
    this.muzzle.rotation.z = Math.random() * Math.PI;
    this._kick = 0.06; // viewmodel recoil

    this.ctx.audio.gunshot(w.name);
    this.ctx.score.add(5, "", true); // small points + combo bump for shooting

    const colliders = this.ctx.level.getColliders();
    for (let p = 0; p < w.pellets; p++) {
      this._fireRay(w, colliders);
    }

    if (this.ammo[this.index] <= 0) this.reload(); // out — start reload
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

    // Closest enemy
    let eDist = Infinity, bestEnemy = null;
    const ePoint = new THREE.Vector3();
    for (const e of this.ctx.level.enemies) {
      if (e.dead) continue;
      if (this.raycaster.ray.intersectBox(e.getHitBox(), _hit)) {
        const d = _origin.distanceTo(_hit);
        if (d < eDist) { eDist = d; bestEnemy = e; ePoint.copy(_hit); }
      }
    }
    // Closest explosive barrel
    let blDist = Infinity, bestBarrel = null;
    const blPoint = new THREE.Vector3();
    for (const bl of this.ctx.level.barrels) {
      if (bl.exploded) continue;
      if (this.raycaster.ray.intersectBox(bl.hitbox, _hit)) {
        const d = _origin.distanceTo(_hit);
        if (d < blDist) { blDist = d; bestBarrel = bl; blPoint.copy(_hit); }
      }
    }
    // Closest wall
    let wDist = Infinity;
    const wPoint = new THREE.Vector3();
    let hasWall = false;
    for (const b of colliders) {
      if (this.raycaster.ray.intersectBox(b, _hit)) {
        const d = _origin.distanceTo(_hit);
        if (d < wDist) { wDist = d; wPoint.copy(_hit); hasWall = true; }
      }
    }

    const minD = Math.min(eDist, blDist, hasWall ? wDist : Infinity);
    if (minD === Infinity) {
      _hit.copy(_origin).addScaledVector(_dir, 60);
      this._tracer(_origin, _hit);
    } else if (minD === blDist) {
      this._tracer(_origin, blPoint);
      this.ctx.level.explodeBarrel(bestBarrel, this.ctx);
    } else if (minD === eDist) {
      const wasAlive = !bestEnemy.dead;
      _dir.copy(ePoint).sub(_origin).normalize();
      bestEnemy.takeDamage(w.damage, _dir, 3);
      this._spawnImpact(ePoint, 0xb01818, true);
      this._tracer(_origin, ePoint);
      this.ctx.score.add(30, "HIT");
      this.ctx.state && this.ctx.state.emit("hit", { position: ePoint.clone(), amount: w.damage });
      if (this.ctx.juice) this.ctx.juice.spawnImpact(ePoint, "blood");
      if (wasAlive && bestEnemy.dead) {
        this.ctx.score.add(120, "KILL");
        this.ctx.audio.kill();
        // Bridge a hitscan kill to the run state ("kill" event + kills stat)
        // so achievements + floating text + RESULTS rewards see it.
        this.ctx.state && this.ctx.state.addKill({ position: ePoint.clone(), weapon: w.name });
        if (this.ctx.juice) {
          this.ctx.juice.hitStop(45);
          this.ctx.juice.shake(0.1, 110);
        }
      }
    } else {
      this._spawnImpact(wPoint, 0xffcc66, false);
      this._tracer(_origin, wPoint);
      // Persistent bullet-hole decal (normal ≈ toward the shooter).
      this.ctx.state && this.ctx.state.emit("surfaceHit", {
        position: wPoint.clone(),
        normal: _dir.clone().multiplyScalar(-1),
      });
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
    // Camera-facing decal quad. Decal sprites are now keyed to transparency, so
    // they composite with normal alpha blending.
    const size = isBlood ? 0.55 : 0.32;
    const tex = isBlood ? this._bloodTex : this._holeTex;
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.98, depthWrite: false, fog: false });
    if (tex) mat.map = tex;
    else mat.color.set(color);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    mesh.position.copy(point);
    mesh.quaternion.copy(this.camera.quaternion);
    this.scene.add(mesh);
    this._track(mesh, isBlood ? 0.8 : 0.6);

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

    // Reload timer
    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloading = false;
        this.ammo[this.index] = this.current.mag;
        this.ctx && this.ctx.hud.setAmmo(this.ammo[this.index], this.current.mag, false);
      }
    }

    // Full-auto fire
    if (this.triggerHeld && this.current.auto && this.cooldown <= 0 && !this.reloading && this._canAct()) {
      this.tryFire();
    }

    // Muzzle flash decay
    if (this._muzzleTime > 0) {
      this._muzzleTime -= dt;
      this.muzzle.material.opacity = Math.max(0, this._muzzleTime / 0.05);
    }

    const player = this.ctx ? this.ctx.player : null;

    // --- Viewmodel bob + sway (gun + hands move together) ----------------
    if (player && this._gun) {
      const speed = Math.hypot(player.vel.x, player.vel.z);
      const bob = player.bobPhase;
      const bobAmt = Math.min(speed / 9, 1) * 0.02;
      this._swayTarget.set(
        THREE.MathUtils.clamp(-((this.camera.rotation.y - this._lastYaw) || 0) * 6, -0.05, 0.05),
        0,
      );
      this._sway.lerp(this._swayTarget, Math.min(1, dt * 8));

      const recoil = this._kick || 0;
      const dx = Math.cos(bob) * bobAmt + this._sway.x;
      const dyBob = Math.abs(Math.sin(bob)) * bobAmt;
      this._gun.position.set(this._gunRest.x + dx, this._gunRest.y + dyBob - recoil * 0.5, this._gunRest.z + recoil);
      if (this._hands) {
        this._hands.position.set(this._handsRest.x + dx, this._handsRest.y + dyBob - recoil * 0.4, this._handsRest.z + recoil * 0.8);
      }
      if (this._kick > 0) this._kick = Math.max(0, this._kick - dt * 0.6);
      this._lastYaw = this.camera.rotation.y;
    }

    // --- Kick boot: swing in from below while the player is kicking -------
    if (this._boot && player) {
      const ka = player.kickAnim || 0;
      if (ka > 0.02) {
        this._boot.visible = true;
        if (this._hands) this._hands.visible = false; // hands tuck away during kick
        const t = ka; // 1 right after the kick, decays to 0
        this._boot.position.set(0.06, -0.85 + t * 0.5, -0.35 - t * 0.3);
        this._boot.rotation.x = -t * 0.65;
      } else {
        this._boot.visible = false;
        if (this._hands) this._hands.visible = true;
      }
    }

    // --- Effects lifetime -------------------------------------------------
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.life -= dt;
      if (fx.gravity && fx.mesh.userData.vel) {
        fx.mesh.userData.vel.y -= 14 * dt;
        fx.mesh.position.addScaledVector(fx.mesh.userData.vel, dt);
      }
      if (fx.mesh.userData.grow) {
        const s = 1 + (1 - fx.life / fx.maxLife) * 7;
        fx.mesh.scale.setScalar(s);
      }
      const t = Math.max(0, fx.life / fx.maxLife);
      if (fx.mesh.material) fx.mesh.material.opacity = t * (fx.mesh.userData.grow ? 0.7 : 1);
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
    this.reloading = false;
    this.reloadTimer = 0;
    this.ammo = WEAPONS.map((w) => w.mag);
    if (this.ctx) this.ctx.hud.setAmmo(this.ammo[this.index], this.current.mag, false);
  }

  dispose() {
    window.removeEventListener("mousedown", this._onDown);
    window.removeEventListener("mouseup", this._onUp);
    window.removeEventListener("keydown", this._onKey);
    this.reset();
  }
}
