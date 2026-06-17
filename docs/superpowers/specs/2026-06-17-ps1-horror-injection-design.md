# PS1 Horror Injection — Design Spec

**Date:** 2026-06-17
**Project:** Belfast Commando (Three.js 0.184 + Vite 6 + Tauri v2)
**Branch:** `feat/ps1-horror` (off `feat/hybrid-loop`), game subrepo only
**Status:** Approved design — ready for implementation plan

---

## 1. Goal

Inject a large feature + aesthetic pass that keeps the fast, kick-heavy combat but shifts
the atmosphere from generic grim realism to an **uncanny, janky PS1 survival-horror vibe
(Silent Hill lineage)**: low-fidelity rendering, unsettling AI pacing, high-impact juice.

Three independent engineering domains, built in **one pass**:
- **Alpha** — uncanny AI & enemy variety
- **Beta** — boots wiring & synergistic, build-defining progression
- **Gamma** — PS1 retro rendering pipeline + persistent decals

## 2. Approved decisions

1. **Scope:** all three workstreams in one pass.
2. **PS1 fidelity:** **stylized hybrid** — nearest-filter textures + vertex snapping + tight
   fog for the jank, but **keep** the existing ACES tone-map + PMREM/HDRI IBL so it reads as
   deliberate art direction, not a broken demake.
3. **Adrenaline Leak low-HP HUD:** **distort, don't kill** — heavy desaturation / static /
   red vignette below 30% HP with a faint danger cue retained, plus a settings toggle.

## 3. Guiding architectural approach

Honor `CONTRACTS.md`. New behavior lives in **new additive modules** reached through `ctx`
and the GameState event bus. Core files (`Engine`, `Player`, `Weapon`, `Enemy`, `Level`/
`LevelManager`, `HUD`, `Audio`, `AssetManager`, `main`) receive only **minimal, explicitly
listed hooks** — never rewrites. Object-pooling and "no per-frame allocation in `update`"
rules are preserved.

### Current architecture facts this builds on (verified)
- Renderer (`Engine.js:19-28`): `WebGLRenderer` AA on, `SRGBColorSpace`, `ACESFilmicToneMapping`
  exposure 0.92. Fog `FogExp2(0x868c90, 0.015)` (`Engine.js:40`). Camera FOV 78, near 0.05,
  **far 400** (`Engine.js:43-48`). Only custom shader is the sky dome (`Engine.js:63`).
- World materials are shared, cached `MeshStandardMaterial` from `AssetManager.getMaterial(slug)`
  — a single global `onBeforeCompile` injection point reaches the whole world.
- `Enemy` is one class (melee swarm); spawned via `Level._addEnemy(pos, opts={})` — `opts` is
  the sanctioned extension point for an archetype field.
- `Juice.spawnImpact(pos, type)` routes to the pooled `Particles`; `Juice.playSfx(id)` delegates
  to `Audio`. New SFX are added to `Audio` behind `Juice.playSfx` (contract §6, §2-Audio).
- `Progression` already has boot `ability` data and a `getActiveBootAbility()`; abilities are
  **not yet wired** into gameplay.
- Bus: `on/off/emit`; existing events include `kill`, `hit`, `breach`, `explosion`, `damage`,
  `score`, `combo`, `currency`, `levelStart/Clear`, `extract*`.

---

## 4. Alpha — Uncanny AI & horror variety

### New files (Alpha-owned)
- `src/data/enemies.json` — archetype stat table.
- `src/game/EnemyBehavior.js` — the stepped-animation clamp helper + per-archetype steering &
  attack strategies (pure-ish functions invoked by `Enemy.update`).
- `src/game/EnemyDirector.js` — chooses the archetype mix per sector, scaling counts/ratios by
  level index; consulted by `LevelManager`/`Level` when populating a sector.

### Core hooks (minimal)
- `Enemy.js`: accept `opts.archetype`; store archetype config; in `update(dt, ctx)` delegate
  steering/attack to `EnemyBehavior`; support ranged attack, knockback immunity, and the
  visual anim clamp. Existing melee `grunt` path is the default/baseline and must remain intact.
- `Level.js` / `LevelManager.js`: when spawning, ask `EnemyDirector` for the archetype of each
  enemy and pass `{archetype}` into `_addEnemy`.
- `Audio.js`: add synthesized SFX methods (gunshot variant, scream, heavy footstep) exposed via
  new `Juice.playSfx` ids.

