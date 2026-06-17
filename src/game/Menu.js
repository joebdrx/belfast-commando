import gameState from "./GameState.js";
import UPGRADES from "../data/upgrades.json";
import BOOTS from "../data/boots.json";
import DIALOGUE from "../data/dialogue.json";

/**
 * Menu
 * ----
 * The safehouse HTML/CSS overlay menu for GamePhase "HUB". Built ENTIRELY in JS
 * (a root <div> appended to document.body + an injected, class-prefixed <style>
 * block) so it never touches index.html or styles.css, yet reuses the existing
 * overlay's visual language (dark card, light text, amber accent, condensed
 * type) so it feels native.
 *
 * Responsibilities:
 *   - Title + a live "Resistance Points" readout (read from the GameState
 *     singleton; also auto-refreshed on the bus "currency" event).
 *   - A row of actions: Start Operation, Upgrades, Story Logs, Exit, wired to
 *     caller-supplied handlers via setHandlers().
 *   - Upgrades sub-panel: renders buyable upgrades + boots from an injected
 *     Progression provider (setProviders); degrades to a graceful placeholder
 *     when no provider is set so the menu still works standalone.
 *   - Story Logs sub-panel: shows dialogue.json snippets whose `requires` gate
 *     is satisfied by the current progression.
 *
 * Cross-module talk follows CONTRACTS.md: RP comes from the GameState singleton;
 * upgrade/boot mutation goes through the injected Progression instance.
 */

const PREFIX = "bc-menu-";

/** Static lookups so the Upgrades panel can backfill any field the provider omits. */
const UPGRADES_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));
const BOOTS_BY_ID = Object.fromEntries(BOOTS.map((b) => [b.id, b]));

