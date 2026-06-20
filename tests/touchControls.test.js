import { describe, it, expect } from "vitest";
import { joystickToKeys } from "../src/game/TouchControls.js";

describe("joystickToKeys", () => {
  it("is neutral at centre and inside the deadzone", () => {
    expect(joystickToKeys(0, 0)).toEqual({
      KeyW: false,
      KeyS: false,
      KeyA: false,
      KeyD: false,
      ShiftLeft: false,
    });
    // Small offset within the default 0.28 deadzone → still neutral.
    expect(joystickToKeys(0.2, -0.2)).toMatchObject({ KeyW: false, KeyD: false });
  });

  it("maps the four cardinal directions (up = forward)", () => {
    expect(joystickToKeys(0, -0.6)).toMatchObject({ KeyW: true, KeyS: false });
    expect(joystickToKeys(0, 0.6)).toMatchObject({ KeyS: true, KeyW: false });
    expect(joystickToKeys(-0.6, 0)).toMatchObject({ KeyA: true, KeyD: false });
    expect(joystickToKeys(0.6, 0)).toMatchObject({ KeyD: true, KeyA: false });
  });

  it("supports diagonals", () => {
    expect(joystickToKeys(0.6, -0.6)).toMatchObject({ KeyW: true, KeyD: true });
  });

  it("engages sprint only when pushed to the rim", () => {
    expect(joystickToKeys(0, -0.6).ShiftLeft).toBe(false);
    expect(joystickToKeys(0, -1).ShiftLeft).toBe(true);
  });

  it("clamps an over-range offset to the unit circle (sprint, single axis)", () => {
    // (0,-2) normalises to (0,-1): full forward + sprint, no spurious side keys.
    expect(joystickToKeys(0, -2)).toEqual({
      KeyW: true,
      KeyS: false,
      KeyA: false,
      KeyD: false,
      ShiftLeft: true,
    });
  });

  it("sprint threshold can be customised", () => {
    // Custom sprint=0.5 — half-way push engages sprint.
    expect(joystickToKeys(0, -0.6, { sprint: 0.5 }).ShiftLeft).toBe(true);
    expect(joystickToKeys(0, -0.4, { sprint: 0.5 }).ShiftLeft).toBe(false);
  });
});
