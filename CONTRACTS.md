# Belfast Commando — Hybrid Gameplay Loop CONTRACTS

**This file is the single source of truth.** Every sub-agent reads it before writing code.
Cross-module communication goes through the APIs defined here. If you need something
not in this contract, STOP and report it — do not invent an interface.

This is an **existing, working MVP**. You are extending it. Match the repo's conventions
exactly: ESM modules, plain JS classes, `/** JSDoc */` headers on classes and key
methods, files under `src/game/`, data under `src/data/`, 2-space indent, `THREE` imported
as `import * as THREE from "three"`.

**Prime directive: do not break existing behavior.** WASD/mouse-look/jump/sprint/slide,
the kick, hitscan shooting, enemies dying, and "clear the sector to win" must all still
work after every change.

---

## 0. Ownership table (ONE owner per file)

| File | Owner | Notes |
|------|-------|-------|
| `src/main.js` | **Orchestrator only** | loop + state machine wiring |
| `src/game/Engine.js` | **Orchestrator only** | render-scene swap, shake offset |
| `src/game/Player.js`, `Weapon.js`, `Level.js`, `Score.js`, `HUD.js`, `Audio.js` | **Orchestrator only** | existing core; agents EXTEND via contract, never edit |
| `src/game/GameState.js` | **F1** | central singleton + event bus |
| `src/data/upgrades.json`, `boots.json`, `dialogue.json`, `modifiers.json`, `achievements.json` | **F1** | schema + 1–2 examples each |
| `src/game/Progression.js` | **Agent A** | upgrades/boots logic + save/load |
| `src/game/Hub.js`, `src/game/Menu.js` | **Agent B** | safehouse scene + HTML menu |
| `src/game/LevelManager.js`, `src/data/levels.json` | **Agent C** | campaign + extraction; authors 6–8 levels |
| `src/game/ComboSystem.js`, `src/game/FloatingText.js` | **Agent D** | bonus/stat tracking + floating numbers |
| `src/game/Juice.js`, `src/game/Particles.js` | **Agent E** | shake/hitstop + pooled particles |
| `src/game/PauseMenu.js` | **Agent P1** | pause + settings overlay |
| `src/game/Modifiers.js`, `src/data/modifiers.json` is F1's | **Agent P2** | run-modifier engine (reads modifiers.json) |
| `src/game/Achievements.js`, `src/data/achievements.json` is F1's | **Agent P3** | achievement engine (reads achievements.json) |

Agents may **read** any file. Agents may **append data entries** to a JSON file they don't
own only if explicitly told to; otherwise report the need. No agent edits another's `.js`.

---

## 1. New file layout (additive)

```
src/
  game/
    GameState.js        # F1  — singleton, run+progression state, event bus
    Progression.js      # A   — upgrade/boot purchase, save/load
    Hub.js              # B   — safehouse THREE.Scene + 2 ally NPCs
    Menu.js             # B   — HTML/CSS menu overlay (built in JS, no index.html edit)
    LevelManager.js     # C   — wraps Level.js: campaign load + extraction volume
    ComboSystem.js      # D   — end-of-level bonus categories + run stats (subscribes to bus)
    FloatingText.js     # D   — world-anchored floating score popups (subscribes to bus)
    Juice.js            # E   — screen shake + hitstop service (exposes hooks)
    Particles.js        # E   — pooled particle bursts
    PauseMenu.js        # P1  — pause + settings overlay
    Modifiers.js        # P2  — per-run modifier engine
    Achievements.js     # P3  — achievement unlock engine
  data/
    levels.json         # C
    upgrades.json       # F1
    boots.json          # F1
    dialogue.json       # F1
    modifiers.json      # F1
    achievements.json   # F1
```

JSON is imported via ESM: `import LEVELS from "../data/levels.json";` (Vite bundles JSON).

---

## 2. Existing-system reference (adapters — extend, do not fork)

All of these already exist. Call them; never reimplement.

