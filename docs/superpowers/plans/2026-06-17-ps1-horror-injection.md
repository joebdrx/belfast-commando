# PS1 Horror Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three new enemy archetypes with uncanny stop-motion pacing, wire boot abilities + two build-defining horror upgrades, and overlay a stylized-hybrid PS1 render look (nearest-filter, vertex snapping, claustrophobic fog, persistent flat blood decals) onto Belfast Commando — without breaking the existing FPS loop.

**Architecture:** New behavior lives in additive modules reached via `ctx` and the GameState event bus; core files (`Engine`, `Player`, `Weapon`, `Enemy`, `Level`, `HUD`, `Audio`, `AssetManager`, `main`) get minimal, explicitly-anchored hooks. Pure logic (archetype composition, ability math, decal ring-buffer, PS1 resolution math) is unit-tested with `vitest`; rendering/feel/integration is verified via `npm run build` + Playwright screenshots + runtime assertions.

**Tech Stack:** Three.js 0.184, Vite 6, Tauri v2, vanilla ESM JS classes, `vitest` (new, dev-only), Playwright MCP for playtest.

**Branch:** `feat/ps1-horror` (already created off `feat/hybrid-loop`), game subrepo `belfast-commando/belfast-commando` only. Never `git add -A` (home dir is its own repo); stage explicit paths.

**Spec:** `docs/superpowers/specs/2026-06-17-ps1-horror-injection-design.md`

---

## File Map

**New files**
- `tests/enemyDirector.test.js`, `tests/abilities.test.js`, `tests/decals.test.js`, `tests/retroMaterial.test.js`, `tests/enemyBehavior.test.js`, `tests/smoke.test.js`
- `src/data/enemies.json` — archetype stat table (Alpha)
- `src/game/EnemyDirector.js` — archetype composition (Alpha, pure)
- `src/game/EnemyBehavior.js` — anim clamp + per-archetype steering/attack (Alpha)
- `src/game/Abilities.js` — boot + horror-upgrade engine on `ctx.abilities` (Beta)
- `src/game/RetroMaterial.js` — nearest-filter + vertex-snap injection (Gamma)
- `src/game/Decals.js` — ring-buffered persistent decals (Gamma)

**Modified core files (minimal hooks)**
- `package.json` — add `vitest` + `test` script (Phase 0)
- `src/game/Enemy.js` — archetype config, ranged/enforcer/breacher behavior, anim clamp, knockback immunity, breacher detonation (Alpha)
- `src/game/Level.js` — construct `EnemyDirector`, assign archetype in `_addEnemy` (Alpha)
- `src/game/Audio.js` — `enemyScream`, `enforcerStep` synth methods (Alpha)
- `src/data/upgrades.json` — drop `steady_aim`, add `adrenaline_leak` + `scavenger_refund` (Beta)
- `src/game/Player.js` — boot move multipliers, 360° kick, `ctx.abilities` hooks (Beta)
- `src/game/Weapon.js` — `addAmmo(n)`, `surfaceHit` event on wall hit (Beta/Gamma)
- `src/game/HUD.js` — adrenaline distortion overlay (Beta)
- `src/game/Engine.js` — claustrophobic fog + far plane + dome radius (Gamma)
- `src/game/AssetManager.js` — route textures/materials through `RetroMaterial` (Gamma)
- `src/main.js` — instantiate + wire `Abilities`, `Decals`, `RetroMaterial`; subscribe events (all)
- `CONTRACTS.md` — register new files + bus events (QA)

---

## PHASE 0 — Tooling

### Task 0: Add vitest

**Files:**
- Modify: `package.json`
- Create: `tests/smoke.test.js`

- [ ] **Step 1: Add the dev dependency + script**

Run:
```bash
npm install -D vitest
```
Then in `package.json`, add to `"scripts"` (alongside the existing `dev`/`build`):
```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 2: Write a smoke test**

Create `tests/smoke.test.js`:
```js
import { describe, it, expect } from "vitest";

describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 3: Run it**

Run: `npm test`
Expected: PASS — `1 passed`. (Vitest uses the Node environment by default; pure-logic + headless-THREE modules import cleanly.)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tests/smoke.test.js
git commit -m "chore(ps1-horror): add vitest harness

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PHASE A — Alpha: Uncanny AI & enemy variety

### Task A1: Archetype data

**Files:**
- Create: `src/data/enemies.json`

- [ ] **Step 1: Author the archetype table**

Create `src/data/enemies.json`:
```json
[
  { "id": "grunt", "health": 100, "speed": 1.8, "runSpeed": 5.4, "sightRange": 42, "meleeRange": 1.7, "meleeDamage": 9, "knockbackImmune": false, "animFps": 11, "attack": "melee" },
  { "id": "gunner", "health": 60, "speed": 2.4, "runSpeed": 3.2, "sightRange": 75, "meleeRange": 1.7, "meleeDamage": 6, "knockbackImmune": false, "animFps": 10, "attack": "ranged",
    "ranged": { "damage": 7, "fireInterval": 1.9, "telegraph": 0.45, "standoff": 16, "strafeInterval": 0.65 } },
  { "id": "enforcer", "health": 320, "speed": 1.5, "runSpeed": 1.7, "sightRange": 90, "meleeRange": 2.0, "meleeDamage": 24, "knockbackImmune": true, "animFps": 8, "attack": "melee", "scale": 1.55 },
  { "id": "breacher", "health": 18, "speed": 7.8, "runSpeed": 8.6, "sightRange": 55, "meleeRange": 1.6, "meleeDamage": 0, "knockbackImmune": false, "animFps": 12, "attack": "detonate",
    "detonate": { "radius": 3.5, "damage": 38 }, "zigzag": { "amplitude": 3.6, "frequency": 2.4 } }
]
```

- [ ] **Step 2: Verify it parses**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('src/data/enemies.json')).length)"`
Expected: `4`

- [ ] **Step 3: Commit**

```bash
git add src/data/enemies.json
git commit -m "feat(ps1-horror): enemy archetype stat table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A2: EnemyDirector (pure composition)

**Files:**
- Create: `src/game/EnemyDirector.js`
- Test: `tests/enemyDirector.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/enemyDirector.test.js`:
```js
import { describe, it, expect } from "vitest";
import { archetypeWeights, pickArchetype, EnemyDirector, ARCHETYPES } from "../src/game/EnemyDirector.js";

describe("archetypeWeights", () => {
  it("sector 0 is grunt-only", () => {
    const w = archetypeWeights(0);
    expect(w.grunt).toBeGreaterThan(0);
    expect(w.gunner).toBe(0);
    expect(w.breacher).toBe(0);
    expect(w.enforcer).toBe(0);
  });
  it("late sectors add variety and cap each type", () => {
    const w = archetypeWeights(6);
    expect(w.gunner).toBeLessThanOrEqual(6);
    expect(w.breacher).toBeLessThanOrEqual(5);
    expect(w.enforcer).toBeLessThanOrEqual(2);
    expect(w.grunt).toBeGreaterThanOrEqual(1);
  });
});

describe("pickArchetype", () => {
  it("returns grunt when all weights are zero", () => {
    expect(pickArchetype({ grunt: 0, gunner: 0, breacher: 0, enforcer: 0 }, 0.5)).toBe("grunt");
  });
  it("selects the only weighted bucket", () => {
    expect(pickArchetype({ grunt: 0, gunner: 1, breacher: 0, enforcer: 0 }, 0.5)).toBe("gunner");
  });
  it("only ever returns known archetypes", () => {
    const w = archetypeWeights(4);
    for (let r = 0; r < 1; r += 0.05) expect(ARCHETYPES).toContain(pickArchetype(w, r));
  });
});

