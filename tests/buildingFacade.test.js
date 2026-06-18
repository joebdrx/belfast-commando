import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { planWindows, planDoor, buildFacade } from "../src/game/BuildingFacade.js";

describe("planWindows", () => {
  it("grids a typical 11x9 face into columns and storeys", () => {
    const p = planWindows(11, 9, { storeyH: 3, colW: 2.2, margin: 0.6 });
    expect(p.cols).toBeGreaterThanOrEqual(3);
    expect(p.rows).toBe(3); // 9m / 3m storeys
    expect(p.positions.length).toBeGreaterThan(0);
    for (const w of p.positions) {
      expect(Math.abs(w.u)).toBeLessThanOrEqual(11 / 2);
      expect(w.v).toBeGreaterThan(0);
      expect(w.v).toBeLessThan(9);
      expect(w.w).toBeGreaterThan(0);
      expect(w.h).toBeGreaterThan(0);
    }
  });

  it("returns no windows for a tiny face", () => {
    expect(planWindows(1, 1).positions).toHaveLength(0);
  });

  it("is proportionate: doubling width adds columns, not wider windows", () => {
    const a = planWindows(6, 9);
    const b = planWindows(12, 9);
    expect(b.cols).toBeGreaterThan(a.cols);
    expect(b.positions[0].w).toBeCloseTo(a.positions[0].w, 5);
  });

  it("keeps the ground-storey centre clear for a door", () => {
    const p = planWindows(11, 9, { doorClear: true });
    // No window should sit centred (u≈0) on the ground storey row.
    const groundCentre = p.positions.filter((w) => Math.abs(w.u) < 0.6 && w.v < 3);
    expect(groundCentre).toHaveLength(0);
  });
});

describe("planDoor", () => {
  it("centres a door on a wide face", () => {
    expect(planDoor(11, 9)).toMatchObject({ u: 0 });
  });
  it("returns null on a too-narrow face", () => {
    expect(planDoor(1.2, 9)).toBeNull();
  });
});

describe("buildFacade", () => {
  it("returns a Group of detail meshes positioned at the face centre", () => {
    const g = buildFacade(THREE, {}, {
      width: 11, height: 9, orientationY: Math.PI / 2, center: { x: 5, y: 0, z: -3 },
    });
    expect(g.isGroup).toBe(true);
    expect(g.children.length).toBeGreaterThan(1); // windows + door + roof cap
    expect(g.position.x).toBe(5);
    expect(g.rotation.y).toBeCloseTo(Math.PI / 2, 5);
  });
});