### Loop & context (`src/main.js`)
- `Game._loop(now)` / `Game._update(dt)` — orchestrator-only.
- `this.ctx` is the shared context object passed to every system each frame. Current fields:
  `{ dom, active, camera, scene, audio, hud, score, player, weapon, level, time,
     onPlayerDeath(), steamFirstKick() }`.
  **Wave 3 will ADD:** `state` (the GameState singleton), `bus` (alias of `state` event bus),
  `juice`, `progression`. Agents that need these receive them via `ctx` — do not import the
  singleton in hot paths if `ctx.state` is available, but importing the GameState singleton
  directly is fine for setup/UI code (it is a true singleton).

### Level (`src/game/Level.js`) — the campaign primitive
- `new Level(scene, index=0, assets=null)` — builds a procedural sector seeded by `index`.
- Properties: `.spawn:Vector3`, `.spawnYaw:number`, `.enemies:Enemy[]`, `.doors:Door[]`,
  `.barrels[]`, `.group:THREE.Group`, `.GRID_HALF_X`, `.GRID_HALF_Z`.
- `.enemiesRemaining` → count of `!dead` enemies (getter).
- `.getColliders()` → `Box3[]` (open doors removed; cached).
- `.lineOfSight(a:Vector3,b:Vector3)` → bool.
- `.update(dt, ctx)` — ticks doors + enemies.
- `.dispose()` — removes group, disposes geometry.
- `_addEnemy(pos:Vector3, opts={})` — spawn primitive (rigged invader + melee AI).

### Enemy (`src/game/Enemy.js`)
- Melee swarm AI. `.dead`, `.position`, `.takeDamage(amt,dir,force)`, `.takeKick(dir)`,
  `.update(dt,ctx)`. Death is detected via `.dead` flipping true.

### Player (`src/game/Player.js`)
- `.reset(spawn:Vector3, yaw=0)`, `.position` (camera pos getter), `.health/.maxHealth/.alive`,
  `.damage(n)` → on lethal calls `ctx.onPlayerDeath()`.
- `_applyCamera(dt)` REWRITES `camera.position` and `camera.quaternion` every frame —
  any screen-shake offset MUST be applied by the loop AFTER `player.update`.

### Weapon (`src/game/Weapon.js`)
- Kill site: `_fireRay` calls `ctx.score.add(120,"KILL")` + `ctx.audio.kill()` when an enemy
  dies. Hit: `ctx.score.add(30,"HIT")`. Shot: `ctx.score.add(5,"",true)`.
- `.reset()`, `.setWeapon(i)`, `.kickFx(point)`, `.explosionFx(point)`.

### Player kick sites (`src/game/Player.js _kick`)
- Door breach: `ctx.score.add(150,"BREACH!")`. Boot kill: `ctx.score.add(250,"BOOT KILL!")`.
- Barrel: `ctx.level.explodeBarrel(...)`.

### Scoring (`src/game/Score.js`) — STAYS authoritative for total + live multiplier
- `.add(base, label="", quiet=false)` — bumps combo, scales by multiplier, updates HUD.
- `.total`, `.combo`, `.bestCombo`, `.kills`, `.multiplier` (getter), `.levelTime`.
- `.reset()` (per level), `.resetAll()` (per run), `.finishLevel()` → `{bonus,time}`.
- **Wave 3 will make `Score.add` also `emit` a `score` event on the bus** (orchestrator edit).
  Agents must NOT add a second running total — subscribe to bus events instead.

### HUD (`src/game/HUD.js`)
- `.setScore/.setTimer/.setHealth/.setWeapon/.setAmmo/.setLevel/.setObjective`,
  `.popCallout(label,points,mult)`, `.flashDamage()`, `.setCrosshairActive(b)`,
  `.showOverlay(title,body,hint)`, `.hideOverlay()`. DOM ids in `index.html`
  (`#overlay`, `#overlay-title/-body/-hint`, `#hud-*`).

