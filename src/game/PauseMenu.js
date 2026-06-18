import gameState from "./GameState.js";

/**
 * PauseMenu
 * ---------
 * The transient PAUSED overlay shown over GamePhase "LEVEL" when pointer lock is
 * lost (CONTRACTS.md §4 — PAUSED is an overlay over LEVEL). Built ENTIRELY in JS
 * (a root <div> appended to document.body + an injected, class-prefixed <style>
 * block) so it never touches index.html or styles.css, yet reuses the existing
 * safehouse Menu's visual language (dark card, light text, amber accent,
 * condensed type) so it feels native. It REPLACES the simple HUD "PAUSED" card
 * the orchestrator used to show.
 *
 * Responsibilities:
 *   - Title card ("PAUSED") with three actions — Resume, Restart Sector, Quit to
 *     Safehouse — wired to caller-supplied handlers via setHandlers().
 *   - A live Settings section editing `progression.settings`
 *     (`{sensitivity, quality, muted}`, CONTRACTS.md §3):
 *       · Mouse Sensitivity — a range slider (0.0008–0.0050, step 0.0002) with a
 *         live numeric readout.
 *       · Graphics Quality — a Low/Medium/High select.
 *   - On any settings change it mutates the live `gameState.getProgression()
 *     .settings`, persists via the injected Progression provider, then fires
 *     `onSettingsChange(settings)` so the orchestrator can apply it live
 *     (sensitivity → Player.sensitivity, quality → Engine renderer pixel ratio).
 *
 * Cross-module talk follows CONTRACTS.md: current settings are read from the
 * GameState singleton; persistence goes through the injected Progression
 * instance (which itself owns the localStorage save). PauseMenu NEVER touches the
 * renderer or the player directly — it only reports the chosen settings.
 */

const PREFIX = "bc-pause-";

/** Mouse-sensitivity slider bounds (radians per mouse-pixel). Default is 0.0022. */
const SENS_MIN = 0.0008;
const SENS_MAX = 0.005;
const SENS_STEP = 0.0002;

/** Graphics-quality options: stored value (lowercase) + display label. */
const QUALITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/** Default settings used only if the persisted block is somehow missing. */
const DEFAULT_SETTINGS = { sensitivity: 0.0022, quality: "high", muted: false };

export class PauseMenu {
  constructor() {
    /** @type {{onResume?:Function,onRestart?:Function,onQuit?:Function}} */
    this._handlers = {};
    /** @type {{progression: any|null}} */
    this._providers = { progression: null };
    /** @type {((settings:object)=>void)|null} */
    this._onSettingsChange = null;

    this._injectStyle();
    this._buildDom();
    this.hide();
  }

  // ---- DOM construction ----------------------------------------------------

