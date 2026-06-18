# Belfast Map Rework — Design Spec

**Date:** 2026-06-17
**Project:** Belfast Commando (Three.js 0.184 + Vite 6 + Tauri v2)
**Branch:** `feat/map-rework`
**Status:** Approved design — ready for implementation plan

---

## 1. Goal

Make the playable sectors look more like a real Belfast terraced-street grid by
replacing **most** procedural box-buildings with optimized real building models
from `asset-reference/`, while **keeping a few buildings as full procedural
interiors** for the breach-and-clear gameplay. Streets must stay walkable.

## 2. Approved decisions

1. **Collision approach:** keep the procedural street grid + **clean AABB
   colliders**; new buildings are **visual GLBs** with a simple **footprint
   collider box** (never their mesh). This avoids the known failure recorded at
   `AssetManager.js:83-90` — a whole-city model's interlocking buildings merged
   into one collider and sealed the streets.
2. **Interiors:** keep **2 procedural interior buildings per sector** (kickable
   door + walls + roof); all other blocks become exterior-only model buildings.
3. **Templates:** reuse **~3–4 optimized building templates** tiled across the
   grid (cloned per block) rather than many unique heavy models — variety
   without download/perf bloat.

## 3. Critical constraint — asset size & format

Reference building GLBs are raw and huge (`old_building` 12 MB,
`collapsed_uk_terraced_house` 7 MB, `betsey_trotwood_pub` 69 MB,
`belfast_city` 54 MB, `church` 91 MB, `bunker` 122 MB). The shipped game is
71 MB total and the loader expects meshopt + webp GLBs (1–3 MB each). They MUST
be optimized before use. The proven recipe is `scripts/optimize-map.sh`:
`@gltf-transform/cli` `metalrough` → `optimize --texture-compress webp
--texture-size 512 --compress meshopt --simplify true --simplify-ratio 0.6
--palette false`. (`--palette false` is required — palette corrupts textures;
this is a recorded lesson.) The Sketchfab city went 206 MB → 15 MB this way.

The `.stl`/`.dae` reference files (`uk-town-house-units`, `terraced-house`) are
NOT drop-in GLBs (no/foreign material pipeline) and are **out of scope** for
this pass — GLB sources only.

## 4. Architecture

### 4.1 Asset pipeline (new)
- `scripts/optimize-buildings.sh` — runs the `metalrough` → `optimize` recipe
  over the selected reference building GLBs, emitting `public/models/bldg_<name>.glb`.
  Target ≤ ~3–5 MB each; total added map assets ≤ ~25 MB.
- Source GLBs are copied/placed under `assets/models/` (the existing raw-source
  convention) and git-ignored or committed per repo norms; only the optimized
  `public/models/bldg_*.glb` ship.

### 4.2 AssetManager (extend)
- Add `MODEL_DEFS` entries for each `bldg_*` slug with per-building normalization
  (`size`, `fit`, `anchor: "bottom"`, `rotY`). Buildings load through the existing
  `getModel(slug)` path (GLTFLoader + MeshoptDecoder + `_prepareModel`).

### 4.3 Level (rework building construction)
- Keep: street grid geometry, `COORDS_X`/`COORDS_Z` block centres, clean AABB
  street/door colliders, spawn, extraction, enemy spawning, props.
- Change: the per-block builder. Each block is either:
  - **Model block:** place a cloned `bldg_*` template at the block centre,
    rotated to face its street; add ONE axis-aligned **footprint collider box**
    sized to the block footprint (so streets stay clear) + an LOS blocker.
  - **Interior block (×2):** the existing procedural enclosed room with a
    kickable `Door`, walls, roof — unchanged gameplay.
- A small per-sector layout descriptor decides which blocks are interior vs which
  model template each exterior block uses (corner shop/pub, mid-terraces, the
  collapsed house for war-torn flavor).

## 5. Candidate building set (validated in Phase 1)

Optimize and preview; keep the usable ones, drop the rest:
- `old_building.glb` → `bldg_terrace` (mid terrace workhorse)
- `collapsed_uk_terraced_house.glb` → `bldg_collapsed` (war-damaged flavor)
- `angers_shop_2_france.glb` → `bldg_shop` (corner shop; already 0.9 MB)
- `betsey_trotwood_pub.glb` → `bldg_pub` (corner landmark; optimize hard)
- (optional) `street_exterior_dead_end.glb` → dead-end cap at a grid edge.

## 6. Implementation phasing (audit-first)

Because the concrete layout depends on what the models actually look like, the
build runs in this order:

1. **Asset audit:** add `optimize-buildings.sh`; optimize each candidate; load
   each in-game (viewer/dev handle), screenshot, record real dimensions +
   correct `rotY`/`size`/`anchor`; **select** the usable templates and discard
   any broken/oversized ones. Output: a confirmed template list + `MODEL_DEFS`.
2. **Footprint-collider building placement:** extend Level to place a model
   template at a block with a footprint AABB collider + LOS blocker; verify a
   single model block renders and blocks movement while streets stay walkable.
3. **Interior retention:** keep exactly 2 procedural interior blocks; verify
   breach/kick still works.
4. **Layout:** assign templates across the grid for a Belfast terraced feel;
   place the collapsed house + shop/pub; keep spawn/extraction/enemy flow intact.
5. **Verify:** `npm run build` clean; Playwright walk-through (streets walkable,
   no sealed blocks, buildings render, 2 interiors breachable); frame-stability +
   collider/pool assertions; bundle-size check within budget.

## 7. Risks & mitigations
- **Model is a whole scene / wrong scale / wrong facing** → Phase 1 audit
  normalizes per-model and drops unusable ones before any layout work.
- **Streets sealed by colliders** → footprint AABB boxes only (never mesh
  colliders); explicit walkability assertion in Phase 5.
- **Download/perf bloat** → aggressive optimize + reuse 3–4 templates; size budget.
- **Interior gameplay regression** → keep 2 procedural interiors unchanged; verify kick/breach.

## 8. Out of scope
- `.stl`/`.dae` sources; church/bunker landmarks (too heavy; bunker is a possible
  future finale objective). Enemy-model swap (separate effort C). No new Rust/Tauri.
- No change to spawn/extraction positions, enemy archetypes, or scoring.
