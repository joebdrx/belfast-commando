# Buildings, Interiors, Victim & Controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a six-part visual/content/controls pass — menu phone scale, scroll-wheel weapons, animated victim, realistic building facades, drop the destroyed building for a fitted interior, and furnished low-ceiling apartment interiors.

**Architecture:** Direct feature development on `feat/buildings-interiors`. New self-contained logic (`BuildingFacade.js`) gets unit tests like the existing `BuildingLayout.js`; asset work runs through the existing gltf-transform pipeline plus a new headless-Blender furniture converter. Visual steps are verified in-engine with screenshots.

**Tech Stack:** Three.js 0.184, Vite 6, Vitest 4, `@gltf-transform/cli` (npx), Flatpak Blender 5.1 (`org.blender.Blender`, headless), Playwright MCP for visual checks.

**Spec:** `docs/superpowers/specs/2026-06-18-buildings-interiors-design.md`

## Global Constraints

- ESM modules; plain JS classes with `/** JSDoc */` headers; 2-space indent; `import * as THREE from "three"`.
- Data-driven: layouts/configs in `src/data/*.json` (imported via ESM).
- **No per-frame allocation in `update(dt)`** — pool/cache, reuse THREE vectors.
- Asset GLBs optimized via gltf-transform `resize`(512) + `meshopt`; **no webp on character-face textures** (documented black-box-at-distance lesson).
- Blender invocations: `flatpak run --filesystem=host org.blender.Blender --background --python <abs.py>`, **absolute host paths only** (Flatpak resolves relatives against its sandbox CWD).
- Stage **explicit paths only** when committing — `/home/pete` is a separate git repo. Repo root: `belfast-commando/belfast-commando`.
- Keep `npm test` and `npm run build` green after every task. End each task with a commit.
- **Prime directive:** never break WASD/look/jump/sprint/slide, kick, hitscan, door breach, enemy AI/death, victim rescue, or the HUB→LEVEL→RESULTS loop.

---

### Task 1: Scroll-wheel weapon switching

**Files:**
- Modify: `src/game/Weapon.js` (input binding near `Digit1/2/3`/`KeyQ`; `_cycleOwned`)
- Test: `tests/weaponCycle.test.js` (create)

**Interfaces:**
- Produces: `_cycleOwned(dir = 1)` — steps through *owned* weapon indices, wrapping, in `+1`/`-1` direction; returns the new index.

- [ ] **Step 1 — Extract a pure cycle helper, write failing test.** `_cycleOwned` currently reads `this` state. Add a pure module-level export `nextOwnedIndex(current, ownedIndices, dir)` and have `_cycleOwned` delegate. Test:

```js
import { describe, it, expect } from "vitest";
import { nextOwnedIndex } from "../src/game/Weapon.js";

describe("nextOwnedIndex", () => {
  const owned = [0, 1, 2];
  it("wraps forward", () => {
    expect(nextOwnedIndex(0, owned, 1)).toBe(1);
    expect(nextOwnedIndex(2, owned, 1)).toBe(0);
  });
  it("wraps backward", () => {
    expect(nextOwnedIndex(0, owned, -1)).toBe(2);
    expect(nextOwnedIndex(1, owned, -1)).toBe(0);
  });
  it("skips unowned (current not in owned → nearest owned forward)", () => {
    expect(nextOwnedIndex(2, [0, 1], 1)).toBe(0);
  });
  it("single owned weapon stays put", () => {
    expect(nextOwnedIndex(0, [0], 1)).toBe(0);
    expect(nextOwnedIndex(0, [0], -1)).toBe(0);
  });
});
```

