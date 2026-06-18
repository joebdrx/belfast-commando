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