### Uncanny animation clamp (QA-critical)
A per-enemy visual accumulator advances the **rendered pose/AnimationMixer only at ~11 FPS**
(snap, no interpolation between steps), while **movement integration, world position, and AABB
colliders run at the full 60 FPS game tick**. The stepped value is applied to the mesh's visual
transform/pose, never to `Enemy.position` or the collision box. Result: jagged stop-motion look
with **zero effect on collision or pooling**.

### Archetypes
| id | role | key behavior |
|----|------|--------------|
| `grunt` | baseline (existing) | melee swarm — unchanged |
| `gunner` | ranged | lurks at medium range in fog; erratic sudden strafes; hitscan to player preceded by a sharp **pixelated muzzle-flash telegraph**; emits `enemyShot`. |
| `enforcer` | unstoppable | big slow silhouette, high HP, **knockback-immune** (`takeKick` applies hitstop/damage but no displacement); beelines down street center, ignores cover routing; heavy footstep cue. |
| `breacher` | rusher | low HP, very fast, **serpentine zig-zag** path; emits `breacherAggro` on detection (audio bus); on death detonates a low-poly particle burst (`breacherDetonate`) **plus small-radius AoE damage to the player if point-blank** (real threat, not VFX-only). |

`enemies.json` defines per-archetype: `health`, `moveSpeed`, `sightRange`, `attack` (`melee`|
`ranged`|`detonate`), ranged `{damage, fireInterval, telegraph, spread}`, `knockbackImmune`,
`animFps` (default 11), and VFX/SFX ids. Missing keys fall back to the current grunt values.

---

## 5. Beta — Boots & synergistic progression

### New file (Beta-owned)
- `src/game/Abilities.js` — single home for all rule-breaking boot/upgrade logic, placed on
  `ctx.abilities`. Reads the equipped boot + active upgrade levels from `ctx.progression`;
  subscribes to bus events; exposes movement multipliers and effect callbacks. Keeps core thin.

### `Abilities` public surface (draft)
- `setContext(ctx)`, `attach()` (subscribe), `update(dt)`.
- Movement getters read by `Player`: `sprintSpeedMul`, `slideFrictionMul`, `slideSpeedMul`.
- `onKick({ point, hitEnemy, isBreach })` — invoked from `Player._kick`.
- `onKickKill({ enemy, distance })` — point-blank refund check.
- Internal low-HP watcher → toggles adrenaline state, emits `adrenaline {active}`.

### Core hooks (minimal)
- `Player.js`: multiply sprint/slide by the ability multipliers; call `ctx.abilities?.onKick(...)`
  from `_kick`; when adrenaline active, the kick uses the **full 360° radius** (ignore the cone).
- `Weapon.js`: add `addAmmo(n)` (clamped to mag) for the refund.
- `HUD.js`: adrenaline distortion overlay (desaturate + static + red vignette) driven by the
  `adrenaline` event, with a settings toggle (default ON) persisted via progression settings.
- `main.js`: instantiate `Abilities`, set `ctx.abilities`, attach.

### Boot abilities wired (reads existing `boots.json`)
- **Semtex Soles** (`explosive_kick`): on successful door-break or enemy impact, trigger a pooled
  explosive shockwave — reuse `Juice.spawnImpact('explosion')` + a radial damage/knockback pass
  over nearby enemies (mirroring barrel explosion logic).
- **Greased Brogues** (`long_slide`): increase slide duration/velocity and lower slide friction.
- **Hare's Hoofs** (`fast_sprint`): raise base sprint speed.

### Horror upgrades (`upgrades.json` edit — schema unchanged)
Keep `kick_master` and `thick_skin`. **Replace `steady_aim`** and **add** one upgrade:
- **Adrenaline Leak** (`effect.type: "adrenaline"`, maxLevel 1): below 30% HP → speed buff +
  360° kick radius; HUD distorted (not blacked out) + faint cue + settings toggle.
- **Scavenger's Refund** (`effect.type: "kick_ammo_refund"`, maxLevel 1): a point-blank kick kill
  refunds 15% of mag size to the current weapon's active magazine.

Net: 2 flat (`kick_master`, `thick_skin`) + 2 build-defining. `effect.type` is the flag string
`Abilities` reads; field names (`type`, `perLevel`, `cost[]`, `maxLevel`) stay as in contract §5.

---

## 6. Gamma — PS1 retro pipeline (stylized hybrid)

### New files (Gamma-owned)
- `src/game/RetroMaterial.js` — PS1 injection: nearest-filter helper, `onBeforeCompile`
  vertex-snap patcher, and a shared `{ resolution }` uniform (updated on resize). Exposes
  `applyTextureFilter(tex)`, `patchMaterial(material, opts)`, `update()`.
- `src/game/Decals.js` — ring-buffered persistent decal system on `ctx.scene`.

