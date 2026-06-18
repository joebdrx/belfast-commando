# Buildings, Interiors, Victim & Controls — Design Spec

**Date:** 2026-06-18
**Project:** Belfast Commando (Three.js 0.184 + Vite 6 + Tauri v2)
**Branch:** `feat/buildings-interiors` (off `master`)
**Status:** Approved design — ready for implementation plan

---

## 1. Goal

A combined visual + content + controls pass with six independent workstreams:

1. Scale up the **main-menu wall phone** so it reads proportionately in the hub hero scene.
2. **Scroll-wheel weapon switching.**
3. Swap the **victim** to an animated rigged model (idle/walk while captive, run while fleeing).
4. Make **building models look real**: proportionate brick UVs, facade variety, and light
   geometry (window grid, ground-floor door, roof cap).
5. **Remove the destroyed building** (`bldg_collapsed`) and replace its slot with a breachable
   **interior building fitted flush** into the terraced row.
6. **Apartment interiors**: lower ceiling, domestic wall/floor textures, and furniture converted
   from the `mobili/` Blender set.

**Prime directive:** do not break existing behaviour. WASD/look/jump/sprint/slide, the kick,
hitscan shooting, door breaching, enemy AI/death, victim rescue, the HUB→LEVEL→RESULTS loop,
and `npm test` / `npm run build` must all still pass after every change.

## 2. Approved decisions

1. **Furniture:** convert `asset-reference/mobili/*.blend` → GLB via **Blender, headless**
   (Flatpak `org.blender.Blender` 5.1, `--background --python`, `--filesystem=host`). Probe
   confirmed: `letto.blend` opens (mesh `lettoO`, textures `lettoO.png`/`lettoOsp.jpg`) and
   exports a valid GLB. Fallback if a piece fails: textured low-poly proxy.
2. **Building realism:** textures **+ light geometry** (window quads, static door plane,
   roof cap) — not texture-only.
3. **Apartment ceiling:** ~3 m **dropped ceiling inside a tall windowed shell** — multi-storey
   outside, one low apartment floor inside; the player cannot reach above the drop.
4. **Destroyed building:** dropped entirely from the template rotation; its slot becomes a
   breachable interior building sized to the block footprint.
5. **Scope:** one branch, logical commits; quick wins (phone, scroll, victim) land before the
   art-heavy work (facades → collapsed swap → interiors+furniture).

## 3. Guiding architectural approach

This is **direct feature development** (not the multi-agent CONTRACTS waves), so `Level.js`,
`AssetManager.js`, etc. are edited directly — but the repo conventions still hold: ESM modules,
plain JS classes with `/** JSDoc */` headers, files under `src/game/`, data under `src/data/`,
2-space indent, `import * as THREE from "three"`, data-driven JSON, **no per-frame allocation in
`update(dt)`** (pool/cache; reuse vectors), and asset GLBs optimized through gltf-transform
(`resize` + `meshopt`, no webp on character faces — the documented black-box lesson).

New, self-contained logic goes in **new modules** (`BuildingFacade.js`) with unit tests, matching
the existing `BuildingLayout.js` + `tests/buildingLayout.test.js` pattern.

---

## 4. Workstreams

### 4.1 Menu wall phone scale — `Hub.js`, `AssetManager.js`

- The hub hero scene (rendered behind the HTML menu) mounts the wall phone in `Hub.js`
  (~L546–598) from the `landline_phone` GLB; `MODEL_DEFS.landline_phone` is `{ size: 0.3,
  fit: "max", anchor: "center" }`.
- Increase the phone to a realistic wall-phone size (~0.7–0.9 m tall) via the `size` field
  and/or the Hub placement scale, and re-seat it on the wall at hand height so it stays mounted
  (not floating / clipping). Exact factor + offset confirmed by screenshot.
- Procedural fallback fixture in `Hub.js` (L598) scaled to match so both paths look consistent.

### 4.2 Scroll-wheel weapon switching — `Weapon.js`

- Add a `wheel` event listener next to the existing keydown handler (`Digit1/2/3`, `KeyQ` →
  `_cycleOwned`). Extend `_cycleOwned(dir = +1)` to step through **owned** weapons in either
  direction.
- **Up = next, down = previous** (`e.deltaY < 0` → +1). Accumulate `deltaY` and switch once per
  notch so a fast scroll doesn't skip weapons; ignore when not in active play (same gate as keys).
- `preventDefault` on the canvas wheel so the page doesn't scroll.

### 4.3 Animated victim — `scripts/optimize-enemies.sh`, `AssetManager.js`, `Victim.js`