- [ ] **Step 2 — Run, verify fail.** `npx vitest run tests/weaponCycle.test.js` → FAIL (`nextOwnedIndex` not exported).
- [ ] **Step 3 — Implement.** Export `nextOwnedIndex(current, ownedIndices, dir)`: find `current`'s position in `ownedIndices` (if absent, treat as -1 so `+1`→first), step by `dir`, wrap modulo length, return `ownedIndices[pos]`. Refactor `_cycleOwned(dir = 1)` to `this.setWeapon(nextOwnedIndex(this.index, this._ownedIndices(), dir))`.
- [ ] **Step 4 — Run, verify pass.** `npx vitest run tests/weaponCycle.test.js` → PASS.
- [ ] **Step 5 — Wire the wheel.** In the input-binding block, add on the canvas/`dom`: `addEventListener("wheel", (e) => { if (!<active gate>) return; e.preventDefault(); this._wheelAcc += e.deltaY; const N = 50; while (this._wheelAcc <= -N) { this._wheelAcc += N; this._cycleOwned(1); } while (this._wheelAcc >= N) { this._wheelAcc -= N; this._cycleOwned(-1); } }, { passive: false })`. Initialise `this._wheelAcc = 0` in the constructor. Match the existing input active-gate used by the keydown handler.
- [ ] **Step 6 — Full suite + build.** `npx vitest run && npm run build` → green.
- [ ] **Step 7 — Commit.** `git add src/game/Weapon.js tests/weaponCycle.test.js && git commit -m "feat(controls): scroll-wheel weapon switching"`

---

### Task 2: Scale up the main-menu wall phone

**Files:**
- Modify: `src/game/AssetManager.js` (`MODEL_DEFS.landline_phone`)
- Modify: `src/game/Hub.js` (wall-phone placement ~L546–598, incl. procedural fallback)

- [ ] **Step 1 — Read placement.** Read `Hub.js:540–610` to confirm the phone's mount position, rotation, and which path (GLB vs procedural fallback) sets scale.
- [ ] **Step 2 — Bump model size.** In `MODEL_DEFS`, change `landline_phone` `size: 0.3` → `size: 0.85` (realistic wall phone ≈ 0.85 m tall). If Hub applies an extra scale, reconcile so final height ≈ 0.8–0.9 m.
- [ ] **Step 3 — Re-seat on wall.** Adjust the Hub mount position so the enlarged phone sits flush at hand height (~1.3 m) without clipping the wall or floating. Update the procedural fallback fixture to the same footprint.
- [ ] **Step 4 — Visual verify.** `npm run dev` (background), Playwright MCP: navigate to the menu/hub, screenshot, confirm the phone reads proportionately on the wall. Iterate size/position if needed.
- [ ] **Step 5 — Build + commit.** `npm run build` green. `git add src/game/AssetManager.js src/game/Hub.js && git commit -m "feat(menu): scale wall phone to proportionate size"`

---

### Task 3: Animated victim rig

**Files:**
- Modify: `scripts/optimize-enemies.sh` (victim block)
- Modify: `src/game/AssetManager.js` (`getRiggedVictim()`; victim rig load/merge)
- Modify: `src/game/Victim.js` (feed rig, walk/run, restore flee speed)
- Produce: `public/models/enemy_victim.glb`, `public/models/anim_victim_run.glb`

**Interfaces:**
- Produces: `AssetManager.getRiggedVictim()` → `{ object3D: THREE.Object3D, clips: { walk: AnimationClip, run?: AnimationClip } }` (same shape `Victim` already consumes via `opts.rig`).

- [ ] **Step 1 — Pick sources.** `ls asset-reference/victim-meshy-rigging-multi-animation` → choose `<…>_walking.glb` (mesh + walk) and `<…>_running_armature.glb` (run clip). Note exact filenames.
- [ ] **Step 2 — Pipeline.** In `optimize-enemies.sh`, replace the static-victim block: run `optimize_mesh "$REF/victim-meshy-rigging-multi-animation/<walking>.glb" "$OUT/enemy_victim.glb"` and `$GT meshopt "$REF/.../<running_armature>.glb" "$OUT/anim_victim_run.glb"` (mirroring the enemy archetype loop). Remove the "static civilian" comment/path.
- [ ] **Step 3 — Run it.** `bash scripts/optimize-enemies.sh 512` → confirm `enemy_victim.glb` (few MB) and `anim_victim_run.glb` (tiny) written.
- [ ] **Step 4 — Loader.** In `AssetManager`, add `getRiggedVictim()` reusing the rigged-enemy load+clip-merge helper: load `enemy_victim.glb`, take `animations[0]` as `walk`, load `anim_victim_run.glb`'s `animations[0]` as `run`, return `{ object3D, clips }`. Cache it.
- [ ] **Step 5 — Wire Victim.** Where `Victim` is constructed (grep `new Victim`), pass `{ rig: assets.getRiggedVictim() }`. In `Victim.js`: `_setAnim("walk")` while captive; on flee `_setAnim("run")`; restore `FLEE_SPEED` to a brisk value (~3.2 m/s) and drop the "static mesh slow glide" rationale comment.
- [ ] **Step 6 — Verify bind in-engine.** `npm run dev`; enter a level; Playwright screenshot the captive victim (should idle-animate, not T-pose) and after rescue (should run-animate). **If the run clip won't bind** (mesh frozen), set flee to reuse `walk` and note it in the commit.
- [ ] **Step 7 — Tests + build + commit.** `npx vitest run && npm run build` green. `git add scripts/optimize-enemies.sh src/game/AssetManager.js src/game/Victim.js public/models/enemy_victim.glb public/models/anim_victim_run.glb && git commit -m "feat(victim): animated rigged victim (walk captive / run on rescue)"`