### Audio (`src/game/Audio.js`)
- `.init()`, `.setMuted(b)`, `.gunshot(name)`, `.kick()`, `.kickWhiff()`, `.kill()`,
  `.explosion(pos,listener)`, `.enemyMelee(pos,listener)`, `.switchWeapon()`, `.uiBlip()`,
  `.reload()`, `.voice(lines[])`. New SFX go through `Juice.playSfx` → delegates here.

### Steam (`src/utils/steam.js`)
- `Steam.unlock(id)`, `Steam.submitScore(n)`, `Steam.status()`. No-ops (logs) outside Tauri.
  Achievement engine (P3) calls `Steam.unlock(...)` behind its own interface.

### AssetManager (`src/game/AssetManager.js`)
- `.getMaterial(slug)`, `.getModel(slug)`, `.hasModel(slug)`, `.getSprite(name)`,
  `.getRiggedEnemy()`, `.getMurals()`, `.getHouseSideTexture()`, `.getFacades()`,
  `.hasFacades()`. Hub may reuse `.getMaterial("brick"/"concrete"/"tarmac")` etc.

---

## 3. GameState API (`src/game/GameState.js`) — F1 builds this

A singleton, default-exported AND named-exported:
```js
export const gameState = new GameState();
export default gameState;
```

### State shape (`getState()` returns a live reference; treat as read-mostly)
```js
{
  phase: "HUB",            // "HUB" | "LEVEL" | "RESULTS" | "PAUSED"
  run: {                   // reset by startRun(); null between runs is OK, prefer zeroed
    active: false,
    levelIndex: 0,
    levelId: null,
    score: 0,              // mirrors Score.total (updated via "score" events)
    kills: 0,
    combo: 0,
    bestCombo: 0,
    modifiers: [],         // array of modifier ids active this run
    stats: { damageTaken: 0, doorsBreached: 0, barrelKills: 0, bootKills: 0, shotsFired: 0,
             noDamage: true, levelTime: 0 },
  },
  progression: {           // PERSISTENT — saved/loaded by Progression (Agent A)
    resistancePoints: 0,   // currency ("RP")
    upgrades: {},          // { upgradeId: level }  e.g. { kick_master: 2 }
    boots: { owned: ["standard"], equipped: "standard" },
    unlockedLevels: 1,     // highest campaign index reachable (1-based count)
    achievements: {},      // { achievementId: true }
    settings: { sensitivity: 0.0022, quality: "high", muted: false },
    version: 1,
  },
}
```

### Methods
- `getState()` → the object above.
- `setPhase(phase)` → sets `state.phase`, emits `"phaseChange" {from,to}`.
- `getPhase()` → string.
- `startRun({levelIndex=0}={})` → zeroes `run`, sets `run.active=true`, emits `"runStart"`.
- `endRun({died=false})` → sets `run.active=false`, emits `"runEnd" {died, run}`.
- `addScore(amount, reason="")` → adds to `run.score`, emits `"score" {gained,total,reason}`.
  (Score.js remains the HUD-facing total; this keeps run.score in sync for RESULTS/rewards.)
- `addKill(meta={})` → `run.kills++`, updates stat flags from `meta` (`{isKick,isBarrel}`),
  emits `"kill" meta`.
- `getCombo()` / `setCombo(n)` → mirror combo for systems that need it; emits `"combo"`.
- `getMultiplier()` → number (mirror of Score multiplier; set via `setCombo`).
- `addCurrency(n)` → `progression.resistancePoints += n`, emits `"currency" {resistancePoints}`.
- `spendCurrency(n)` → returns bool; deducts if affordable, emits `"currency"`.
- `hydrate(progressionObj)` → deep-merges a loaded progression (used by Progression.load).
- `getProgression()` → `state.progression`.
- `recordStat(key, value)` / `bumpStat(key, delta=1)` → mutate `run.stats`, emit `"stat"`.