describe("EnemyDirector", () => {
  it("honors the enforcer cap", () => {
    const d = new EnemyDirector(6, () => 0.99, 2);
    d.weights = { grunt: 0, gunner: 0, breacher: 0, enforcer: 1 }; // force enforcer rolls
    const draws = Array.from({ length: 8 }, () => d.next());
    expect(draws.filter((x) => x === "enforcer").length).toBe(2);
    expect(draws.filter((x) => x === "grunt").length).toBe(6); // overflow falls back to grunt
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- enemyDirector`
Expected: FAIL — `Failed to resolve import "../src/game/EnemyDirector.js"`.

- [ ] **Step 3: Implement**

Create `src/game/EnemyDirector.js`:
```js
/**
 * EnemyDirector
 * -------------
 * Decides which archetype each spawned enemy is, scaling the mix by sector
 * index. Pure logic (no THREE / no DOM) so it is unit-testable.
 *
 *  - Sector 0 is all grunts (teach the baseline).
 *  - Gunners + breachers fade in as the index climbs; enforcers are rare and
 *    hard-capped (the "unstoppable" beat).
 */
export const ARCHETYPES = ["grunt", "gunner", "breacher", "enforcer"];

/** Relative spawn weights per archetype for a sector index. */
export function archetypeWeights(index) {
  const i = Math.max(0, index);
  return {
    grunt: Math.max(1, 10 - i * 1.5),
    gunner: Math.min(6, i * 1.2),
    breacher: Math.min(5, i * 0.9),
    enforcer: i >= 2 ? Math.min(2, (i - 1) * 0.5) : 0,
  };
}

/** Pick an archetype from weights given a 0..1 roll (cumulative buckets). */
export function pickArchetype(weights, roll) {
  const entries = ARCHETYPES.map((id) => [id, Math.max(0, weights[id] || 0)]);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  if (total <= 0) return "grunt";
  const target = roll * total;
  let acc = 0;
  for (const [id, w] of entries) {
    acc += w;
    if (target < acc) return id;
  }
  return entries[entries.length - 1][0];
}

export class EnemyDirector {
  /** @param {number} index @param {()=>number} rng 0..1 @param {number} enforcerCap */
  constructor(index, rng = Math.random, enforcerCap = 3) {
    this.index = index;
    this.rng = rng;
    this.weights = archetypeWeights(index);
    this.enforcerCap = enforcerCap;
    this._enforcers = 0;
  }

  /** Draw the next archetype id, honoring the enforcer cap. */
  next() {
    let id = pickArchetype(this.weights, this.rng());
    if (id === "enforcer") {
      if (this._enforcers >= this.enforcerCap) id = "grunt";
      else this._enforcers++;
    }
    return id;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- enemyDirector`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/game/EnemyDirector.js tests/enemyDirector.test.js
git commit -m "feat(ps1-horror): EnemyDirector archetype composition (Alpha)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A3: EnemyBehavior (anim clamp + steering helpers)

**Files:**
- Create: `src/game/EnemyBehavior.js`
- Test: `tests/enemyBehavior.test.js`

- [ ] **Step 1: Write the failing test (pure helpers only)**

Create `tests/enemyBehavior.test.js`:
```js
import { describe, it, expect } from "vitest";
import { animStep, serpentineOffset } from "../src/game/EnemyBehavior.js";

describe("animStep (stop-motion clamp)", () => {
  it("does not advance until a frame interval has accumulated", () => {
    const r = animStep(0, 0.016, 11); // one 60fps frame at 11fps
    expect(r.advance).toBe(0);
    expect(r.accum).toBeCloseTo(0.016, 5);
  });
  it("advances by exactly one step once accumulated, keeping remainder", () => {
    const r = animStep(0.08, 0.02, 11); // 0.10 >= 1/11 (0.0909)
    expect(r.advance).toBeCloseTo(1 / 11, 5);
    expect(r.accum).toBeCloseTo(0.1 - 1 / 11, 5);
  });
});

describe("serpentineOffset", () => {
  it("is zero at t=0 and oscillates within amplitude", () => {
    expect(serpentineOffset(0, 4, 2)).toBeCloseTo(0, 5);
    for (let t = 0; t < 3; t += 0.1) expect(Math.abs(serpentineOffset(t, 4, 2))).toBeLessThanOrEqual(4 + 1e-9);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- enemyBehavior`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Implement**

Create `src/game/EnemyBehavior.js`:
```js
import * as THREE from "three";

const _toPlayer = new THREE.Vector3();
const _flat = new THREE.Vector3();
const _tan = new THREE.Vector3();

/**
 * Quantise animation advance to a fixed frame rate (PS1 stop-motion). Pure.
 * @returns {{advance:number, accum:number}} advance = dt to feed the mixer (0 or 1/fps)
 */
export function animStep(accum, dt, fps) {
  const step = 1 / Math.max(1, fps);
  accum += dt;
  let advance = 0;
  if (accum >= step) {
    advance = step;
    accum -= step;
  }
  return { advance, accum };
}

/** Lateral zig-zag offset for the breacher. Pure. */
export function serpentineOffset(time, amplitude, frequency) {
  return Math.sin(time * frequency * Math.PI * 2) * amplitude;
}

/** Tick a rigged enemy's mixer at its clamped FPS (visual only — never position). */
export function tickAnim(enemy, dt) {
  if (!enemy.mixer || enemy.dead) return;
  const r = animStep(enemy._animAccum || 0, dt, enemy.animFps || 11);
  enemy._animAccum = r.accum;
  if (r.advance > 0) enemy.mixer.update(r.advance);
}

/** Gunner: hold standoff range, strafe erratically, telegraph + hitscan. */
export function stepGunner(enemy, dt, ctx) {
  const a = enemy.archetypeCfg.ranged;
  const pos = enemy.group.position;
  const playerPos = ctx.player.position;
  _toPlayer.copy(playerPos).sub(pos);
  const dist = _toPlayer.length();
  const see = dist < enemy.sightRange && ctx.level.lineOfSight(enemy.eyePosition(), playerPos);
  enemy.group.rotation.y = Math.atan2(_toPlayer.x, _toPlayer.z);
  _flat.copy(_toPlayer).setY(0).normalize();

  if (see) {
    // Keep distance: back off if too close, advance if too far.
    if (dist < a.standoff - 3) pos.addScaledVector(_flat, -enemy.runSpeed * dt);
    else if (dist > a.standoff + 3) pos.addScaledVector(_flat, enemy.runSpeed * dt);
    // Erratic strafe.
    enemy._strafeT = (enemy._strafeT || 0) - dt;
    if (enemy._strafeT <= 0) {
      enemy._strafeT = a.strafeInterval;
      enemy._strafeDir = Math.random() < 0.5 ? -1 : 1;
    }
    _tan.set(-_flat.z, 0, _flat.x).multiplyScalar(enemy._strafeDir);
    pos.addScaledVector(_tan, enemy.speed * dt);
    enemy._setAnim("run");
    // Fire on interval (telegraph handled by the muzzle flash decay already in Enemy).
    enemy._fireT = (enemy._fireT || a.fireInterval) - dt;
    if (enemy._fireT <= 0) {
      enemy._fireT = a.fireInterval;
      enemy._flashTime = 0.06;
      enemy.flash.material.opacity = 1;
      ctx.player.damage(a.damage);
      ctx.hud.flashDamage();
      ctx.audio.enemyShot(pos, ctx.camera.position);
      ctx.state && ctx.state.emit("enemyShot", { position: pos.clone(), dir: _flat.clone() });
    }
  } else {
    enemy._setAnim("idle");
  }
}

/** Enforcer: slow, relentless beeline down the player's bearing, ignores cover. */
export function stepEnforcer(enemy, dt, ctx) {
  const pos = enemy.group.position;
  const playerPos = ctx.player.position;
  _toPlayer.copy(playerPos).sub(pos);
  const dist = _toPlayer.length();
  enemy.group.rotation.y = Math.atan2(_toPlayer.x, _toPlayer.z);
  _flat.copy(_toPlayer).setY(0).normalize();
  if (dist > enemy.meleeRange) {
    pos.addScaledVector(_flat, enemy.runSpeed * dt); // no LOS / no cover routing
    enemy._setAnim("walk");
  } else {
    enemy._setAnim("walk");
    enemy.meleeTimer -= dt;
    if (enemy.meleeTimer <= 0) {
      enemy.meleeTimer = enemy.meleeCooldown;
      ctx.audio.enforcerStep(pos, ctx.camera.position);
      if (_toPlayer.setY(0).length() <= enemy.meleeRange + 0.5) {
        ctx.player.damage(enemy.damage);
        ctx.hud.flashDamage();
      }
    }
  }
}

/** Breacher: blistering serpentine rush; contact + death both hurt. */
export function stepBreacher(enemy, dt, ctx) {
  const pos = enemy.group.position;
  const playerPos = ctx.player.position;
  _toPlayer.copy(playerPos).sub(pos);
  const dist = _toPlayer.length();
  const see = dist < enemy.sightRange;
  if (see && !enemy._screamed) {
    enemy._screamed = true;
    ctx.audio.enemyScream(pos, ctx.camera.position);
    ctx.state && ctx.state.emit("breacherAggro", { position: pos.clone() });
  }
  enemy.group.rotation.y = Math.atan2(_toPlayer.x, _toPlayer.z);
  _flat.copy(_toPlayer).setY(0).normalize();
  // Serpentine: forward + lateral sine.
  enemy._zigT = (enemy._zigT || 0) + dt;
  const z = enemy.archetypeCfg.zigzag;
  _tan.set(-_flat.z, 0, _flat.x).multiplyScalar(serpentineOffset(enemy._zigT, z.amplitude, z.frequency) * dt);
  pos.addScaledVector(_flat, enemy.runSpeed * dt).add(_tan);
  enemy._setAnim("run");
  // Contact detonation.
  if (dist <= enemy.meleeRange) enemy.takeDamage(enemy.health + 50, _flat, 0);
}

/** Breacher death blast: VFX + audio + point-blank AoE to the player. */
export function detonate(enemy, ctx) {
  const pos = enemy.group.position;
  const d = enemy.archetypeCfg.detonate;
  ctx.state && ctx.state.emit("breacherDetonate", { position: pos.clone() });
  if (ctx.juice) {
    ctx.juice.spawnImpact(pos, "explosion");
    ctx.juice.shake(0.25, 200);
  }
  ctx.audio.explosion(pos, ctx.camera.position);
  if (pos.distanceTo(ctx.player.position) <= d.radius) {
    ctx.player.damage(d.damage);
    ctx.hud.flashDamage();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- enemyBehavior`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/EnemyBehavior.js tests/enemyBehavior.test.js
git commit -m "feat(ps1-horror): EnemyBehavior anim-clamp + archetype steering (Alpha)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A4: Enemy.js hooks

**Files:**
- Modify: `src/game/Enemy.js` (constructor ~21-126; `takeKick` 156-160; `_die` 162-170; `update` 192-224)

- [ ] **Step 1: Import the behavior module + archetype data**

At the top of `src/game/Enemy.js`, after `import * as THREE from "three";` (line 1), add:
```js
import * as EnemyBehavior from "./EnemyBehavior.js";
import ENEMY_TYPES from "../data/enemies.json";

const ENEMY_BY_ID = Object.fromEntries(ENEMY_TYPES.map((e) => [e.id, e]));
```

- [ ] **Step 2: Apply archetype config in the constructor**

In `src/game/Enemy.js`, immediately after the existing defaults block — insert just before `// Patrol / chase` (currently line 34) — add:
```js
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
```
Then, at the END of the constructor (just before its closing `}`, after line 125 `this.height = 1.9;`), add the enforcer up-scale:
```js
    if (arch.scale && arch.scale !== 1) {
      this.group.scale.setScalar(arch.scale);
      this.radius *= arch.scale;
      this.height *= arch.scale;
    }
```
Note: `this.health`/`sightRange`/`meleeRange`/`damage` set here OVERRIDE the literals assigned a few lines above; that is intentional and safe (later assignment wins). Leaving the originals avoids reordering unrelated lines.

- [ ] **Step 3: Respect knockback immunity in `takeKick`**

Replace the body of `takeKick(dir)` (lines 156-160) with:
```js
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
```

- [ ] **Step 4: Flag breacher detonation on death**

In `_die(dir)` (lines 162-170), add as the first line inside the method (before `this.dead = true;`):
```js
    if (this.archetype === "breacher") this._pendingDetonate = true;
```

- [ ] **Step 5: Clamp the animation rate + dispatch archetype behavior in `update`**

(a) Replace line 193 `if (this.mixer && !this.dead) this.mixer.update(dt);` with:
```js
    EnemyBehavior.tickAnim(this, dt);
```

(b) In the dead branch (currently starts line 217 `if (this.dead) {`), insert the detonation handler as the first statement inside the block:
```js
    if (this.dead) {
      if (this._pendingDetonate) {
        this._pendingDetonate = false;
        EnemyBehavior.detonate(this, ctx);
      }
```
(leave the rest of the topple block unchanged).

(c) Immediately after the dead branch closes (after line 224 `}`), before `const playerPos = ctx.player.position;`, insert the archetype dispatch:
```js
    // Non-grunt archetypes run their own steering/attack, then bail out before
    // the baseline grunt melee AI below.
    if (this.archetype === "gunner") { EnemyBehavior.stepGunner(this, dt, ctx); return; }
    if (this.archetype === "enforcer") { EnemyBehavior.stepEnforcer(this, dt, ctx); return; }
    if (this.archetype === "breacher") { EnemyBehavior.stepBreacher(this, dt, ctx); return; }
```

- [ ] **Step 6: Build to verify no syntax/import errors**

Run: `npm run build`
Expected: `✓ built` with no errors. (JSON import via ESM is already used elsewhere; Vite bundles it.)

- [ ] **Step 7: Commit**

```bash
git add src/game/Enemy.js
git commit -m "feat(ps1-horror): Enemy archetypes — gunner/enforcer/breacher + anim clamp (Alpha)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A5: Level.js archetype assignment

**Files:**
- Modify: `src/game/Level.js` (import; constructor; `_addEnemy` 718-733)

- [ ] **Step 1: Import EnemyDirector**

At the top of `src/game/Level.js`, alongside the existing imports, add:
```js
import { EnemyDirector } from "./EnemyDirector.js";
```

- [ ] **Step 2: Construct a director per Level**

In the `Level` constructor, right after `this.enemies = [];` (line 106), add:
```js
    // Archetype mix scales with sector index. Deterministic enough; uses the
    // global RNG so each run varies. Drives _addEnemy when no archetype is given.
    this._director = new EnemyDirector(index || 0);
```

- [ ] **Step 3: Assign an archetype in `_addEnemy`**

In `_addEnemy(pos, opts = {})` (line 718), as the first line inside the method, add:
```js
    if (!opts.archetype) opts.archetype = this._director.next();
```
This flows into `new Enemy(pos, opts)` (line 731), which now reads `opts.archetype`.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: `✓ built`, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/game/Level.js
git commit -m "feat(ps1-horror): Level assigns enemy archetypes via director (Alpha)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A6: Audio — scream + heavy footstep

**Files:**
- Modify: `src/game/Audio.js` (add two methods near `enemyShot`/`enemyMelee`, ~line 153)

- [ ] **Step 1: Add the synth methods**

In `src/game/Audio.js`, immediately after the `enemyShot(...)` method (ends line 153), add:
```js
  /** Breacher aggro shriek — noise burst with a falling, dissonant tone. */
  enemyScream(pos, listenerPos) {
    if (!this._ok()) return;
    const d = pos.distanceTo(listenerPos);
    const vol = Math.max(0.08, Math.min(0.5, 11 / (d + 4)));
    const n = this._noise(0.4);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(1600, this._now());
    bp.frequency.exponentialRampToValueAtTime(500, this._now() + 0.4);
    n.connect(bp);
    this._env(bp, vol, 0.01, 0.4);
    n.start();
    n.stop(this._now() + 0.45);
    this._tone(740, vol * 0.7, 0.4, "sawtooth", 220);
  }

  /** Enforcer footfall — a heavy, distance-attenuated low thud. */
  enforcerStep(pos, listenerPos) {
    if (!this._ok()) return;
    const d = pos.distanceTo(listenerPos);
    const vol = Math.max(0.1, Math.min(0.6, 12 / (d + 5)));
    this._tone(55, vol, 0.35, "sine", 30);
  }
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `✓ built`, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/game/Audio.js
git commit -m "feat(ps1-horror): Audio — breacher scream + enforcer footstep (Alpha)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A7: Verify Alpha live

**Files:** none (verification)

- [ ] **Step 1: Start the dev server (if not already on :1420)**

Run: `npm run dev` (background). Confirm `curl -s -o /dev/null -w "%{http_code}" http://localhost:1420/` prints `200`.

- [ ] **Step 2: Deploy + sample archetypes via the dev handle**

Using the Playwright MCP, navigate to `http://localhost:1420/`, then `browser_evaluate`:
```js
() => {
  const g = window.__game; g._startCampaign();
  const counts = {};
  g.level.enemies.forEach(e => { counts[e.archetype] = (counts[e.archetype]||0)+1; });
  return { sector: g.levelManager.name, total: g.level.enemies.length, counts };
}
```
Expected: `total` > 0 and `counts` is `{ grunt: N }` only on sector 1 (index 0 → grunt-only weights). Re-run after advancing to a later sector (`g._loadLevel(4)`) and expect a mix including `gunner`/`breacher`/`enforcer`.

- [ ] **Step 3: Assert anim clamp does not corrupt positions/colliders**

`browser_evaluate`:
```js
() => {
  const g = window.__game; const e = g.level.enemies[0];
  const before = e.position.clone();
  for (let i=0;i<10;i++) e.update(1/60, g.ctx);
  const box = g.level.getColliders().length;
  return { moved: e.position.distanceTo(before) >= 0, finite: Number.isFinite(e.position.x), colliders: box };
}
```
Expected: `finite: true`, `colliders` is a positive number (collision data intact). No console errors.

- [ ] **Step 4: Screenshot a later sector**

Advance to sector 5 (`g._loadLevel(4)`), position the camera down a lane (reuse the report's camera-aim snippet), `browser_take_screenshot`. Confirm enemies render (no crash). Save as `bc-alpha.jpeg`.

- [ ] **Step 5: No commit (verification only). Record findings in the task notes.**

---

## PHASE B — Beta: Boots & synergistic progression

### Task B1: Abilities engine

**Files:**
- Create: `src/game/Abilities.js`
- Test: `tests/abilities.test.js`

- [ ] **Step 1: Write the failing test (pure helpers)**

Create `tests/abilities.test.js`:
```js
import { describe, it, expect } from "vitest";
import { bootModifiers, isAdrenaline, computeRefund } from "../src/game/Abilities.js";

describe("bootModifiers", () => {
  it("fast_sprint boosts sprint only", () => {
    const m = bootModifiers("fast_sprint");
    expect(m.sprintSpeedMul).toBeGreaterThan(1);
    expect(m.slideDurationMul).toBe(1);
  });
  it("long_slide lengthens + speeds the slide", () => {
    const m = bootModifiers("long_slide");
    expect(m.slideDurationMul).toBeGreaterThan(1);
    expect(m.slideSpeedMul).toBeGreaterThan(1);
  });
  it("unknown/standard is neutral", () => {
    const m = bootModifiers("standard");
    expect(m).toEqual({ sprintSpeedMul: 1, slideSpeedMul: 1, slideDurationMul: 1 });
  });
});

describe("isAdrenaline", () => {
  it("triggers below 30% with the upgrade", () => {
    expect(isAdrenaline(29, 100, true)).toBe(true);
    expect(isAdrenaline(30, 100, true)).toBe(false);
  });
  it("never triggers without the upgrade", () => {
    expect(isAdrenaline(1, 100, false)).toBe(false);
  });
});

describe("computeRefund", () => {
  it("is 15% of the mag, floored, min 1", () => {
    expect(computeRefund(30)).toBe(4);
    expect(computeRefund(12)).toBe(1);
    expect(computeRefund(6)).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- abilities`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Implement**

Create `src/game/Abilities.js`:
```js
import * as THREE from "three";

/** Boot id -> movement modifiers. Unknown/standard => neutral. Pure. */
export function bootModifiers(bootId) {
  switch (bootId) {
    case "fast_sprint": return { sprintSpeedMul: 1.35, slideSpeedMul: 1.0, slideDurationMul: 1.0 };
    case "long_slide": return { sprintSpeedMul: 1.0, slideSpeedMul: 1.25, slideDurationMul: 1.8 };
    default: return { sprintSpeedMul: 1.0, slideSpeedMul: 1.0, slideDurationMul: 1.0 };
  }
}

/** Adrenaline triggers below 30% HP when the upgrade is owned. Pure. */
export function isAdrenaline(health, maxHealth, hasUpgrade) {
  if (!hasUpgrade || maxHealth <= 0) return false;
  return health / maxHealth < 0.3;
}

/** Ammo refunded by a point-blank kick kill (Scavenger's Refund). Pure. */
export function computeRefund(magSize, fraction = 0.15) {
  return Math.max(1, Math.floor(magSize * fraction));
}

const ADRENALINE_SPEED_MUL = 1.25;
const POINT_BLANK = 2.2;
const _dir = new THREE.Vector3();

/**
 * Abilities
 * ---------
 * The single home for rule-breaking boot + horror-upgrade logic, on ctx.abilities.
 * Player/Weapon call into it; it reads equipped boot + upgrade levels from
 * ctx.progression and emits "adrenaline" on the bus when the low-HP state flips.
 */
export class Abilities {
  constructor(state) {
    this.state = state;
    this.ctx = null;
    this._adrenaline = false;
    this._mods = bootModifiers("standard");
  }

  setContext(ctx) { this.ctx = ctx; }

  /** Recompute from the equipped boot at level start; subscribe to damage. */
  attach() {
    this.refresh();
    this.state.on("damage", () => this._checkAdrenaline());
    this.state.on("runStart", () => { this._adrenaline = false; this.refresh(); });
  }

  /** Re-read the equipped boot (call when loadout changes / level loads). */
  refresh() {
    const prog = this.state.getProgression();
    this._mods = bootModifiers(prog.boots && prog.boots.equipped);
    this._adrenaline = false;
  }

  _hasUpgrade(id) {
    const up = this.state.getProgression().upgrades || {};
    return (up[id] || 0) > 0;
  }

  get sprintSpeedMul() { return this._mods.sprintSpeedMul * (this._adrenaline ? ADRENALINE_SPEED_MUL : 1); }
  get walkSpeedMul() { return this._adrenaline ? ADRENALINE_SPEED_MUL : 1; }
  get slideSpeedMul() { return this._mods.slideSpeedMul; }
  get slideDurationMul() { return this._mods.slideDurationMul; }
  /** Adrenaline turns the kick into a full 360° clear. */
  get kickFullRadius() { return this._adrenaline; }

  _checkAdrenaline() {
    const p = this.ctx && this.ctx.player;
    if (!p) return;
    const active = isAdrenaline(p.health, p.maxHealth, this._hasUpgrade("adrenaline_leak"));
    if (active !== this._adrenaline) {
      this._adrenaline = active;
      this.state.emit("adrenaline", { active });
    }
  }

  /** Called by Player on a connecting kick. Explosive boots → shockwave. */
  onKick({ point }) {
    const boots = this.state.getProgression().boots;
    if (!boots || boots.equipped !== "explosive_kick" || !point) return;
    const ctx = this.ctx;
    if (ctx.weapon && ctx.weapon.explosionFx) ctx.weapon.explosionFx(point);
    if (ctx.juice) { ctx.juice.spawnImpact(point, "explosion"); ctx.juice.shake(0.18, 160); }
    ctx.audio && ctx.audio.explosion(point, ctx.camera.position);
    ctx.state && ctx.state.emit("explosion", { position: point.clone ? point.clone() : point });
    // Radial damage to nearby living enemies (mirrors barrel logic).
    for (const e of ctx.level.enemies) {
      if (e.dead) continue;
      if (e.position.distanceTo(point) <= 3.2) {
        _dir.copy(e.position).sub(point).setY(0).normalize();
        e.takeDamage(120, _dir, 8);
      }
    }
  }

  /** Called by Player on a kick KILL. Scavenger's Refund tops up the mag. */
  onKickKill({ distance }) {
    if (!this._hasUpgrade("scavenger_refund")) return;
    if (distance > POINT_BLANK) return;
    const ctx = this.ctx;
    if (ctx.weapon && ctx.weapon.addAmmo) {
      ctx.weapon.addAmmo(computeRefund(ctx.weapon.current.mag));
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- abilities`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/Abilities.js tests/abilities.test.js
git commit -m "feat(ps1-horror): Abilities engine — boots + adrenaline + refund (Beta)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B2: Horror upgrades data

**Files:**
- Modify: `src/data/upgrades.json`

- [ ] **Step 1: Confirm `steady_aim` is unused before removing it**

Run: `grep -rn "steady_aim" src/`
Expected: matches ONLY in `src/data/upgrades.json` (the Menu renders upgrades generically; gameplay only reads `thick_skin` in `main.js`). If any `.js` references `steady_aim` by id, STOP and report.

- [ ] **Step 2: Rewrite the file**

Replace the entire contents of `src/data/upgrades.json` with:
```json
[
  {
    "id": "kick_master",
    "name": "Kick Master",
    "desc": "Bigger boot radius and bone-cracking knockback.",
    "maxLevel": 3,
    "cost": [50, 120, 250],
    "effect": { "type": "kickPower", "perLevel": 0.15 }
  },
  {
    "id": "thick_skin",
    "name": "Thick Skin",
    "desc": "More health. Belfast hardens what it does not kill.",
    "maxLevel": 3,
    "cost": [60, 140, 300],
    "effect": { "type": "maxHealth", "perLevel": 0.25 }
  },
  {
    "id": "adrenaline_leak",
    "name": "Adrenaline Leak",
    "desc": "Below 30% health: a surge of speed and your boot clears a full 360°. The world swims at the edges.",
    "maxLevel": 1,
    "cost": [180],
    "effect": { "type": "adrenaline", "perLevel": 1 }
  },
  {
    "id": "scavenger_refund",
    "name": "Scavenger's Refund",
    "desc": "A point-blank boot kill jams 15% of a magazine straight back into your gun.",
    "maxLevel": 1,
    "cost": [160],
    "effect": { "type": "kick_ammo_refund", "perLevel": 0.15 }
  }
]
```

- [ ] **Step 3: Build + verify the Hub upgrades panel renders**

Run: `npm run build` (expect `✓ built`). Then with the dev server up, open the Hub → Upgrades panel via Playwright and confirm 4 upgrades list with costs (no crash). The Menu reads the JSON generically, so no Menu code change is needed.

- [ ] **Step 4: Commit**

```bash
git add src/data/upgrades.json
git commit -m "feat(ps1-horror): swap steady_aim for adrenaline_leak + scavenger_refund (Beta)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B3: Player.js ability hooks

**Files:**
- Modify: `src/game/Player.js` (`update` targetSpeed 183-184; `_startSlide` 291-299; `_kick` 312-385)

- [ ] **Step 1: Apply boot + adrenaline speed to `targetSpeed`**

In `update(dt)`, replace lines 183-184:
```js
    let targetSpeed = (sprinting ? SPRINT_SPEED : WALK_SPEED) * this.speedMul;
    if (this.sliding) targetSpeed = SLIDE_SPEED * (this.slideTimer / 0.7);
```
with:
```js
    const ab = this.ctx && this.ctx.abilities;
    const sprintMul = sprinting ? (ab ? ab.sprintSpeedMul : 1) : (ab ? ab.walkSpeedMul : 1);
    let targetSpeed = (sprinting ? SPRINT_SPEED : WALK_SPEED) * this.speedMul * sprintMul;
    if (this.sliding) targetSpeed = SLIDE_SPEED * (ab ? ab.slideSpeedMul : 1) * (this.slideTimer / 0.7);
```

- [ ] **Step 2: Lengthen the slide for `long_slide` boots**

In `_startSlide()` (line 291), replace `this.slideTimer = 0.7;` (line 293) with:
```js
    const ab = this.ctx && this.ctx.abilities;
    this.slideTimer = 0.7 * (ab ? ab.slideDurationMul : 1);
```
and replace the two `SLIDE_SPEED` assignments (lines 296-297):
```js
    this.vel.x = (this.vel.x / sp) * SLIDE_SPEED;
    this.vel.z = (this.vel.z / sp) * SLIDE_SPEED;
```
with:
```js
    const slideSpeed = SLIDE_SPEED * (ab ? ab.slideSpeedMul : 1);
    this.vel.x = (this.vel.x / sp) * slideSpeed;
    this.vel.z = (this.vel.z / sp) * slideSpeed;
```

- [ ] **Step 3: 360° kick under adrenaline + ability callbacks in `_kick`**

(a) At the top of `_kick()`, after `this._basisFromYaw();` (line 316), add:
```js
    const cone = this.ctx.abilities && this.ctx.abilities.kickFullRadius ? -1.1 : KICK_CONE;
    let kickPoint = null;
```
(b) In the THREE cone tests inside `_kick` (door loop line 328, enemy loop 352, barrel loop 378), replace each `KICK_CONE` with `cone`. There are three occurrences — replace all three.
(c) In the enemy branch, right after `e.takeKick(_tmp);` (line 353), add:
```js
        kickPoint = e.position.clone();
        this.ctx.abilities && this.ctx.abilities.onKickKill({ distance: dist });
```
(d) In the door branch, after `door.kick();` (line 329), add:
```js
        if (!kickPoint) kickPoint = door.center.clone();
```
(e) At the very end of `_kick()`, replace `if (!connected) this.ctx.audio.kickWhiff();` (line 384) with:
```js
    if (connected) {
      const pt = kickPoint || this.camera.position.clone().addScaledVector(_forward, KICK_RANGE * 0.6);
      this.ctx.abilities && this.ctx.abilities.onKick({ point: pt });
    } else {
      this.ctx.audio.kickWhiff();
    }
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: `✓ built`, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/game/Player.js
git commit -m "feat(ps1-horror): Player reads boot/adrenaline abilities + 360 kick (Beta)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B4: Weapon.addAmmo

**Files:**
- Modify: `src/game/Weapon.js` (add a method near `reload()` ~line 245)

- [ ] **Step 1: Add `addAmmo`**

In `src/game/Weapon.js`, immediately after the `reload()` method (ends line 245), add:
```js
  /** Top up the current magazine (Scavenger's Refund). Clamped to mag size. */
  addAmmo(n) {
    const w = this.current;
    this.ammo[this.index] = Math.min(w.mag, this.ammo[this.index] + n);
    if (this.ctx) this.ctx.hud.setAmmo(this.ammo[this.index], w.mag, this.reloading);
  }
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `✓ built`, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/game/Weapon.js
git commit -m "feat(ps1-horror): Weapon.addAmmo for kick refund (Beta)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B5: HUD adrenaline distortion overlay

**Files:**
- Modify: `src/game/HUD.js` (constructor ~9-28; add `setAdrenaline`; `update` 120-125)

- [ ] **Step 1: Create the overlay element + state in the constructor**

In the `HUD` constructor, after `this._damageT = 0;` (line 27), add:
```js
    // Adrenaline distortion layer (built in JS so index.html stays untouched).
    this._adrenaline = document.createElement("div");
    this._adrenaline.id = "hud-adrenaline";
    Object.assign(this._adrenaline.style, {
      position: "fixed", inset: "0", pointerEvents: "none", opacity: "0",
      transition: "opacity 0.25s ease", zIndex: "40",
      boxShadow: "inset 0 0 220px 60px rgba(150,0,0,0.85)",
      background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(40,0,0,0.35) 100%)",
      mixBlendMode: "multiply",
    });
    document.body.appendChild(this._adrenaline);
    this._adrenalinePulse = 0;
    this._adrenalineOn = false;
    this._adrenalineFx = true; // toggled via settings
```

- [ ] **Step 2: Add `setAdrenaline` + a settings toggle**

After `setCrosshairActive(...)` (ends line 106), add:
```js
  /** Enable/disable the low-HP distortion FX (settings toggle; default on). */
  setAdrenalineFxEnabled(enabled) {
    this._adrenalineFx = enabled !== false;
    if (!this._adrenalineFx) {
      this._adrenalineOn = false;
      this._adrenaline.style.opacity = "0";
      document.getElementById("hud") && (document.getElementById("hud").style.filter = "");
    }
  }

  /** Toggle the adrenaline state (desaturate HUD + pulsing red vignette). The
   *  health readout stays legible — distort, don't blackout. */
  setAdrenaline(active) {
    if (!this._adrenalineFx) return;
    this._adrenalineOn = !!active;
    const hud = document.getElementById("hud");
    if (hud) hud.style.filter = active ? "grayscale(0.85) contrast(1.1)" : "";
    if (!active) this._adrenaline.style.opacity = "0";
  }
```

- [ ] **Step 3: Pulse the vignette in `update`**

Replace the `update(dt)` body (lines 120-125) with:
```js
  update(dt) {
    if (this._damageT > 0) {
      this._damageT -= dt;
      if (this.vignette) this.vignette.style.opacity = Math.max(0, this._damageT / 0.35) * 0.8;
    }
    if (this._adrenalineOn) {
      this._adrenalinePulse += dt * 5;
      const o = 0.45 + Math.sin(this._adrenalinePulse) * 0.25;
      this._adrenaline.style.opacity = String(o);
    }
  }
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: `✓ built`, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/game/HUD.js
git commit -m "feat(ps1-horror): HUD adrenaline distortion overlay (Beta)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B6: Wire Abilities into main.js

**Files:**
- Modify: `src/main.js` (imports ~10-21; constructor systems ~76-122; `_loadLevel` ~213-273)

- [ ] **Step 1: Import + instantiate Abilities**

(a) After the existing system imports (line 21), add:
```js
import { Abilities } from "./game/Abilities.js";
```
(b) In the constructor, after `this.modifiers = new Modifiers(this.state);` (line 84), add:
```js
    this.abilities = new Abilities(this.state);
```
(c) In the `this.ctx = { ... }` object, after `modifiers: this.modifiers,` (line 113), add:
```js
      abilities: this.abilities,
```
(d) After `this.juice.setContext(this.ctx);` (line 119), add:
```js
    this.abilities.setContext(this.ctx);
    this.abilities.attach();
    // Drive the HUD distortion from the adrenaline event.
    this.state.on("adrenaline", ({ active }) => this.hud.setAdrenaline(active));
    // Honor the persisted FX toggle (default on).
    const adrFx = this.state.getProgression().settings;
    if (adrFx && adrFx.adrenalineFx === false) this.hud.setAdrenalineFxEnabled(false);
```

- [ ] **Step 2: Refresh the equipped boot each level load**

In `_loadLevel(index)`, after `this.modifiers.clear();` (line 217), add:
```js
    this.abilities.refresh();
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `✓ built`, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main.js
git commit -m "feat(ps1-horror): wire Abilities + adrenaline HUD into orchestrator (Beta)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B7: Verify Beta live

**Files:** none (verification)

- [ ] **Step 1: Equip explosive boots + grant upgrades via the dev handle, then test**

Playwright `browser_evaluate` (before starting a run):
```js
() => {
  const g = window.__game; const p = g.state.getProgression();
  p.boots.owned = ["standard","explosive_kick","long_slide","fast_sprint"];
  p.boots.equipped = "explosive_kick";
  p.upgrades = { adrenaline_leak: 1, scavenger_refund: 1, thick_skin: 1 };
  g.progression.save(); g._startCampaign(); g.abilities.refresh();
  return { equipped: p.boots.equipped, sprintMul: g.abilities.sprintSpeedMul, slideMul: g.abilities.slideDurationMul };
}
```
Expected: `equipped: "explosive_kick"`, multipliers defined (sprint 1.0 for these boots, slide 1.0). Swap to `fast_sprint`/`long_slide` and re-check `sprintMul`/`slideMul` change as in `bootModifiers`.

- [ ] **Step 2: Adrenaline flip + 360° kick**

`browser_evaluate`:
```js
() => {
  const g = window.__game;
  g.player.maxHealth = 100; g.player.health = 20; // below 30%
  g.abilities._checkAdrenaline();
  return { adrenaline: g.abilities.kickFullRadius };
}
```
Expected: `adrenaline: true`. Confirm a console/DOM check that `#hud-adrenaline` opacity rises and `#hud` gets a grayscale filter (the `adrenaline` event fired → `setAdrenaline(true)`).

- [ ] **Step 3: Refund**

`browser_evaluate`: set ammo low, call `g.abilities.onKickKill({distance:1})`, read `g.weapon.ammo[g.weapon.index]` before/after.
Expected: ammo increases by `computeRefund(mag)` (clamped to mag).

- [ ] **Step 4: No commit (verification only).**

---

## PHASE G — Gamma: PS1 retro pipeline

### Task G1: RetroMaterial

**Files:**
- Create: `src/game/RetroMaterial.js`
- Test: `tests/retroMaterial.test.js`

- [ ] **Step 1: Write the failing test (pure resolution math)**

Create `tests/retroMaterial.test.js`:
```js
import { describe, it, expect } from "vitest";
import { computeResolution } from "../src/game/RetroMaterial.js";

describe("computeResolution", () => {
  it("keeps the target vertical resolution and scales x by aspect", () => {
    const r = computeResolution(1920, 1080, 240);
    expect(r.y).toBe(240);
    expect(r.x).toBe(Math.round(240 * (1920 / 1080)));
  });
  it("degrades gracefully on zero size", () => {
    const r = computeResolution(0, 0, 240);
    expect(r).toEqual({ x: 240, y: 240 });
  });
  it("never returns < 1", () => {
    const r = computeResolution(100, 100, 0);
    expect(r.x).toBeGreaterThanOrEqual(1);
    expect(r.y).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- retroMaterial`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Implement**

Create `src/game/RetroMaterial.js`:
```js
import * as THREE from "three";

/**
 * The PS1 "stylized hybrid" look. Two effects:
 *   1) Nearest-filter textures (crunchy, no bilinear smoothing).
 *   2) Vertex snapping — clip-space xy quantised to a low-res grid in the vertex
 *      shader (authentic PS1 wiggle) WITHOUT touching JS positions, so collision
 *      and pooling are unaffected.
 * ACES tone-mapping + PMREM/HDRI lighting are intentionally KEPT (hybrid).
 */

/** Effective snap grid for a viewport. Lower target => chunkier wiggle. Pure. */
export function computeResolution(width, height, targetHeight = 240) {
  const h = Math.max(1, targetHeight);
  const aspect = width > 0 && height > 0 ? width / height : 1;
  return { x: Math.max(1, Math.round(h * aspect)), y: h };
}

export class RetroMaterial {
  constructor({ targetHeight = 240 } = {}) {
    this.targetHeight = targetHeight;
    this.uniforms = { uSnap: { value: new THREE.Vector2(426, 240) } };
    this._patched = new Set();
  }

  setViewport(width, height) {
    const r = computeResolution(width, height, this.targetHeight);
    this.uniforms.uSnap.value.set(r.x, r.y);
  }

  /** Nearest-filter a texture in place. */
  applyTextureFilter(tex) {
    if (!tex) return tex;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  /** Inject vertex snapping into a material via onBeforeCompile (idempotent). */
  patchMaterial(mat) {
    if (!mat || this._patched.has(mat)) return mat;
    this._patched.add(mat);
    const uSnap = this.uniforms.uSnap;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader) => {
      if (prev) prev(shader);
      shader.uniforms.uSnap = uSnap;
      shader.vertexShader = "uniform vec2 uSnap;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        {
          vec4 snapPos = gl_Position;
          snapPos.xyz /= snapPos.w;
          snapPos.xy = floor(snapPos.xy * uSnap) / uSnap;
          snapPos.xyz *= snapPos.w;
          gl_Position = snapPos;
        }`,
      );
    };
    mat.needsUpdate = true;
    return mat;
  }

  /** Patch every material under an Object3D (GLB models). */
  patchObject(obj) {
    if (!obj) return obj;
    obj.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => this.patchMaterial(m));
    });
    return obj;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- retroMaterial`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/RetroMaterial.js tests/retroMaterial.test.js
git commit -m "feat(ps1-horror): RetroMaterial nearest-filter + vertex-snap (Gamma)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task G2: Route AssetManager through RetroMaterial

**Files:**
- Modify: `src/game/AssetManager.js` (constructor; shared-material build ~108; texture load ~124-130; `getModel`)

- [ ] **Step 1: Hold a RetroMaterial instance**

(a) At the top of `src/game/AssetManager.js`, add to the imports:
```js
import { RetroMaterial } from "./RetroMaterial.js";
```
(b) In the `AssetManager` constructor, near `this.texLoader = new THREE.TextureLoader();` (line 93), add:
```js
    this.retro = new RetroMaterial({ targetHeight: 240 });
    this.retro.setViewport(window.innerWidth, window.innerHeight);
```

- [ ] **Step 2: Nearest-filter loaded world textures**

In the texture-load callback (the block at lines 127-130 that sets `wrapS/wrapT`, `anisotropy`, `colorSpace`), add after the existing assignments (after line 130):
```js
          this.retro.applyTextureFilter(tex);
```
This applies to the tiled world textures. Do NOT add it to the `RGBELoader` HDRI loads (lines 563/585) — environment maps must stay smooth.

- [ ] **Step 3: Vertex-snap the shared world materials**

After the shared material is created at line 108 (`this.materials[slug] = new THREE.MeshStandardMaterial({...})`), patch it. Insert immediately after that assignment statement closes:
```js
      this.retro.patchMaterial(this.materials[slug]);
```

- [ ] **Step 4: Vertex-snap GLB model materials**

Find `getModel(slug)`. At its return site (wherever it returns the cloned/loaded `THREE.Object3D`), wrap the returned object with `this.retro.patchObject(obj)` before returning. Concretely, change `return obj;` (or the equivalent return of the model group) to:
```js
      return this.retro.patchObject(obj);
```
If `getModel` returns in multiple places, patch at each return that yields a model object. (Search: `grep -n "getModel" src/game/AssetManager.js` then read the method.)

- [ ] **Step 5: Build + Playwright visual check**

Run: `npm run build` (expect `✓ built`). With the dev server, start a run and screenshot a brick wall (reuse the report's camera snippet). Save `bc-gamma-tex.jpeg`.
Expected: brick texture shows crisp, blocky nearest-neighbour pixels (no smooth bilinear blur); slight vertex wiggle visible when nudging the camera. No console errors.

- [ ] **Step 6: Assert collision unaffected by the shader snap**

`browser_evaluate`:
```js
() => {
  const g = window.__game;
  const before = g.player.pos.clone();
  for (let i=0;i<30;i++) g.player.update(1/60);
  return { finite: Number.isFinite(g.player.pos.x) && Number.isFinite(g.player.pos.y), colliders: g.level.getColliders().length };
}
```
Expected: `finite: true`, colliders > 0 (vertex snap is GPU-only; JS state intact).

- [ ] **Step 7: Commit**

```bash
git add src/game/AssetManager.js
git commit -m "feat(ps1-horror): route textures/materials through RetroMaterial (Gamma)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task G3: Claustrophobic fog

**Files:**
- Modify: `src/game/Engine.js` (fog line 40; sky dome radius line 62; camera far line 47)

- [ ] **Step 1: Tighten fog, darken it, pull the far plane + dome in**

(a) Replace line 40:
```js
    this.scene.fog = new THREE.FogExp2(0x868c90, 0.015);
```
with:
```js
    this.scene.fog = new THREE.FogExp2(0x3c4042, 0.05); // claustrophobic PS1 mist (~18m)
```
(b) In `_buildSky`, replace `new THREE.SphereGeometry(300, 24, 12)` (line 62) with:
```js
    const geo = new THREE.SphereGeometry(150, 24, 12);
```
(c) Replace the camera far plane `400` (line 47) with `160`:
```js
    this.camera = new THREE.PerspectiveCamera(
      78,
      window.innerWidth / window.innerHeight,
      0.05,
      160,
    );
```
(d) Optional matching mood: darken the background fallback at line 37 `this.scene.background = skyBottom.clone();` is fine as-is (HDRI overrides it); leave it.

- [ ] **Step 2: Build + screenshot the establishing view**

Run: `npm run build` (expect `✓ built`). Start a run, take the elevated establishing screenshot (reuse the report's `(55,40,95)→(0,2,0)` camera). Save `bc-gamma-fog.jpeg`.
Expected: the far blocks are swallowed by dark mist within ~15-25m; the scene reads tight and oppressive but the near street is still playable/visible.

- [ ] **Step 3: Sanity-check ranged fairness**

Confirm a gunner at its `standoff` (16m) is faintly visible through the fog (not fully invisible). If invisible, the fog density is too high — reduce `0.05 → 0.04` and re-screenshot. Record the chosen value.

- [ ] **Step 4: Commit**

```bash
git add src/game/Engine.js
git commit -m "feat(ps1-horror): claustrophobic fog + tight far plane (Gamma)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task G4: Decals (ring-buffered persistent blood)

**Files:**
- Create: `src/game/Decals.js`
- Test: `tests/decals.test.js`

**Decision (deviation from spec, intentional):** the world uses AABB `Box3` colliders with no per-hit mesh/face, so `THREE.DecalGeometry` (which samples a target mesh) does not apply. We use flat oriented quads instead — cheaper, pool-friendly, and a better match for the flat, aliased PS1 decal look. Persistence + the 100-cap ring buffer from the spec are preserved.

- [ ] **Step 1: Write the failing test (ring buffer + cap)**

Create `tests/decals.test.js`:
```js
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { ringNext, Decals } from "../src/game/Decals.js";

describe("ringNext", () => {
  it("wraps at the cap", () => {
    expect(ringNext(0, 100)).toBe(1);
    expect(ringNext(99, 100)).toBe(0);
  });
});

describe("Decals", () => {
  it("never exceeds the cap and reuses meshes", () => {
    const scene = new THREE.Scene();
    const decals = new Decals(scene, 5);
    for (let i = 0; i < 12; i++) decals.bloodPool(new THREE.Vector3(i, 0, 0));
    expect(decals.group.children.length).toBe(5); // capped, reused
  });

  it("clear() hides everything and resets the cursor", () => {
    const scene = new THREE.Scene();
    const decals = new Decals(scene, 5);
    decals.bloodPool(new THREE.Vector3(0, 0, 0));
    decals.clear();
    expect(decals.group.children.every((m) => m.visible === false)).toBe(true);
    expect(decals._cursor).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- decals`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Implement**

Create `src/game/Decals.js`:
```js
import * as THREE from "three";

/** Ring-buffer slot after `i` for capacity `cap`. Pure. */
export function ringNext(i, cap) {
  return (i + 1) % cap;
}

/**
 * Decals — persistent, flat, retro blood pools + bullet holes.
 *
 * The world uses AABB colliders (no per-hit mesh/face), so THREE.DecalGeometry
 * isn't applicable. We lay flat quads on the surface and keep them for the
 * level's lifetime, ring-buffered at a hard cap. Matches the PS1 look (flat,
 * aliased decals) and fits the existing pooling discipline.
 */
const _q = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _up = new THREE.Vector3(0, 1, 0);

export class Decals {
  constructor(scene, cap = 100) {
    this.cap = cap;
    this.group = new THREE.Group();
    this.group.name = "decals";
    scene.add(this.group);
    this._slots = new Array(cap).fill(null);
    this._cursor = 0;
    this.ctx = null;
    this._unsub = [];

    this.bloodMat = new THREE.MeshBasicMaterial({
      color: 0x6e0b0b, transparent: true, opacity: 0.92,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, fog: true,
    });
    this.holeMat = new THREE.MeshBasicMaterial({
      color: 0x141414, transparent: true, opacity: 0.85,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, fog: true,
    });
    this._geo = new THREE.PlaneGeometry(1, 1);
  }

  setContext(ctx) { this.ctx = ctx; }

  attach() {
    const bus = this.ctx.state;
    this._unsub.push(bus.on("kill", (p) => p && p.position && this.bloodPool(p.position)));
    this._unsub.push(bus.on("explosion", (p) => p && p.position && this.bloodPool(p.position, 2.0)));
    this._unsub.push(bus.on("surfaceHit", (p) => p && p.position && this.bulletHole(p.position, p.normal)));
  }

  /** Flat blood pool on the ground under a death/explosion. */
  bloodPool(position, scale = 1) {
    const s = (0.7 + Math.random() * 0.8) * scale;
    const m = this._place(this.bloodMat, position.x, 0.02, position.z, _up, s);
    m.rotateZ(Math.random() * Math.PI); // spin in the ground plane (local +Z = up)
  }

  /** Bullet hole oriented to a surface normal. */
  bulletHole(position, normal) {
    const n = normal || _up;
    const s = 0.18 + Math.random() * 0.12;
    this._place(this.holeMat, position.x, position.y, position.z, n, s, 0.02);
  }

  _place(mat, x, y, z, normal, scale, lift = 0) {
    let mesh = this._slots[this._cursor];
    if (!mesh) {
      mesh = new THREE.Mesh(this._geo, mat);
      this.group.add(mesh);
      this._slots[this._cursor] = mesh;
    } else {
      mesh.material = mat;
      mesh.visible = true;
    }
    _q.setFromUnitVectors(_zAxis, normal); // orient quad +Z to the surface normal
    mesh.quaternion.copy(_q);
    mesh.position.set(x + normal.x * lift, y + normal.y * lift, z + normal.z * lift);
    mesh.scale.set(scale, scale, scale);
    this._cursor = ringNext(this._cursor, this.cap);
    return mesh;
  }

  clear() {
    for (const m of this._slots) if (m) m.visible = false;
    this._cursor = 0;
  }

  dispose(scene) {
    this._unsub.forEach((u) => u && u());
    this._unsub.length = 0;
    scene.remove(this.group);
    this._geo.dispose();
    this.bloodMat.dispose();
    this.holeMat.dispose();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- decals`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/Decals.js tests/decals.test.js
git commit -m "feat(ps1-horror): ring-buffered persistent blood decals (Gamma)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task G5: Wire Decals + RetroMaterial.update + surfaceHit event

**Files:**
- Modify: `src/main.js` (imports; constructor; `_loadLevel`; loop)
- Modify: `src/game/Weapon.js` (`_fireRay` wall branch ~347-350)

- [ ] **Step 1: Emit `surfaceHit` on a wall hit**

In `src/game/Weapon.js` `_fireRay`, the final `else` branch (lines 347-350, the wall-hit case) currently:
```js
    } else {
      this._spawnImpact(wPoint, 0xffcc66, false);
      this._tracer(_origin, wPoint);
    }
```
Replace with:
```js
    } else {
      this._spawnImpact(wPoint, 0xffcc66, false);
      this._tracer(_origin, wPoint);
      // Persistent bullet-hole decal (normal ≈ toward the shooter).
      this.ctx.state && this.ctx.state.emit("surfaceHit", {
        position: wPoint.clone(),
        normal: _dir.clone().multiplyScalar(-1),
      });
    }
```

- [ ] **Step 2: Instantiate + wire Decals in main.js**

(a) After the `Abilities` import (added in B6), add:
```js
import { Decals } from "./game/Decals.js";
```
(b) In the constructor, after `this.abilities = new Abilities(this.state);`, add:
```js
    this.decals = new Decals(this.engine.scene, 100);
```
(c) After `this.abilities.attach();` (added in B6), add:
```js
    this.decals.setContext(this.ctx);
    this.decals.attach();
```

- [ ] **Step 3: Clear decals on each level load**

In `_loadLevel(index)`, after `this.abilities.refresh();` (added in B6), add:
```js
    this.decals.clear();
```

- [ ] **Step 4: Keep the snap grid in sync with the viewport**

In the constructor, the renderer resize is owned by `Engine`. The `AssetManager` holds the live `RetroMaterial` (`this.assets.retro`). Add a resize listener after `this._bindUI();` (line 173):
```js
    window.addEventListener("resize", () => {
      this.assets.retro && this.assets.retro.setViewport(window.innerWidth, window.innerHeight);
    });
```
(The `uSnap` uniform is shared by reference across all patched materials, so this one update reaches the whole world. No per-frame update needed.)

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: `✓ built`, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/game/Weapon.js src/main.js
git commit -m "feat(ps1-horror): wire decals + surfaceHit + retro resize (Gamma)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task G6: Verify Gamma live

**Files:** none (verification)

- [ ] **Step 1: Persistent blood**

Start a run, kick/shoot some enemies via the dev handle (or emit kills): `browser_evaluate`:
```js
() => {
  const g = window.__game;
  for (let i=0;i<6;i++) g.state.emit("kill", { position: { x: -10+i*2, y: 0, z: 50, clone(){return {...this}} } });
  return { decals: g.decals.group.children.length };
}
```
Expected: `decals` grows (≤100) and the quads remain (don't vanish after 1s). Screenshot the ground to confirm crimson pools persist. Save `bc-gamma-blood.jpeg`.

- [ ] **Step 2: Cap holds**

Emit 150 kills in a loop; confirm `g.decals.group.children.length === 100` (ring buffer caps; no unbounded growth).

- [ ] **Step 3: No commit (verification only).**

---

## PHASE QA — Integration, build, docs

### Task QA1: Full build + console-error sweep

- [ ] **Step 1: Production build**

Run: `npm run build`
Expected: `✓ built` with zero errors. Note the bundle size (three.js dominates; a size increase of a few KB is expected).

- [ ] **Step 2: Unit suite**

Run: `npm test`
Expected: all suites pass (smoke, enemyDirector, enemyBehavior, abilities, retroMaterial, decals).

- [ ] **Step 3: Steam stays OFF**

Run: `grep -rn "steamworks" src-tauri/Cargo.toml`
Expected: still `optional = true` and gated behind the `steam` feature; no Rust files were modified this pass. Confirm `git diff --name-only feat/hybrid-loop..HEAD -- src-tauri/` returns nothing.

### Task QA2: Full Playwright playtest

- [ ] **Step 1: Boot + zero console errors (besides favicon 404)**

Navigate to `http://localhost:1420/`, `browser_console_messages` (level error).
Expected: only the known `favicon.ico` 404; no game errors.

- [ ] **Step 2: Capture the showcase screenshots**

Deploy into a late sector with the horror loadout (explosive boots + adrenaline upgrade, low HP) and capture: fogged street, a gunner muzzle flash in fog, an enforcer silhouette, a breacher detonation (emit a breacher kill), persistent blood decals, and the adrenaline HUD distortion. Save under `docs/superpowers/plans/assets/`.

- [ ] **Step 3: Frame-stability + pool/collision assertion**

`browser_evaluate` run ~120 simulated frames advancing player + all enemies + weapon; assert all positions finite, `getColliders().length > 0`, `decals.group.children.length <= 100`, and `weapon.effects.length <= 80`.
Expected: all true (no pool drift, no NaN from the shader snap or anim clamp).

### Task QA3: Update CONTRACTS.md

**Files:**
- Modify: `CONTRACTS.md` (ownership table §0; event catalog §3)

- [ ] **Step 1: Register the new files in the ownership table**

Add rows under §0:
```
| `src/game/EnemyDirector.js`, `src/game/EnemyBehavior.js`, `src/data/enemies.json` | **Alpha** | archetype composition + behavior + data |
| `src/game/Abilities.js` | **Beta** | boot + horror-upgrade engine (ctx.abilities) |
| `src/game/RetroMaterial.js`, `src/game/Decals.js` | **Gamma** | PS1 material pipeline + persistent decals |
```

- [ ] **Step 2: Add the new bus events to the §3 catalog**

```
| `enemyShot` | `{position, dir}` | gunner (Alpha) |
| `breacherAggro` | `{position}` | breacher detection (Alpha) |
| `breacherDetonate` | `{position}` | breacher death (Alpha) |
| `adrenaline` | `{active}` | Abilities (Beta) |
| `surfaceHit` | `{position, normal}` | Weapon wall hit → Decals (Gamma) |
```

- [ ] **Step 3: Commit**

```bash
git add CONTRACTS.md
git commit -m "docs(ps1-horror): register new modules + bus events in CONTRACTS (QA)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task QA4: Finish the branch

- [ ] **Step 1: Confirm the diff scope**

Run: `git diff --stat feat/hybrid-loop..HEAD`
Expected: only files listed in the File Map (plus the spec/plan docs). No stray files from outside the game subrepo.

- [ ] **Step 2: Invoke `superpowers:finishing-a-development-branch`**

Use the skill to choose merge / PR / cleanup. Do NOT merge automatically — present options and confirm with the user (the game subrepo's default integration branch is `feat/hybrid-loop`).

---

## Spec Coverage Check

- Alpha anim clamp → A3 (`animStep`/`tickAnim`), A4 (Enemy hook), verified A7-Step3.
- Gunner → A1 data, A3 `stepGunner`, A4 dispatch, audio A6 (reuses `enemyShot`).
- Enforcer (knockback-immune, ignores cover) → A1, A3 `stepEnforcer`, A4 `takeKick` immunity + scale, A6 footstep.
- Breacher (zig-zag, scream, detonate) → A1, A3 `stepBreacher`/`detonate`/`serpentineOffset`, A4 `_die` flag + dead-branch detonation, A6 scream.
- Boots wired (explosive/long_slide/fast_sprint) → B1 `bootModifiers`+`onKick`, B3 Player hooks.
- Adrenaline Leak (distort-not-kill + toggle) → B1 `isAdrenaline`, B5 HUD, B6 wiring.
- Scavenger's Refund → B1 `computeRefund`/`onKickKill`, B3 hook, B4 `addAmmo`.
- Nearest-filter → G1/G2. Vertex snap (clip-space only) → G1/G2 + collision assertion G2-Step6/QA2.
- Claustrophobic fog → G3. Persistent decals (cap 100, cleared on load) → G4/G5.
- QA: build + Steam-off + Playwright + CONTRACTS → QA1-QA4.

## Notes for the implementer
- **Stage explicit paths only.** The user's home dir is a separate git repo; never `git add -A`.
- **Don't reorder unrelated lines** in core files — keep diffs minimal and anchored.
- If any anchor line number has drifted (the repo may have changed), match by the quoted code, not the number.
- Phases are independent; if you must split, A / B / G each build and verify standalone.
- **Boots equip UI is out of scope (known limitation).** This plan wires the boot *ability logic* (the approved spec) and reads `progression.boots.equipped`. If the Hub `Menu.js` does not already expose a buy/equip control for boots, players can only change boots via save data (or the dev handle, as in B7). During Task B7-Step1, check `Menu.js` for an existing boots panel; if absent, log it as a recommended follow-up (a small Hub UI task) — do NOT expand this plan to build it.
- **Enforcer tuning:** 320 HP + knockback-immune is deliberately tanky ("unstoppable"). If playtest (A7) shows it's a damage sponge that stalls the fast loop, drop `enemies.json` `enforcer.health` toward ~220 and re-verify — the value lives in data precisely so this is a one-line tweak, not a code change.