---

### Task 4: BuildingFacade module (window grid + door + roof cap)

**Files:**
- Create: `src/game/BuildingFacade.js`
- Test: `tests/buildingFacade.test.js`

**Interfaces:**
- Produces:
  - `planWindows(faceW, faceH, { storeyH = 3, colW = 2.2, margin = 0.6 })` → `{ cols, rows, positions: [{u, v, w, h}] }` where `u`∈[-faceW/2,faceW/2], `v` is height-from-ground of each window centre, sized `w×h`. `cols≥0`, `rows≥0`; returns empty `positions` for faces too small for one window+margins.
  - `planDoor(faceW, faceH, { doorW = 1.1, doorH = 2.1 })` → `{ u: 0, h: doorH, w: doorW }` or `null` if face narrower than `doorW + 2*0.3`.
  - `buildFacade(THREE, materials, { width, height, orientationY, center }, opts)` → `THREE.Group` of merged window/door/roof-cap meshes (pure geometry; caller adds to scene). Uses `materials.glass`, `materials.door`, `materials.roof`.

- [ ] **Step 1 — Failing tests for the math.**

```js
import { describe, it, expect } from "vitest";
import { planWindows, planDoor } from "../src/game/BuildingFacade.js";

describe("planWindows", () => {
  it("grids a typical 11x9 face into columns and storeys", () => {
    const p = planWindows(11, 9, { storeyH: 3, colW: 2.2, margin: 0.6 });
    expect(p.cols).toBeGreaterThanOrEqual(3);
    expect(p.rows).toBe(3); // 9m / 3m storeys
    expect(p.positions).toHaveLength(p.cols * p.rows);
    for (const w of p.positions) {
      expect(Math.abs(w.u)).toBeLessThanOrEqual(11 / 2);
      expect(w.v).toBeGreaterThan(0);
      expect(w.v).toBeLessThan(9);
    }
  });
  it("returns no windows for a tiny face", () => {
    expect(planWindows(1, 1).positions).toHaveLength(0);
  });
  it("is proportionate: doubling width adds columns, not wider windows", () => {
    const a = planWindows(6, 9), b = planWindows(12, 9);
    expect(b.cols).toBeGreaterThan(a.cols);
    expect(b.positions[0].w).toBeCloseTo(a.positions[0].w, 5);
  });
});

describe("planDoor", () => {
  it("centres a door on a wide face", () => {
    expect(planDoor(11, 9)).toMatchObject({ u: 0 });
  });
  it("returns null on a too-narrow face", () => {
    expect(planDoor(1.2, 9)).toBeNull();
  });
});
```

- [ ] **Step 2 — Run, verify fail.** `npx vitest run tests/buildingFacade.test.js` → FAIL (module missing).
- [ ] **Step 3 — Implement `planWindows`/`planDoor`.** Pure functions per the interface. `rows = max(0, floor(faceH / storeyH))`; `cols = max(0, floor((faceW - 2*margin) / colW))`; window `w = colW*0.55`, `h = storeyH*0.5`; centre each in its column/storey cell; skip the ground-storey centre column if a door occupies it.
- [ ] **Step 4 — Run, verify pass.** `npx vitest run tests/buildingFacade.test.js` → PASS.
- [ ] **Step 5 — Implement `buildFacade`.** Build small plane geometries for windows (glass mat; faint emissive on a deterministic ~1/4 subset keyed off cell index), the door plane, and a thin roof-cap box along the top edge; position+orient by `orientationY`/`center`; merge per type into a `THREE.Group`. No per-call texture loads (materials passed in). Add a smoke test asserting `buildFacade` returns a `Group` with children for an 11×9 face (use a minimal THREE stub or import three — three is already a test dep via existing tests).
- [ ] **Step 6 — Commit.** `npx vitest run && npm run build` green. `git add src/game/BuildingFacade.js tests/buildingFacade.test.js && git commit -m "feat(buildings): BuildingFacade — proportionate window grid, door, roof cap"`

