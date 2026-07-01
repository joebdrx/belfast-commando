import { describe, it, expect, beforeAll } from "vitest";
import * as THREE from "three";
import { sectorProfile, SECTOR_PROFILES } from "../src/game/SectorProfile.js";
import { blockPlan, INTERIOR_BLOCKS } from "../src/game/BuildingLayout.js";
import { Level } from "../src/game/Level.js";

// Headless DOM shim (Level's procedural build touches THREE.TextureLoader → document).
beforeAll(() => {
  if (typeof globalThis.document === "undefined") {
    const fakeEl = () => ({
      addEventListener() {}, removeEventListener() {}, setAttribute() {},
      style: {}, getContext: () => null,
    });
    globalThis.document = { createElementNS: fakeEl, createElement: fakeEl };
  }
});

// Count interior blocks across the 3×2 grid for a given index + profile.
function countInteriors(index, profile) {
  let n = 0;
  for (let c = 0; c < 3; c++) for (let r = 0; r < 2; r++)
    if (blockPlan(c, r, index, profile).kind === "interior") n++;
  return n;
}

describe("sectorProfile", () => {
  it("defines a profile for every campaign sector (0–6)", () => {
    for (let i = 0; i <= 6; i++) expect(SECTOR_PROFILES[i]).toBeTruthy();
  });
  it("falls back to a neutral standard profile for unknown indices", () => {
    expect(sectorProfile(99).label).toBe("standard");
    expect(sectorProfile(99).interiorBias).toBe(0);
  });
});

describe("blockPlan interiorBias", () => {
  it("is unchanged with no profile (back-compat = bias 0)", () => {
    for (let c = 0; c < 3; c++) for (let r = 0; r < 2; r++)
      expect(blockPlan(c, r, 0)).toEqual(blockPlan(c, r, 0, { interiorBias: 0 }));
  });
  it("more interiors with +bias, fewer with -bias (monotonic)", () => {
    const more = countInteriors(0, { interiorBias: 1 });
    const base = countInteriors(0, null);
    const less = countInteriors(0, { interiorBias: -1 });
    expect(more).toBeGreaterThan(base);
    expect(base).toBeGreaterThan(less);
  });
});

describe("special block archetypes (arena / yard)", () => {
  it("the Markets swap one block for an arena; Docks a yard; Divis a tower", () => {
    expect(blockPlan(1, 1, 2, sectorProfile(2)).kind).toBe("arena");
    expect(blockPlan(1, 1, 3, sectorProfile(3)).kind).toBe("yard");
    expect(blockPlan(1, 1, 6, sectorProfile(6)).kind).toBe("tower");
  });
  it("never emits a special kind without a profile (back-compat)", () => {
    for (let i = 0; i <= 6; i++)
      for (let c = 0; c < 3; c++) for (let r = 0; r < 2; r++) {
        const k = blockPlan(c, r, i).kind;
        expect(k === "interior" || k === "model").toBe(true);
      }
  });
  it("the special slot never lands on an anchored interior", () => {
    // The interior victim relies on the two anchored interiors staying interiors.
    for (const idx of [2, 3, 6]) {
      const sp = sectorProfile(idx).special;
      const onAnchor = INTERIOR_BLOCKS.some((b) => b.col === sp.col && b.row === sp.row);
      expect(onAnchor).toBe(false);
    }
  });
  it("the Markets and Docks build a populated sector (enemies + barrels)", () => {
    const markets = new Level(new THREE.Scene(), 2, null, 1234);
    const docks = new Level(new THREE.Scene(), 3, null, 1234);
    expect(markets.enemies.length).toBeGreaterThan(0);
    expect(markets.victimCount).toBeGreaterThan(0);
    expect(docks.enemies.length).toBeGreaterThan(0);
    expect(docks.barrels.length).toBeGreaterThan(0);
  });
  it("Divis builds a tall climbable tower at its centre block", () => {
    const divis = new Level(new THREE.Scene(), 6, null, 1234);
    expect(divis.enemies.length).toBeGreaterThan(0);
    // A tower tier reaches the rooftop height (~5.2m) centred on the col1,row1
    // block (cx=0, cz≈33) — no ordinary building/footprint collider gets that tall.
    const tower = divis.colliders.some(
      (b) => b.max.y > 5 && Math.abs((b.min.x + b.max.x) / 2) < 2 && Math.abs((b.min.z + b.max.z) / 2 - 33) < 3,
    );
    expect(tower).toBe(true);
    // Ledge ambushers are seated up on the tier rings (floor-by-floor garrison).
    expect(divis.enemies.some((e) => e.group.position.y > 1)).toBe(true);
  });
});

describe("per-sector worlds are measurably different", () => {
  it("a breach-maze sector builds more kickable doors than a gauntlet sector", () => {
    // Falls Road (interiorBias +1) vs Shankill (interiorBias -1), same seed.
    const falls = new Level(new THREE.Scene(), 0, null, 4242);
    const shankill = new Level(new THREE.Scene(), 1, null, 4242);
    expect(falls.doors.length).toBeGreaterThan(0);
    expect(shankill.enemies.length).toBeGreaterThan(0);
    expect(falls.doors.length).toBeGreaterThan(shankill.doors.length);
  });
  it("the Docks are barrel-dense relative to residential Falls Road", () => {
    const falls = new Level(new THREE.Scene(), 0, null, 7777);
    const docks = new Level(new THREE.Scene(), 3, null, 7777);
    expect(docks.barrels.length).toBeGreaterThan(falls.barrels.length);
  });
});
