# Belfast Map Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace most procedural box-buildings with optimized real Belfast building models (tiled into terraced rows), keep 2 procedural interior buildings for breaching, and keep the streets walkable.

**Architecture:** Keep Level's procedural street grid + clean AABB colliders. Each of the 6 blocks (3 cols × 2 rows) is either an *interior block* (existing `_buildBlock`) or a *model block* (new `_buildModelBlock`: a building GLB template tiled along the block's long axis + ONE footprint AABB collider matching the block, never the mesh — this is the proven-safe approach per `AssetManager.js:83-90`). Building models are optimized via gltf-transform and loaded through the existing `MODEL_DEFS`/`getModel` path.

**Tech Stack:** Three.js 0.184, Vite 6, vitest, `@gltf-transform/cli` (via npx), Playwright MCP for verification.

**Branch:** `feat/map-rework`. Spec: `docs/superpowers/specs/2026-06-17-map-rework-design.md`. Stage explicit paths only (home dir is a separate git repo).

---

## File Map

**New**
- `scripts/optimize-buildings.sh` — optimize chosen reference GLBs → `public/models/bldg_*.glb`
- `src/game/BuildingLayout.js` — pure helpers: footprint collider, tiling spec, per-sector block plan
- `tests/buildingLayout.test.js` — unit tests for the pure helpers
- `public/models/bldg_*.glb` — optimized building templates (produced by the script)
- `assets/models/<source>.glb` — raw reference sources copied in for the script (not shipped)

**Modified**
- `src/game/AssetManager.js` — add `MODEL_DEFS` entries for the `bldg_*` slugs (Phase 1 fills values)
- `src/game/Level.js` — add `_buildModelBlock`; swap the block loop to a layout-driven dispatch

---

## PHASE 1 — Asset audit (discovery gate; produces the building manifest)

This phase determines which models are usable and their normalization. Its output
is a **manifest** the later phases consume. No layout work until it's done.

### Task 1: Optimize-buildings script

**Files:** Create `scripts/optimize-buildings.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Optimize raw reference building GLBs into web-shippable templates
# (public/models/bldg_*.glb), mirroring scripts/optimize-map.sh's proven recipe:
# specGloss->metalRough, webp textures, meshopt, geometry simplify. NO --palette
# (palette corrupts textures — recorded lesson).
#
# Usage: scripts/optimize-buildings.sh [texture_size]   (default 512)
set -euo pipefail
SIZE="${1:-512}"
GT="npx --yes @gltf-transform/cli@latest"
REF="../asset-reference"          # raw sources live alongside the repo
OUT="public/models"
mkdir -p "$OUT"

# slug -> source filename. Edit this list as the audit selects/drops candidates.
declare -A SRC=(
  [bldg_terrace]="old_building.glb"
  [bldg_collapsed]="collapsed_uk_terraced_house.glb"
  [bldg_shop]="angers_shop_2_france.glb"
  [bldg_pub]="betsey_trotwood_pub.glb"
)

for slug in "${!SRC[@]}"; do
  src="$REF/${SRC[$slug]}"
  if [ ! -f "$src" ]; then echo "SKIP $slug (missing $src)"; continue; fi
  t="$(mktemp --suffix=.glb)"
  echo "[$slug] specGloss -> metalRough…"
  $GT metalrough "$src" "$t" 2>/dev/null || cp "$src" "$t"
  echo "[$slug] optimize webp@${SIZE} + meshopt + simplify…"
  $GT optimize "$t" "$OUT/$slug.glb" \
    --texture-compress webp --texture-size "$SIZE" \
    --compress meshopt --palette false --simplify true \
    --simplify-ratio 0.6 --simplify-error 0.01
  rm -f "$t"
  echo "  -> $(du -h "$OUT/$slug.glb" | cut -f1)"
done
echo "done."
```

- [ ] **Step 2: Make executable + run**

Run: `chmod +x scripts/optimize-buildings.sh && scripts/optimize-buildings.sh 512`
Expected: each `bldg_*.glb` written to `public/models/`, each printing a size
(target ≤ ~5 MB). If a model fails `metalrough`, the script falls back to copying
then optimizing. Record any failures.

- [ ] **Step 3: Commit the script + optimized models**

