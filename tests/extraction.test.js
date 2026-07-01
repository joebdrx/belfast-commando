import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { withinExtraction } from "../src/game/LevelManager.js";

describe("withinExtraction", () => {
  const ground = new THREE.Vector3(0, 0, 0);
  const roof = new THREE.Vector3(0, 5.2, 33);

  it("ground beacon (dy=Infinity) ignores height — original behaviour", () => {
    expect(withinExtraction(ground, 4, Infinity, 1, 0, 1)).toBe(true);
    expect(withinExtraction(ground, 4, Infinity, 1, 99, 1)).toBe(true); // any height
    expect(withinExtraction(ground, 4, Infinity, 10, 0, 0)).toBe(false); // outside XZ
  });

  // NB: the `y` passed by LevelManager is the player's FEET (`pos.y`), NOT the
  // camera/eye position (`player.position` is a getter for the camera, feet+1.7m).
  // Feeding eye-Y here would make the rooftop gate off by ~1.7m and never arm up
  // top — a real bug caught in playtest. These values are all feet heights.
  it("rooftop beacon arms only near the roof height (feet, not eye)", () => {
    expect(withinExtraction(roof, 4, 1.2, 0, 5.2, 33)).toBe(true);  // feet on the roof
    expect(withinExtraction(roof, 4, 1.2, 0, 0, 33)).toBe(false);   // feet on ground, same XZ
    expect(withinExtraction(roof, 4, 1.2, 0, 3.9, 33)).toBe(false); // feet on tier below roof
    expect(withinExtraction(roof, 4, 1.2, 10, 5.2, 33)).toBe(false); // off the pad
    expect(withinExtraction(roof, 4, 1.2, 0, 6.9, 33)).toBe(false); // eye-height Y would be the bug
  });
});
