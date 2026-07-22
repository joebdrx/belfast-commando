import { describe, expect, it } from "vitest";
import { catalogVisual } from "../src/game/CatalogVisuals.js";

describe("catalogVisual", () => {
  it("gives every current shop item a named vector thumbnail", () => {
    const ids = [
      "pistol", "boomstick", "smg",
      "kick_master", "thick_skin", "adrenaline_leak", "scavenger_refund",
      "standard", "explosive_kick", "long_slide", "fast_sprint",
    ];
    for (const id of ids) {
      const visual = catalogVisual(id);
      expect(visual.label).toBeTruthy();
      expect(visual.code).toBeTruthy();
      expect(visual.paths.length).toBeGreaterThan(0);
    }
  });

  it("uses a safe stock fallback for future catalogue entries", () => {
    expect(catalogVisual("not-yet-listed").code).toBe("STOCK");
  });
});