- **Pipeline:** add a victim block to `optimize-enemies.sh` mirroring the enemy archetypes:
  `victim-meshy-rigging-multi-animation/<walking.glb>` → `enemy_victim.glb` (mesh + walk clip),
  and `<running_armature.glb>` → `anim_victim_run.glb` (run clip on the same skeleton). Pick the
  concrete source filenames during implementation by listing the folder.
- **AssetManager:** add `getRiggedVictim()` returning `{ object3D, clips: { walk, run } }`,
  loading `enemy_victim.glb` + merging the `anim_victim_run.glb` clip as `run` (reuse the existing
  rigged-enemy load/merge helper).
- **Victim.js:** pass `opts.rig` (mixer path already implemented). `walk` while captive,
  crossfade to `run` while fleeing; restore a brisk `FLEE_SPEED` (remove the "static mesh → slow
  glide" caveat). Existing flee collision/bounds/despawn logic unchanged.
- **Risk/fallback:** the *old* rigged victim's run clip never bound. If `anim_victim_run.glb`
  likewise fails to bind on the new rig, flee on the `walk` clip (still animated). Verify the
  bind in-engine; only ship `run` if it actually plays.

### 4.4 Building realism — `AssetManager.js`, `Level.js`, **new** `BuildingFacade.js`

- **Proportionate UVs:** `MATERIAL_DEFS` brick/brick_dark/concrete currently use a fixed
  `repeat: [2, 1.6]`, which under-tiles large faces (smooth slabs, img 1) and stretches narrow
  ones (img 2). Drive `repeat` from real face dimensions — a "texels per metre" constant per
  material so a brick course is a consistent real size regardless of wall size. Procedural walls
  (`_brickWall`, `_box` with `los`) set `repeat` from their `(w, h)` at build time.
- **Variety:** rotate 3–4 facade materials (brick / brick_dark / concrete, plus tint variants)
  across adjacent buildings so neighbours differ (deterministic from block position + sector
  index, matching `BuildingLayout`'s existing seeding).
- **`BuildingFacade.js` (new, pure-ish + pooled):** given a wall-face rect
  `(center, width, height, orientationY)` and a storey height, return/stamp:
  - a **window grid** — columns × rows of inset quads sized from the face (dark glass
    `MeshStandardMaterial`, low metalness/high smoothness, faint emissive on a deterministic
    subset for "lit" windows);
  - a **ground-floor static door plane** centred on the face (using the `door` texture);
  - a **flat/parapet roof cap** along the top edge to kill the bare top seen in the screenshots.
  - Window count derives from face size (≈ one window per ~2.2 m column, per storey) so it stays
    proportionate. Geometry is merged/instanced per building; **no per-frame allocation**.
- Applied to **both** procedural interior buildings and the model-building footprints.
- Unit test (`tests/buildingFacade.test.js`): window counts/positions for representative face
  sizes, door placement, and that a tiny face degrades gracefully (≥0 windows, no NaN).

### 4.5 Remove destroyed building, fit interior building — `BuildingLayout.js`, `Level.js`, `AssetManager.js`

- `BuildingLayout.MODEL_TEMPLATES`: remove `"bldg_collapsed"` from the exterior rotation →
  `["bldg_terrace", "bldg_shop", "bldg_church"]` (church stays sparing — it's a landmark; keep
  the existing rotation feel so rows stay varied). Update `tests/buildingLayout.test.js` to the
  new template set.
- `blockPlan`: the block position that previously planned as `bldg_collapsed` now plans as
  `kind: "interior"` — a **breachable interior** building (reuse the `_buildBlock` interior path),
  sized to `BLOCK_W × BLOCK_L` with the §4.4 windowed facade so it sits flush in the terrace.
  The other exterior positions rotate among terrace/shop/church. Net: the destroyed building is
  gone, replaced in place by an enterable building, with a continuous street line. Spawn-adjacent
  interiors stay guaranteed (the existing `INTERIOR_BLOCKS` anchors).
- `AssetManager`: remove the `bldg_collapsed` `MODEL_DEFS` entry; `Level._brightenBuildingModel`:
  remove the collapsed-specific dark-lift branch (now dead). Retire the unused `bldg_collapsed`
  GLB from `public/models` (and its optimize-script entry) once nothing references it.

### 4.6 Apartment interiors — `Level.js`, **new** `scripts/convert-furniture.sh`, `AssetManager.js`, **new** `src/data/furniture.json`

- **Lower ceiling:** introduce `CEIL_H ≈ 3.0` decoupled from `WALL_H = 15`. The playable room
  gets a ceiling slab at `CEIL_H`; the brick shell + §4.4 windowed facade continues above it to
  `WALL_H` (closed off — unreachable). Re-seat interior wall heights, door header, lighting, and
  the pitched-roof/chimney so they read as one low apartment floor under a tall exterior.
- **Apartment textures:** add `apartment_wall` (plaster, light) and `apartment_floor` (wood)
  `MATERIAL_DEFS`/materials so interiors read domestic, not bare brick. Reuse existing
  texture sets where adequate; add minimal new texture refs only if needed.
- **Furniture conversion (`scripts/convert-furniture.sh`):**
  - For each `mobili/<name>.blend`: `flatpak run --filesystem=host org.blender.Blender
    --background --python <export.py>` → `<name>.glb`, then gltf-transform `resize`(512) +
    `meshopt` → `public/models/furn_<name>.glb`. Script paths are **absolute host paths**
    (Flatpak resolves relatives against its sandbox CWD). Per-piece failure → log + skip
    (proxy fallback handled in `Level`).
  - Pieces: `letto` (bed), `armadio` (wardrobe), `comodino` (nightstand), `tavolo1` (table),
    `sedia1` (chair), `libreria2` (bookshelf), optionally `scrivania1` (desk), `poltroncina`
    (armchair).
- **`AssetManager`:** register `furn_*` slugs in `MODEL_DEFS` with real-world `size`/`fit`/
  `anchor` (e.g. wardrobe ~2 m tall, bed ~0.5 m, anchor bottom).
- **Placement (`src/data/furniture.json` + `Level`):** a small **data-driven layout** of
  `{ slug, x, z, rotY, collider }` offsets relative to the interior room centre. Big pieces
  (bed, wardrobe, table) get AABB colliders; small props are visual-only. **Hard constraint:**
  furniture never overlaps the kickable door path, the player spawn, or a victim/captor position
  (validated against room metrics; unit-tested).

---

## 5. New / changed files

**New**
- `src/game/BuildingFacade.js` — window grid + door + roof-cap stamping (pure helpers + pooled mesh build)
- `tests/buildingFacade.test.js`
- `scripts/convert-furniture.sh` — headless Blender `.blend → .glb` + gltf-transform optimize
- `src/data/furniture.json` — per-room furniture layout
- `public/models/furn_*.glb` — converted furniture, **committed** like the existing `bldg_*`/`enemy_*` GLBs
- `public/models/enemy_victim.glb`, `public/models/anim_victim_run.glb` — regenerated animated victim (committed)

**Modified**
- `src/game/Weapon.js` — scroll-wheel switching
- `src/game/Hub.js`, `src/game/AssetManager.js` — phone scale; victim rig loader; furniture/material defs; drop `bldg_collapsed`
- `src/game/Victim.js` — animated rig (walk/run), restored flee speed
- `src/game/Level.js` — proportionate UVs; facade application; collapsed-slot → interior; low ceiling; furniture placement
- `src/game/BuildingLayout.js` — template list + `blockPlan` collapsed→interior
- `scripts/optimize-enemies.sh` — victim rig block
- `tests/buildingLayout.test.js` — updated template expectations

## 6. Testing & verification

- **Unit (vitest):** `buildingFacade` window/door math; `buildingLayout` template + interior-slot
  plan; furniture-layout non-overlap. Keep all existing tests green (`npm test`).
- **Build:** `npm run build` stays green.
- **Visual (Playwright MCP, as the repo already does):** menu phone proportion; building facades
  at correct brick scale with windows/door/roof; the ex-collapsed slot reading as a flush interior
  building; apartment interior (low ceiling + furniture, breach path clear); victim animating while
  captive and running on rescue. Screenshot each before marking its step done.
- **Regression sweep:** breach a door, clear a sector, rescue a victim, take damage, switch weapons
  (keys + wheel), HUB→LEVEL→RESULTS round-trip.

## 7. Risks & mitigations

- **Flatpak Blender sandbox paths** — confirmed working with `--filesystem=host` + absolute paths;
  script encodes absolute paths only.
- **Victim run-clip binding** — fallback to walk clip while fleeing (§4.3).
- **Asset size** — victim resized 512 + meshopt like enemies; furniture GLBs are tiny (~30 KB raw
  pre-optimize). Watch total bundle.
- **Ceiling/collider interaction** — lowering the interior ceiling and adding facade geometry must
  not seal the breach path or trap the player; re-run the regression sweep after §4.6.
- **`public/models/*` tracking** — confirm whether converted/regenerated GLBs are committed or
  produced by script at build; follow whatever the existing `bldg_*`/`enemy_*` GLBs do (they are
  committed), so commit the new ones too.

## 8. Out of scope

No new weapons, levels, enemies, or audio. No netcode. No change to the scoring, progression,
modifier, or achievement systems beyond what the above touches incidentally.
