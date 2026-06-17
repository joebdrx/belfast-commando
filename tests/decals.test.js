import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { ringNext, Decals } from "../src/game/Decals.js";

describe("ringNext", () => {
  it("wraps at the cap", () => {
    expect(ringNext(0, 100)).toBe(1);
    expect(ringNext(99, 100)).toBe(0);
  });
});

describe("Decals", () => {
  it("never exceeds the cap and reuses meshes", () => {
    const scene = new THREE.Scene();
    const decals = new Decals(scene, 5);
    for (let i = 0; i < 12; i++) decals.bloodPool(new THREE.Vector3(i, 0, 0));
    expect(decals.group.children.length).toBe(5); // capped, reused
  });

  it("clear() hides everything and resets the cursor", () => {
    const scene = new THREE.Scene();
    const decals = new Decals(scene, 5);
    decals.bloodPool(new THREE.Vector3(0, 0, 0));
    decals.clear();
    expect(decals.group.children.every((m) => m.visible === false)).toBe(true);
    expect(decals._cursor).toBe(0);
  });
});
