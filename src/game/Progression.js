import gameState from "./GameState.js";
import UPGRADES from "../data/upgrades.json";
import BOOTS from "../data/boots.json";

/**
 * Progression
 * -----------
 * Layers upgrade/boot purchasing + persistence over the GameState singleton.
 * This is the ONLY module that reads/writes the persistent save; everything it
 * touches lives in `state.progression` (see CONTRACTS.md §3). It is pure data —
 * NO rendering, NO three.js — so the menu (Agent B) and gameplay just read it.
 *
 * Persistence is browser-first: localStorage key `belfast_commando_save_v1`
 * holds `JSON.stringify(state.getProgression())` (CONTRACTS.md §5). A Tauri
 * filesystem mirror is best-effort and feature-detected (`window.__TAURI__.fs`,
 * mirroring `src/utils/steam.js`); its absence is a silent no-op and never
 * breaks the browser path. No Tauri module is statically imported (that would
 * break the Vite build). Node/SSR (no `localStorage`) degrades to a no-op too.
 *
 * Upgrade effect.type → consumer (read `getUpgradeEffectValue(id)`):
 *   - "kickPower"  (kick_master) → Player kick radius/knockback bonus
 *   - "maxHealth"  (thick_skin)  → Player.maxHealth bonus (flat per level)
 */

/** localStorage key + Tauri mirror filename — LAW per CONTRACTS.md §5. */
const SAVE_KEY = "belfast_commando_save_v1";
const SAVE_FILE = "belfast_commando_save_v1.json";

class Progression {
  /**
   * @param {object} state the GameState singleton (injectable for tests).
   */
  constructor(state = gameState) {
    this.state = state;
  }

  // ---- internal lookups --------------------------------------------------

  /** @returns {object|null} the upgrade definition for `id`, or null. */
  _upgrade(id) {
    return UPGRADES.find((u) => u.id === id) || null;
  }

  /** @returns {object|null} the boot definition for `id`, or null. */
  _boot(id) {
    return BOOTS.find((b) => b.id === id) || null;
  }

  // ---- persistence -------------------------------------------------------

