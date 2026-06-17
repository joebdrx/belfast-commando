import gameState from "./GameState.js";
import { Steam } from "../utils/steam.js";
import ACHIEVEMENTS from "../data/achievements.json";

/**
 * Achievements
 * ------------
 * A data-driven, bus-subscribing unlock engine for the Hybrid Gameplay Loop.
 * It reads `src/data/achievements.json` (F1's schema, CONTRACTS.md §5) and, for
 * every entry, watches its `trigger.event` on the GameState event bus. When a
 * matching event has fired `trigger.count` times the achievement unlocks: the
 * persistent `progression.achievements[id]` flag is set, `Steam.unlock(steamId)`
 * is fired (a no-op outside Tauri — that IS the "stubbed behind an interface"
 * requirement), the injected Progression is saved, and a small comic-book toast
 * brags about it in the corner.
 *
 * Design notes:
 *   - One bus listener per DISTINCT event name (grouped), not one per
 *     achievement, so a noisy event (`kill`) only wakes a single handler.
 *   - Pure-ish + headless-safe: every DOM touch guards `typeof document` so the
 *     engine is unit-testable under Node and never throws when there's no body
 *     to hang a toast off. The DOM is built lazily on first unlock.
 *   - Defensive: bus payloads may be missing/partial; matching never throws.
 *     (GameState.emit already swallows listener exceptions, but we don't lean
 *     on that — a thrown listener still costs a console warn every frame.)
 *
 * See CONTRACTS.md §3 (event bus + catalog) and §5 (achievements schema).
 */

const PREFIX = "bc-ach-";
/** How long a toast lingers before auto-dismissing, in ms. */
const TOAST_MS = 3500;
/** Hard cap on simultaneously visible toasts (oldest is evicted past this). */
const MAX_TOASTS = 3;

export class Achievements {
  /**
   * @param {object} state the GameState singleton (injectable for tests).
   */
  constructor(state = gameState) {
    this.state = state;
    /** Optional shared frame context (may carry `progression`). */
    this._ctx = null;
    /** Injected providers; `progression` is Agent A's instance (or null). */
    this._providers = { progression: null };
    /** Per-achievement progress toward `trigger.count` — NOT persisted. */
    this._counters = {};
    /** Active `on()` unsubscribe fns, cleared by dispose(). */
    this._unsubs = [];
    /** Guards double-subscription so attach() is idempotent. */
    this._attached = false;
    /** Toast DOM root (built lazily) + live toast entries `{el, timer}`. */
    this._root = null;
    this._toasts = [];

    // Build the toast surface up front when a DOM exists; otherwise it is
    // created lazily on the first unlock (and skipped entirely under Node).
    this._ensureDom();
  }

  // ---- wiring ------------------------------------------------------------

  /**
   * Store the shared frame context. We only use it as a fallback source of a
   * Progression to persist through (`ctx.progression.save()`); setProviders is
   * the preferred channel.
   * @param {object} ctx
   */
  setContext(ctx) {
    this._ctx = ctx || null;
  }

  /**
   * Inject Agent A's Progression for persistence. May be null → the engine
   * still unlocks + toasts, it just won't write the save to disk.
   * @param {{progression?: any}} providers
   */
  setProviders(providers = {}) {
    if ("progression" in providers) this._providers.progression = providers.progression;
  }

  /**
   * Subscribe to the bus. For each DISTINCT trigger event we register ONE
   * listener that fans out to all achievements watching that event. Idempotent:
   * a second call while already attached is a no-op.
   */
  attach() {
    if (this._attached) return;
    this._attached = true;

    /** event name -> achievements watching it */
    const byEvent = new Map();
    for (const ach of ACHIEVEMENTS) {
      const event = ach && ach.trigger && ach.trigger.event;
      if (!event) continue;
      let list = byEvent.get(event);
      if (!list) {
        list = [];
        byEvent.set(event, list);
      }
      list.push(ach);
    }

    for (const [event, list] of byEvent) {
      const handler = (payload) => {
        for (const ach of list) this._process(ach, payload);
      };
      this._unsubs.push(this.state.on(event, handler));
    }
  }

  // ---- unlock pipeline ---------------------------------------------------

