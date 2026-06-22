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
