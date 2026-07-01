import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Enemy } from "../src/game/Enemy.js";

// Enemies now rest on box tops (vertical support), so a ledge garrison holds its
// floor instead of snapping to y=0 — the basis for Divis tower ambushers.
describe("enemy vertical support", () => {
  // Player parked far away with no LOS → the enemy idles in place (won't walk off).
  const idleCtx = (colliders) => ({
    player: { position: new THREE.Vector3(0, 0, 100) },
    level: { getColliders: () => colliders, lineOfSight: () => false },
  });

  it("holds a box-top ledge instead of falling to the ground", () => {
    const e = new Enemy(new THREE.Vector3(0, 1.3, 0), {}); // placed on a 1.3m ledge
    const ledge = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1.3, 1));
    const ctx = idleCtx([ledge]);
    for (let i = 0; i < 30; i++) e.update(1 / 60, ctx);
    expect(e.group.position.y).toBeCloseTo(1.3, 2); // held the ledge — did NOT fall
  });

  it("falls to the floor when stood over no box", () => {
    const e = new Enemy(new THREE.Vector3(0, 1.3, 0), {});
    const ctx = idleCtx([]);
    for (let i = 0; i < 30; i++) e.update(1 / 60, ctx);
    expect(e.group.position.y).toBeCloseTo(0, 3); // no support → gravity to the floor
  });
});