```bash
git add scripts/optimize-buildings.sh public/models/bldg_terrace.glb public/models/bldg_collapsed.glb public/models/bldg_shop.glb public/models/bldg_pub.glb
git commit -m "build(map): optimize-buildings script + optimized Belfast building templates"
```
(Only add the `bldg_*.glb` that were actually produced.)

### Task 2: Preview + normalize each template (manifest)

**Files:** Modify `src/game/AssetManager.js` (`MODEL_DEFS`, after `prop_car`, ~line 70)

- [ ] **Step 1: Add provisional MODEL_DEFS entries**

In `MODEL_DEFS` add (these are starting guesses; Step 3 corrects them):
```js
  // Belfast exterior building templates (optimized from asset-reference).
  bldg_terrace:   { size: 12, fit: "height", anchor: "bottom", rotY: 0 },
  bldg_collapsed: { size: 11, fit: "height", anchor: "bottom", rotY: 0 },
  bldg_shop:      { size: 10, fit: "height", anchor: "bottom", rotY: 0 },
  bldg_pub:       { size: 12, fit: "height", anchor: "bottom", rotY: 0 },
```

- [ ] **Step 2: Build + load each template in-game and inspect it**

Run `npm run build` (expect `✓ built`). Start the dev server, then via the
Playwright dev handle add each template to the scene in front of the camera and
screenshot to judge facing, scale, and whether it's a single building (vs a whole
scene or broken mesh):
```js
() => {
  const g = window.__game; g._startCampaign();
  const out = {};
  let x = -6;
  for (const slug of ["bldg_terrace","bldg_collapsed","bldg_shop","bldg_pub"]) {
    const m = g.assets.getModel(slug);
    if (!m) { out[slug] = "MISSING"; continue; }
    m.position.set(x, 0, g.player.pos.z - 14); // line them up ahead of spawn
    m.updateMatrixWorld(true);
    g.engine.scene.add(m);
    out[slug] = { children: m.children.length };
    x += 6;
  }
  g.pauseMenu.hide(); g.phase = "RESULTS";   // neutralize the headless soft-pause
  g.player._applyCamera(0);
  return out;
}
```
Then `browser_take_screenshot`. Judge each model's facing/scale/quality visually.
(Per-model true dimensions are measured in code by `_buildModelBlock` via
`new THREE.Box3().setFromObject(tpl)`; for the audit, the screenshot is the judge.)

- [ ] **Step 3: Record the manifest + correct MODEL_DEFS**

For each usable model, set in `MODEL_DEFS`: `size` (height in metres so it reads as
a 2–4 storey building, ~10–14), `rotY` (so the facade/front faces +X or the street;
rotate by Math.PI/2 increments until the front faces the lane), `anchor:"bottom"`.
**Record a manifest comment** above the building defs listing, per slug:
`{ usable: true/false, footprintDepthZ: <metres>, facadeFacesStreet rotY: <rad> }`.
Drop (delete the def + remove from the script + delete the glb) any model that is
broken, a whole-scene, or too heavy after optimization. The surviving slugs +
their `footprintDepthZ` feed Phase 3 tiling and Phase 4 layout.

- [ ] **Step 4: Commit**

```bash
git add src/game/AssetManager.js
git commit -m "feat(map): register + normalize optimized building templates (audit manifest)"
```

---

## PHASE 2 — Layout helper (pure, tested)

### Task 3: BuildingLayout module