**Setting `run.levelId` and `run.modifiers`:** GameState has no dedicated setter for these two
documented `run` fields. Their owners write them directly on the live reference returned by
`getState()` and additionally emit the canonical event:
- Agent C (LevelManager): `state.getState().run.levelId = id; state.getState().run.levelIndex = index;`
  then `state.emit("levelStart", {levelId:id, index})`.
- Agent P2 (Modifiers): `state.getState().run.modifiers = ids;` on run/level entry.
This is the sanctioned exception to "read-mostly"; all OTHER run/progression mutation goes
through GameState methods.

### Event bus (on the same singleton)
- `on(event, fn)` → returns an `unsubscribe()` function.
- `off(event, fn)`.
- `emit(event, payload)` → synchronous fan-out; listener exceptions are caught + warned so
  one bad listener never breaks the frame.

### Event catalog (names are LAW — do not rename)
| event | payload | emitted by |
|-------|---------|-----------|
| `phaseChange` | `{from, to}` | GameState.setPhase |
| `runStart` | `{}` | GameState.startRun |
| `runEnd` | `{died, run}` | GameState.endRun |
| `score` | `{gained, total, reason}` | GameState.addScore (Wave 3 bridges Score.add) |
| `kill` | `{position?, isKick?, isBarrel?, weapon?}` | Wave 3 bridges kill sites |
| `hit` | `{position?, amount}` | Wave 3 bridges hit site |
| `breach` | `{position?}` | Wave 3 bridges door kick |
| `explosion` | `{position}` | Wave 3 bridges barrel |
| `damage` | `{amount, health}` | Wave 3 bridges Player.damage |
| `combo` | `{combo, multiplier}` | GameState.setCombo |
| `currency` | `{resistancePoints}` | GameState.addCurrency/spendCurrency |
| `stat` | `{key, value}` | GameState.recordStat/bumpStat |
| `levelStart` | `{levelId, index}` | LevelManager (C) |
| `levelClear` | `{stats}` | LevelManager (C) |
| `extractReady` | `{}` | LevelManager (C) |
| `extracted` | `{}` | LevelManager (C) |

F1 OWNS emitting only the GameState-internal events above (phaseChange, runStart/End, score,
kill, combo, currency, stat). The combat-bridge emits (`kill`/`hit`/`breach`/`explosion`/
`damage`) and the level emits (`levelStart`/`levelClear`/`extract*`) are produced by the
orchestrator (Wave 3) and Agent C respectively — but they are LISTED here so subscribers
(D, E, P3) can rely on them.

---

## 4. State machine & loop integration (orchestrator does the wiring in Wave 3)

Top-level **GamePhase** layered over the existing in-level sub-states:

```
            Start Operation
   HUB  ─────────────────────►  LEVEL  ──(extracted)──►  RESULTS  ──(continue)──►  HUB
    ▲                             │ │                        │
    │                             │ └──(player death)────────┘ (died:true → partial RP)
    └─────────────(quit to hub)───┘
                         PAUSED is a transient overlay over LEVEL (pointer-lock lost)
```

- **HUB**: Hub.js renders the safehouse scene (its own `THREE.Scene`), Menu.js shows the
  HTML menu. No pointer lock. Engine renders the hub scene (orchestrator adds an optional
  `render(sceneOverride)` arg to Engine).
- **LEVEL**: existing playing flow. LevelManager owns the current `Level`. Pointer lock on.
  The existing `playing|paused|dead` sub-states still operate inside LEVEL.
- **RESULTS**: overlay showing score, bonus breakdown (ComboSystem), kills, RP earned, and
  a spend/continue prompt. Pointer lock off.
- Player death (`ctx.onPlayerDeath`) → endRun({died:true}) → RESULTS with **partial RP**
  (e.g. `floor(run.score / 100) + run.kills * 2`, halved on death). Then RESULTS → HUB.
- The old `menu` overlay is superseded by HUB. The old `victory` is reached when the last
  campaign level is extracted (RESULTS shows a campaign-complete variant).

