/**
 * GameState
 * ---------
 * The central, single-source-of-truth singleton for the Hybrid Gameplay Loop.
 * Holds two kinds of state:
 *   - `run`         — transient, reset every operation (mirrors Score.js totals).
 *   - `progression` — persistent, saved/loaded by Progression (Agent A).
 * Also IS the project-wide synchronous event bus (`on`/`off`/`emit`).
 *
 * This module is intentionally PURE: it imports nothing (no three.js, no game
 * files) so it stays trivially Node-testable and allocation-free in hot paths.
 * Score.js remains authoritative for the on-screen total + live multiplier; this
 * mirror only exists so RESULTS/rewards/achievements can read a consistent run.
 *
 * See CONTRACTS.md §3 (API + event catalog) and §5 (save format). Event names
 * are LAW: phaseChange, runStart, runEnd, score, kill, combo, currency, stat.
 */

/** Build a fresh, zeroed run block (matches CONTRACTS.md §3 shape exactly). */
function freshRun(levelIndex = 0, active = false) {
  return {
    active,
    levelIndex,
    levelId: null,
    score: 0, // mirrors Score.total via "score" events
    kills: 0,
    combo: 0,
    bestCombo: 0,
    modifiers: [], // modifier ids active this run
    stats: {
      damageTaken: 0,
      doorsBreached: 0,
      barrelKills: 0,
      bootKills: 0,
      shotsFired: 0,
      noDamage: true,
      levelTime: 0,
    },
  };
}

/** Build the persistent progression block with documented defaults. */
function freshProgression() {
  return {
    resistancePoints: 0, // currency ("RP")
    upgrades: {}, // { upgradeId: level }
    boots: { owned: ["standard"], equipped: "standard" },
    weapons: { owned: ["pistol"] }, // one-time weapon unlocks (pistol always owned)
    unlockedLevels: 1, // highest campaign index reachable (1-based count)
    achievements: {}, // { achievementId: true }
    settings: { sensitivity: 0.0022, quality: "high", muted: false },
    version: 2,
  };
}

/**
 * Deep-merge `source` over `target` IN PLACE. Plain objects merge recursively;
 * arrays and primitives overwrite wholesale. Used by hydrate() so a loaded save
 * with missing keys keeps defaults and extra keys are tolerated (never throws).
 */
function deepMerge(target, source) {
  if (!source || typeof source !== "object") return target;
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (Array.isArray(sv)) {
      target[key] = sv.slice();
    } else if (sv && typeof sv === "object") {
      if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
        target[key] = {};
      }
      deepMerge(target[key], sv);
    } else {
      target[key] = sv;
    }
  }
  return target;
}

class GameState {
  constructor() {
    this.state = {
      phase: "HUB", // "HUB" | "LEVEL" | "RESULTS" | "PAUSED"
      run: freshRun(),
      progression: freshProgression(),
    };
    // event name -> Set<listener>. Set lets us add/remove cheaply and tolerates
    // listeners (un)subscribing mid-emit without revisiting removed ones.
    this._listeners = new Map();
  }

  // ---- state access ------------------------------------------------------

  /** @returns {object} the live state reference (treat as read-mostly). */
  getState() {
    return this.state;
  }

  /** @returns {object} the persistent progression block. */
  getProgression() {
    return this.state.progression;
  }

  // ---- phase / state machine --------------------------------------------

  /** Set the top-level GamePhase, emitting `phaseChange {from,to}`. */
  setPhase(phase) {
    const from = this.state.phase;
    this.state.phase = phase;
    this.emit("phaseChange", { from, to: phase });
  }

  /** @returns {string} current phase. */
  getPhase() {
    return this.state.phase;
  }

  // ---- run lifecycle -----------------------------------------------------

  /** Begin an operation: zero the run, mark it active, emit `runStart`. */
  startRun({ levelIndex = 0 } = {}) {
    this.state.run = freshRun(levelIndex, true);
    this.emit("runStart", {});
  }

  /** End the current run; emit `runEnd {died, run}` with the final run snapshot. */
  endRun({ died = false } = {}) {
    this.state.run.active = false;
    this.emit("runEnd", { died, run: this.state.run });
  }

