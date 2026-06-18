import { describe, it, expect } from "vitest";
import { nextOwnedIndex } from "../src/game/Weapon.js";

describe("nextOwnedIndex", () => {
  const owned = [0, 1, 2];
  it("wraps forward", () => {
    expect(nextOwnedIndex(0, owned, 1)).toBe(1);
    expect(nextOwnedIndex(2, owned, 1)).toBe(0);
  });
  it("wraps backward", () => {
    expect(nextOwnedIndex(0, owned, -1)).toBe(2);
    expect(nextOwnedIndex(1, owned, -1)).toBe(0);
  });
  it("skips unowned (current not in owned → nearest owned forward)", () => {
    expect(nextOwnedIndex(2, [0, 1], 1)).toBe(0);
  });
  it("single owned weapon stays put", () => {
    expect(nextOwnedIndex(0, [0], 1)).toBe(0);
    expect(nextOwnedIndex(0, [0], -1)).toBe(0);
  });
  it("empty owned set returns current", () => {
    expect(nextOwnedIndex(1, [], 1)).toBe(1);
  });
});