Reward formula (orchestrator-final, agents may read it): on level clear,
`RP = floor(score/100) + kills*2 + comboBonus`; on death, `RP = round(that * 0.4)`.

---

## 5. JSON schemas (field names are LAW)

### `levels.json` (Agent C authors 6–8) — array
```json
[{
  "id": "falls_road",
  "index": 0,
  "name": "Falls Road",
  "seed": 0,                      // passed to new Level(scene, seed, assets)
  "intro": "Operation: clear the Falls.",
  "outro": "The Falls is ours.",
  "extraction": { "x": -12, "z": 38, "r": 4 },   // optional; defaults to spawn area
  "modifierChance": 0.5,          // optional; chance a run modifier is rolled on entry
  "par": 45                       // optional; seconds for time-bonus baseline
}]
```

### `upgrades.json` (F1) — array
```json
[{
  "id": "kick_master",
  "name": "Kick Master",
  "desc": "Bigger kick radius and knockback.",
  "maxLevel": 3,
  "cost": [50, 120, 250],         // RP per level (index = current level)
  "effect": { "type": "kickPower", "perLevel": 0.15 }   // consumed by gameplay later
}]
```
Define examples for: `kick_master` (kickPower), `steady_aim` (spread reduction),
`thick_skin` (maxHealth). `effect.type` is a free string the gameplay reads; lock the
field names `type` and `perLevel`.

### `boots.json` (F1) — array
```json
[{
  "id": "standard",
  "name": "Standard Issue",
  "desc": "Reliable steel toecaps.",
  "cost": 0,
  "ability": "none"               // "explosive_kick" | "long_slide" | "fast_sprint" | "none"
}]
```
Include `standard` (free, owned by default) plus `explosive_kick`, `long_slide`,
`fast_sprint` examples.

### `dialogue.json` (F1) — array of story snippets, progress-gated
```json
[{
  "id": "intro_alliance",
  "speaker": "Ruairí",            // IRA fighter
  "faction": "ira",
  "requires": { "unlockedLevels": 1 },   // gate: show only when progression meets this
  "lines": ["Never thought I'd fight beside an Orangeman.", "Aye well, needs must."]
}]
```
Two speakers: `Ruairí` (faction `ira`) and `Davy` (faction `ulster`). `requires` is an
object of `progression` fields with `>=` semantics. Provide 3–4 snippets gated across
`unlockedLevels` 1..3.

### `modifiers.json` (F1) — array
```json
[{
  "id": "rainy_night",
  "name": "Rainy Night",
  "desc": "Slippery streets, but the invaders can't see you coming.",
  "effects": { "playerSpeedMul": 1.0, "frictionMul": 0.5, "enemySightMul": 0.7 },
  "scoreMul": 1.15                // run score multiplier reward for the handicap
}]
```
Provide `rainy_night`, `curfew` (fewer/tougher enemies), `adrenaline` (faster everything).
`effects` keys are a closed set the engine reads: `playerSpeedMul`, `frictionMul`,
`enemySightMul`, `enemySpeedMul`, `enemyCountMul`. Missing keys default to 1.0.

### `achievements.json` (F1) — array
```json
[{
  "id": "first_kick",
  "name": "First Kick",
  "desc": "Boot your first invader.",
  "steamId": "ACH_FIRST_KICK",    // passed to Steam.unlock; may be null
  "trigger": { "event": "kill", "match": { "isKick": true }, "count": 1 }
}]
```
Provide `first_kick` (kill isKick), `alliance_formed` (phaseChange to first LEVEL / runStart),
`shankill_clear` (levelClear with levelId "shankill"). `trigger.event` is a bus event name;
`match` is a shallow-equality filter on payload; `count` is the threshold.

### Save format
- localStorage key: **`belfast_commando_save_v1`**.
- Value: `JSON.stringify(state.progression)` (the persistent block only; never the run).
- `version: 1` lives inside progression; loader migrates/ignores mismatched versions safely.