---

### Task 5: Proportionate brick UVs + apply facades

**Files:**
- Modify: `src/game/AssetManager.js` (`MATERIAL_DEFS` → texels-per-metre; helper to set repeat from size)
- Modify: `src/game/Level.js` (`_brickWall`/`_box` UV from face size; call `buildFacade` on building faces)

**Interfaces:**
- Consumes: `BuildingFacade.buildFacade`, `planWindows`, `planDoor` (Task 4).
- Produces: a `Level` material bundle exposing `glass`/`door`/`roof` mats for facades.

- [ ] **Step 1 — Texels-per-metre.** In `AssetManager`, replace fixed `repeat: [2,1.6]` for brick/brick_dark/concrete with a `tilesPerMeter` value (brick ≈ 0.5/m so a course reads right) and a helper `setRepeatForSize(tex, w, h, tpm)` that sets `tex.repeat`. Where these materials are cloned per-wall, set repeat from the wall's real `(w, h)`.
- [ ] **Step 2 — Procedural wall UVs.** In `Level._brickWall` and the `_box(..., { los: true })` building walls, compute repeat from the face dimensions (clone the shared material per distinct size, or set `.repeat` on a per-wall clone) so large slabs tile densely and narrow strips aren't stretched.
- [ ] **Step 3 — Add glass/door/roof mats.** Add a `glass` MeshStandardMaterial (dark, low-roughness, slight emissive option) to `Level._materials`; reuse existing `door`/`roof` mats.
- [ ] **Step 4 — Apply facades.** After building each model-block footprint and each procedural building's street-facing wall, call `buildFacade(THREE, {glass,door,roof}, {width,height,orientationY,center})` and add the returned group to `this.group`. Cap window emissive count; reuse geometries.
- [ ] **Step 5 — Visual verify.** `npm run dev`; Playwright screenshots from the two angles in the spec images: brick now reads at human scale, buildings have windows + a ground door + a clean roofline (no bare top edge). Tune `tilesPerMeter`/window density.
- [ ] **Step 6 — Build + commit.** `npx vitest run && npm run build` green. `git add src/game/AssetManager.js src/game/Level.js && git commit -m "feat(buildings): proportionate brick UVs + window/door/roof facades"`

---

### Task 6: Drop bldg_collapsed → fitted interior building

**Files:**
- Modify: `src/game/BuildingLayout.js` (`MODEL_TEMPLATES`, `blockPlan`)
- Modify: `tests/buildingLayout.test.js`
- Modify: `src/game/Level.js` (`_buildModelBlock` collapsed branch; `_brightenBuildingModel`)
- Modify: `src/game/AssetManager.js` (remove `bldg_collapsed` MODEL_DEF)

- [ ] **Step 1 — Update layout test (failing).** Edit `tests/buildingLayout.test.js`: assert `MODEL_TEMPLATES` no longer contains `"bldg_collapsed"`; assert the block position that previously yielded collapsed now yields `{ kind: "interior" }`; other exterior positions yield `terrace|shop|church`.
- [ ] **Step 2 — Run, verify fail.** `npx vitest run tests/buildingLayout.test.js` → FAIL.
- [ ] **Step 3 — Implement.** `MODEL_TEMPLATES = ["bldg_terrace","bldg_shop","bldg_church"]`; in `blockPlan`, map the former-collapsed position to `{ kind: "interior" }` (keep `INTERIOR_BLOCKS` anchors; ensure church stays sparing). 
- [ ] **Step 4 — Run, verify pass.** `npx vitest run tests/buildingLayout.test.js` → PASS.
- [ ] **Step 5 — Remove dead collapsed code.** In `Level._buildModelBlock`, drop the `bldg_collapsed` special-case; in `_brightenBuildingModel`, remove the `slug === "bldg_collapsed"` branch; remove the `bldg_collapsed` entry from `AssetManager.MODEL_DEFS`. Ensure the new interior slot is sized to `BLOCK_W × BLOCK_L` and gets the Task 5 facade so it sits flush.
- [ ] **Step 6 — Visual verify.** `npm run dev`; Playwright: the row that used to show the dark destroyed building now shows a flush, enterable building; breaching its door still works.
- [ ] **Step 7 — Retire asset + commit.** Delete unreferenced `public/models/bldg_collapsed.glb` (confirm no refs via grep first). `npx vitest run && npm run build` green. `git add -A src/game/BuildingLayout.js tests/buildingLayout.test.js src/game/Level.js src/game/AssetManager.js && git rm public/models/bldg_collapsed.glb && git commit -m "feat(map): drop destroyed building; fit a breachable interior in its place"`

