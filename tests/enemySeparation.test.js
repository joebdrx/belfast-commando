import { describe, it, expect } from "vitest";
import { separateBodies } from "../src/game/Level.js";

// Enemies all beeline to the player with no inter-enemy collision, so they stacked
// into a single blob of overlapping meshes. separateBodies pushes overlapping pairs
// apart each frame so they fan out around the player instead.
describe("separateBodies", () => {
  const dist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

  it("leaves non-overlapping bodies untouched", () => {
    const bodies = [{ x: 0, z: 0, r: 0.45 }, { x: 5, z: 0, r: 0.45 }];
    separateBodies(bodies);
    expect(bodies[0]).toEqual({ x: 0, z: 0, r: 0.45 });
    expect(bodies[1]).toEqual({ x: 5, z: 0, r: 0.45 });
  });

  it("pushes an overlapping pair to exactly touching (one pass)", () => {
    const bodies = [{ x: 0, z: 0, r: 0.45 }, { x: 0.3, z: 0, r: 0.45 }];
    separateBodies(bodies);
    expect(dist(bodies[0], bodies[1])).toBeCloseTo(0.9, 5); // r+r
    // Symmetric split: each moved half the overlap.
    expect(bodies[0].x).toBeCloseTo(-0.3, 5);
    expect(bodies[1].x).toBeCloseTo(0.6, 5);
  });

  it("separates exactly-coincident bodies (no NaN, deterministic nudge)", () => {
    const bodies = [{ x: 2, z: 2, r: 0.45 }, { x: 2, z: 2, r: 0.45 }];
    separateBodies(bodies);
    const d = dist(bodies[0], bodies[1]);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeCloseTo(0.9, 5);
  });

  it("relaxes a 3-way pile so no pair stays fully overlapped", () => {
    const bodies = [{ x: 0, z: 0, r: 0.45 }, { x: 0.1, z: 0, r: 0.45 }, { x: 0, z: 0.1, r: 0.45 }];
    separateBodies(bodies);
    for (let i = 0; i < bodies.length; i++)
      for (let j = i + 1; j < bodies.length; j++)
        expect(dist(bodies[i], bodies[j])).toBeGreaterThan(0.1); // meaningfully spread
  });
});
