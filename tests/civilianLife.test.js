import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Victim } from "../src/game/Victim.js";

/**
 * Group C1 regression: civilians now have "life" that drains while a captor is
 * actively menacing them (a short grace, then MENACE_DPS/sec). At zero they die
 * — lost with no penalty — splicing out of the sector and emitting "victimDied".
 * A menace timer (refreshed each frame by EnemyBehavior.menaceVictim) is decayed
 * here, so we re-assert it per tick to simulate a captor standing over them.
 */
function makeCtx() {
  const events = [];
  return {
    events,
    player: { position: new THREE.Vector3(100, 0, 0), keys: {} }, // far away: no prompt/rescue
    level: { getColliders: () => [] },
    state: { emit: (name, data) => events.push({ name, data }), bumpStat: () => {}, addCurrency: () => {} },
  };
}

function tick(v, ctx, dt, n) {
  for (let i = 0; i < n; i++) {
    v._menacedTimer = 0.3; // a captor is on them this frame
    v.update(dt, ctx);
    if (v.dead) break;
  }
}

describe("Victim life / death while menaced", () => {
  it("survives the grace period without losing life", () => {
    const v = new Victim(new THREE.Vector3(0, 0, 0));
    const ctx = makeCtx();
    tick(v, ctx, 0.1, 15); // 1.5s < 2.0s grace
    expect(v.life).toBe(100);
    expect(v.dead).toBe(false);
  });

  it("drains and dies after sustained menace, emitting victimDied (no penalty)", () => {
    const v = new Victim(new THREE.Vector3(0, 0, 0));
    const ctx = makeCtx();
    tick(v, ctx, 0.1, 300); // well past grace + full drain
    expect(v.dead).toBe(true);
    expect(v.removed).toBe(true);
    expect(v.life).toBeLessThanOrEqual(0);
    expect(ctx.events.some((e) => e.name === "victimDied")).toBe(true);
    expect(v.rescued).toBe(false); // death is not a rescue
  });

  it("does not drain when not menaced", () => {
    const v = new Victim(new THREE.Vector3(0, 0, 0));
    const ctx = makeCtx();
    for (let i = 0; i < 100; i++) v.update(0.1, ctx); // never sets _menacedTimer
    expect(v.life).toBe(100);
    expect(v.dead).toBe(false);
  });

  it("cannot be rescued once dead", () => {
    const v = new Victim(new THREE.Vector3(0, 0, 0));
    const ctx = makeCtx();
    tick(v, ctx, 0.1, 300);
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
