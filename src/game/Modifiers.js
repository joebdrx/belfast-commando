import gameState from "./GameState.js";
import MODIFIERS from "../data/modifiers.json";

/** The closed set of effect keys the engine reads (CONTRACTS.md §5). Any key a
 * modifier omits defaults to 1.0 (i.e. "no change"). */
const DEFAULT_EFFECTS = {
  playerSpeedMul: 1,
  frictionMul: 1,
  enemySightMul: 1,
  enemySpeedMul: 1,
  enemyCountMul: 1,
};

/**
 * Modifiers
 * ---------
 * Per-run modifier engine. A modifier (e.g. "Rainy Night") is rolled on LEVEL
 * entry with the level's `modifierChance`, applied to the freshly-built world,
 * and cleared on exit. Effects are pure scalar mutations of public knobs that
 * the existing systems already read — no rendering, no three.js needed here.
 *
 *   - Player: writes `player.speedMul` / `player.frictionMul` (Player multiplies
 *     these into movement). Player is a long-lived singleton, so we STORE its
 *     originals and RESTORE them in clear().
 *   - Enemies: scales `sightRange` / `speed` / `runSpeed` on each live Enemy and
 *     can TRIM the patrol down (enemyCountMul < 1). Enemies are rebuilt fresh by
 *     `new Level(...)` every level entry, so we DO NOT restore enemy scaling —
 *     the next level's enemies start unscaled by construction. (Documented
 *     choice per CONTRACTS.md §0 P2 brief: "rely on the next level rebuilding
 *     fresh enemies".)
 *
 * Score reward for taking the handicap is exposed via getScoreMul() and applied
 * to the RESULTS reward by the orchestrator — this class never touches Score.
 *
 * See CONTRACTS.md §3 (run.modifiers is set DIRECTLY on the live state ref, plus
 * a "modifier" bus emit) and §5 (modifiers.json schema + closed effect-key set).
 */
export class Modifiers {
  /** @param {object} [state] the GameState singleton (injectable for tests). */
  constructor(state = gameState) {
    this.state = state;
    /** @type {object|null} the currently-active modifier object, or null. */
    this.active = null;
    // Restore targets captured by applyToLevel(); cleared by clear().
    this._player = null;
    this._origSpeedMul = 1;
    this._origFrictionMul = 1;
  }

  /**
   * Roll a random modifier for a level entry. With probability
   * `entry.modifierChance ?? 0` a modifier is chosen from MODIFIERS, set active,
   * mirrored into `run.modifiers`, and announced on the bus.
   *
   * @param {object} entry a `levels.json` entry (uses `modifierChance`).
   * @param {() => number} [rng] 0..1 source (injected for deterministic tests).
   * @returns {object|null} the chosen modifier, or null if none rolled.
   */
  maybeRoll(entry, rng = Math.random) {
    this.active = null;
    const chance = (entry && entry.modifierChance) || 0;
    if (chance <= 0 || rng() >= chance || !MODIFIERS.length) {
      return null;
    }
    const mod = MODIFIERS[Math.floor(rng() * MODIFIERS.length) % MODIFIERS.length];
    this.active = mod;
    // Sanctioned direct write of run.modifiers (CONTRACTS.md §3) + canonical emit.
    this.state.getState().run.modifiers = [mod.id];
    this.state.emit("modifier", { id: mod.id, name: mod.name, desc: mod.desc });
    return mod;
  }

  /** Merge the active modifier's effects over the closed-key defaults. */
  _effects() {
    return { ...DEFAULT_EFFECTS, ...(this.active && this.active.effects) };
  }

  /**
   * Apply the active modifier to a freshly-built level + the player. No-op when
   * nothing is active. Safe to call once per level entry, after the Level and
   * Player have spawned.
   *
   * @param {object} level a Level instance (uses `enemies`, `scene`, `spawn`).
   * @param {object} player the Player instance (uses `speedMul`/`frictionMul`).
   */
  applyToLevel(level, player) {
    if (!this.active) return;
    const fx = this._effects();

    // --- Player: store originals, then set the run knobs directly. ----------
    if (player) {
      this._player = player;
      this._origSpeedMul = player.speedMul;
      this._origFrictionMul = player.frictionMul;
      player.speedMul = fx.playerSpeedMul;
      player.frictionMul = fx.frictionMul;
    }

    if (!level || !Array.isArray(level.enemies)) return;

    // --- Enemy count: only ever REMOVE (enemyCountMul < 1). Spawning new
    // rigged enemies post-build is unsafe (no assets/AI wiring here), so
    // enemyCountMul > 1 is clamped to no effect. Removal disposes + splices
    // FULLY so enemiesRemaining can still reach 0 (never half-remove). --------
    if (fx.enemyCountMul < 1) {
      this._trimEnemies(level, fx.enemyCountMul);
    }

    // --- Enemy stats: scale the survivors. ----------------------------------
    if (fx.enemySightMul !== 1 || fx.enemySpeedMul !== 1) {
      for (const e of level.enemies) {
        if (e.dead) continue;
        e.sightRange *= fx.enemySightMul;
        e.speed *= fx.enemySpeedMul;
        e.runSpeed *= fx.enemySpeedMul;
      }
    }
  }

  /**
   * Remove the farthest `round(count*(1-mul))` live enemies from the spawn,
   * disposing each before splicing it out of `level.enemies`. Distance is from
   * the player spawn (`level.spawn`), falling back to the player position.
   */
  _trimEnemies(level, countMul) {
    const ref = (level.spawn) || (this._player && this._player.position) || null;
    const alive = level.enemies.filter((e) => !e.dead);
    const removeCount = Math.round(alive.length * (1 - countMul));
    if (removeCount <= 0) return;

    const dist = (e) => (ref ? e.position.distanceTo(ref) : 0);
    // Farthest-first; take the top N to cull.
    const cull = new Set(
      alive.slice().sort((a, b) => dist(b) - dist(a)).slice(0, removeCount),
    );
    // Splice back-to-front so indices stay valid while we dispose+remove.
    for (let i = level.enemies.length - 1; i >= 0; i--) {
      const e = level.enemies[i];
      if (cull.has(e)) {
        if (e.dispose) e.dispose(level.scene);
        level.enemies.splice(i, 1);
      }
    }
  }

  /** @returns {number} run-score reward multiplier (1 when nothing active). */
  getScoreMul() {
    return this.active ? (this.active.scoreMul ?? 1) : 1;
  }

  /** @returns {{id,name,desc}|null} the active modifier for the HUD/intro banner. */
  getActive() {
    if (!this.active) return null;
    const { id, name, desc } = this.active;
    return { id, name, desc };
  }

  /**
   * Undo everything maybeRoll/applyToLevel set up, ready for the next level.
   * Restores the stored player knobs (Player is persistent), empties
   * run.modifiers, and drops the active modifier. Enemy scaling is intentionally
   * NOT restored — the next level rebuilds fresh enemies (see class header).
   */
  clear() {
    if (this._player) {
      this._player.speedMul = this._origSpeedMul;
      this._player.frictionMul = this._origFrictionMul;
    }
    this._player = null;
    this._origSpeedMul = 1;
    this._origFrictionMul = 1;
    this.state.getState().run.modifiers = [];
    this.active = null;
  }
}

export default Modifiers;
