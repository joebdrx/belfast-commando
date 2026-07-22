import { describe, expect, it } from "vitest";
import { shouldShowPrologue } from "../src/game/Menu.js";

describe("first-run prologue", () => {
  it("shows when the player has not acknowledged it", () => {
    expect(shouldShowPrologue({ getItem: () => null })).toBe(true);
  });

  it("stays dismissed after acknowledgement", () => {
    expect(shouldShowPrologue({ getItem: () => "1" })).toBe(false);
  });

  it("fails open when browser storage is unavailable", () => {
    expect(shouldShowPrologue({ getItem: () => { throw new Error("denied"); } })).toBe(true);
  });
});
