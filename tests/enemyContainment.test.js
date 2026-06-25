import { describe, it, expect } from "vitest";
import { clampInsideBounds } from "../src/game/Level.js";

// Regression: an enemy must never sit outside the boundary wall, where the player
// can't reach it (knockback tunnelling / hunting pathing once pushed one past a
// thin wall → an un-killable, sector-blocking ghost that soft-locks the level).
describe("clampInsideBounds", () => {
  const HX = 31 + 12; // GRID_HALF_X + boundary margin (level-1 values)
  const HZ = 61 + 12;

  it("leaves in-bounds positions untouched", () => {
    const c = clampInsideBounds(10, -20, HX, HZ);
    expect(c.x).toBe(10);
    expect(c.z).toBe(-20);
  });

  it("pulls an out-of-bounds enemy back inside the wall (curing a soft-lock)", () => {
    const c = clampInsideBounds(999, -999, HX, HZ);
    expect(c.x).toBeLessThan(HX); // strictly inside the wall centreline
    expect(c.z).toBeGreaterThan(-HZ);
    expect(Math.abs(c.x)).toBeLessThanOrEqual(HX);
    expect(Math.abs(c.z)).toBeLessThanOrEqual(HZ);
  });

  it("keeps the body off the slab via the inset on every side", () => {
    expect(clampInsideBounds(1e6, 0, HX, HZ).x).toBeCloseTo(HX - 1, 5);
    expect(clampInsideBounds(-1e6, 0, HX, HZ).x).toBeCloseTo(-(HX - 1), 5);
    expect(clampInsideBounds(0, 1e6, HX, HZ).z).toBeCloseTo(HZ - 1, 5);
    expect(clampInsideBounds(0, -1e6, HX, HZ).z).toBeCloseTo(-(HZ - 1), 5);
  });
});