export class Menu {
  constructor() {
    /** @type {{onStartOperation?:Function,onUpgrades?:Function,onStoryLogs?:Function,onExit?:Function}} */
    this._handlers = {};
    /** @type {{progression: any|null}} */
    this._providers = { progression: null };
    /** Which view is showing: "main" | "upgrades" | "story". */
    this._view = "main";

    this._injectStyle();
    this._buildDom();

    // Keep the RP readout live without polling.
    this._unsubCurrency = gameState.on("currency", () => this._updateRp());
    this._updateRp();
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
        position: fixed; inset: 0; z-index: 30;
        display: flex; align-items: center; justify-content: center;
        pointer-events: auto;
        font-family: "Arial Narrow", "Inter", system-ui, sans-serif;
        color: #f0ede8;
        background:
          radial-gradient(ellipse at center, rgba(8,10,13,0.62) 0%, rgba(3,4,6,0.9) 100%);
      }
      .${PREFIX}root.${PREFIX}hidden { display: none; }
      .${PREFIX}card {
        max-width: 640px; width: 92%;
        max-height: 88vh; overflow-y: auto;
        padding: 38px 46px;
        background: rgba(14,16,18,0.94);
        border: 1px solid rgba(255,122,26,0.28);
        border-top: 2px solid #ff7a1a;
        border-radius: 4px; text-align: center;
        box-shadow: 0 0 80px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.04);
      }
      .${PREFIX}title {
        font-size: 34px; font-weight: 900; letter-spacing: 0.10em;
        text-transform: uppercase; color: #ff7a1a; line-height: 1.05;
        text-shadow: 0 0 22px rgba(255,122,26,0.5), 0 2px 4px rgba(0,0,0,0.85);
        margin-bottom: 8px;
      }
      .${PREFIX}rp {
        font-size: 14px; font-weight: 800; letter-spacing: 0.16em;
        text-transform: uppercase; color: rgba(240,237,232,0.7);
        margin-bottom: 24px;
      }
      .${PREFIX}rp b { color: #ff7a1a; font-size: 18px; }
      .${PREFIX}btnrow {
        display: flex; flex-wrap: wrap; gap: 12px; justify-content: center;
      }
      .${PREFIX}btn {
        flex: 1 1 40%; min-width: 150px;
        padding: 14px 18px;
        font-family: inherit; font-size: 15px; font-weight: 800;
        letter-spacing: 0.10em; text-transform: uppercase;
        color: #f0ede8; cursor: pointer;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,122,26,0.35);
        border-radius: 4px;
        transition: background 0.14s ease, border-color 0.14s ease, transform 0.06s ease;
      }
      .${PREFIX}btn:hover { background: rgba(255,122,26,0.18); border-color: #ff7a1a; }
      .${PREFIX}btn:active { transform: translateY(1px); }
      .${PREFIX}btn:disabled {
        opacity: 0.4; cursor: not-allowed; border-color: rgba(255,255,255,0.14);
      }
      .${PREFIX}btn:disabled:hover { background: rgba(255,255,255,0.05); }
      .${PREFIX}btn-sm {
        flex: 0 0 auto; min-width: 0; padding: 8px 16px; font-size: 13px;
      }
      .${PREFIX}sub-title {
        font-size: 22px; font-weight: 900; letter-spacing: 0.10em;
        text-transform: uppercase; color: #ff7a1a; margin-bottom: 18px;
      }
      .${PREFIX}list { display: flex; flex-direction: column; gap: 10px; text-align: left; }
      .${PREFIX}section-label {
        font-size: 12px; font-weight: 800; letter-spacing: 0.18em;
        text-transform: uppercase; color: rgba(240,237,232,0.5);
        margin: 18px 0 4px;
      }
      .${PREFIX}item {
        display: flex; align-items: center; gap: 14px;
        padding: 12px 14px;
        background: rgba(255,255,255,0.035);
        border: 1px solid rgba(255,255,255,0.10);
        border-left: 2px solid rgba(255,122,26,0.5);
        border-radius: 3px;
      }
      .${PREFIX}item-main { flex: 1 1 auto; min-width: 0; }
      .${PREFIX}item-name {
        font-size: 15px; font-weight: 800; letter-spacing: 0.04em; color: #f0ede8;
      }
      .${PREFIX}item-name .${PREFIX}eq {
        color: #3fb950; font-size: 11px; font-weight: 800;
        letter-spacing: 0.10em; margin-left: 8px;
      }
      .${PREFIX}item-desc {
        font-size: 12.5px; line-height: 1.45; color: rgba(240,237,232,0.6); margin-top: 2px;
      }
      .${PREFIX}item-meta {
        font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
        text-transform: uppercase; color: rgba(240,237,232,0.45); margin-top: 4px;
      }
      .${PREFIX}item-meta b { color: #ffc566; }
      .${PREFIX}story {
        padding: 14px 16px; text-align: left;
        background: rgba(255,255,255,0.035);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 3px;
      }
      .${PREFIX}story-head {
        display: flex; align-items: center; gap: 10px; margin-bottom: 8px;
      }
      .${PREFIX}speaker { font-size: 15px; font-weight: 900; letter-spacing: 0.05em; }
      .${PREFIX}faction {
        font-size: 10px; font-weight: 800; letter-spacing: 0.14em;
        text-transform: uppercase; padding: 2px 8px; border-radius: 3px; color: #0b0c0d;
      }
      .${PREFIX}faction.ira { background: #2f9e44; }
      .${PREFIX}faction.ulster { background: #e07b1a; }
      .${PREFIX}line {
        font-size: 13.5px; line-height: 1.5; color: rgba(240,237,232,0.82);
        font-style: italic;
      }
      .${PREFIX}line::before { content: "“"; }
      .${PREFIX}line::after { content: "”"; }
      .${PREFIX}empty {
        font-size: 13px; color: rgba(240,237,232,0.5); line-height: 1.6; padding: 8px 0;
      }
      .${PREFIX}back { margin-top: 22px; }
    `;
    document.head.appendChild(style);
  }

  /** Helper: create an element with optional class + text/html. */
  _el(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  /** Build the root, card, title, RP readout, the main button row and the sub-view host. */
  _buildDom() {
    this.root = this._el("div", `${PREFIX}root`);

    this.card = this._el("div", `${PREFIX}card`);
    this.root.appendChild(this.card);

    this.title = this._el("div", `${PREFIX}title`, "Belfast Commando — Safehouse");
    this.card.appendChild(this.title);

    this.rpReadout = this._el("div", `${PREFIX}rp`);
    this.card.appendChild(this.rpReadout);

    // Body host — swapped between the main buttons and the sub-panels.
    this.body = this._el("div", `${PREFIX}body`);
    this.card.appendChild(this.body);

    this._renderMain();
    document.body.appendChild(this.root);
  }

  // ---- views ---------------------------------------------------------------

  /** Clear the swappable body host. */
  _clearBody() {
    this.body.replaceChildren();
  }

  /** The main menu: the four primary actions. */
  _renderMain() {
    this._view = "main";
    this._clearBody();

    const row = this._el("div", `${PREFIX}btnrow`);
    row.appendChild(this._makeButton("Start Operation", () => {
      this._call("onStartOperation");
    }));
    row.appendChild(this._makeButton("Upgrades", () => {
      this._call("onUpgrades");
      this._renderUpgrades();
    }));
    row.appendChild(this._makeButton("Story Logs", () => {
      this._call("onStoryLogs");
      this._renderStory();
    }));
    row.appendChild(this._makeButton("Exit", () => {
      this._call("onExit");
    }));
    this.body.appendChild(row);
  }

  /** Upgrades + boots sub-panel. Degrades gracefully without a provider. */
  _renderUpgrades() {
    this._view = "upgrades";
    this._clearBody();

    this.body.appendChild(this._el("div", `${PREFIX}sub-title`, "Upgrades & Boots"));

    const prog = this._providers.progression;
    if (!prog || typeof prog.listUpgrades !== "function") {
      const empty = this._el(
        "div",
        `${PREFIX}empty`,
        "Progression unavailable — connect a quartermaster to spend your Resistance Points.",
      );
      this.body.appendChild(empty);
      this.body.appendChild(this._makeBackRow());
      return;
    }

    const rp = this._rp();

    // --- Upgrades ---------------------------------------------------------
    this.body.appendChild(this._el("div", `${PREFIX}section-label`, "Upgrades"));
    const upList = this._el("div", `${PREFIX}list`);
    const upgrades = this._safeArray(() => prog.listUpgrades());
    for (const raw of upgrades) {
      upList.appendChild(this._upgradeRow(this._normUpgrade(raw, rp), prog));
    }
    this.body.appendChild(upList);

    // --- Boots ------------------------------------------------------------
    this.body.appendChild(this._el("div", `${PREFIX}section-label`, "Boots"));
    const bootList = this._el("div", `${PREFIX}list`);
    const boots = this._safeArray(() => (prog.listBoots ? prog.listBoots() : []));
    for (const raw of boots) {
      bootList.appendChild(this._bootRow(this._normBoot(raw, rp), prog));
    }
    this.body.appendChild(bootList);

    this.body.appendChild(this._makeBackRow());
  }

  /** Story Logs sub-panel: only snippets unlocked by current progression. */
  _renderStory() {
    this._view = "story";
    this._clearBody();

    this.body.appendChild(this._el("div", `${PREFIX}sub-title`, "Story Logs"));

    const prog = gameState.getProgression();
    const unlocked = DIALOGUE.filter((d) => this._meetsRequirement(d.requires, prog));

    if (!unlocked.length) {
      this.body.appendChild(this._el(
        "div",
        `${PREFIX}empty`,
        "No transmissions yet. Clear a sector to loosen tongues in the safehouse.",
      ));
      this.body.appendChild(this._makeBackRow());
      return;
    }

    const list = this._el("div", `${PREFIX}list`);
    for (const snip of unlocked) {
      list.appendChild(this._storyRow(snip));
    }
    this.body.appendChild(list);
    this.body.appendChild(this._makeBackRow());
  }

  // ---- row builders --------------------------------------------------------

  /** A single upgrade row with a context-aware Buy button. */
  _upgradeRow(u, prog) {
    const item = this._el("div", `${PREFIX}item`);

    const main = this._el("div", `${PREFIX}item-main`);
    main.appendChild(this._el("div", `${PREFIX}item-name`, u.name));
    main.appendChild(this._el("div", `${PREFIX}item-desc`, u.desc));
    const meta = this._el("div", `${PREFIX}item-meta`);
    if (u.maxed) {
      meta.innerHTML = `Lv <b>${u.level}/${u.maxLevel}</b> · MAXED`;
    } else {
      meta.innerHTML = `Lv <b>${u.level}/${u.maxLevel}</b> · Next <b>${u.nextCost} RP</b>`;
    }
    main.appendChild(meta);
    item.appendChild(main);

    const btn = this._makeButton(
      u.maxed ? "Maxed" : "Buy",
      () => {
        if (this._invoke(prog, "buyUpgrade", u.id)) this._afterPurchase();
      },
      true,
    );
    btn.disabled = u.maxed || !u.affordable;
    item.appendChild(btn);
    return item;
  }

  /** A single boot row: Buy if unowned/affordable, Equip if owned, Equipped if active. */
  _bootRow(b, prog) {
    const item = this._el("div", `${PREFIX}item`);

    const main = this._el("div", `${PREFIX}item-main`);
    const name = this._el("div", `${PREFIX}item-name`, b.name);
    if (b.equipped) {
      const eq = this._el("span", `${PREFIX}eq`, "EQUIPPED");
      name.appendChild(eq);
    }
    main.appendChild(name);
    main.appendChild(this._el("div", `${PREFIX}item-desc`, b.desc));
    const meta = this._el("div", `${PREFIX}item-meta`);
    meta.innerHTML = b.owned
      ? `Ability <b>${b.ability}</b> · Owned`
      : `Ability <b>${b.ability}</b> · <b>${b.cost} RP</b>`;
    main.appendChild(meta);
    item.appendChild(main);

    let label, action, disabled;
    if (b.equipped) {
      label = "Equipped";
      action = null;
      disabled = true;
    } else if (b.owned) {
      label = "Equip";
      action = () => {
        if (this._invoke(prog, "equipBoot", b.id)) this._afterPurchase();
      };
      disabled = false;
    } else {
      label = "Buy";
      action = () => {
        if (this._invoke(prog, "buyBoot", b.id)) this._afterPurchase();
      };
      disabled = !b.affordable;
    }
    const btn = this._makeButton(label, action || (() => {}), true);
    btn.disabled = disabled;
    item.appendChild(btn);
    return item;
  }

  /** A single story snippet: speaker, faction badge, lines. */
  _storyRow(snip) {
    const wrap = this._el("div", `${PREFIX}story`);
    const head = this._el("div", `${PREFIX}story-head`);
    head.appendChild(this._el("span", `${PREFIX}speaker`, snip.speaker));
    const faction = this._el(
      "span",
      `${PREFIX}faction ${snip.faction === "ira" ? "ira" : "ulster"}`,
      snip.faction === "ira" ? "IRA" : "Ulster",
    );
    head.appendChild(faction);
    wrap.appendChild(head);
    for (const line of snip.lines || []) {
      wrap.appendChild(this._el("div", `${PREFIX}line`, line));
    }
    return wrap;
  }

  /** A "Back" button row returning to the main menu. */
  _makeBackRow() {
    const row = this._el("div", `${PREFIX}back`);
    const back = this._makeButton("◂ Back", () => this._renderMain(), true);
    row.appendChild(back);
    return row;
  }

  /** Build a styled button; `small` uses the compact variant. */
  _makeButton(label, onClick, small = false) {
    const btn = this._el("button", `${PREFIX}btn${small ? ` ${PREFIX}btn-sm` : ""}`, label);
    btn.type = "button";
    btn.addEventListener("click", onClick);
    return btn;
  }

  // ---- normalisation (defensive against the provider's exact return shape) --

  /**
   * Merge a provider upgrade entry with the canonical JSON def so we can render
   * even if the provider omits name/desc/cost. The provider's level/maxed/
   * affordable win when present; otherwise we derive them from level + RP.
   */
  _normUpgrade(raw, rp) {
    const id = raw && raw.id;
    const def = UPGRADES_BY_ID[id] || {};
    const level = Number.isFinite(raw && raw.level) ? raw.level : 0;
    const maxLevel = Number.isFinite(raw && raw.maxLevel) ? raw.maxLevel : (def.maxLevel || 1);
    const maxed = raw && raw.maxed != null ? !!raw.maxed : level >= maxLevel;
    // Next cost: prefer an explicit field, else a scalar cost, else the JSON
    // cost array indexed by the current level.
    let nextCost = null;
    if (raw && Number.isFinite(raw.nextCost)) nextCost = raw.nextCost;
    else if (raw && typeof raw.cost === "number") nextCost = raw.cost;
    else if (Array.isArray(def.cost)) nextCost = def.cost[level];
    if (!Number.isFinite(nextCost)) nextCost = 0;
    const affordable = raw && raw.affordable != null ? !!raw.affordable : rp >= nextCost;
    return {
      id,
      name: (raw && raw.name) || def.name || id || "Upgrade",
      desc: (raw && raw.desc) || def.desc || "",
      level,
      maxLevel,
      maxed,
      nextCost,
      affordable,
    };
  }

  /** Merge a provider boot entry with the canonical JSON def (same strategy). */
  _normBoot(raw, rp) {
    const id = raw && raw.id;
    const def = BOOTS_BY_ID[id] || {};
    const cost = Number.isFinite(raw && raw.cost) ? raw.cost : (def.cost || 0);
    const owned = raw && raw.owned != null ? !!raw.owned : false;
    const equipped = raw && raw.equipped != null ? !!raw.equipped : false;
    const affordable = raw && raw.affordable != null ? !!raw.affordable : rp >= cost;
    return {
      id,
      name: (raw && raw.name) || def.name || id || "Boots",
      desc: (raw && raw.desc) || def.desc || "",
      ability: (raw && raw.ability) || def.ability || "none",
      cost,
      owned,
      equipped,
      affordable,
    };
  }

  /**
   * Gate helper: every key of `requires` must be satisfied by `progression`.
   * Numeric requirements use `>=` (e.g. unlockedLevels); others use equality.
   */
  _meetsRequirement(requires, progression) {
    if (!requires) return true;
    for (const key of Object.keys(requires)) {
      const need = requires[key];
      const have = progression ? progression[key] : undefined;
      if (typeof need === "number") {
        if (!(typeof have === "number" && have >= need)) return false;
      } else if (have !== need) {
        return false;
      }
    }
    return true;
  }

  // ---- helpers -------------------------------------------------------------

  /** Current Resistance Points, read live from the GameState singleton. */
  _rp() {
    const prog = gameState.getProgression();
    return prog && Number.isFinite(prog.resistancePoints) ? prog.resistancePoints : 0;
  }

  /** Repaint the RP readout from the singleton. */
  _updateRp() {
    if (!this.rpReadout) return;
    this.rpReadout.innerHTML = `Resistance Points: <b>${this._rp()}</b>`;
  }

  /** Run a handler callback if the caller supplied one. */
  _call(name) {
    const fn = this._handlers[name];
    if (typeof fn === "function") fn();
  }

  /** Call a provider method defensively; returns its (truthy) result or false. */
  _invoke(prog, method, ...args) {
    if (!prog || typeof prog[method] !== "function") return false;
    try {
      const r = prog[method](...args);
      return r === undefined ? true : r; // undefined → treat as "did something"
    } catch (err) {
      console.warn(`[Menu] progression.${method} threw:`, err);
      return false;
    }
  }

  /** Evaluate a provider list getter defensively, always returning an array. */
  _safeArray(fn) {
    try {
      const r = fn();
      return Array.isArray(r) ? r : [];
    } catch (err) {
      console.warn("[Menu] provider list getter threw:", err);
      return [];
    }
  }

  /** After a buy/equip: refresh RP and re-render the upgrades panel in place. */
  _afterPurchase() {
    this._updateRp();
    this._renderUpgrades();
  }

  // ---- public API ----------------------------------------------------------

  /** Show the menu (resets to the main view) and make it interactive. */
  show() {
    this._renderMain();
    this._updateRp();
    this.root.classList.remove(`${PREFIX}hidden`);
  }

  /** Hide the menu. */
  hide() {
    this.root.classList.add(`${PREFIX}hidden`);
  }

  /**
   * Wire button callbacks.
   * @param {{onStartOperation?:Function,onUpgrades?:Function,onStoryLogs?:Function,onExit?:Function}} handlers
   */
  setHandlers(handlers = {}) {
    this._handlers = { ...this._handlers, ...handlers };
  }

  /**
   * Inject providers. `progression` is Agent A's Progression instance (or null
   * for standalone tests). If the Upgrades panel is open, re-render it.
   * @param {{progression?: any}} providers
   */
  setProviders(providers = {}) {
    if ("progression" in providers) this._providers.progression = providers.progression;
    if (this._view === "upgrades") this._renderUpgrades();
  }

  /** Re-read RP + unlocked content and repaint whichever view is open. */
  refresh() {
    this._updateRp();
    if (this._view === "upgrades") this._renderUpgrades();
    else if (this._view === "story") this._renderStory();
  }

  /** Tear down: remove the DOM, the style block, and the bus subscription. */
  dispose() {
    if (this._unsubCurrency) this._unsubCurrency();
    this._unsubCurrency = null;
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    const style = document.getElementById(`${PREFIX}style`);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }
}
