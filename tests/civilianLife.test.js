import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Victim } from "../src/game/Victim.js";

/**
 * Group D regression: civilians are harmed ONLY by discrete captor taunt-strikes
 * (`takeMenaceHit`), never a continuous drain and never by the player. Each hit
 * applies damage + a backward knockback shove, with a refractory window so two
 * captors can't double-strike on one beat. At zero life the civilian dies — lost
 * with no penalty — and the body topples and STAYS on the ground (`removed` stays
 * false) rather than being disposed.
 */
function makeCtx() {
  const events = [];
  return {
    events,
    player: { position: new THREE.Vector3(100, 0, 0), keys: {} }, // far away: no prompt/rescue
    level: { getColliders: () => [] },
    camera: { getWorldDirection: (v) => v.set(0, 0, -1), position: new THREE.Vector3() },
    state: { emit: (name, data) => events.push({ name, data }), bumpStat: () => {}, addCurrency: () => {} },
  };
}

describe("Victim taunt-strike damage + knockback", () => {
  it("a landed hit reduces life and shoves the civilian back", () => {
    const v = new Victim(new THREE.Vector3(0, 0, 0));
    const ctx = makeCtx();
    v.takeMenaceHit(12, new THREE.Vector3(1, 0, 0), ctx); // captor to the +x side
    expect(v.life).toBe(v.maxLife - 12); // 300 - 12 = 288
    expect(v._knock.lengthSq()).toBeGreaterThan(0); // knockback impulse applied
    expect(v._knock.x).toBeLessThan(0); // shoved away from the captor (toward -x)
  });

  it("ignores a second hit within the refractory window (no double-strike)", () => {
    const v = new Victim(new THREE.Vector3(0, 0, 0));
    const ctx = makeCtx();
    v.takeMenaceHit(12, new THREE.Vector3(1, 0, 0), ctx);
    v.takeMenaceHit(12, new THREE.Vector3(1, 0, 0), ctx); // same beat → ignored
    expect(v.life).toBe(v.maxLife - 12);
  });

  it("dies after enough hits; body topples and STAYS (not removed)", () => {
    const v = new Victim(new THREE.Vector3(0, 0, 0));
    const ctx = makeCtx();
    for (let i = 0; i < 40 && !v.dead; i++) {
      v._hitGap = 0; // simulate the cadence gap elapsing between strikes
      v.takeMenaceHit(12, new THREE.Vector3(1, 0, 0), ctx); // 300hp / 12 ≈ 25 hits
    }
    expect(v.dead).toBe(true);
    expect(v.life).toBeLessThanOrEqual(0);
    expect(v.removed).toBe(false); // corpse persists on the ground
    expect(v.rescued).toBe(false); // death is not a rescue
    expect(ctx.events.some((e) => e.name === "victimDied")).toBe(true);
    // The death topple advances and lays the body down over ~0.5s.
    for (let i = 0; i < 40; i++) v.update(1 / 60, ctx);
    expect(v._toppleAmt).toBeCloseTo(Math.PI / 2, 2);
    expect(v.removed).toBe(false);
  });

  it("does not lose life when never menaced", () => {
    const v = new Victim(new THREE.Vector3(0, 0, 0));
    const ctx = makeCtx();
    for (let i = 0; i < 120; i++) v.update(0.1, ctx); // no _menacedTimer, no hits
    expect(v.life).toBe(v.maxLife);
    expect(v.dead).toBe(false);
  });

  it("cannot be rescued once dead", () => {
    const v = new Victim(new THREE.Vector3(0, 0, 0));
    const ctx = makeCtx();
    for (let i = 0; i < 40 && !v.dead; i++) { v._hitGap = 0; v.takeMenaceHit(12, new THREE.Vector3(1, 0, 0), ctx); }
    expect(v.dead).toBe(true);
    v._rescue(ctx);
    expect(v.rescued).toBe(false);
  });

  it("rescue credits civiliansSaved and is idempotent", () => {
    const v = new Victim(new THREE.Vector3(0, 0, 0));
    const ctx = makeCtx();
    let saved = 0;
    ctx.state.bumpStat = (key) => { if (key === "civiliansSaved") saved += 1; };
    v._rescue(ctx);
    v._rescue(ctx); // second call is a no-op (already rescued)
    expect(v.rescued).toBe(true);
    expect(saved).toBe(1);
  });
});