**Files:** Create `src/game/BuildingLayout.js`, Test `tests/buildingLayout.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { footprintCollider, tileSpec, blockPlan, INTERIOR_BLOCKS } from "../src/game/BuildingLayout.js";

describe("footprintCollider", () => {
  it("is an axis-aligned box centred on the block, full height", () => {
    const box = footprintCollider(10, -20, 14, 15, 56);
    expect(box.min.x).toBeCloseTo(3);   // 10 - 7
    expect(box.max.x).toBeCloseTo(17);  // 10 + 7
    expect(box.min.z).toBeCloseTo(-48); // -20 - 28
    expect(box.max.z).toBeCloseTo(8);   // -20 + 28
    expect(box.min.y).toBeCloseTo(0);
    expect(box.max.y).toBeCloseTo(15);
  });
});

describe("tileSpec", () => {
  it("fits whole copies of a model along the block run and centres them", () => {
    const s = tileSpec(56, 9, 0.3); // blockLen, modelDepth, gap
    expect(s.count).toBe(6);                 // floor(56 / 9.3) = 6
    expect(s.step).toBeCloseTo(9.3);
    // first copy centre offset from block centre
    expect(s.offsets.length).toBe(6);
    expect(s.offsets[0]).toBeCloseTo(-((6 - 1) * 9.3) / 2, 5);
  });
  it("never returns fewer than 1 copy", () => {
    expect(tileSpec(8, 20, 0.3).count).toBe(1);
  });
});

describe("blockPlan / INTERIOR_BLOCKS", () => {
  it("marks exactly 2 interior blocks across the 3x2 grid", () => {
    let interiors = 0;
    for (let c = 0; c < 3; c++) for (let r = 0; r < 2; r++)
      if (blockPlan(c, r, 0).kind === "interior") interiors++;
    expect(interiors).toBe(2);
    expect(INTERIOR_BLOCKS.length).toBe(2);
  });
  it("model blocks reference a known template slug", () => {
    const slugs = new Set(["bldg_terrace","bldg_collapsed","bldg_shop","bldg_pub"]);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 2; r++) {
      const p = blockPlan(c, r, 0);
      if (p.kind === "model") expect(slugs.has(p.template)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- buildingLayout`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Implement**

```js
import * as THREE from "three";

/**
 * Axis-aligned footprint collider for a block: a clean box matching the block's
 * ground rectangle, full wall height. Streets stay walkable because this never
 * uses the building mesh (which would interlock and seal lanes).
 */
export function footprintCollider(cx, cz, w, h, l) {
  return new THREE.Box3(
    new THREE.Vector3(cx - w / 2, 0, cz - l / 2),
    new THREE.Vector3(cx + w / 2, h, cz + l / 2),
  );
}

/**
 * Tile a single building model into a terraced row down a block's long (Z) run.
 * Returns the copy count, the Z step, and centred Z offsets from the block centre.
 */
export function tileSpec(blockLen, modelDepth, gap = 0.3) {
  const step = Math.max(0.1, modelDepth + gap);
  const count = Math.max(1, Math.floor(blockLen / step));
  const span = (count - 1) * step;
  const offsets = [];
  for (let i = 0; i < count; i++) offsets.push(-span / 2 + i * step);
  return { count, step, offsets };
}

/**
 * The 2 blocks (col,row) that keep full procedural interiors (kickable doors).
 * Chosen so an interior building sits on each row near the player's path.
 */
export const INTERIOR_BLOCKS = [
  { col: 0, row: 1 }, // south-west block (near spawn)
  { col: 2, row: 0 }, // north-east block
];

/**
 * Plan for one grid block. `kind:"interior"` keeps the procedural room; else a
 * building-model template tiled into a terrace. `index` is the sector index so
 * the mix can vary per sector (kept simple here; landmarks at the corners).
 */
export function blockPlan(col, row, index) {
  if (INTERIOR_BLOCKS.some((b) => b.col === col && b.row === row)) {
    return { kind: "interior" };
  }
  // Corners get landmarks (shop / collapsed); the rest are terraces. Pub appears
  // from sector 2 onward as a feature block.
  if (col === 0 && row === 0) return { kind: "model", template: "bldg_shop" };
  if (col === 2 && row === 1) return { kind: "model", template: "bldg_collapsed" };
  if (col === 1 && row === 0 && index >= 2) return { kind: "model", template: "bldg_pub" };
  return { kind: "model", template: "bldg_terrace" };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- buildingLayout`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/BuildingLayout.js tests/buildingLayout.test.js