  /**
   * Evaluate one achievement against an incoming event payload: skip if already
   * unlocked, require the `match` subset, then count toward `trigger.count`.
   */
  _process(ach, payload) {
    if (!ach || !ach.id || !ach.trigger) return;
    if (this.isUnlocked(ach.id)) return;
    if (!this._matches(ach.trigger.match, payload)) return;

    const need = Number.isFinite(ach.trigger.count) ? ach.trigger.count : 1;
    const next = (this._counters[ach.id] || 0) + 1;
    this._counters[ach.id] = next;
    if (next >= need) this._unlock(ach);
  }

  /**
   * Shallow-equality subset test: every key in `match` must equal the payload's
   * value for that key. An empty/absent `match` matches everything.
   *
   * Special case (documented): the `levelClear` event carries `{stats}`, NOT a
   * `levelId`, so for a `levelId` match key that is absent from the payload we
   * fall back to the live run's `levelId` (`state.getState().run.levelId`).
   * This is what lets `shankill_clear` ({levelId:"shankill"}) fire.
   * @returns {boolean}
   */
  _matches(match, payload) {
    if (!match || typeof match !== "object") return true;
    const pl = payload && typeof payload === "object" ? payload : {};
    for (const key of Object.keys(match)) {
      let actual = pl[key];
      if (actual === undefined && key === "levelId") {
        actual = this._runLevelId();
      }
      if (actual !== match[key]) return false;
    }
    return true;
  }

  /** Live `run.levelId`, defensively (returns undefined on any failure). */
  _runLevelId() {
    try {
      return this.state.getState().run.levelId;
    } catch (_err) {
      return undefined;
    }
  }

  /**
   * Commit an unlock: flip the persistent flag, tell Steam, persist via the
   * injected Progression, and brag with a toast. Every side effect is guarded
   * so a failure in one (e.g. no Steam, no DOM) never blocks the others.
   */
  _unlock(ach) {
    const prog = this.state.getProgression();
    if (prog) {
      if (!prog.achievements) prog.achievements = {};
      prog.achievements[ach.id] = true;
    }

    // Steam: no-op/log outside Tauri. Guard a null/absent steamId and never let
    // the (async) call reject into the void unhandled.
    if (ach.steamId) {
      try {
        Promise.resolve(Steam.unlock(ach.steamId)).catch((err) =>
          console.warn(`[Achievements] Steam.unlock failed for ${ach.steamId}:`, err),
        );
      } catch (err) {
        console.warn(`[Achievements] Steam.unlock threw for ${ach.steamId}:`, err);
      }
    }

    // Persist the unlock through Agent A's Progression, if we were given one.
    const progression = this._progression();
    if (progression && typeof progression.save === "function") {
      try {
        progression.save();
      } catch (err) {
        console.warn(`[Achievements] progression.save() threw for ${ach.id}:`, err);
      }
    }

    this._showToast(ach);
  }

  /** Resolve a Progression to save through: explicit provider wins over ctx. */
  _progression() {
    if (this._providers.progression) return this._providers.progression;
    if (this._ctx && this._ctx.progression) return this._ctx.progression;
    return null;
  }

  // ---- public queries ----------------------------------------------------

  /** @returns {boolean} whether `id` is already unlocked in progression. */
  isUnlocked(id) {
    try {
      return !!this.state.getProgression().achievements[id];
    } catch (_err) {
      return false;
    }
  }

  /** Clear in-memory progress counters. Does NOT touch persisted unlocks. */
  reset() {
    this._counters = {};
  }

  /** Unsubscribe every bus listener and tear down all toast DOM + the style. */
  dispose() {
    for (const unsub of this._unsubs) {
      try {
        unsub();
      } catch (_err) {
        /* listener already gone — ignore */
      }
    }
    this._unsubs = [];
    this._attached = false;

    for (const entry of this._toasts.slice()) this._removeToast(entry);
    this._toasts = [];

    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;

    if (typeof document !== "undefined") {
      const style = document.getElementById(`${PREFIX}style`);
      if (style && style.parentNode) style.parentNode.removeChild(style);
    }
  }

  // ---- toast DOM (all guarded so the engine runs headless) ---------------

