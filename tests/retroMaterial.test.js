import { describe, it, expect } from "vitest";
import { computeResolution } from "../src/game/RetroMaterial.js";

describe("computeResolution", () => {
  it("keeps the target vertical resolution and scales x by aspect", () => {
    const r = computeResolution(1920, 1080, 240);
    expect(r.y).toBe(240);
    expect(r.x).toBe(Math.round(240 * (1920 / 1080)));
  });
  it("degrades gracefully on zero size", () => {
    const r = computeResolution(0, 0, 240);
    expect(r).toEqual({ x: 240, y: 240 });
  });
  it("never returns < 1", () => {
    const r = computeResolution(100, 100, 0);
    expect(r.x).toBeGreaterThanOrEqual(1);
    expect(r.y).toBeGreaterThanOrEqual(1);
  });
});
