import { describe, it, expect } from "vitest";
import {
  archetypeWeights,
  pickArchetype,
  squadComposition,
  EnemyDirector,
  ARCHETYPES,
} from "../src/game/EnemyDirector.js";

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

  it("builds the same shuffled fireteam from the same injected RNG", () => {
    const rolls = [0.8, 0.1, 0.55, 0.25];
    const makeRng = () => {
      let i = 0;
      return () => rolls[i++ % rolls.length];
    };
    const a = new EnemyDirector(4, makeRng());
    const b = new EnemyDirector(4, makeRng());
    expect(a.nextSquad(5)).toEqual(b.nextSquad(5));
  });

  it("shares the enforcer cap across multiple fireteams", () => {
    const d = new EnemyDirector(4, () => 0.5, 1);
    const roles = [...d.nextSquad(4), ...d.nextSquad(4)];
    expect(roles.filter((role) => role === "enforcer")).toHaveLength(1);
  });
});

describe("squadComposition", () => {
  it("keeps the opening sector focused on the baseline grunt", () => {
    expect(squadComposition(0, 5)).toEqual(["grunt", "grunt", "grunt", "grunt", "grunt"]);
  });

  it("turns a four-enemy midgame group into a complete mixed fireteam", () => {
    expect(squadComposition(3, 4)).toEqual(["grunt", "gunner", "breacher", "enforcer"]);
  });

  it("leans late five-enemy groups toward two urgent breachers", () => {
    expect(squadComposition(6, 5)).toEqual(["grunt", "gunner", "breacher", "enforcer", "breacher"]);
  });
});