### Core hooks (minimal)
- `AssetManager.js`: route loaded textures through `RetroMaterial.applyTextureFilter` and the
  shared materials through `RetroMaterial.patchMaterial`.
- `Engine.js`: fog density ~`0.015 → ~0.05` (darker grey), camera far `400 → ~120`.
- `Weapon.js`: include an optional surface `normal` (+ hit object) in the `hit`/`kill` event
  payloads when a raycast hit exists, so `Decals` can project. Backward compatible (optional).
- `main.js`: instantiate `Decals`, attach; call `RetroMaterial.update()` from the loop.

### Techniques
1. **Nearest-filter textures:** `tex.minFilter = tex.magFilter = THREE.NearestFilter`,
   `generateMipmaps = false`, on world + enemy textures. ACES/PMREM/HDRI lighting **kept**.
2. **Vertex snapping (jitter):** in `onBeforeCompile`, after the projection, snap clip-space:
   `pos.xyz /= pos.w; pos.xy = floor(pos.xy * uResolution) / uResolution; pos.xyz *= pos.w;`
   on the shared cached materials (and enemy/prop materials). Moderate, **readable** grid.
   **Affine texture warp left OFF** for hybrid (exposed as an off-by-default toggle). Sky dome
   excluded. **Clip-space only → no effect on JS positions, pooling, or collision** (QA guardrail).
3. **Claustrophobic fog:** tighten `FogExp2` to a denser, darker grey + pull the far plane in,
   tuned so ~15–25 m is visible (keeps the fog-lurking gunner fair; synergizes with Alpha).
4. **Persistent blood decals:** `DecalGeometry` from `three/examples/jsm/geometries/DecalGeometry.js`,
   **ring buffer capped at 100** (oldest reused), flat crimson nearest-filtered material with
   `polygonOffset` to avoid z-fighting, projected onto **static world surfaces only** (skip moving
   enemies), persisting for the level lifetime and **cleared on `Level.dispose`**. Subscribes to
   `kill` / `hit` / `explosion`.

---

## 7. CONTRACTS.md additions

- **Ownership table:** add `EnemyBehavior.js`, `EnemyDirector.js`, `enemies.json` (Alpha);
  `Abilities.js` (Beta); `RetroMaterial.js`, `Decals.js` (Gamma).
- **Event catalog additions:**
  | event | payload | emitted by |
  |-------|---------|-----------|
  | `enemyShot` | `{position, dir}` | gunner (Alpha) |
  | `breacherAggro` | `{position}` | breacher on detection (Alpha) |
  | `breacherDetonate` | `{position}` | breacher on death (Alpha) |
  | `adrenaline` | `{active}` | Abilities (Beta) |
  | `decal` | `{position, normal, type}` | optional, if decals are bus-driven (Gamma) |

---

## 8. QA & build verification

1. `npm run build` → zero bundling errors.
2. **Steam stays OFF by default** — no Rust/Tauri changes, no static import of an uninstalled
   plugin; default `cargo build` still compiles.
3. **Vertex-snap / anim-clamp safety:** confirm enemy `.position` and `Level.getColliders()`
   are unaffected (visual-only); no object-pool drift; bounding-box collision still resolves.
4. **Performance:** `onBeforeCompile` is per-compile (free per frame); decals capped + geometry
   reused; anim-clamp reduces mixer cost; gunner tracers / breacher bursts use existing pools.
   Hold 60 FPS; no per-frame allocation in `update`.
5. **Playwright playtest** with screenshots: fogged street, gunner muzzle-in-fog, enforcer
   silhouette emerging, breacher detonation, persistent blood decals, adrenaline HUD distortion.

## 9. Risks & mitigations

- **Fog too thick → unfair ranged enemies / unreadable scene.** Tune to 15–25 m; verify in playtest.
- **`DecalGeometry` cost per hit.** Cap at 100, reuse buffers, static surfaces only, skip on rapid
  multi-hit frames if needed.
- **Vertex snap interacting with collision.** Strictly clip-space in shader; never touch JS state —
  explicitly verified in QA step 3.
- **Anim clamp desyncing hitboxes.** Visual transform only; logic position authoritative.
- **Adrenaline distortion accessibility.** Distort-not-kill + settings toggle (default ON).
- **Scope creep across 3 domains in one pass.** Modules are independent; build + verify per domain,
  integrate via bus/ctx, then full QA.

## 10. Out of scope
- No Rust/Tauri/Steam changes. No new 3D model assets (reuse existing GLBs/textures, restyle via
  pipeline). No audio production beyond synthesized SFX. No new sectors.
