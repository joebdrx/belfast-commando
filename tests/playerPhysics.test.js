import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { verticalSupport } from "../src/game/Player.js";

const EYE = 1.7;
// A box top at y=1.2, centred at origin, footprint 2×2.
const box = (top, min = [-1, 0, -1], maxXZ = [1, 1]) =>
  new THREE.Box3(new THREE.Vector3(min[0], min[1], min[2]), new THREE.Vector3(maxXZ[0], top, maxXZ[1]));

describe("verticalSupport", () => {
  it("flat ground (no boxes) is unchanged: floor at y=0", () => {
    // Falling through the floor → clamped to 0, grounded.
    expect(verticalSupport([], 0, 0, 0.1, -0.05, -2, EYE)).toEqual({ y: 0, vy: 0, onGround: true });
    // Above the floor → still falling, airborne.
    const r = verticalSupport([], 0, 0, 1.0, 0.8, -2, EYE);
    expect(r.onGround).toBe(false);
    expect(r.y).toBeCloseTo(0.8);
  });

  it("at ground level a tall box never yanks the player up (street unchanged)", () => {
    const wall = box(3.6); // building-height box overlapping the feet column
    const r = verticalSupport([wall], 0, 0, 0.0, 0.0, 0, EYE);
    expect(r.y).toBe(0); // floor, NOT the 3.6 rooftop
    expect(r.onGround).toBe(true);
  });

  it("lands on a box top when descending onto it", () => {
    const ledge = box(1.2);
    const r = verticalSupport([ledge], 0, 0, 1.3, 1.1, -3, EYE);
    expect(r).toEqual({ y: 1.2, vy: 0, onGround: true });
  });

  it("stays put while standing on a box top (gravity nudge re-clamps)", () => {
    const ledge = box(1.2);
    const r = verticalSupport([ledge], 0, 0, 1.2, 1.19, -0.1, EYE);
    expect(r.y).toBe(1.2);
    expect(r.onGround).toBe(true);
  });

  it("falls off the edge: no horizontal overlap → no support", () => {
    const ledge = box(1.2); // spans x∈[-1,1]
    const r = verticalSupport([ledge], 2.0, 0, 1.2, 1.1, -3, EYE); // walked well past +x edge
    expect(r.onGround).toBe(false);
    expect(r.y).toBeCloseTo(1.1);
  });

  it("head-bumps a raised ceiling while rising and stops upward motion", () => {
    const ceiling = new THREE.Box3(new THREE.Vector3(-1, 2.0, -1), new THREE.Vector3(1, 2.6, 1));
    // Rising: head was below 2.0, crosses above it this frame.
    const r = verticalSupport([ceiling], 0, 0, 0.2, 0.4, 5, EYE);
    expect(r.vy).toBe(0);
    expect(r.y).toBeCloseTo(2.0 - EYE); // pushed down so head sits just under the slab
    expect(r.onGround).toBe(false);
  });
});
