/**
 * SectorProfile
 * -------------
 * Per-sector layout profile. The game has ONE procedural generator (Level.js);
 * these profiles steer it into seven distinct "layout problems" instead of seven
 * visual reskins — the authored-skeleton + procedural-dressing model.
 *
 * Every knob is a delta/ratio applied ON TOP of the index-scaled defaults, so the
 * difficulty curve (keyed off the campaign `index`) is preserved while the *shape*
 * of each sector changes.
 *
 *   interiorBias      +1 promotes one more grid block to a breach-room interior
 *                     (denser door-to-door maze); -1 reverts the rotating interior
 *                     to a solid terrace (longer sightlines → street gauntlet).
 *                     The two anchored interiors are never touched, so an interior
 *                     victim always has a real room.
 *   garrisonMin/Var   room garrison = garrisonMin + (50% ? garrisonVar : 0).
 *   coverBonus        extra street cover props on top of `6 + index*2`.
 *   crateRatio        P(a cover prop is a loot crate); 1-crateRatio = explosive
 *                     barrel. Low ratio = barrel-dense (Docks chain-reaction yards).
 *   streetEnemyBonus  extra roaming invaders on top of `12 + index*3`
 *                     (Short Strand = surrounded).
 *   special           optional { kind, col, row } that swaps one grid block for a
 *                     bespoke archetype — "arena" (open market square) or "yard"
 *                     (container maze). The block at (col,row) is built by the
 *                     matching Level._build*Block; the two anchored interiors are
 *                     never used as the special slot, so the interior victim is safe.
 *   label             short identity string (used by tests + debug; not rendered).
 *
 * Layer 2 hooks (not yet consumed): per-sector prop/mural palette, archetype
 * emphasis, and TRUE verticality (Divis tower) — the player only grounds at y=0,
 * so stacked-container / walkway routes need a player-controller change first.
 */

const DEFAULT_PROFILE = {
  label: "standard",
  interiorBias: 0,
  garrisonMin: 2,
  garrisonVar: 1,
  coverBonus: 0,
  crateRatio: 0.5,
  streetEnemyBonus: 0,
};

/** Keyed by campaign index (matches levels.json). */
export const SECTOR_PROFILES = {
  // Falls Road — residential breach maze: max interiors, residential loot (fewer barrels).
  0: { label: "residential breach maze", interiorBias: 1, garrisonMin: 2, garrisonVar: 1, coverBonus: 0, crateRatio: 0.6, streetEnemyBonus: 0 },
  // Shankill — street gauntlet: fewer interiors (long sightlines), barricades, heavier street control.
  1: { label: "street gauntlet", interiorBias: -1, garrisonMin: 2, garrisonVar: 1, coverBonus: 2, crateRatio: 0.5, streetEnemyBonus: 4 },
  // The Markets — crowded hub: an open market-square arena block is the landmark.
  2: { label: "market hub", interiorBias: 0, garrisonMin: 2, garrisonVar: 1, coverBonus: 5, crateRatio: 0.45, streetEnemyBonus: 2, special: { kind: "arena", col: 1, row: 1 } },
  // The Docks — industrial yards: a container-maze block + barrel-dense chains.
  3: { label: "industrial yards", interiorBias: -1, garrisonMin: 2, garrisonVar: 1, coverBonus: 5, crateRatio: 0.25, streetEnemyBonus: 2, special: { kind: "yard", col: 1, row: 1 } },
  // Ardoyne — tight maze: max interiors, heavier room garrisons, ambush pressure.
  4: { label: "tight maze", interiorBias: 1, garrisonMin: 3, garrisonVar: 1, coverBonus: 0, crateRatio: 0.55, streetEnemyBonus: 4 },
  // Short Strand — siege pocket: surrounded, max roaming enemies, plenty of cover.
  5: { label: "siege pocket", interiorBias: 0, garrisonMin: 2, garrisonVar: 1, coverBonus: 3, crateRatio: 0.5, streetEnemyBonus: 6 },
  // Divis Tower — vertical finale: a central climbable tower to a rooftop extraction.
  6: { label: "vertical finale", interiorBias: 1, garrisonMin: 3, garrisonVar: 1, coverBonus: 4, crateRatio: 0.5, streetEnemyBonus: 4, special: { kind: "tower", col: 1, row: 1 } },
};

/** Profile for a campaign index; falls back to a neutral standard profile. Pure. */
export function sectorProfile(index) {
  return SECTOR_PROFILES[index] || DEFAULT_PROFILE;
}