  /**
   * Persist the progression block. localStorage is the source of truth in the
   * browser; a Tauri file mirror is fired best-effort (never awaited, never
   * blocks). Guards `typeof localStorage` so Node/SSR is a graceful no-op.
   * @returns {boolean} true if written to localStorage.
   */
  save() {
    const json = JSON.stringify(this.state.getProgression());
    let ok = false;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(SAVE_KEY, json);
        ok = true;
      } catch (err) {
        // Private mode / quota exceeded — keep playing, just don't persist.
        console.warn("[Progression] localStorage save failed:", err);
      }
    }
    this._saveToTauri(json); // best-effort, fire-and-forget
    return ok;
  }

  /**
   * Load the persisted progression and hydrate GameState. Reads localStorage
   * synchronously (returns whether it loaded), and additionally kicks a
   * best-effort Tauri file read that prefers the on-disk save when present.
   * Tolerates missing/malformed JSON (catch → false). No-op in Node/SSR.
   * @returns {boolean} true if a valid save hydrated from localStorage.
   */
  load() {
    let loaded = false;
    if (typeof localStorage !== "undefined") {
      try {
        const raw = localStorage.getItem(SAVE_KEY);
        if (raw) {
          this.state.hydrate(JSON.parse(raw));
          loaded = true;
        }
      } catch (err) {
        // Corrupt/partial save — ignore and fall back to defaults.
        console.warn("[Progression] localStorage load failed/invalid:", err);
        loaded = false;
      }
    }
    this._loadFromTauri(); // best-effort: prefer the file when it exists
    return loaded;
  }

  /**
   * Resolve the feature-detected Tauri fs API, or null. Mirrors the detection
   * in src/utils/steam.js (`__TAURI_INTERNALS__`/`__TAURI__`) and additionally
   * requires the `fs` global (only present when the fs plugin is wired with
   * withGlobalTauri). Returns null everywhere else (browser dev, Node, SSR).
   * @returns {object|null}
   */
  _tauriFs() {
    if (typeof window === "undefined") return null;
    const inTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
    if (!inTauri) return null;
    const t = window.__TAURI__;
    return t && t.fs ? t.fs : null;
  }

  /** Best-effort Tauri file write. Guarded so absence is a silent no-op. */
  _saveToTauri(json) {
    const fs = this._tauriFs();
    if (!fs || typeof fs.writeTextFile !== "function") return;
    try {
      Promise.resolve(fs.writeTextFile(SAVE_FILE, json)).catch((err) =>
        console.warn("[Progression] Tauri save mirror failed:", err),
      );
    } catch (err) {
      console.warn("[Progression] Tauri save mirror threw:", err);
    }
  }

  /**
   * Best-effort Tauri file read. When a save file exists, it is preferred:
   * its contents hydrate GameState (file wins over localStorage). A missing
   * file or any error is a silent no-op so the browser path is untouched.
   */
  _loadFromTauri() {
    const fs = this._tauriFs();
    if (!fs || typeof fs.readTextFile !== "function") return;
    try {
      Promise.resolve(fs.readTextFile(SAVE_FILE))
        .then((raw) => {
          if (!raw) return;
          this.state.hydrate(JSON.parse(raw));
        })
        .catch(() => {
          /* no file yet / unreadable — keep localStorage or defaults */
        });
    } catch (err) {
      /* synchronous throw — silent best-effort */
    }
  }

  // ---- upgrades (data-driven from UPGRADES) ------------------------------

  /** @returns {number} current purchased level of `id` (0 if never bought). */
  getUpgradeLevel(id) {
    return this.state.getProgression().upgrades[id] || 0;
  }

  /**
   * Cost of the NEXT level of `id`, indexed by current level.
   * @returns {number|null} RP cost, or null if unknown/maxed.
   */
  getUpgradeCost(id) {
    const upgrade = this._upgrade(id);
    if (!upgrade) return null;
    const level = this.getUpgradeLevel(id);
    if (level >= upgrade.maxLevel) return null; // maxed — nothing to buy
    const cost = upgrade.cost[level];
    return cost == null ? null : cost;
  }

  /** @returns {boolean} true if `id` is not maxed AND currently affordable. */
  canBuyUpgrade(id) {
    const cost = this.getUpgradeCost(id);
    if (cost == null) return false; // unknown or maxed
    return this.state.getProgression().resistancePoints >= cost;
  }

  /**
   * Purchase the next level of upgrade `id`. Spends RP via GameState, bumps the
   * level, and persists. Atomic: never deducts RP without raising the level.
   * @returns {{ok:true, level:number} | {ok:false, reason:string}}
   */
  buyUpgrade(id) {
    const upgrade = this._upgrade(id);
    if (!upgrade) return { ok: false, reason: "unknown" };
    const level = this.getUpgradeLevel(id);
    if (level >= upgrade.maxLevel) return { ok: false, reason: "maxed" };
    const cost = this.getUpgradeCost(id);
    if (cost == null) return { ok: false, reason: "maxed" };
    if (!this.state.spendCurrency(cost)) return { ok: false, reason: "broke" };
    const next = level + 1;
    this.state.getProgression().upgrades[id] = next;
    this.save();
    return { ok: true, level: next };
  }

  /**
   * Total gameplay effect value for `id` = `effect.perLevel * currentLevel`.
   * (See the effect.type → consumer map in the file header.)
   * @returns {number} 0 when unowned/unknown.
   */
  getUpgradeEffectValue(id) {
    const upgrade = this._upgrade(id);
    if (!upgrade || !upgrade.effect) return 0;
    return upgrade.effect.perLevel * this.getUpgradeLevel(id);
  }

  /**
   * Menu-ready snapshot of every upgrade.
   * @returns {Array<object>} `{...upgradeData, level, cost, maxed, affordable}`.
   */
  listUpgrades() {
    const rp = this.state.getProgression().resistancePoints;
    return UPGRADES.map((u) => {
      const level = this.getUpgradeLevel(u.id);
      const maxed = level >= u.maxLevel;
      const cost = maxed ? null : u.cost[level];
      return {
        ...u,
        level,
        cost,
        maxed,
        affordable: !maxed && cost != null && rp >= cost,
      };
    });
  }

  // ---- boots (data-driven from BOOTS) ------------------------------------

  /** @returns {boolean} whether boot `id` is owned. */
  ownsBoot(id) {
    return this.state.getProgression().boots.owned.includes(id);
  }

  /**
   * Buy boot `id` (one-time unlock). Spends RP and persists.
   * @returns {{ok:true} | {ok:false, reason:string}}
   */
  buyBoot(id) {
    const boot = this._boot(id);
    if (!boot) return { ok: false, reason: "unknown" };
    if (this.ownsBoot(id)) return { ok: false, reason: "owned" };
    if (!this.state.spendCurrency(boot.cost)) return { ok: false, reason: "broke" };
    this.state.getProgression().boots.owned.push(id);
    this.save();
    return { ok: true };
  }

  /**
   * Equip an owned boot.
   * @returns {{ok:true} | {ok:false, reason:string}}
   */
  equipBoot(id) {
    const boot = this._boot(id);
    if (!boot) return { ok: false, reason: "unknown" };
    if (!this.ownsBoot(id)) return { ok: false, reason: "notOwned" };
    this.state.getProgression().boots.equipped = id;
    this.save();
    return { ok: true };
  }

  /** @returns {object|null} the full boot definition currently equipped. */
  getEquippedBoot() {
    return this._boot(this.state.getProgression().boots.equipped);
  }

  /** @returns {string} the equipped boot's ability ("none" if unresolved). */
  getActiveBootAbility() {
    const boot = this.getEquippedBoot();
    return boot ? boot.ability : "none";
  }

  /**
   * Menu-ready snapshot of every boot.
   * @returns {Array<object>} `{...bootData, owned, equipped, affordable}`.
   */
  listBoots() {
    const prog = this.state.getProgression();
    const rp = prog.resistancePoints;
    return BOOTS.map((b) => {
      const owned = this.ownsBoot(b.id);
      return {
        ...b,
        owned,
        equipped: prog.boots.equipped === b.id,
        affordable: !owned && rp >= b.cost,
      };
    });
  }
}

export default Progression;
export { Progression };
