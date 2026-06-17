import { describe, it, expect } from "vitest";
import { animStep, serpentineOffset } from "../src/game/EnemyBehavior.js";

describe("animStep (stop-motion clamp)", () => {
  it("does not advance until a frame interval has accumulated", () => {
    const r = animStep(0, 0.016, 11); // one 60fps frame at 11fps
    expect(r.advance).toBe(0);
    expect(r.accum).toBeCloseTo(0.016, 5);
  });
  it("advances by exactly one step once accumulated, keeping remainder", () => {
    const r = animStep(0.08, 0.02, 11); // 0.10 >= 1/11 (0.0909)
    expect(r.advance).toBeCloseTo(1 / 11, 5);
    expect(r.accum).toBeCloseTo(0.1 - 1 / 11, 5);
  });
});

describe("serpentineOffset", () => {
  it("is zero at t=0 and oscillates within amplitude", () => {
    expect(serpentineOffset(0, 4, 2)).toBeCloseTo(0, 5);
    for (let t = 0; t < 3; t += 0.1) expect(Math.abs(serpentineOffset(t, 4, 2))).toBeLessThanOrEqual(4 + 1e-9);
  });
});
