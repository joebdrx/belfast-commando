/**
 * EnemyDirector
 * -------------
 * Decides which archetype each spawned enemy is, scaling the mix by sector
 * index. Pure logic (no THREE / no DOM) so it is unit-testable.
 *
 *  - Sector 0 is all grunts (teach the baseline).
 *  - Gunners + breachers fade in as the index climbs; enforcers are rare and
 *    hard-capped (the "unstoppable" beat).
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
}
