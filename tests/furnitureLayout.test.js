import { describe, it, expect } from "vitest";
import LAYOUT from "../src/data/furniture.json";
import { furnitureFits, INTERIOR_ROOM } from "../src/game/FurnitureLayout.js";

describe("furniture layout", () => {
  it("keeps every piece inside the interior room bounds", () => {
    for (const p of LAYOUT) {
      expect(Math.abs(p.x) + p.w / 2).toBeLessThanOrEqual(INTERIOR_ROOM.halfW);
      expect(Math.abs(p.z) + p.d / 2).toBeLessThanOrEqual(INTERIOR_ROOM.halfD);
    }
  });

  it("never blocks the door approach or the room centre (captor/victim slot)", () => {
    expect(furnitureFits(LAYOUT, INTERIOR_ROOM)).toBe(true);
  });

  it("flags a piece that would sit on the door", () => {
    const bad = [{ slug: "x", x: INTERIOR_ROOM.door.x, z: 0, w: 1, d: 1, collider: true }];
    expect(furnitureFits(bad, INTERIOR_ROOM)).toBe(false);
  });

  it("flags a piece that overflows the room", () => {
    const bad = [{ slug: "x", x: INTERIOR_ROOM.halfW, z: 0, w: 2, d: 1 }];
    expect(furnitureFits(bad, INTERIOR_ROOM)).toBe(false);
  });
});
