import { describe, it, expect } from "vitest";
import gameState from "../src/game/GameState.js";

/**
 * Group B4 regression: breaking crates and saving civilians feed the end-of-sector
 * £ payout via run.stats counters. A fresh run must zero them, and bumpStat must
 * accumulate so main._toResults can read them when computing the reward.
 */
describe("run.stats reward counters (crates + civilians)", () => {
  it("zeroes cratesOpened and civiliansSaved on a fresh run", () => {
    gameState.startRun({ levelIndex: 0 });
    const stats = gameState.getState().run.stats;
    expect(stats.cratesOpened).toBe(0);
    expect(stats.civiliansSaved).toBe(0);
  });

  it("accumulates via bumpStat", () => {
    gameState.startRun({ levelIndex: 0 });
    gameState.bumpStat("cratesOpened");
    gameState.bumpStat("cratesOpened");
    gameState.bumpStat("civiliansSaved", 3);
    const stats = gameState.getState().run.stats;
    expect(stats.cratesOpened).toBe(2);
    expect(stats.civiliansSaved).toBe(3);
  });
});
