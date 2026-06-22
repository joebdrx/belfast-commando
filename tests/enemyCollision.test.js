import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Enemy } from "../src/game/Enemy.js";

/**
 * Group A1 regression: enemies must collide with static level geometry the same
 * way the player does (per-axis push-out keyed on `this.radius`), so they can no
 * longer translate straight through walls. Exercises `_collideXZ`/`_resolveAxis`
 * against a fake `ctx.level.getColliders()`.
 */
function ctxWith(...boxes) {
  return { level: { getColliders: () => boxes } };
}

describe("Enemy._collideXZ (wall collision)", () => {
  it("pushes the enemy back out to the collider face after moving into it", () => {
    const e = new Enemy(new THREE.Vector3(0, 0, 0), {});
    const box = new THREE.Box3(new THREE.Vector3(2, 0, -2), new THREE.Vector3(6, 3, 2));
    const r = e.radius;
    // Behaviour translated it from outside the -x face (x=1) into the wall (x=3).
    e.group.position.set(3, 0, 0);
    e._collideXZ(ctxWith(box), 1, 0);
    // Resolved flush to the expanded -x face (box.min.x - radius), never inside.
    expect(e.group.position.x).toBeCloseTo(box.min.x - r, 2);
    const p = e.group.position;
    const inside = p.x > box.min.x && p.x < box.max.x && p.z > box.min.z && p.z < box.max.z;
    expect(inside).toBe(false);
  });

  it("does not tunnel through a thick wall on a fast (substepped) step", () => {
    const e = new Enemy(new THREE.Vector3(0, 0, 0), {});
    const box = new THREE.Box3(new THREE.Vector3(2, 0, -2), new THREE.Vector3(6, 3, 2));
    const r = e.radius;
    // A 1.5 m displacement in one frame (well above radius*0.8) must substep and
    // still land outside the wall rather than skipping across it.
    e.group.position.set(2.5, 0, 0);
    e._collideXZ(ctxWith(box), 1.0, 0);
    expect(e.group.position.x).toBeLessThanOrEqual(box.min.x - r + 1e-6);
  });

  it("ignores colliders that don't overlap the enemy's vertical span", () => {
    const e = new Enemy(new THREE.Vector3(0, 0, 0), {});
    // A flat ground slab below the enemy's feet must not block horizontal motion.
    const slab = new THREE.Box3(new THREE.Vector3(-10, -1, -10), new THREE.Vector3(10, -0.1, 10));
    e.group.position.set(0, 0, 0);
    e._collideXZ(ctxWith(slab), -1, 0);
    expect(e.group.position.x).toBe(0); // untouched — slab is below footY
  });
});

/** Full-update regression: knockback must be collision-resolved (snapshot taken
 *  BEFORE the knock is applied), so a hard kick can't fling an enemy through a wall
 *  and leave it embedded as an un-killable, sector-blocking ghost. */
describe("Enemy.update knockback + corpse settling", () => {
  function liveCtx(box) {
    return {
      player: { position: new THREE.Vector3(100, 0, 0) }, // far → no chase, just idles
      level: { getColliders: () => (box ? [box] : []), lineOfSight: () => false },
    };
  }

  it("a hard knockback into a wall does not embed the enemy", () => {
    const e = new Enemy(new THREE.Vector3(0, 0, 0), {});
    const box = new THREE.Box3(new THREE.Vector3(2, 0, -3), new THREE.Vector3(6, 3, 3));
    e.group.position.set(box.min.x - 0.5, 0, 0); // just outside the -x face
    e.knock.set(40, 0, 0); // violent shove straight into the wall
    const ctx = liveCtx(box);
    for (let i = 0; i < 40; i++) e.update(1 / 60, ctx);
    const p = e.group.position;
    const inside = p.x > box.min.x && p.x < box.max.x && p.z > box.min.z && p.z < box.max.z;
    expect(inside).toBe(false);
    expect(p.x).toBeLessThanOrEqual(box.min.x - e.radius + 0.06);
  });

  it("a corpse topples flat and rests ON the floor (lifted, not half-buried)", () => {
    const e = new Enemy(new THREE.Vector3(0, 0, 0), {});
    const ctx = liveCtx(null);
    e.takeDamage(99999, { x: 1, y: 0, z: 0 }, 0); // kill (sets topple axis)
    for (let i = 0; i < 60; i++) e.update(1 / 60, ctx);
    expect(e.dead).toBe(true);
    expect(e._toppleAmt).toBeCloseTo(Math.PI / 2, 2);
    // Rest height = radius (the mesh pivots about the feet; lifting by ~half-thickness
    // keeps the flat body on top of the ground rather than sunk through it).
    expect(e.group.position.y).toBeCloseTo(e.radius, 2);
  });

  it("a corpse killed mid-air falls down to its rest height", () => {
    const e = new Enemy(new THREE.Vector3(0, 0, 0), {});
    const ctx = liveCtx(null);
    e.takeDamage(99999, { x: 1, y: 0, z: 0 }, 0);
    e.group.position.y = 4; // flung up at the moment of death
    for (let i = 0; i < 90; i++) e.update(1 / 60, ctx);
    expect(e.group.position.y).toBeCloseTo(e.radius, 2); // settled flat on the floor
  });
});