git commit -m "feat(map): BuildingLayout — footprint collider, tiling, per-block plan"
```

---

## PHASE 3 — Level integration (model blocks + dispatch)

### Task 4: `_buildModelBlock` + layout dispatch

**Files:** Modify `src/game/Level.js` (import; `_buildProcedural` block loop ~210-215; add method near `_buildBlock`)

- [ ] **Step 1: Import the layout helper**

At the top of `src/game/Level.js`, after `import { EnemyDirector } ...`, add:
```js
import { footprintCollider, tileSpec, blockPlan } from "./BuildingLayout.js";
```

- [ ] **Step 2: Add `_buildModelBlock`**

Add this method immediately AFTER `_buildBlock(...)` closes:
```js
  /**
   * Exterior-only block: a building-model template tiled into a terraced row
   * down the block's long (Z) run, plus ONE footprint collider matching the
   * block (never the model mesh — keeps the street grid walkable). Falls back to
   * the procedural block if the template model isn't available.
   */
  _buildModelBlock(cx, cz, slug, rng) {
    const tpl = this.assets && this.assets.getModel(slug);
    if (!tpl) { this._buildBlock(cx, cz, 0, rng); return; } // safe fallback

    // Pavement apron (matches the interior blocks' look; walk-over, no collider).
    const pave = new THREE.Mesh(
      new THREE.BoxGeometry(this.BLOCK_W + 3, 0.12, this.BLOCK_L + 3),
      this._materials.pavement,
    );
    pave.position.set(cx, 0.06, cz);
    this.group.add(pave);

    // Face the model's front toward the inner street (east blocks face -X, etc.).
    const faceY = cx < 0 ? Math.PI / 2 : cx > 0 ? -Math.PI / 2 : 0;

    // Measure the template's depth (Z) once to tile copies down the run.
    const size = new THREE.Box3().setFromObject(tpl).getSize(new THREE.Vector3());
    const depth = Math.max(2, Math.min(size.z, size.x)); // narrow axis = frontage depth
    const { offsets } = tileSpec(this.BLOCK_L, depth, 0.3);
    for (const dz of offsets) {
      const m = this.assets.getModel(slug); // fresh clone per copy
      m.rotation.y = faceY;
      m.position.set(cx, 0, cz + dz);
      this.group.add(m);
    }

    // One clean footprint collider + LOS blocker for the whole block.
    const box = footprintCollider(cx, cz, this.BLOCK_W, this.WALL_H, this.BLOCK_L);
    this.colliders.push(box);
    this.losBlockers.push(box);
  }
```

- [ ] **Step 3: Swap the block loop to the layout dispatch**

Replace the block loop (currently `Level.js:210-215`):
```js
    for (const cz of COORDS_Z) {
      for (const cx of COORDS_X) {
        const enemyCount = 2 + (rng() < 0.5 ? 1 : 0); // 2–3 occupied rooms per building
        this._buildBlock(cx, cz, enemyCount, rng);
      }
    }
```
with:
```js
    COORDS_Z.forEach((cz, row) => {
      COORDS_X.forEach((cx, col) => {
        const plan = blockPlan(col, row, this.index);
        if (plan.kind === "interior") {
          const enemyCount = 2 + (rng() < 0.5 ? 1 : 0);
          this._buildBlock(cx, cz, enemyCount, rng);
        } else {
          this._buildModelBlock(cx, cz, plan.template, rng);
        }
      });
    });
