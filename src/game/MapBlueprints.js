/**
 * Authored campaign map skeletons.
 *
 * Each blueprint owns its dimensions, occupied cells, landmark vocabulary,
 * deploy transform, extraction, encounter zones, cover rhythm, and civilians.
 * Procedural dressing is still seeded per run, but the navigational decisions
 * and combat pacing remain authored and learnable.
 */

const MAPS = [
  {
    id: "falls_road",
    topology: "serpentine",
    blockW: 13, blockL: 42, street: 8,
    columns: 4, rows: 3,
    cells: [
      ["model", "interior", null, "model"],
      ["interior", null, "courtyard", "interior"],
      ["model", "interior", "model", null],
    ],
    spawn: [0, 78], spawnYaw: 0,
    extraction: [31.5, -78, 5],
    encounterZones: [[0, 62, 3], [-21, 25, 3], [0, 0, 4], [21, -25, 3], [0, -62, 3]],
    cover: [[0, 32, "crate"], [-21, -25, "crate"], [10, 10, "barrel"], [21, -25, "crate"]],
    civilians: [[-31, 20, "interior"], [0, -25, "street"]],
    lamps: [[-31, 45], [-10, 20], [10, 0], [31, -30]],
  },
  {
    id: "shankill",
    topology: "gauntlet",
    blockW: 15, blockL: 34, street: 13,
    columns: 2, rows: 4,
    cells: [
      ["interior", "model"],
      ["checkpoint", "model"],
      ["model", "checkpoint"],
      ["model", "interior"],
    ],
    spawn: [0, 76], spawnYaw: 0,
    extraction: [0, -76, 5],
    encounterZones: [[0, 54, 3], [0, 24, 4], [0, -5, 4], [0, -35, 5], [0, -63, 4]],
    cover: [[-3, 42, "car"], [4, 11, "crate"], [-4, -18, "barrel"], [3, -51, "car"]],
    civilians: [[-14, -60, "interior"], [0, -25, "street"]],
    lamps: [[-6, 58], [6, 31], [-6, 3], [6, -27], [-6, -56]],
  },
  {
    id: "the_markets",
    topology: "hub_and_spokes",
    blockW: 12, blockL: 30, street: 10,
    columns: 3, rows: 3,
    cells: [
      ["model", "interior", "model"],
      ["interior", "arena", "interior"],
      ["model", "courtyard", "model"],
    ],
    spawn: [0, 56], spawnYaw: 0,
    extraction: [-33, -43, 5],
    encounterZones: [[0, 30, 3], [-11, 20, 3], [0, 0, 6], [11, -20, 3], [-11, -32, 4]],
    cover: [[-8, 0, "crate"], [8, 0, "barrel"], [-11, 20, "crate"], [11, -20, "crate"]],
    civilians: [[22, 0, "interior"], [-8, 8, "street"], [-11, -20, "street"]],
    lamps: [[0, 39], [-22, 17], [22, 17], [-22, -17], [22, -17]],
  },
  {
    id: "the_docks",
    topology: "parallel_flanks",
    blockW: 16, blockL: 46, street: 12,
    columns: 4, rows: 2,
    cells: [
      ["yard", null, "yard", "model"],
      ["model", "yard", null, "yard"],
    ],
    spawn: [-42, 59], spawnYaw: -0.35,
    extraction: [42, -59, 5],
    encounterZones: [[-25, 32, 4], [0, 30, 4], [26, 18, 3], [-25, -20, 4], [4, -32, 5], [28, -40, 3]],
    cover: [[-13, 14, "barrel"], [-9, 14, "barrel"], [14, -12, "barrel"], [18, -12, "barrel"], [0, 0, "crate"]],
    civilians: [[42, 24, "street"], [-14, -24, "street"], [15, 23, "street"]],
    lamps: [[-42, 30], [-14, 26], [14, 18], [42, 5], [-14, -28], [14, -36]],
  },
  {
    id: "ardoyne",
    topology: "nested_loops",
    blockW: 11, blockL: 28, street: 7,
    columns: 4, rows: 4,
    cells: [
      ["interior", "model", null, "interior"],
      ["interior", "alley", "interior", "model"],
      [null, "interior", "alley", "interior"],
      ["interior", "model", "interior", null],
    ],
    spawn: [-18, 73], spawnYaw: 0,
    extraction: [18, -73, 5],
    encounterZones: [[-18, 44, 3], [-18, 35, 4], [0, 17, 3], [18, 0, 4], [-18, -35, 4], [18, -55, 5]],
    cover: [[0, 35, "crate"], [-18, 0, "barrel"], [9, 17, "crate"], [-9, -32, "barrel"], [18, -35, "crate"]],
    civilians: [[-27, -18, "interior"], [9, 45, "interior"], [18, 0, "street"]],
    lamps: [[-27, 45], [-9, 27], [9, 9], [27, -9], [9, -28], [27, -45]],
  },
  {
    id: "short_strand",
    topology: "siege_ring",
    blockW: 13, blockL: 32, street: 11,
    columns: 3, rows: 3,
    cells: [
      ["model", "checkpoint", "model"],
      ["courtyard", "stronghold", "courtyard"],
      ["interior", "checkpoint", "interior"],
    ],
    spawn: [0, 66], spawnYaw: 0,
    extraction: [0, 0, 5],
    encounterZones: [[0, 43, 4], [-25, 19, 4], [25, 19, 4], [-25, -18, 4], [25, -18, 4], [0, 0, 6]],
    cover: [[-10, 30, "crate"], [10, 30, "barrel"], [-28, 0, "car"], [28, 0, "car"], [0, -28, "crate"]],
    civilians: [[-24, 43, "interior"], [24, 43, "interior"], [0, 10, "street"]],
    lamps: [[0, 43], [-25, 20], [25, 20], [-25, -20], [25, -20], [0, 0]],
  },
  {
    id: "divis_tower",
    topology: "vertical_ascent",
    blockW: 14, blockL: 32, street: 12,
    columns: 3, rows: 3,
    cells: [
      ["ruins", "model", "ruins"],
      ["checkpoint", "tower", "checkpoint"],
      ["interior", "courtyard", "interior"],
    ],
    spawn: [0, 67], spawnYaw: 0,
    extraction: [0, 0, 4, 5.2, 1.2],
    encounterZones: [[0, 43, 4], [-24, 21, 4], [24, 21, 4], [-25, -18, 4], [25, -18, 4], [0, -22, 4]],
    cover: [[-10, 32, "crate"], [10, 32, "barrel"], [-27, 0, "car"], [27, 0, "car"]],
    civilians: [[-26, 44, "interior"], [26, 44, "interior"], [0, 28, "street"]],
    lamps: [[0, 43], [-24, 22], [24, 22], [-24, -20], [24, -20]],
  },
];