  /** Inject the scoped stylesheet once (id-guarded so re-construction is safe). */
  _injectStyle() {
    const styleId = `${PREFIX}style`;
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .${PREFIX}root {
        position: fixed; inset: 0; z-index: 40;
        display: flex; align-items: stretch; justify-content: flex-start;
        pointer-events: auto;
        font-family: "Arial Narrow", "Inter", system-ui, sans-serif;
        color: #f0ede8;
        background:
          linear-gradient(100deg, rgba(3,4,6,0.86) 0%, rgba(4,5,7,0.6) 46%, rgba(4,5,7,0.18) 100%);
      }
      .${PREFIX}root.${PREFIX}hidden { display: none; }
      /* Left-aligned command panel, matching the safehouse lobby aesthetic. */
      .${PREFIX}card {
        position: relative;
        width: 40%; min-width: 340px; max-width: 480px;
        height: 100%; overflow-y: auto;
        padding: 48px 42px;
        background: linear-gradient(100deg,
          rgba(8,9,11,0.97) 0%, rgba(9,11,13,0.95) 70%, rgba(11,13,15,0.6) 100%);
        border-right: 1px solid rgba(255,122,26,0.20);
        text-align: left;
        box-shadow: 26px 0 70px rgba(0,0,0,0.6);
      }
      /* Far-left amber stencil stripe (mirrors the safehouse menu). */
      .${PREFIX}card::before {
        content: ""; position: absolute; top: 0; left: 0; bottom: 0; width: 4px;
        background: linear-gradient(#ff7a1a, rgba(255,122,26,0.15));
      }
      .${PREFIX}title {
        font-size: 32px; font-weight: 900; letter-spacing: 0.08em;
        text-transform: uppercase; color: #ff7a1a; line-height: 1.04;
        text-shadow: 0 0 22px rgba(255,122,26,0.5), 0 2px 4px rgba(0,0,0,0.85);
        margin-bottom: 4px;
      }
      .${PREFIX}subtitle {
        font-size: 12px; font-weight: 800; letter-spacing: 0.16em;
        text-transform: uppercase; color: rgba(240,237,232,0.55);
        margin-bottom: 26px;
        padding-bottom: 18px; border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .${PREFIX}btnrow {
        display: flex; flex-direction: column; gap: 11px;
      }
      .${PREFIX}btn {
        width: 100%;
        padding: 15px 18px; text-align: left;
        font-family: inherit; font-size: 15px; font-weight: 800;
        letter-spacing: 0.10em; text-transform: uppercase;
        color: #f0ede8; cursor: pointer;
        background: rgba(255,255,255,0.045);
        border: 1px solid rgba(255,122,26,0.30);
        border-left: 3px solid rgba(255,122,26,0.55);
        border-radius: 3px;
        transition: background 0.14s ease, border-color 0.14s ease, transform 0.06s ease;
      }
      .${PREFIX}btn:hover {
        background: rgba(255,122,26,0.18); border-color: #ff7a1a; border-left-color: #ff7a1a;
      }
      .${PREFIX}btn:active { transform: translateX(2px); }
      .${PREFIX}btn-primary {
        background: rgba(255,122,26,0.18); border-color: #ff7a1a;
        border-left-color: #ff7a1a;
      }
      .${PREFIX}btn-primary:hover { background: rgba(255,122,26,0.30); }
      .${PREFIX}section-label {
        font-size: 12px; font-weight: 800; letter-spacing: 0.18em;
        text-transform: uppercase; color: rgba(240,237,232,0.5);
        margin: 26px 0 12px; text-align: left;
      }
      .${PREFIX}row {
        display: flex; align-items: center; gap: 14px;
        padding: 12px 14px; margin-bottom: 10px;
        background: rgba(255,255,255,0.035);
        border: 1px solid rgba(255,255,255,0.10);
        border-left: 2px solid rgba(255,122,26,0.5);
        border-radius: 3px; text-align: left;
      }
      .${PREFIX}row-label {
        flex: 0 0 auto; min-width: 132px;
        font-size: 13px; font-weight: 800; letter-spacing: 0.06em;
        text-transform: uppercase; color: #f0ede8;
      }
      .${PREFIX}row-control { flex: 1 1 auto; display: flex; align-items: center; gap: 12px; }
      .${PREFIX}range {
        flex: 1 1 auto; min-width: 0; height: 4px; cursor: pointer;
        accent-color: #ff7a1a;
        background: rgba(255,255,255,0.14); border-radius: 2px;
      }
      .${PREFIX}range-value {
        flex: 0 0 auto; min-width: 58px; text-align: right;
        font-size: 13px; font-weight: 800; letter-spacing: 0.04em; color: #ffc566;
        font-variant-numeric: tabular-nums;
      }
      .${PREFIX}select {
        flex: 1 1 auto; min-width: 0;
        padding: 8px 10px;
        font-family: inherit; font-size: 13px; font-weight: 800;
        letter-spacing: 0.06em; text-transform: uppercase;
        color: #f0ede8; cursor: pointer;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,122,26,0.35);
        border-radius: 4px;
      }
      .${PREFIX}select:hover { border-color: #ff7a1a; }
      .${PREFIX}select option { color: #0b0c0d; }
    `;
    document.head.appendChild(style);
  }

  /** Helper: create an element with optional class + text. */
  _el(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  /** Build the root, card, title, action buttons, and the live settings rows. */
  _buildDom() {
    this.root = this._el("div", `${PREFIX}root`);

    this.card = this._el("div", `${PREFIX}card`);
    this.root.appendChild(this.card);

    this.card.appendChild(this._el("div", `${PREFIX}title`, "Paused"));
    this.card.appendChild(this._el("div", `${PREFIX}subtitle`, "Operation suspended"));

    // --- Actions ----------------------------------------------------------
    const row = this._el("div", `${PREFIX}btnrow`);
    row.appendChild(this._makeButton("Resume", () => this._call("onResume"), true));
    row.appendChild(this._makeButton("Restart Sector", () => this._call("onRestart")));
    row.appendChild(this._makeButton("Quit to Safehouse", () => this._call("onQuit")));
    this.card.appendChild(row);

    // --- Settings ---------------------------------------------------------
    this.card.appendChild(this._el("div", `${PREFIX}section-label`, "Settings"));
    this.card.appendChild(this._buildSensitivityRow());
    this.card.appendChild(this._buildQualityRow());

    document.body.appendChild(this.root);
  }

  /** Mouse Sensitivity row: a range slider + a live numeric readout. */
  _buildSensitivityRow() {
    const rowEl = this._el("div", `${PREFIX}row`);
    rowEl.appendChild(this._el("div", `${PREFIX}row-label`, "Mouse Sensitivity"));

    const control = this._el("div", `${PREFIX}row-control`);
    const input = this._el("input", `${PREFIX}range`);
    input.type = "range";
    input.min = String(SENS_MIN);
    input.max = String(SENS_MAX);
    input.step = String(SENS_STEP);
    // "input" fires on every drag tick → live value + live apply (CONTRACTS §3).
    input.addEventListener("input", () => this._onSensitivityInput());
    this.sensInput = input;

    const value = this._el("div", `${PREFIX}range-value`);
    this.sensValue = value;

    control.appendChild(input);
    control.appendChild(value);
    rowEl.appendChild(control);
    return rowEl;
  }

  /** Graphics Quality row: a Low/Medium/High select. */
  _buildQualityRow() {
    const rowEl = this._el("div", `${PREFIX}row`);
    rowEl.appendChild(this._el("div", `${PREFIX}row-label`, "Graphics Quality"));

    const control = this._el("div", `${PREFIX}row-control`);
    const select = this._el("select", `${PREFIX}select`);
    for (const opt of QUALITY_OPTIONS) {
      const o = this._el("option", null, opt.label);
      o.value = opt.value;
      select.appendChild(o);
    }
    select.addEventListener("change", () => this._onQualityChange());
    this.qualitySelect = select;

    control.appendChild(select);
    rowEl.appendChild(control);
    return rowEl;
  }

  /** Build a styled button; `primary` is the full-width amber Resume action. */
  _makeButton(label, onClick, primary = false) {
    const btn = this._el("button", `${PREFIX}btn${primary ? ` ${PREFIX}btn-primary` : ""}`, label);
    btn.type = "button";
    btn.addEventListener("click", onClick);
    return btn;
  }

  // ---- settings plumbing ---------------------------------------------------

  /**
   * The live settings object on the persistent progression block. Mutating the
   * returned object mutates `gameState.getProgression().settings` directly (this
   * is what gets saved). Backfills a default block if a malformed save dropped it.
   * @returns {{sensitivity:number, quality:string, muted:boolean}}
   */
  _settings() {
    const prog = gameState.getProgression();
    if (!prog.settings || typeof prog.settings !== "object") {
      prog.settings = { ...DEFAULT_SETTINGS };
    }
    return prog.settings;
  }

  /** Clamp/normalise a quality string to one of the known option values. */
  _normQuality(quality) {
    const v = typeof quality === "string" ? quality.toLowerCase() : "";
    return v === "low" || v === "medium" || v === "high" ? v : "high";
  }

  /** Format a sensitivity value for the live readout (e.g. 0.0022). */
  _fmtSensitivity(v) {
    return Number.isFinite(v) ? v.toFixed(4) : "—";
  }

  /**
   * Quality → renderer/particle budget mapping (DOCUMENTATION + reporting only).
   * PauseMenu only STORES the string and reports it via onSettingsChange; the
   * ORCHESTRATOR applies the renderer change (Engine.renderer.setPixelRatio) and
   * any particle-count reduction. This helper documents the intended mapping and
   * is provided for the orchestrator's convenience:
   *   "low"    → pixelRatio 1   / fewer particles
   *   "medium" → pixelRatio 1.5
   *   "high"   → pixelRatio 2
   * @param {string} quality
   * @returns {{pixelRatio:number}} advisory renderer settings.
   */
  qualityToRenderer(quality) {
    switch (this._normQuality(quality)) {
      case "low":
        return { pixelRatio: 1 };
      case "medium":
        return { pixelRatio: 1.5 };
      default:
        return { pixelRatio: 2 };
    }
  }

  /** Sensitivity slider moved: update settings, repaint readout, commit. */
  _onSensitivityInput() {
    const v = parseFloat(this.sensInput.value);
    if (!Number.isFinite(v)) return;
    const s = this._settings();
    s.sensitivity = v;
    if (this.sensValue) this.sensValue.textContent = this._fmtSensitivity(v);
    this._commit(s);
  }

  /** Quality select changed: update settings, commit. */
  _onQualityChange() {
    const s = this._settings();
    s.quality = this._normQuality(this.qualitySelect.value);
    this._commit(s);
  }

  /**
   * Persist (if a provider is wired) and report the new settings. Both calls are
   * guarded so a throwing provider/listener can never break the pause overlay.
   * @param {object} settings the live settings object (passed through to caller).
   */
  _commit(settings) {
    const prog = this._providers.progression;
    if (prog && typeof prog.save === "function") {
      try {
        prog.save();
      } catch (err) {
        console.warn("[PauseMenu] progression.save threw:", err);
      }
    }
    if (typeof this._onSettingsChange === "function") {
      try {
        this._onSettingsChange(settings);
      } catch (err) {
        console.warn("[PauseMenu] onSettingsChange threw:", err);
      }
    }
  }

  /** Run a handler callback if the caller supplied one. */
  _call(name) {
    const fn = this._handlers[name];
    if (typeof fn === "function") fn();
  }

  // ---- public API ----------------------------------------------------------

  /**
   * Wire button callbacks.
   * @param {{onResume?:Function,onRestart?:Function,onQuit?:Function}} handlers
   */
  setHandlers(handlers = {}) {
    this._handlers = { ...this._handlers, ...handlers };
  }

  /**
   * Inject providers. `progression` is Agent A's Progression instance (or null
   * for standalone tests — settings still apply live, they just don't persist).
   * @param {{progression?: any}} providers
   */
  setProviders(providers = {}) {
    if ("progression" in providers) this._providers.progression = providers.progression;
  }

  /**
   * Register the live-apply callback. Invoked with the full settings object
   * (`{sensitivity, quality, muted}`) whenever a control changes so the
   * orchestrator can apply sensitivity → Player and quality → renderer.
   * @param {(settings:object)=>void} fn
   */
  setOnSettingsChange(fn) {
    this._onSettingsChange = typeof fn === "function" ? fn : null;
  }

  /** Re-sync the controls from the current persisted settings. */
  refresh() {
    const s = this._settings();
    if (this.sensInput) this.sensInput.value = String(s.sensitivity);
    if (this.sensValue) this.sensValue.textContent = this._fmtSensitivity(s.sensitivity);
    if (this.qualitySelect) this.qualitySelect.value = this._normQuality(s.quality);
  }

  /** Show the overlay (re-reading current settings) and make it interactive. */
  show() {
    this.refresh();
    this.root.classList.remove(`${PREFIX}hidden`);
  }

  /** Hide the overlay. */
  hide() {
    this.root.classList.add(`${PREFIX}hidden`);
  }

  /** Tear down: remove the DOM and the injected style block. */
  dispose() {
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    const style = document.getElementById(`${PREFIX}style`);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }
}

export default PauseMenu;
