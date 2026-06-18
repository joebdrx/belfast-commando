import * as THREE from "three";

/**
 * Axis-aligned footprint collider for a block: a clean box matching the block's
 * ground rectangle, full wall height. Streets stay walkable because this never
 * uses the building mesh (which would interlock and seal lanes).
 */
export function footprintCollider(cx, cz, w, h, l) {
  return new THREE.Box3(
    new THREE.Vector3(cx - w / 2, 0, cz - l / 2),
    new THREE.Vector3(cx + w / 2, h, cz + l / 2),
  );
}

/**
 * Tile a single building model into a terraced row down a block's long (Z) run.
 * Returns the copy count, the Z step, and centred Z offsets from the block centre.
 */
export function tileSpec(blockLen, modelDepth, gap = 0.3) {
  const step = Math.max(0.1, modelDepth + gap);
  const count = Math.max(1, Math.floor(blockLen / step));
  const span = (count - 1) * step;
  const offsets = [];
  for (let i = 0; i < count; i++) offsets.push(-span / 2 + i * step);
  return { count, step, offsets };
}

/**
 * The 2 blocks (col,row) that keep full procedural interiors (kickable doors).
 * Chosen so an interior building sits on each row near the player's path.
 */
export const INTERIOR_BLOCKS = [
  { col: 0, row: 1 }, // south-west block (near spawn)
  { col: 2, row: 0 }, // north-east block
];

/**
 * Plan for one grid block. `kind:"interior"` keeps the procedural room; else a
 * building-model template tiled into a terrace. `index` is the sector index so
 * the mix can vary per sector (kept simple here; landmarks at the corners).
 */
export function blockPlan(col, row, index) {
  if (INTERIOR_BLOCKS.some((b) => b.col === col && b.row === row)) {
    return { kind: "interior" };
  }
  // Corners get landmarks (shop / collapsed); the rest are terraces. Pub appears
  // from sector 2 onward as a feature block.
  if (col === 0 && row === 0) return { kind: "model", template: "bldg_shop" };
  if (col === 2 && row === 1) return { kind: "model", template: "bldg_collapsed" };
  if (col === 1 && row === 0 && index >= 2) return { kind: "model", template: "bldg_pub" };
  return { kind: "model", template: "bldg_terrace" };
}