function axisCoordinates(count, pitch) {
  const start = -((count - 1) * pitch) / 2;
  return Array.from({ length: count }, (_, i) => start + i * pitch);
}

function compile(source) {
  const pitchX = source.blockW + source.street;
  const pitchZ = source.blockL + source.street;
  const coordsX = axisCoordinates(source.columns, pitchX);
  const coordsZ = axisCoordinates(source.rows, pitchZ);
  const blocks = [];
  source.cells.forEach((row, r) => row.forEach((kind, c) => {
    if (kind) blocks.push({ col: c, row: r, x: coordsX[c], z: coordsZ[r], kind });
  }));
  return Object.freeze({
    ...source,
    pitchX,
    pitchZ,
    coordsX,
    coordsZ,
    blocks,
    halfX: ((source.columns - 1) * pitchX + source.blockW) / 2,
    halfZ: ((source.rows - 1) * pitchZ + source.blockL) / 2,
  });
}

export const MAP_BLUEPRINTS = Object.freeze(MAPS.map(compile));

export function mapBlueprint(index) {
  return MAP_BLUEPRINTS[index] || MAP_BLUEPRINTS[0];
}

export function validateBlueprint(blueprint) {
  const errors = [];
  if (!blueprint || !blueprint.id) errors.push("missing id");
  if (!blueprint || blueprint.blocks.length < 5) errors.push("needs at least five occupied blocks");
  if (!blueprint || !blueprint.encounterZones.length) errors.push("needs authored encounter zones");
  if (!blueprint || !blueprint.civilians.length) errors.push("needs civilian placements");
  if (!blueprint || !blueprint.extraction) errors.push("needs extraction");
  return errors;
}
