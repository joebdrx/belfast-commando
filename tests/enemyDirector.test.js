import { describe, it, expect } from "vitest";
import { archetypeWeights, pickArchetype, EnemyDirector, ARCHETYPES } from "../src/game/EnemyDirector.js";

describe("archetypeWeights", () => {
  it("sector 0 is grunt-only", () => {
    const w = archetypeWeights(0);
    expect(w.grunt).toBeGreaterThan(0);
    expect(w.gunner).toBe(0);
    expect(w.breacher).toBe(0);
    expect(w.enforcer).toBe(0);
  });
  it("late sectors add variety and cap each type", () => {
    const w = archetypeWeights(6);
    expect(w.gunner).toBeLessThanOrEqual(6);
    expect(w.breacher).toBeLessThanOrEqual(5);
    expect(w.enforcer).toBeLessThanOrEqual(2);
    expect(w.grunt).toBeGreaterThanOrEqual(1);
  });
});

describe("pickArchetype", () => {
  it("returns grunt when all weights are zero", () => {
    expect(pickArchetype({ grunt: 0, gunner: 0, breacher: 0, enforcer: 0 }, 0.5)).toBe("grunt");
  });
  it("selects the only weighted bucket", () => {
    expect(pickArchetype({ grunt: 0, gunner: 1, breacher: 0, enforcer: 0 }, 0.5)).toBe("gunner");
  });
  it("only ever returns known archetypes", () => {
    const w = archetypeWeights(4);
    for (let r = 0; r < 1; r += 0.05) expect(ARCHETYPES).toContain(pickArchetype(w, r));
  });
});

describe("EnemyDirector", () => {
  it("honors the enforcer cap", () => {
    const d = new EnemyDirector(6, () => 0.99, 2);
    d.weights = { grunt: 0, gunner: 0, breacher: 0, enforcer: 1 }; // force enforcer rolls
    const draws = Array.from({ length: 8 }, () => d.next());
    expect(draws.filter((x) => x === "enforcer").length).toBe(2);
    expect(draws.filter((x) => x === "grunt").length).toBe(6); // overflow falls back to grunt
  });
});
