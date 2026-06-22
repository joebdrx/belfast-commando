import { describe, it, expect, beforeAll } from "vitest";
import * as THREE from "three";
import { Level } from "../src/game/Level.js";
import { Victim } from "../src/game/Victim.js";

// Headless DOM shim: Level's procedural build kicks off async texture loads via
// THREE.TextureLoader (which touches `document` to create an <img>). The load
// callbacks never fire in node — we only need the synchronous build to complete,
// so a permissive element stub is enough.
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
 * Group D4 regression: the player must NEVER be able to damage a civilian. The
 * guarantee is structural — victims live in `level.victims`, never `level.enemies`,
 * and expose no `takeDamage`. Every player damage path (weapon raycast, kick, barrel
 * AoE) iterates `level.enemies`/`level.doors` only, so this isolation is the lock.
 */
describe("civilian damage immunity (structural)", () => {
  it("victims expose no player-damage entry point", () => {
    expect(typeof Victim.prototype.takeDamage).toBe("undefined");
    expect(typeof Victim.prototype.takeKick).toBe("undefined");
    // The only way to harm a civilian is the captor's taunt-strike.
    expect(typeof Victim.prototype.takeMenaceHit).toBe("function");
  });

  it("spawned victims are never present in level.enemies", () => {
    const scene = new THREE.Scene();
    const level = new Level(scene, 1, null, 4242); // headless procedural build
    expect(level.victims.length).toBeGreaterThan(0);
    for (const v of level.victims) {
      expect(level.enemies.includes(v)).toBe(false);
      expect(typeof v.takeDamage).toBe("undefined");
    }
    // Captors that menace a victim are real enemies (killable), distinct from victims.
    const captors = level.enemies.filter((e) => e._guardingVictim);
    expect(captors.length).toBeGreaterThan(0);
    for (const c of captors) expect(level.victims.includes(c)).toBe(false);
  });

  it("reports SAVED count + wellbeing so a fully-rescued sector reads as success", () => {
    const scene = new THREE.Scene();
    const level = new Level(scene, 1, null, 7777);
    const total = level.victimCount;
    expect(total).toBeGreaterThan(0);

    // All alive + at full life, none rescued yet → bar full, 0 saved.
    expect(level.victimsSaved).toBe(0);
    expect(level.civilianWellbeing).toBeCloseTo(1, 5);

    // Rescue them all → wellbeing stays full (NOT drained to 0) and saved == total.
    for (const v of level.victims) v.rescued = true;
    expect(level.victimsSaved).toBe(total);
    expect(level.civilianWellbeing).toBeCloseTo(1, 5);

    // A death drops wellbeing below full and is excluded from the saved count.
    level.victims[0].rescued = false;
    level.victims[0].dead = true;
    expect(level.victimsSaved).toBe(total - 1);
    expect(level.civilianWellbeing).toBeCloseTo((total - 1) / total, 5);
  });
});
