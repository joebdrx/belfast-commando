import gameState from "./GameState.js";

/**
 * ComboSystem
 * -----------
 * End-of-level BONUS + per-level stat tracking layered over the GameState bus.
 * Score.js stays authoritative for the on-screen total and live multiplier — this
 * module NEVER touches Score.total. It only listens to the event bus, folds a few
 * derived stats into `state.run.stats` (via recordStat/bumpStat), and computes the
 * RESULTS-screen bonus breakdown the orchestrator applies once per level clear.
 *
 * Subscriptions (CONTRACTS.md §3 catalog, §7 scoring contract):
 *   - "breach"  → bumpStat("doorsBreached")        (door kicks)
 *   - "damage"  → recordStat("noDamage", false)    (any hit ends a flawless run)
 *   - "combo"   → mirror bestCombo for the STYLE bonus only
 *
 * Kills / boot-kills / barrel-kills are already counted by GameState.addKill, so
 * we do NOT re-subscribe to "kill" for stats — that would double-count.
 *
 * Pure-ish: imports no three.js, renders nothing. Injectable `state` keeps it
 * trivially Node-testable.
 */

/** Default time-bonus baseline (seconds) when a level provides no `par`. */
const DEFAULT_PAR = 45;

class ComboSystem {
  /** @param {object} state the GameState singleton (injectable for tests). */
  constructor(state = gameState) {
    this.state = state;
    /** @type {object|null} shared game context (camera/scene/etc); optional here. */
    this.ctx = null;
    /** Best combo seen this level — mirror for the STYLE bonus only. */
    this._bestCombo = 0;
    /** Stored unsubscribe fns so dispose() can detach cleanly. */
    this._unsubs = [];
    this._attached = false;
    // Wire up immediately: this module has no setup dependency (unlike
    // FloatingText, which needs a camera), so it is safe to listen from birth.
    this.attach();
  }

  /** Store the shared context (matches Player/Weapon). Not required for bus work. */
  setContext(ctx) {
    this.ctx = ctx;
  }

  /**
   * Subscribe to the bus and keep the unsubscribe fns. Idempotent — calling it
   * again (e.g. orchestrator wiring after construction) is a safe no-op so we
   * never double-count.
   */
  attach() {
    if (this._attached) return;
    this._attached = true;
    this._unsubs.push(
      // A boot to a door = one more breach this level.
      this.state.on("breach", () => this.state.bumpStat("doorsBreached")),
      // Taking any damage permanently ends the flawless (no-damage) run.
      this.state.on("damage", () => this.state.recordStat("noDamage", false)),
      // Track the peak combo purely for the STYLE bonus (Score.js owns the live one).
      this.state.on("combo", (p) => {
        const c = (p && p.combo) || 0;
        if (c > this._bestCombo) this._bestCombo = c;
      }),
    );
  }

  /** Clear per-level local tracking. Run stats themselves live in GameState. */
  resetLevel() {
    this._bestCombo = 0;
  }

  /**
   * Compute the RESULTS-screen bonus breakdown for a finished run. Zero-point
   * categories are omitted so the screen only shows what was actually earned.
   * Does NOT mutate score — the orchestrator sums these and applies them once.
   *
   * @param {object} run   a `state.run` snapshot (needs `.stats`).
   * @param {number} [par] time-bonus baseline in seconds (per-level; default 45).
   * @returns {Array<{label:string, points:number}>} earned bonus categories.
   */
  computeBonuses(run, par = DEFAULT_PAR) {
    if (!run || !run.stats) return [];
    const s = run.stats;
    // Peak combo: prefer whichever is higher between our local mirror and the
    // run's mirrored bestCombo, so this is robust whether or not "combo" events
    // were observed for this exact run.
    const bestCombo = Math.max(this._bestCombo, run.bestCombo || 0);

    const out = [];
    // Speed: every second under par is worth 50 pts.
    const time = Math.max(0, Math.round((par - (s.levelTime || 0)) * 50));
    if (time > 0) out.push({ label: "TIME", points: time });
    // Flawless: a flat reward for taking no damage all level.
    if (s.noDamage) out.push({ label: "FLAWLESS", points: 1000 });
    // Demolition: reward for chaining barrel detonations into kills.
    const demo = (s.barrelKills || 0) * 100;
    if (demo > 0) out.push({ label: "DEMOLITION", points: demo });
    // Style: reward the highest chain reached.
    const style = Math.round(bestCombo * 50);
    if (style > 0) out.push({ label: "STYLE", points: style });

    return out;
  }

  /**
   * Convenience: total of all earned bonus points.
   * @param {object} run @param {number} [par]
   * @returns {number}
   */
  totalBonus(run, par = DEFAULT_PAR) {
    let sum = 0;
    for (const b of this.computeBonuses(run, par)) sum += b.points;
    return sum;
  }

  /** Detach every bus listener. Safe to call once; idempotent thereafter. */
  dispose() {
    for (const off of this._unsubs) {
      try {
        off();
      } catch (err) {
        console.warn("[ComboSystem] unsubscribe failed:", err);
      }
    }
    this._unsubs.length = 0;
    this._attached = false;
  }
}

export default ComboSystem;
export { ComboSystem };