```

- [ ] **Step 4: Build + verify a model block renders and blocks movement**

Run: `npm run build` (expect `✓ built`). Then via Playwright:
```js
() => {
  const g = window.__game; g._startCampaign();
  // count interior (door-bearing) buildings vs model blocks
  return { doors: g.level.doors.length, colliders: g.level.getColliders().length,
           enemies: g.level.enemies.length };
}
```
Expected: `doors` > 0 (the 2 interior blocks still have kickable doors),
`colliders` positive (footprint boxes + street + doors). Screenshot the spawn
view — model buildings line the street, no crash.

- [ ] **Step 5: Verify streets are still walkable (no sealed blocks)**

```js
() => {
  const g = window.__game; g._startCampaign();
  const P = g.player; P.reset(g.levelManager.spawn, g.levelManager.spawnYaw||0);
  P.keys = Object.create(null); P.keys["KeyW"]=true;
  const z0 = P.pos.z;
  for (let i=0;i<240;i++) P.update(1/60); // walk forward 4s down the lane
  return { startZ:+z0.toFixed(1), endZ:+P.pos.z.toFixed(1), moved:+Math.abs(P.pos.z - z0).toFixed(1), finite: Number.isFinite(P.pos.z) };
}
```
Expected: `moved` is several metres (the player advances down the lane — not stuck
against a wall at spawn), `finite: true`. If `moved` ≈ 0, a footprint collider is
overlapping the lane — recheck `footprintCollider` sizing.

- [ ] **Step 6: Commit**

```bash
git add src/game/Level.js
git commit -m "feat(map): model-building blocks + footprint colliders, keep 2 interiors"
```

---

## PHASE 4 — Belfast layout pass

### Task 5: Tune the grid for a terraced-street feel

**Files:** Modify `src/game/BuildingLayout.js` (`blockPlan`/`INTERIOR_BLOCKS`) using audit results

- [ ] **Step 1: Adjust template assignment from the audit**

Using the Phase 1 manifest (which templates survived), edit `blockPlan` so the 4
model blocks read as a Belfast terrace: terrace rows on the through-streets, the
`bldg_collapsed` as war-torn flavor at one corner, `bldg_shop`/`bldg_pub` as corner
features. If a template was dropped in the audit, replace its references with
`bldg_terrace`. Keep `INTERIOR_BLOCKS` at exactly 2 (verified by the Task 3 test).

- [ ] **Step 2: Re-run the layout test + build**

Run: `npm test -- buildingLayout && npm run build`
Expected: tests pass (still exactly 2 interiors; all model templates are known
slugs), `✓ built`.

- [ ] **Step 3: Screenshot the reworked sector**

Via Playwright, snap the spawn view + an elevated establishing shot of a sector.
Confirm it reads as a Belfast terraced grid, the 2 interior buildings are present,
and the streets are open. Adjust `tileSpec` gap or per-template `rotY`/`size` in
`MODEL_DEFS` if buildings overlap, float, or face the wrong way.

- [ ] **Step 4: Commit**

```bash
git add src/game/BuildingLayout.js src/game/AssetManager.js
git commit -m "feat(map): Belfast terraced layout pass (template assignment + tuning)"
```

---

## PHASE 5 — Verify

### Task 6: Full verification

**Files:** none (verification)

- [ ] **Step 1: Build + unit suite + size budget**

Run: `npm run build && npm test`
Expected: `✓ built`, all tests pass. Note `dist` size: `du -sh dist` — the added
`bldg_*` models should keep the total within ~+25 MB of the prior build; if not,
re-run `optimize-buildings.sh 256` (smaller textures) or drop a heavy template.

- [ ] **Step 2: Playtest — walkability, breaching, enemies, frame stability**

Via Playwright on `localhost:1420`:
- Walk down each of the 3 north–south lanes (simulate `KeyW`/strafe) and confirm
  the player traverses the sector (no sealed lanes).
- Confirm the 2 interior buildings' doors are kickable (`g.level.doors.length` > 0;
  position the camera at a door and verify the kick opens it via `_kick`).
- Advance player + enemies 120 frames in a late sector; assert all positions finite,
  `getColliders().length > 0`, no console errors.
- Screenshot spawn + establishing views for the record.

- [ ] **Step 3: No commit (verification only). Record findings.**

### Task 7: Finish the branch

- [ ] **Step 1: Confirm diff scope**

Run: `git diff --stat <base>..HEAD` — only the File Map files (+ spec/plan docs +
`bldg_*.glb`). No files outside the subrepo.

- [ ] **Step 2: Invoke `superpowers:finishing-a-development-branch`** to choose merge / PR / cleanup (do not auto-merge).

---

## Spec Coverage Check
- §4.1 pipeline → Task 1. §4.2 AssetManager defs → Task 2. §4.3 Level rework (model + interior dispatch, footprint colliders) → Tasks 3–4. §2 decisions (footprint colliders, 2 interiors, template reuse) → Tasks 3 + helper. §5 candidate set + §6 audit-first → Phase 1. §7 risks (sealed streets, scale/facing, bloat, interior regression) → Tasks 3-Step5, 2-Step3, 6-Step1, 6-Step2.

## Notes for the implementer
- **Phase 1 is a discovery gate** — its manifest (surviving templates, depths, rotY) drives Phases 3–4. Don't hardcode layout before the audit; the helpers default-fall-back to `bldg_terrace` so a dropped template never breaks the build.
- Stage explicit paths only (home dir is a separate git repo); never `git add -A`.
- `THREE.Box3().setFromObject()` works headless (used in tests + `_buildModelBlock`); model *rendering* is verified via Playwright, not unit tests.
- Match anchors by quoted code if line numbers drift.