---

### Task 7: Apartment interiors — low ceiling + domestic textures

**Files:**
- Modify: `src/game/Level.js` (`CEIL_H`, interior room build, dropped ceiling, lighting)
- Modify: `src/game/AssetManager.js` (`apartment_wall`, `apartment_floor` materials)

- [ ] **Step 1 — Add materials.** In `AssetManager`, add `apartment_wall` (light plaster, MeshStandard) and `apartment_floor` (wood; reuse an existing wood-ish texture or tint `crate`/`door` wood) with proportionate repeat.
- [ ] **Step 2 — Decouple ceiling.** In `Level`, add `this.CEIL_H = 3.0` (keep `WALL_H = 15` for the exterior shell). In `_buildBlock`, build interior room walls/door-header to `CEIL_H`, place a ceiling slab at `CEIL_H`, and continue the brick shell + facade closed from `CEIL_H` up to `WALL_H` (unreachable). Re-seat any interior light to the low ceiling.
- [ ] **Step 3 — Apply domestic textures.** Interior room walls → `apartment_wall`; interior floor → `apartment_floor` (exterior/street unchanged).
- [ ] **Step 4 — Visual + collision verify.** `npm run dev`; Playwright: interior reads as a low domestic room, not a 15 m brick hall; **breach + walk-through still works**, no head-clipping at the door, player can't reach above the drop.
- [ ] **Step 5 — Build + commit.** `npx vitest run && npm run build` green. `git add src/game/Level.js src/game/AssetManager.js && git commit -m "feat(interiors): low apartment ceiling + domestic wall/floor textures"`

---

### Task 8: Furniture conversion pipeline (headless Blender)

**Files:**
- Create: `scripts/convert-furniture.sh`
- Produce: `public/models/furn_*.glb`

- [ ] **Step 1 — Write converter.** `scripts/convert-furniture.sh`: a `declare -A PIECE` map of `furn_<slug>` → `<name>.blend` (letto→bed, armadio→wardrobe, comodino→nightstand, tavolo1→table, sedia1→chair, libreria2→bookshelf, scrivania1→desk, poltroncina→armchair). For each: write an absolute-path export `.py` (`bpy.ops.wm.open_mainfile` + `bpy.ops.export_scene.gltf(export_format='GLB')`), run `flatpak run --filesystem=host org.blender.Blender --background --python <abs.py>`, then gltf-transform `resize 512` + `meshopt` → `public/models/furn_<slug>.glb`. Per-piece failure → echo + continue. Use absolute host paths throughout.
- [ ] **Step 2 — Run it.** `bash scripts/convert-furniture.sh`; confirm each `furn_*.glb` exists and is small (tens–hundreds KB). Note any piece that failed (→ proxy in Task 9).
- [ ] **Step 3 — Sanity-load.** Quick node check (or the existing viewer) that one GLB loads and has a mesh. 
- [ ] **Step 4 — Commit.** `git add scripts/convert-furniture.sh public/models/furn_*.glb && git commit -m "build(interiors): headless Blender furniture conversion (mobili → furn_*.glb)"`

---

### Task 9: Furniture placement in interiors

**Files:**
- Create: `src/data/furniture.json`
- Modify: `src/game/AssetManager.js` (`MODEL_DEFS` furn_* sizes), `src/game/Level.js` (place layout)
- Test: `tests/furnitureLayout.test.js`

**Interfaces:**
- Produces: `furnitureFits(layout, room)` (in `BuildingLayout.js` or a small `src/game/FurnitureLayout.js`) → bool: no piece footprint overlaps the door path, spawn, or captor/victim cell, and all pieces stay inside the room AABB.