---

## 6. Juice hooks (`src/game/Juice.js`) — Agent E

A class instantiated once by the orchestrator and placed on `ctx.juice`. Exposes EXACTLY:
- `shake(intensity, ms)` — queue an additive camera shake (intensity in metres-ish, ~0.05–0.4).
- `hitStop(ms)` — request a brief global time freeze/slow.
- `spawnImpact(position, type)` — `type` ∈ `"kick"|"explosion"|"blood"|"spark"`; routes to
  `Particles`.
- `playSfx(id)` — `id` ∈ a documented set; delegates to existing `Audio` (e.g. `id==="kick"`
  → `ctx.audio.kick()`); unknown ids no-op with a warn.
- `update(dt)` → returns `{ timeScale:number, shake:{x,y,z,roll} }`. The ORCHESTRATOR calls
  this each frame: multiplies the loop `dt` by `timeScale` (clamped ≥ 0.05) and adds the
  shake offset to the camera AFTER `player.update`. Juice must NOT touch the camera itself.
- Constructor takes `(ctx)` or is given `setContext(ctx)` (match Player/Weapon's
  `setContext` pattern). No per-frame allocation; reuse vectors.

`Particles.js`: a pooled emitter. `Particles` preallocates N meshes, `emit(pos,type)` reuses
them, `update(dt)` advances. Owned by Juice (Juice composes Particles). Add particle group to
`ctx.scene`.

---

## 7. Scoring contract (Agent D)

`Score.js` stays authoritative for the on-screen total and live multiplier. Agent D ADDS:
- `ComboSystem.js` — subscribes to bus `kill/hit/breach/explosion/damage/score`. Tracks per-
  level stat flags (noDamage, barrelKills, bootKills, doorsBreached) into `ctx.state` via
  `recordStat/bumpStat`. Exposes `computeBonuses(run)` → `[{label, points}]` for RESULTS:
  time bonus, no-damage bonus, destruction (barrel kills) bonus, style (bestCombo) bonus.
  Pure-ish; reads `ctx.state.run`. Does NOT add to Score.total directly (orchestrator applies
  the bonus sum at RESULTS).
- `FloatingText.js` — subscribes to bus `kill/breach/explosion`. Spawns a short-lived
  world-anchored DOM or sprite popup at `payload.position` showing points/label. Must be
  cheap: pool DOM nodes or sprites; cap concurrent popups (~12); no per-frame `new`.
  Add via `setContext(ctx)`; `update(dt)` advances/cull. Project world→screen using
  `ctx.camera` for DOM popups.

Decay rules: unchanged — Score.js already decays combo over a 3s window. Do not duplicate.

---

## 8. Report format (every sub-agent ends with this)
```
FILES CREATED/EDITED: <paths>
EXISTING FILES READ: <paths>
PUBLIC API: <exported functions/classes + signatures>
DEPENDS ON: <contract items + existing APIs consumed>
DEVIATIONS: <anything differing from the contract, or "none">
REGRESSION RISK: <existing behavior this could affect, or "none">
SELF-TEST: <how it was verified in isolation>
INTEGRATION NOTES: <what the orchestrator must call/wire>
```

---

## 9. Hard rules
- One owner per `.js` file. Never edit a core file (section 0 row 1–2) — that's the orchestrator.
- All cross-module talk goes through GameState (state + bus) or explicit constructor callbacks.
- Data-driven: levels/upgrades/boots/dialogue/modifiers/achievements live in `src/data/*.json`.
- 60 FPS: no per-frame allocation in `update(dt)`; pool meshes/DOM; reuse THREE vectors.
- Comment key functions (what + why), match existing JSDoc style.
- Save/load must work in a plain browser (localStorage). Tauri fs is best-effort only and must
  not break the Vite build or the browser path (feature-detect `window.__TAURI__`; do NOT add
  a static import of an uninstalled Tauri plugin).
