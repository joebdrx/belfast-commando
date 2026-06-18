/**
 * FurnitureLayout
 * ---------------
 * Pure helpers + the canonical interior-room metrics used to validate that the
 * data-driven apartment furniture layout (`src/data/furniture.json`) never blocks
 * the kickable door approach or the room centre (where a captor enemy / victim
 * spawns), and stays inside the room. Used by the unit test and by Level when it
 * furnishes each interior room.
 *
 * Frame: offsets are relative to the room centre. +X points toward the door wall
 * (Level mirrors X by `doorSide` at placement time); Z runs along the terrace.
 */

/**
 * Canonical interior room (a single breach-room: BLOCK_W wide, roomLen deep, minus
 * wall thickness). `door` is the inward door-approach clearance; `center` keeps the
 * captor/victim spawn slot clear.
 */
export const INTERIOR_ROOM = {
  halfW: 6.7,
  halfD: 3.7,
  door: { x: 6.0, z: 0, r: 1.8 },
  center: { x: 0, z: 0, r: 1.3 },
};

/** True if a piece's footprint AABB overlaps a clearance circle. */
function aabbHitsCircle(p, c) {
  if (!c) return false;
  const nx = Math.max(p.x - p.w / 2, Math.min(c.x, p.x + p.w / 2));
  const nz = Math.max(p.z - p.d / 2, Math.min(c.z, p.z + p.d / 2));
  const dx = c.x - nx, dz = c.z - nz;
  return dx * dx + dz * dz < c.r * c.r;
}

/**
 * Validate a furniture layout against a room: every piece stays inside the room
 * bounds and clears the door approach + the centre slot.
 * @param {Array<{x:number,z:number,w:number,d:number}>} layout
 * @param {typeof INTERIOR_ROOM} room
 * @returns {boolean}
 */
export function furnitureFits(layout, room) {
  const EPS = 1e-6;
  for (const p of layout) {
    if (Math.abs(p.x) + p.w / 2 > room.halfW + EPS) return false;
    if (Math.abs(p.z) + p.d / 2 > room.halfD + EPS) return false;
    if (aabbHitsCircle(p, room.door)) return false;
    if (aabbHitsCircle(p, room.center)) return false;
  }
  return true;
}
