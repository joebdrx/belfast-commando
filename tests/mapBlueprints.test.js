import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { MAP_BLUEPRINTS, validateBlueprint } from "../src/game/MapBlueprints.js";
import { Level } from "../src/game/Level.js";

beforeAll(() => {
  if (typeof globalThis.document === "undefined") {
    const fakeEl = () => ({
      addEventListener() {}, removeEventListener() {}, setAttribute() {},
      style: {}, getContext: () => null,
    });
    globalThis.document = { createElementNS: fakeEl, createElement: fakeEl };
  }
});

function insideSolidBlock(blueprint, x, z) {
  const marginX = blueprint.blockW / 2 + 0.8;
  const marginZ = blueprint.blockL / 2 + 0.8;
  return blueprint.blocks.some((block) =>
    ["model", "interior"].includes(block.kind)
    && Math.abs(x - block.x) < marginX
    && Math.abs(z - block.z) < marginZ);
}

describe("authored campaign map blueprints", () => {
  it("defines seven valid maps with seven different topologies", () => {
    expect(MAP_BLUEPRINTS).toHaveLength(7);
    expect(new Set(MAP_BLUEPRINTS.map((map) => map.topology)).size).toBe(7);
    for (const map of MAP_BLUEPRINTS) expect(validateBlueprint(map)).toEqual([]);
  });

  it("does not reuse one grid footprint across the campaign", () => {
    const signatures = MAP_BLUEPRINTS.map((map) =>
      `${map.columns}x${map.rows}:${map.blockW}x${map.blockL}:${map.blocks.map((b) => b.kind).join(",")}`);
    expect(new Set(signatures).size).toBe(7);
  });

  it("keeps deploy, extraction, encounter, and authored cover points navigable", () => {
    for (const map of MAP_BLUEPRINTS) {
      const points = [map.spawn, map.extraction, ...map.encounterZones, ...map.cover];
      for (const point of points) {
        expect(insideSolidBlock(map, point[0], point[1]), `${map.id} point ${point}`).toBe(false);
        expect(Math.abs(point[0])).toBeLessThan(map.halfX + 12);
        expect(Math.abs(point[1])).toBeLessThan(map.halfZ + 12);
      }
      for (const [x, z, placement] of map.civilians) {
        if (placement !== "street") continue;
        expect(insideSolidBlock(map, x, z), `${map.id} street civilian`).toBe(false);
        expect(insideSolidBlock(map, x - 1.8, z), `${map.id} left captor`).toBe(false);
        expect(insideSolidBlock(map, x + 1.8, z), `${map.id} right captor`).toBe(false);
      }
    }
  });

  it("builds every map with its authored transform, civilians, and combat population", () => {
    MAP_BLUEPRINTS.forEach((map, index) => {
      const level = new Level(new THREE.Scene(), index, null, 4242);
      expect(level.blueprint.id).toBe(map.id);
      expect(level.spawn.x).toBe(map.spawn[0]);
      expect(level.spawn.z).toBe(map.spawn[1]);
      expect(level.victimCount).toBe(map.civilians.length);
      expect(level.enemies.length).toBeGreaterThan(map.encounterZones.length);
      expect(level.colliders.length).toBeGreaterThan(4);
    });
  });

  it("reproduces enemy positions and archetypes from the same layout seed", () => {
    const first = new Level(new THREE.Scene(), 4, null, 0xdecafbad);
    const second = new Level(new THREE.Scene(), 4, null, 0xdecafbad);
    const roster = (level) => level.enemies.map((enemy) => ({
      archetype: enemy.archetype,
      position: enemy.position.toArray(),
    }));

    expect(roster(second)).toEqual(roster(first));
  });

  it("gives each sector an exclusive landmark/route vocabulary", () => {
    const kinds = (index) => new Set(MAP_BLUEPRINTS[index].blocks.map((block) => block.kind));
    expect(kinds(0).has("courtyard")).toBe(true);
    expect(kinds(1).has("checkpoint")).toBe(true);
    expect(kinds(2).has("arena")).toBe(true);
    expect(kinds(3).has("yard")).toBe(true);
    expect(kinds(4).has("alley")).toBe(true);
    expect(kinds(5).has("stronghold")).toBe(true);
    expect(kinds(6).has("tower") && kinds(6).has("ruins")).toBe(true);
  });
});