  // ---- scoring / kills / combo (mirrors Score.js) ------------------------

  /**
   * Mirror a score gain into `run.score` and broadcast it. Score.js stays the
   * HUD-facing total; this keeps run.score in sync for RESULTS/rewards.
   */
  addScore(amount, reason = "") {
    this.state.run.score += amount;
    this.emit("score", { gained: amount, total: this.state.run.score, reason });
  }

  /**
   * Record a kill. `meta` may carry `{isKick, isBarrel, position, weapon}`.
   * Bumps the matching stat counters, then emits `kill` with the raw meta.
   */
  addKill(meta = {}) {
    this.state.run.kills += 1;
    if (meta.isKick) this.state.run.stats.bootKills += 1;
    if (meta.isBarrel) this.state.run.stats.barrelKills += 1;
    this.emit("kill", meta);
  }

  /** @returns {number} current combo count. */
  getCombo() {
    return this.state.run.combo;
  }

  /** Set the mirrored combo (kept in sync from Score.js); emits `combo`. */
  setCombo(n) {
    this.state.run.combo = n;
    if (n > this.state.run.bestCombo) this.state.run.bestCombo = n;
    this.emit("combo", { combo: n, multiplier: this.getMultiplier() });
  }

  /** @returns {number} live multiplier — mirrors Score.js's formula exactly. */
  getMultiplier() {
    return Math.min(5, 1 + this.getState().run.combo * 0.25);
  }

  // ---- currency ----------------------------------------------------------

  /** Award Resistance Points; emits `currency {resistancePoints}`. */
  addCurrency(n) {
    this.state.progression.resistancePoints += n;
    this.emit("currency", { resistancePoints: this.state.progression.resistancePoints });
  }

  /**
   * Spend Resistance Points if affordable.
   * @returns {boolean} true and deducts when affordable; false (no-op) when broke.
   */
  spendCurrency(n) {
    if (this.state.progression.resistancePoints < n) return false;
    this.state.progression.resistancePoints -= n;
    this.emit("currency", { resistancePoints: this.state.progression.resistancePoints });
    return true;
  }

  // ---- run stats ---------------------------------------------------------

  /** Set a `run.stats` key to an absolute value; emits `stat {key,value}`. */
  recordStat(key, value) {
    this.state.run.stats[key] = value;
    this.emit("stat", { key, value });
  }

  /** Increment a numeric `run.stats` key; emits `stat {key,value}`. */
  bumpStat(key, delta = 1) {
    const next = (this.state.run.stats[key] || 0) + delta;
    this.state.run.stats[key] = next;
    this.emit("stat", { key, value: next });
  }

  // ---- persistence -------------------------------------------------------

  /**
   * Deep-merge a loaded progression over the defaults. Tolerates missing/extra
   * keys. If the save's `version` mismatches, keeps defaults and warns — never
   * throws (CONTRACTS.md §5 save format).
   * @param {object} progressionObj parsed `belfast_commando_save_v1` value
   */
  hydrate(progressionObj) {
    if (!progressionObj || typeof progressionObj !== "object") {
      console.warn("[GameState] hydrate: ignoring non-object progression");
      return;
    }
    const expected = this.state.progression.version;
    if (progressionObj.version !== expected) {
      console.warn(
        `[GameState] hydrate: save version ${progressionObj.version} != ${expected}; keeping defaults`,
      );
      return;
    }
    deepMerge(this.state.progression, progressionObj);
  }

  // ---- event bus ---------------------------------------------------------

  /**
   * Subscribe to a bus event.
   * @param {string} event
   * @param {Function} fn
   * @returns {Function} unsubscribe() — removes exactly this listener.
   */
  on(event, fn) {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(fn);
    return () => this.off(event, fn);
  }

  /** Remove a previously-registered listener. */
  off(event, fn) {
    const set = this._listeners.get(event);
    if (set) set.delete(fn);
  }

  /**
   * Synchronously fan a payload out to every listener. Each listener is wrapped
   * in try/catch so one throwing listener can never break the frame. No
   * per-emit allocation beyond the unavoidable iteration.
   */
  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.warn(`[GameState] listener for "${event}" threw:`, err);
      }
    }
  }
}

export const gameState = new GameState();
export default gameState;
