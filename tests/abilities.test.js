import { describe, it, expect } from "vitest";
import { bootModifiers, isAdrenaline, computeRefund } from "../src/game/Abilities.js";

describe("bootModifiers", () => {
  it("fast_sprint boosts sprint only", () => {
    const m = bootModifiers("fast_sprint");
    expect(m.sprintSpeedMul).toBeGreaterThan(1);
    expect(m.slideDurationMul).toBe(1);
  });
  it("long_slide lengthens + speeds the slide", () => {
    const m = bootModifiers("long_slide");
    expect(m.slideDurationMul).toBeGreaterThan(1);
    expect(m.slideSpeedMul).toBeGreaterThan(1);
  });
  it("unknown/standard is neutral", () => {
    const m = bootModifiers("standard");
    expect(m).toEqual({ sprintSpeedMul: 1, slideSpeedMul: 1, slideDurationMul: 1 });
  });
});

describe("isAdrenaline", () => {
  it("triggers below 30% with the upgrade", () => {
    expect(isAdrenaline(29, 100, true)).toBe(true);
    expect(isAdrenaline(30, 100, true)).toBe(false);
  });
  it("never triggers without the upgrade", () => {
    expect(isAdrenaline(1, 100, false)).toBe(false);
  });
});

describe("computeRefund", () => {
  it("is 15% of the mag, floored, min 1", () => {
    expect(computeRefund(30)).toBe(4);
    expect(computeRefund(12)).toBe(1);
    expect(computeRefund(6)).toBe(1);
  });
});
