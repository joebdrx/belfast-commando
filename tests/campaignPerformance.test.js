import { describe, expect, it } from "vitest";
import {
  evaluateSectorPerformance,
  formatMissionTime,
  mergeSectorRecord,
} from "../src/game/CampaignPerformance.js";

const entry = { par: 60, scoreTarget: 10000 };

describe("campaign performance", () => {
  it("awards three medals for a clear under par with every civilian saved", () => {
    const grade = evaluateSectorPerformance({
      died: false, score: 12000, time: 55, civiliansSaved: 3, civiliansTotal: 3, noDamage: true,
    }, entry);
    expect(grade.medals).toBe(3);
    expect(grade.rank).toBe("S");
  });

  it("does not award mission progress on death", () => {
    expect(evaluateSectorPerformance({ died: true, score: 99999 }, entry)).toEqual({
      rank: "D", rating: 0, medals: 0, underPar: false, allCivilians: false,
    });
    expect(mergeSectorRecord({ clears: 1 }, { died: true })).toEqual({ clears: 1 });
  });

  it("merges independent best score, time, rank, and medals", () => {
    const previous = { clears: 2, bestScore: 15000, bestTime: 48, bestRank: "A", medals: 2 };
    const merged = mergeSectorRecord(previous, {
      died: false, score: 12000, time: 42, rank: "S", medals: 3,
    });
    expect(merged).toEqual({ clears: 3, bestScore: 15000, bestTime: 42, bestRank: "S", medals: 3 });
  });

  it("formats operation times for compact UI", () => {
    expect(formatMissionTime(65.4)).toBe("1:05");
  });
});