  /**
   * Create the fixed toast container + scoped stylesheet once. No-op under Node
   * (no `document`) and id-guarded so reconstruction never duplicates the style.
   */
  _ensureDom() {
    if (this._root || typeof document === "undefined") return;
    try {
      this._injectStyle();
      const root = document.createElement("div");
      root.className = `${PREFIX}root`;
      document.body.appendChild(root);
      this._root = root;
    } catch (_err) {
      // Some headless DOM shims throw — degrade to "no toasts", never crash.
      this._root = null;
    }
  }

  /** Inject the scoped stylesheet (mirrors Menu.js's amber comic-book look). */
  _injectStyle() {
    const styleId = `${PREFIX}style`;
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .${PREFIX}root {
        position: fixed; top: 18px; right: 18px; z-index: 60;
        display: flex; flex-direction: column; gap: 10px;
        pointer-events: none;
        font-family: "Arial Narrow", "Inter", system-ui, sans-serif;
      }
      .${PREFIX}toast {
        min-width: 220px; max-width: 320px;
        padding: 12px 16px;
        background: rgba(14,16,18,0.96);
        border: 1px solid rgba(255,122,26,0.32);
        border-left: 3px solid #ff7a1a;
        border-radius: 4px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.04);
        color: #f0ede8;
        transform: translateX(120%); opacity: 0;
        transition: transform 0.32s cubic-bezier(0.2,0.9,0.3,1), opacity 0.32s ease;
      }
      .${PREFIX}toast.${PREFIX}in { transform: translateX(0); opacity: 1; }
      .${PREFIX}toast.${PREFIX}out { transform: translateX(120%); opacity: 0; }
      .${PREFIX}label {
        font-size: 10px; font-weight: 800; letter-spacing: 0.18em;
        text-transform: uppercase; color: #ff7a1a;
        text-shadow: 0 0 14px rgba(255,122,26,0.5);
        margin-bottom: 3px;
      }
      .${PREFIX}name {
        font-size: 17px; font-weight: 900; letter-spacing: 0.04em;
        line-height: 1.1; color: #f0ede8;
      }
      .${PREFIX}desc {
        font-size: 12px; line-height: 1.4; color: rgba(240,237,232,0.62); margin-top: 3px;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Pop a "Achievement Unlocked" toast for `ach`. Caps concurrent toasts,
   * auto-dismisses after TOAST_MS, and is a silent no-op when there's no DOM.
   */
  _showToast(ach) {
    this._ensureDom();
    if (!this._root || typeof document === "undefined") return;

    // Evict the oldest toast(s) once we're at the cap.
    while (this._toasts.length >= MAX_TOASTS) {
      this._removeToast(this._toasts[0]);
    }

    const el = document.createElement("div");
    el.className = `${PREFIX}toast`;

    const label = document.createElement("div");
    label.className = `${PREFIX}label`;
    label.textContent = "Achievement Unlocked";
    el.appendChild(label);

    const name = document.createElement("div");
    name.className = `${PREFIX}name`;
    name.textContent = ach.name || ach.id;
    el.appendChild(name);

    if (ach.desc) {
      const desc = document.createElement("div");
      desc.className = `${PREFIX}desc`;
      desc.textContent = ach.desc;
      el.appendChild(desc);
    }

    this._root.appendChild(el);

    const entry = { el, timer: null };
    this._toasts.push(entry);

    // Slide in next frame so the transition actually animates.
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => el.classList.add(`${PREFIX}in`));
    } else {
      el.classList.add(`${PREFIX}in`);
    }

    if (typeof setTimeout === "function") {
      entry.timer = setTimeout(() => this._removeToast(entry), TOAST_MS);
    }
  }

  /** Slide a toast out, clear its timer, and detach it from DOM + tracking. */
  _removeToast(entry) {
    if (!entry) return;
    const idx = this._toasts.indexOf(entry);
    if (idx !== -1) this._toasts.splice(idx, 1);
    if (entry.timer && typeof clearTimeout === "function") clearTimeout(entry.timer);
    entry.timer = null;

    const el = entry.el;
    if (!el) return;
    el.classList.remove(`${PREFIX}in`);
    el.classList.add(`${PREFIX}out`);
    const detach = () => {
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    if (typeof setTimeout === "function") setTimeout(detach, 340);
    else detach();
  }
}

export default Achievements;