- [ ] **Step 1 — Author layout + failing test.** `furniture.json`: array of `{ slug, x, z, rotY, w, d, collider }` offsets from room centre (bed against back wall, wardrobe in a corner, nightstand by bed, table+2 chairs centre-ish, bookshelf on a side wall). Test:

```js
import { describe, it, expect } from "vitest";
import LAYOUT from "../src/data/furniture.json";
import { furnitureFits } from "../src/game/FurnitureLayout.js";

const room = { halfW: 5, halfD: 6, doorPath: { x: 0, z: 5, r: 1.4 }, spawn: { x: 0, z: -4, r: 1 } };

describe("furniture layout", () => {
  it("keeps every piece inside the room", () => {
    for (const p of LAYOUT) {
      expect(Math.abs(p.x) + p.w / 2).toBeLessThanOrEqual(room.halfW);
      expect(Math.abs(p.z) + p.d / 2).toBeLessThanOrEqual(room.halfD);
    }
  });
  it("never blocks the door path or spawn", () => {
    expect(furnitureFits(LAYOUT, room)).toBe(true);
  });
});
```

- [ ] **Step 2 — Run, verify fail.** `npx vitest run tests/furnitureLayout.test.js` → FAIL (`furnitureFits` missing).
- [ ] **Step 3 — Implement `furnitureFits`** (AABB-vs-circle for door/spawn, AABB-in-room bounds) and tune `furniture.json` offsets until the test passes.
- [ ] **Step 4 — Run, verify pass.** `npx vitest run tests/furnitureLayout.test.js` → PASS.
- [ ] **Step 5 — Register + place.** Add `furn_*` `MODEL_DEFS` (real sizes/anchors). In `Level._buildBlock`, after the room is built, instantiate each layout piece (`assets.getModel("furn_…")`), position relative to room centre, add AABB collider for pieces with `collider: true`. Missing GLB (failed conversion) → skip or simple box proxy.
- [ ] **Step 6 — Visual + regression verify.** `npm run dev`; Playwright: furnished apartment, breach path clear, victim still rescuable, sector still clearable.
- [ ] **Step 7 — Build + commit.** `npx vitest run && npm run build` green. `git add src/data/furniture.json src/game/FurnitureLayout.js src/game/AssetManager.js src/game/Level.js tests/furnitureLayout.test.js && git commit -m "feat(interiors): place apartment furniture (non-blocking, collider-gated)"`

---

### Task 10: Full regression sweep + ship check

**Files:** none (verification + any fix-ups)

- [ ] **Step 1 — Suite + build.** `npx vitest run` (all green) and `npm run build` (green, no new errors).
- [ ] **Step 2 — In-engine regression (Playwright).** One run through: HUB (phone scaled) → start op → switch weapons with keys *and* scroll wheel → breach a door → enter furnished low-ceiling apartment → rescue the animated victim → clear the sector → RESULTS → back to HUB. Screenshot each beat.
- [ ] **Step 3 — Fix any regressions** found, re-running the relevant task's tests.
- [ ] **Step 4 — Final commit (if fixes).** `git commit -am "fix(buildings-interiors): regression sweep fixes"`. Leave `feat/buildings-interiors` ready for review/merge.

---

## Self-Review

**Spec coverage:** §4.1 phone→T2; §4.2 scroll→T1; §4.3 victim→T3; §4.4 facades→T4+T5; §4.5 collapsed→T6; §4.6 interiors→T7(ceiling/textures)+T8(furniture convert)+T9(placement); §6 testing→per-task + T10; §7 risks (Blender paths, victim bind, ceiling/collider) → T8 Step1 / T3 Step6 / T7 Step4. All covered.

**Placeholder scan:** Unit-testable tasks (1,4,6,9) carry real test code. Visual/asset tasks (2,3,5,7,8) specify exact files, commands, and screenshot checks — the "test" for tuned visuals is a build + in-engine screenshot, stated explicitly rather than faked as code.

**Type consistency:** `getRiggedVictim()` returns `{object3D, clips:{walk,run}}` consumed by `Victim` `opts.rig` (T3). `planWindows`/`planDoor`/`buildFacade` signatures defined in T4 are consumed unchanged in T5. `furnitureFits(layout, room)` defined and consumed in T9. `nextOwnedIndex` exported in T1 and used by `_cycleOwned`.
