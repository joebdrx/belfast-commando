/**
 * EnemyDirector
 * -------------
 * Decides which archetype each spawned enemy is, scaling the mix by sector
 * index. Pure logic (no THREE / no DOM) so it is unit-testable.
 *
 *  - Sector 0 is all grunts (teach the baseline).
 *  - Spatially-authored groups use a readable fireteam: baseline grunt, fast
 *    gunner, volatile breacher, then the slow enforcer anchor. That order gives
 *    each encounter a threat-scan → burst → reload/reposition cadence.
 *  - Enforcers remain rare and hard-capped (the "unstoppable" beat).
 */
export const ARCHETYPES = ["grunt", "gunner", "breacher", "enforcer"];

/** Relative spawn weights per archetype for a sector index. */
export function archetypeWeights(index) {
  const i = Math.max(0, index);
  return {
    grunt: Math.max(1, 10 - i * 1.5),
    gunner: Math.min(6, i * 1.2),
    breacher: Math.min(5, i * 0.9),
    enforcer: i >= 2 ? Math.min(2, (i - 1) * 0.5) : 0,
  };
}

/** Pick an archetype from weights given a 0..1 roll (cumulative buckets). */
export function pickArchetype(weights, roll) {
  const entries = ARCHETYPES.map((id) => [id, Math.max(0, weights[id] || 0)]);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  if (total <= 0) return "grunt";
  const target = roll * total;
  let acc = 0;
  for (const [id, w] of entries) {
    acc += w;
    if (target < acc) return id;
  }
  return entries[entries.length - 1][0];
}

/**
 * Authored role mix for one nearby enemy group. Small encounters introduce one
 * contrast at a time; groups of four or five contain a complete combat phrase.
 * The returned order is semantic only — EnemyDirector.nextSquad shuffles it
 * with the injected seeded RNG before positions are assigned.
 */
export function squadComposition(index, size) {
  const count = Math.max(0, Math.floor(size));
  const sector = Math.max(0, Math.floor(index));
  if (!count) return [];
  if (sector === 0) return Array(count).fill("grunt");

  const roles = ["grunt"];
  if (count >= 2) roles.push("gunner");
  if (count >= 3) roles.push(sector >= 2 ? "breacher" : "grunt");
  if (count >= 4) roles.push(sector >= 2 ? "enforcer" : "gunner");
  if (count >= 5) {
    if (sector >= 5) roles.push("breacher");
    else if (sector >= 4) roles.push("gunner");
    else roles.push("grunt");
  }
  while (roles.length < count) roles.push("grunt");
  return roles;
}

export class EnemyDirector {
  /** @param {number} index @param {()=>number} rng 0..1 @param {number} enforcerCap */
  constructor(index, rng = Math.random, enforcerCap = 3) {
    this.index = index;
    this.rng = rng;
    this.weights = archetypeWeights(index);
    this.enforcerCap = enforcerCap;
    this._enforcers = 0;
  }

  /** Draw the next archetype id, honoring the enforcer cap. */
  next() {
    let id = pickArchetype(this.weights, this.rng());
    if (id === "enforcer") {
      if (this._enforcers >= this.enforcerCap) id = "grunt";
      else this._enforcers++;
    }
    return id;
  }

  /**
   * Return a seeded, shuffled fireteam for one authored encounter zone while
   * sharing the same global enforcer cap as singleton draws.
   */
  nextSquad(size) {
    const roles = squadComposition(this.index, size);
    for (let i = roles.length - 1; i > 0; i--) {
      const j = Math.min(i, Math.floor(this.rng() * (i + 1)));
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }
    return roles.map((role) => {
      if (role !== "enforcer") return role;
      if (this._enforcers >= this.enforcerCap) return "grunt";
      this._enforcers++;
      return role;
    });
  }
}
