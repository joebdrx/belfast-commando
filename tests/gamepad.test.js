import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Gamepad, applyDeadzone } from "../src/game/Gamepad.js";

// Standard-mapping button indices used below: RT=7, X=2 (reload), START=9.
function mkpad(axes = [0, 0, 0, 0], pressed = [], analog = {}) {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const value = analog[i] != null ? analog[i] : pressed.includes(i) ? 1 : 0;
    return { pressed: pressed.includes(i) || value > 0.5, value };
  });
  return { axes, buttons, mapping: "standard", connected: true };
}

describe("applyDeadzone", () => {
  it("zeroes inside the deadzone and rescales outside", () => {
    expect(applyDeadzone(0.1, 0.18)).toBe(0);
    expect(applyDeadzone(1, 0.18)).toBeCloseTo(1, 5); // full deflection → full output
    expect(applyDeadzone(-1, 0.18)).toBeCloseTo(-1, 5);
    expect(applyDeadzone(0.18, 0.18)).toBe(0); // exactly at the edge
  });
});

describe("Gamepad.poll", () => {
  let gp, calls, current;

  beforeEach(() => {
    current = mkpad();
    vi.stubGlobal("navigator", { getGamepads: () => [current] });
    calls = [];
    gp = new Gamepad();
    gp.setHandlers(
      Object.fromEntries(
        ["onLook", "onMove", "onKeyDown", "onKeyUp", "onFireDown", "onFireUp", "onReload", "onSwitch", "onPause", "onMute", "onSprintDown", "onSprintUp"].map(
          (n) => [n, (...a) => calls.push([n, ...a])],
        ),
      ),
    );
    gp.setActive(true);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  const names = () => calls.map((c) => c[0]);

  it("does nothing while inactive", () => {
    gp.setActive(false);
    calls = []; // ignore the release emitted on deactivate (tested separately)
    current = mkpad([0, -1, 0, 0], [7]); // moving + firing
    gp.poll(1 / 60);
    expect(calls).toHaveLength(0);
  });

  it("edge-detects the fire trigger (down once, up once)", () => {
    current = mkpad([0, 0, 0, 0], [], { 7: 0.8 }); // RT held
    gp.poll(1 / 60);
    gp.poll(1 / 60); // still held → no second onFireDown
    expect(names().filter((n) => n === "onFireDown")).toHaveLength(1);
    current = mkpad(); // released
    gp.poll(1 / 60);
    expect(names().filter((n) => n === "onFireUp")).toHaveLength(1);
  });

  it("treats reload (X) as one-shot on the rising edge", () => {
    current = mkpad([0, 0, 0, 0], [2]);
    gp.poll(1 / 60);
    gp.poll(1 / 60); // held → not again
    expect(names().filter((n) => n === "onReload")).toHaveLength(1);
  });

  it("maps the right stick to a look delta (sign + deadzone)", () => {
    current = mkpad([0, 0, 0.1, 0]); // inside deadzone → no look
    gp.poll(1 / 60);
    expect(names()).not.toContain("onLook");
    current = mkpad([0, 0, 1, 0]); // full right
    gp.poll(1 / 60);
    const look = calls.find((c) => c[0] === "onLook");
    expect(look[1]).toBeGreaterThan(0); // dx > 0 turns right
    expect(look[2]).toBe(0);
  });

  it("emits move only while deflected, with one release", () => {
    current = mkpad([0, -1, 0, 0]); // left stick full up → forward
    gp.poll(1 / 60);
    let mv = calls.find((c) => c[0] === "onMove");
    expect(mv[1].KeyW).toBe(true);
    calls = [];
    current = mkpad(); // centred → one release emit
    gp.poll(1 / 60);
    expect(names().filter((n) => n === "onMove")).toHaveLength(1);
    calls = [];
    gp.poll(1 / 60); // still centred → no further onMove (won't stomp keyboard)
    expect(names()).not.toContain("onMove");
  });

  it("sprints on the analog left trigger and releases", () => {
    current = mkpad([0, 0, 0, 0], [], { 6: 0.7 }); // LT pulled past threshold
    gp.poll(1 / 60);
    expect(names()).toContain("onSprintDown");
    calls = [];
    current = mkpad(); // released
    gp.poll(1 / 60);
    expect(names()).toContain("onSprintUp");
  });

  it("interacts (KeyE) on R3 press", () => {
    current = mkpad([0, 0, 0, 0], [11]); // R3 (right stick click)
    gp.poll(1 / 60);
    expect(calls).toContainEqual(["onKeyDown", "KeyE"]);
  });

  it("releases held fire when deactivated", () => {
    current = mkpad([0, 0, 0, 0], [], { 7: 0.9 });
    gp.poll(1 / 60);
    calls = [];
    gp.setActive(false);
    expect(names()).toContain("onFireUp");
  });
});
