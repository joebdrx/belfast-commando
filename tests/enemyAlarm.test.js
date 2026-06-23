import { describe, it, expect, beforeAll } from "vitest";
import * as THREE from "three";
import { Level, ALARM_TIME, ALARM_KILL_FRAC } from "../src/game/Level.js";
import { Enemy } from "../src/game/Enemy.js";

// Headless DOM shim (Level's procedural build touches THREE.TextureLoader → document).
beforeAll(() => {
  if (typeof globalThis.document === "undefined") {
    const fakeEl = () => ({
      addEventListener() {}, removeEventListener() {}, setAttribute() {},
      style: {}, getContext: () => null,
    });
    globalThis.document = { createElementNS: fakeEl, createElement: fakeEl };
  }
});

/**
 * Escalation regression: a sector mustn't go stale while the player hunts the last
 * few stragglers. `Level.tickAlarm` raises the alarm once EITHER enough time has
 * passed OR enough of the garrison is down, and flips every living invader into a
 * `_hunting` state. A hunting enemy converges on the player with no line of sight,
 * so room-garrison invaders leave their rooms and bring the fight to the player.
 */
describe("Level.tickAlarm (escalation)", () => {
  it("raises the alarm after the time threshold even with zero kills", () => {
    const level = new Level(new THREE.Scene(), 1, null, 4242);
    expect(level.alarmRaised).toBe(false);
    expect(level.enemies.length).toBeGreaterThan(0);

    let raised = false;
    let ticks = 0;
    // 1s steps; must trip strictly from elapsed time (no enemy is ever killed here).
    while (!raised && ticks < ALARM_TIME + 5) { raised = level.tickAlarm(1); ticks += 1; }

    expect(raised).toBe(true);
    expect(level.alarmRaised).toBe(true);
    expect(ticks).toBeGreaterThanOrEqual(ALARM_TIME);
    expect(level.enemies.every((e) => e._hunting)).toBe(true);
  });

  it("raises the alarm once the kill-fraction threshold is crossed (before the timer)", () => {
    const level = new Level(new THREE.Scene(), 1, null, 4242);
    level.tickAlarm(0); // capture the initial garrison count without advancing far
    const initial = level._initialEnemies;
    expect(initial).toBeGreaterThan(1);

    // Drop just over the kill fraction worth of enemies.
    const toKill = Math.ceil(initial * ALARM_KILL_FRAC);
    for (let i = 0; i < toKill; i++) level.enemies[i].dead = true;

    const raised = level.tickAlarm(0.016); // tiny dt — well under the time threshold
    expect(level._combatTime).toBeLessThan(ALARM_TIME);
    expect(raised).toBe(true);
    expect(level.alarmRaised).toBe(true);
    // Only the still-living enemies are mobilised; corpses are left alone.
    for (const e of level.enemies) {
      if (e.dead) expect(e._hunting).toBe(false);
      else expect(e._hunting).toBe(true);
    }
  });

  it("flips the alarm true exactly once (returns true only on the raising frame)", () => {
    const level = new Level(new THREE.Scene(), 1, null, 4242);
    let trues = 0;
    for (let i = 0; i < ALARM_TIME + 20; i++) if (level.tickAlarm(1)) trues += 1;
    expect(trues).toBe(1);
  });
});

describe("Enemy hunting (post-alarm)", () => {
  function ctxNoSight(player) {
    return {
      player: { position: player },
      level: { getColliders: () => [], lineOfSight: () => false },
    };
  }

  it("a hunting enemy converges on the player with no LOS and beyond sight range", () => {
    const e = new Enemy(new THREE.Vector3(0, 0, 0), {});
    // Player well past the grunt's sightRange AND with LOS forced false: a normal
    // idle enemy would NOT move; only the hunt flag should drive it forward.
    const player = new THREE.Vector3(0, 0, e.sightRange + 30);
    const ctx = ctxNoSight(player);

    const startDist = e.group.position.distanceTo(player);
    for (let i = 0; i < 60; i++) e.update(1 / 60, ctx);
    const endDist = e.group.position.distanceTo(player);

    expect(e._hunting).toBe(false); // baseline: idle, no flag
    // re-run with the flag set to prove it's the mover.
    const e2 = new Enemy(new THREE.Vector3(0, 0, 0), {});
    e2._hunting = true;
    const ctx2 = ctxNoSight(new THREE.Vector3(0, 0, e2.sightRange + 30));
    const d0 = e2.group.position.z;
    for (let i = 0; i < 60; i++) e2.update(1 / 60, ctx2);
    expect(e2.group.position.z).toBeGreaterThan(d0 + 1); // advanced toward the player
    // And the no-flag enemy stayed put (idle).
    expect(endDist).toBeCloseTo(startDist, 3);
  });
});
