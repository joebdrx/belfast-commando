import gameState from "./GameState.js";
import UPGRADES from "../data/upgrades.json";
import BOOTS from "../data/boots.json";
import DIALOGUE from "../data/dialogue.json";
import LEVELS from "../data/levels.json";

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

/**
 * Desktop (Tauri) build download. The native installers are published to the
 * repo's GitHub Releases by the `release` CI workflow (.github/workflows/release.yml);
 * `releases/latest/download/<asset>` always resolves to the newest release.
 * Filenames follow Tauri's default bundle naming for productName
 * `belfast-commando` v0.1.0 — bump the version here when tauri.conf.json changes.
 */
const DESKTOP_BUILD = {
  baseUrl: "https://github.com/joebdrx/belfast-commando/releases/latest/download/",
  releasesPage: "https://github.com/joebdrx/belfast-commando/releases/latest",
  assets: {
    windows: "belfast-commando_0.1.0_x64-setup.exe",
    macos: "belfast-commando_0.1.0_universal.dmg",
    linux: "belfast-commando_0.1.0_amd64.AppImage",
  },
  labels: { windows: "Windows (.exe)", macos: "macOS (.dmg)", linux: "Linux (.AppImage)" },
};

/** Static lookups so the Upgrades panel can backfill any field the provider omits. */
const UPGRADES_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));
const BOOTS_BY_ID = Object.fromEntries(BOOTS.map((b) => [b.id, b]));

export class Menu {
  constructor() {
    /** @type {{onStartOperation?:Function,onUpgrades?:Function,onStoryLogs?:Function,onExit?:Function,onCodeAccepted?:Function}} */
    this._handlers = {};
    /** @type {{progression: any|null, levelManager: any|null}} */
    this._providers = { progression: null, levelManager: null };
    /** Which view is showing: "main" | "upgrades" | "story". */
    this._view = "main";
    /** Landline dial state. */
    this._dialEntry = "";
    this._dialCloseTimer = null;

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
        pointer-events: none; /* right side stays clickable → hub 3D shows through */
        font-family: "Arial Narrow", "Inter", system-ui, sans-serif;
        color: #f0ede8;
      }
      .${PREFIX}root.${PREFIX}hidden { display: none; }
      /* LEFT vertical command panel; the right ~60% is transparent so the hub
         hero model reads behind it (CoD-lobby framing). */
      .${PREFIX}panel {
        pointer-events: auto;
        position: absolute; top: 0; left: 0; bottom: 0;
        width: 40%; min-width: 326px; max-width: 468px;
        display: flex; flex-direction: column;
        padding: 46px 40px 36px;
        overflow-y: auto;
        background: linear-gradient(100deg,
          rgba(8,9,11,0.97) 0%, rgba(9,11,13,0.95) 68%, rgba(11,13,15,0.58) 100%);
        border-right: 1px solid rgba(255,122,26,0.20);
        box-shadow: 26px 0 70px rgba(0,0,0,0.6);
      }
      /* Far-left amber stencil stripe for the gritty operations-board look. */
      .${PREFIX}panel::before {
        content: ""; position: absolute; top: 0; left: 0; bottom: 0; width: 4px;
        background: linear-gradient(#ff7a1a, rgba(255,122,26,0.15));
      }
      .${PREFIX}kicker {
        font-size: 11px; font-weight: 800; letter-spacing: 0.34em;
        text-transform: uppercase; color: rgba(255,122,26,0.85); margin-bottom: 6px;
      }
      .${PREFIX}title {
        font-size: 30px; font-weight: 900; letter-spacing: 0.08em;
        text-transform: uppercase; color: #ff7a1a; line-height: 1.04;
        text-shadow: 0 0 22px rgba(255,122,26,0.5), 0 2px 4px rgba(0,0,0,0.85);
        margin-bottom: 10px;
      }
      .${PREFIX}rp {
        font-size: 13px; font-weight: 800; letter-spacing: 0.16em;
        text-transform: uppercase; color: rgba(240,237,232,0.7);
        margin-bottom: 22px;
        padding-bottom: 18px; border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .${PREFIX}rp b { color: #ff7a1a; font-size: 17px; }
      .${PREFIX}body { display: flex; flex-direction: column; }
      /* Main actions: a clean stacked list filling the panel width. */
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
        background: rgba(255,122,26,0.18); border-color: #ff7a1a;
        border-left-color: #ff7a1a;
      }
      .${PREFIX}btn:active { transform: translateX(2px); }
      .${PREFIX}btn:disabled {
        opacity: 0.4; cursor: not-allowed; border-color: rgba(255,255,255,0.14);
      }
      .${PREFIX}btn:disabled:hover { background: rgba(255,255,255,0.045); }
      .${PREFIX}btn-sm {
        width: auto; flex: 0 0 auto; min-width: 0; padding: 8px 16px;
        font-size: 13px; text-align: center;
      }
      .${PREFIX}sub-title {
        font-size: 21px; font-weight: 900; letter-spacing: 0.08em;
        text-transform: uppercase; color: #ff7a1a; margin-bottom: 16px;
      }
      /* Desktop-download CTA: green accent so it reads apart from the orange ops. */
      .${PREFIX}btnrow + .${PREFIX}btnrow { margin-top: 16px; }
      .${PREFIX}dl {
        border-color: rgba(86,201,123,0.40); border-left-color: rgba(86,201,123,0.70);
        color: #dff5e6;
      }
      .${PREFIX}dl:hover { background: rgba(86,201,123,0.16); border-color: #56c97b; border-left-color: #56c97b; }
      .${PREFIX}dlsub {
        margin-top: 8px; font-size: 12px; letter-spacing: 0.04em;
        color: rgba(240,237,232,0.55);
      }
      .${PREFIX}dllink { color: #8fd6a4; text-decoration: none; border-bottom: 1px dotted rgba(143,214,164,0.5); }
      .${PREFIX}dllink:hover { color: #b6ecc4; }
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
      .${PREFIX}item-meta.${PREFIX}locked b { color: #f85149; }

      /* ---- Landline level-code dial (modal over everything) ---------------- */
      .${PREFIX}dial {
        position: fixed; inset: 0; z-index: 36;
        pointer-events: auto;
        display: flex; align-items: center; justify-content: center;
        font-family: "Arial Narrow", "Inter", system-ui, sans-serif;
        background: radial-gradient(ellipse at center, rgba(4,5,7,0.82) 0%, rgba(2,3,4,0.95) 100%);
      }
      .${PREFIX}dial.${PREFIX}hidden { display: none; }
      .${PREFIX}dialcard {
        position: relative;
        width: 320px; max-width: 92%;
        padding: 26px 26px 24px;
        background: rgba(14,16,18,0.98);
        border: 1px solid rgba(255,122,26,0.30);
        border-top: 2px solid #ff7a1a;
        border-radius: 6px; text-align: center;
        box-shadow: 0 0 70px rgba(0,0,0,0.88), inset 0 1px 0 rgba(255,255,255,0.04);
      }
      .${PREFIX}dialtitle {
        font-size: 18px; font-weight: 900; letter-spacing: 0.10em;
        text-transform: uppercase; color: #ff7a1a; margin-bottom: 4px;
      }
      .${PREFIX}dialhint {
        font-size: 11px; font-weight: 700; letter-spacing: 0.10em;
        text-transform: uppercase; color: rgba(240,237,232,0.45); margin-bottom: 14px;
      }
      .${PREFIX}dialdisplay {
        font-family: "Courier New", "Consolas", monospace;
        font-size: 32px; font-weight: 700; letter-spacing: 0.42em;
        color: #ffc566; padding: 10px 0 8px; min-height: 44px;
        background: rgba(0,0,0,0.45);
        border: 1px solid rgba(255,122,26,0.25); border-radius: 4px;
        margin-bottom: 8px; text-indent: 0.42em;
      }
      .${PREFIX}dialstatus {
        font-size: 11.5px; font-weight: 800; letter-spacing: 0.10em;
        text-transform: uppercase; min-height: 16px; margin-bottom: 14px;
        color: rgba(240,237,232,0.55);
      }
      .${PREFIX}dialstatus.ok { color: #3fb950; }
      .${PREFIX}dialstatus.bad { color: #f85149; }
      .${PREFIX}pad {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px;
      }
      .${PREFIX}key {
        padding: 14px 0;
        font-family: "Courier New", "Consolas", monospace;
        font-size: 19px; font-weight: 800; color: #f0ede8; cursor: pointer;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,122,26,0.30);
        border-radius: 4px;
        transition: background 0.12s ease, border-color 0.12s ease, transform 0.05s ease;
      }
      .${PREFIX}key:hover { background: rgba(255,122,26,0.20); border-color: #ff7a1a; }
      .${PREFIX}key:active { transform: translateY(1px); }
      .${PREFIX}key-fn {
        font-family: inherit; font-size: 13px; font-weight: 800;
        letter-spacing: 0.08em; text-transform: uppercase;
      }
      .${PREFIX}key-enter { color: #0b0c0d; background: #ff7a1a; border-color: #ff7a1a; }
      .${PREFIX}key-enter:hover { background: #ffa24d; }
      .${PREFIX}dialclose { margin-top: 14px; }
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

  /** Build the root, left panel, title, RP readout, the action list and the sub-view host. */
  _buildDom() {
    this.root = this._el("div", `${PREFIX}root`);

    // The left command panel; the right side of the root is transparent so the
    // hub hero model renders behind the menu.
    this.panel = this._el("div", `${PREFIX}panel`);
    this.root.appendChild(this.panel);

    this.panel.appendChild(this._el("div", `${PREFIX}kicker`, "// Belfast Commando"));
    this.title = this._el("div", `${PREFIX}title`, "Safehouse");
    this.panel.appendChild(this.title);

    this.rpReadout = this._el("div", `${PREFIX}rp`);
    this.panel.appendChild(this.rpReadout);

    // Body host — swapped between the main actions and the sub-panels.
    this.body = this._el("div", `${PREFIX}body`);
    this.panel.appendChild(this.body);

    this._renderMain();
    document.body.appendChild(this.root);

    // The landline level-code dial (independent modal, hidden until opened).
    this._buildDialDom();
  }

  /** Build the number-pad dial modal (a separate root appended to the body). */
  _buildDialDom() {
    this.dialRoot = this._el("div", `${PREFIX}dial ${PREFIX}hidden`);
    const card = this._el("div", `${PREFIX}dialcard`);
    this.dialRoot.appendChild(card);

    card.appendChild(this._el("div", `${PREFIX}dialtitle`, "Operation Line"));
    card.appendChild(this._el("div", `${PREFIX}dialhint`, "Dial a 4-digit operation code"));

    this.dialDisplay = this._el("div", `${PREFIX}dialdisplay`);
    card.appendChild(this.dialDisplay);

    this.dialStatus = this._el("div", `${PREFIX}dialstatus`);
    card.appendChild(this.dialStatus);

    const pad = this._el("div", `${PREFIX}pad`);
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
    for (const k of keys) {
      pad.appendChild(this._makeKey(k, () => this._dialPush(k)));
    }
    pad.appendChild(this._makeKey("CLR", () => this._dialClear(), "fn"));
    pad.appendChild(this._makeKey("0", () => this._dialPush("0")));
    pad.appendChild(this._makeKey("ENTER", () => this._dialSubmit(), "enter"));
    card.appendChild(pad);

    const closeRow = this._el("div", `${PREFIX}dialclose`);
    closeRow.appendChild(this._makeButton("◂ Hang Up", () => this.closeDial(), true));
    card.appendChild(closeRow);

    // Physical-keyboard support while the dial is open (bound on open).
    this._dialKeyHandler = (e) => this._onDialKey(e);

    document.body.appendChild(this.dialRoot);
  }

  /** Build a keypad key. `kind` = "" | "fn" | "enter". */
  _makeKey(label, onClick, kind = "") {
    let cls = `${PREFIX}key`;
    if (kind === "fn") cls += ` ${PREFIX}key-fn`;
    else if (kind === "enter") cls += ` ${PREFIX}key-fn ${PREFIX}key-enter`;
    const btn = this._el("button", cls, label);
    btn.type = "button";
    btn.addEventListener("click", onClick);
    return btn;
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
    row.appendChild(this._makeButton("Arsenal & Upgrades", () => {
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

    // Desktop (Tauri) build download — shown only in the BROWSER (it's pointless
    // inside the native app). Auto-targets the visitor's OS; other platforms below.
    if (!this._inTauri()) {
      const os = this._detectOS();
      const dlRow = this._el("div", `${PREFIX}btnrow`);
      const dl = this._makeButton(`⬇ Download Desktop Version — ${DESKTOP_BUILD.labels[os]}`, () => this._downloadDesktop());
      dl.classList.add(`${PREFIX}dl`);
      dlRow.appendChild(dl);
      this.body.appendChild(dlRow);

      const sub = this._el("div", `${PREFIX}dlsub`);
      sub.appendChild(this._el("span", null, "Other platforms: "));
      const others = Object.keys(DESKTOP_BUILD.assets).filter((k) => k !== os);
      others.forEach((k, i) => {
        const a = this._el("a", `${PREFIX}dllink`, DESKTOP_BUILD.labels[k]);
        a.href = `${DESKTOP_BUILD.baseUrl}${DESKTOP_BUILD.assets[k]}`;
        a.setAttribute("download", DESKTOP_BUILD.assets[k]);
        sub.appendChild(a);
        if (i < others.length - 1) sub.appendChild(this._el("span", null, " · "));
      });
      this.body.appendChild(sub);
    }
  }

  /** True when running inside the native Tauri desktop shell (not the browser). */
  _inTauri() {
    return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
  }

  /** Best-guess the visitor's OS for the default download target. */
  _detectOS() {
    const ua = `${navigator.userAgent || ""} ${navigator.platform || ""}`;
    if (/Win/i.test(ua)) return "windows";
    if (/Mac|iPhone|iPad|iPod/i.test(ua)) return "macos";
    return "linux";
  }

  /**
   * Trigger a download of the native build for the given (or detected) OS. The
   * GitHub Release asset is served with an attachment disposition, so it downloads
   * directly; opened in a new tab so it never navigates the game away.
   */
  _downloadDesktop(os = this._detectOS()) {
    const file = DESKTOP_BUILD.assets[os] || DESKTOP_BUILD.assets.linux;
    const a = this._el("a");
    a.href = `${DESKTOP_BUILD.baseUrl}${file}`;
    a.setAttribute("download", file);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /** Arsenal (weapons) + upgrades + boots sub-panel. Degrades gracefully without a provider. */
  _renderUpgrades() {
    this._view = "upgrades";
    this._clearBody();

    this.body.appendChild(this._el("div", `${PREFIX}sub-title`, "Arsenal & Upgrades"));

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

    // --- Arsenal (weapons) ------------------------------------------------
    if (typeof prog.listWeapons === "function") {
      this.body.appendChild(this._el("div", `${PREFIX}section-label`, "Arsenal"));
      // Transient buy-feedback line (e.g. "Need a prerequisite" / "Not enough RP").
      this._arsenalMsg = this._el("div", `${PREFIX}item-meta`);
      this._arsenalMsg.style.minHeight = "14px";
      this._arsenalMsg.style.margin = "0 0 4px";
      this.body.appendChild(this._arsenalMsg);

      const weapons = this._safeArray(() => prog.listWeapons());
      const nameById = Object.fromEntries(weapons.map((w) => [w.id, w.name]));
      const wList = this._el("div", `${PREFIX}list`);
      for (const w of weapons) {
        wList.appendChild(this._weaponRow(w, prog, nameById));
      }
      this.body.appendChild(wList);
    }

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

  /**
   * A single weapon row. OWNED → ✓ badge + disabled; locked (prereq unmet) →
   * "Requires <prereq>" + disabled; affordable → a Buy button; else Buy disabled.
   * @param {object} w a `prog.listWeapons()` entry.
   * @param {object} prog the Progression provider.
   * @param {Record<string,string>} nameById id → display name (for prereq labels).
   */
  _weaponRow(w, prog, nameById) {
    const item = this._el("div", `${PREFIX}item`);

    const main = this._el("div", `${PREFIX}item-main`);
    const name = this._el("div", `${PREFIX}item-name`, w.name);
    if (w.owned) {
      name.appendChild(this._el("span", `${PREFIX}eq`, "✓ OWNED"));
    }
    main.appendChild(name);
    main.appendChild(this._el("div", `${PREFIX}item-desc`, w.desc || ""));

    const meta = this._el("div", `${PREFIX}item-meta`);
    if (w.owned) {
      meta.innerHTML = w.cost > 0 ? "In your locker" : "Standard issue";
    } else if (w.locked) {
      meta.classList.add(`${PREFIX}locked`);
      const prereq = (w.requires && nameById[w.requires]) || w.requires || "a prior weapon";
      meta.innerHTML = `Locked · Requires <b>${prereq}</b>`;
    } else {
      meta.innerHTML = `Cost <b>${w.cost} RP</b>`;
    }
    main.appendChild(meta);
    item.appendChild(main);

    let label;
    let disabled;
    if (w.owned) {
      label = "Owned";
      disabled = true;
    } else if (w.locked) {
      label = "Locked";
      disabled = true;
    } else {
      label = "Buy";
      disabled = !w.affordable;
    }
    const btn = this._makeButton(label, () => this._buyWeapon(prog, w.id), true);
    btn.disabled = disabled;
    item.appendChild(btn);
    return item;
  }

  /**
   * Attempt a weapon purchase. On success, refresh RP + the panel; on failure,
   * surface the reason briefly in the arsenal message line.
   */
  _buyWeapon(prog, id) {
    let res;
    try {
      res = prog.buyWeapon(id);
    } catch (err) {
      console.warn("[Menu] progression.buyWeapon threw:", err);
      return;
    }
    if (res && res.ok) {
      this._afterPurchase();
    } else {
      const reason = (res && res.reason) || "unknown";
      const msg = {
        broke: "Not enough Resistance Points",
        locked: "Buy the prerequisite weapon first",
        owned: "Already in your locker",
        unknown: "Unavailable",
      }[reason] || "Unavailable";
      if (this._arsenalMsg) {
        this._arsenalMsg.classList.add(`${PREFIX}locked`);
        this._arsenalMsg.innerHTML = `⚠ <b>${msg}</b>`;
      }
    }
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

  /** Run a handler callback if the caller supplied one (forwarding any args). */
  _call(name, ...args) {
    const fn = this._handlers[name];
    if (typeof fn === "function") fn(...args);
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

  // ---- landline level-code dial -------------------------------------------

  /** Repaint the masked 4-slot display from the current entry. */
  _renderDialDisplay() {
    if (!this.dialDisplay) return;
    const slots = (this._dialEntry + "————").slice(0, 4);
    this.dialDisplay.textContent = slots.split("").join(" ");
  }

  /** Set the dial status line. `kind` = "" | "ok" | "bad". */
  _setDialStatus(text, kind = "") {
    if (!this.dialStatus) return;
    this.dialStatus.textContent = text || "";
    this.dialStatus.className = `${PREFIX}dialstatus${kind ? ` ${kind}` : ""}`;
  }

  /** Append a digit (max 4), clearing any prior result message. */
  _dialPush(d) {
    if (this._dialCloseTimer) return; // locked while a confirmation is animating
    if (this._dialEntry.length >= 4) return;
    this._dialEntry += d;
    this._setDialStatus("");
    this._renderDialDisplay();
  }

  /** Clear the entry. */
  _dialClear() {
    if (this._dialCloseTimer) return;
    this._dialEntry = "";
    this._setDialStatus("");
    this._renderDialDisplay();
  }

  /** Validate the entered code against the LevelManager and confirm/deny. */
  _dialSubmit() {
    if (this._dialCloseTimer) return;
    const code = this._dialEntry;
    if (code.length < 4) {
      this._setDialStatus("Enter all 4 digits", "bad");
      return;
    }
    const lm = this._providers.levelManager;
    const index = lm && typeof lm.indexForCode === "function" ? lm.indexForCode(code) : -1;
    if (index >= 0) {
      const name = this._levelName(index);
      this._setDialStatus(`Code accepted — Operation ${name}`, "ok");
      this._call("onCodeAccepted", index);
      // Auto-close after the player reads the confirmation.
      this._dialCloseTimer = setTimeout(() => {
        this._dialCloseTimer = null;
        this.closeDial();
      }, 1200);
    } else {
      this._setDialStatus("Invalid code", "bad");
    }
  }

  /** Display name for a campaign index (from levels.json). */
  _levelName(index) {
    const entry = LEVELS[index];
    return (entry && entry.name) ? entry.name : `Sector ${index + 1}`;
  }

  /** Keyboard support for the open dial (digits / Backspace / Enter / Escape). */
  _onDialKey(e) {
    if (e.key >= "0" && e.key <= "9") {
      this._dialPush(e.key);
      e.preventDefault();
    } else if (e.key === "Backspace") {
      if (!this._dialCloseTimer) {
        this._dialEntry = this._dialEntry.slice(0, -1);
        this._setDialStatus("");
        this._renderDialDisplay();
      }
      e.preventDefault();
    } else if (e.key === "Enter") {
      this._dialSubmit();
      e.preventDefault();
    } else if (e.key === "Escape") {
      this.closeDial();
      e.preventDefault();
    }
  }

  // ---- public API ----------------------------------------------------------

  /** Show the menu (resets to the main view) and make it interactive. */
  show() {
    this._renderMain();
    this._updateRp();
    this.root.classList.remove(`${PREFIX}hidden`);
  }

  /** Hide the menu (and any open dial). */
  hide() {
    this.closeDial();
    this.root.classList.add(`${PREFIX}hidden`);
  }

  /** Open the Arsenal & Upgrades sub-panel directly (e.g. from the 3D crate). */
  openUpgrades() {
    this._renderUpgrades();
  }

  /** Open the landline level-code dial modal (e.g. from the 3D wall phone). */
  openDial() {
    if (!this.dialRoot) return;
    if (this._dialCloseTimer) {
      clearTimeout(this._dialCloseTimer);
      this._dialCloseTimer = null;
    }
    this._dialEntry = "";
    this._renderDialDisplay();
    this._setDialStatus("");
    this.dialRoot.classList.remove(`${PREFIX}hidden`);
    if (typeof document !== "undefined") {
      document.addEventListener("keydown", this._dialKeyHandler, true);
    }
  }

  /** Close the dial modal and unbind its keyboard handler. */
  closeDial() {
    if (!this.dialRoot) return;
    if (this._dialCloseTimer) {
      clearTimeout(this._dialCloseTimer);
      this._dialCloseTimer = null;
    }
    this.dialRoot.classList.add(`${PREFIX}hidden`);
    if (typeof document !== "undefined") {
      document.removeEventListener("keydown", this._dialKeyHandler, true);
    }
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
   * for standalone tests); `levelManager` powers the level-code dial. If the
   * Upgrades panel is open, re-render it.
   * @param {{progression?: any, levelManager?: any}} providers
   */
  setProviders(providers = {}) {
    if ("progression" in providers) this._providers.progression = providers.progression;
    if ("levelManager" in providers) this._providers.levelManager = providers.levelManager;
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
    this.closeDial();
    if (this._unsubCurrency) this._unsubCurrency();
    this._unsubCurrency = null;
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    if (this.dialRoot && this.dialRoot.parentNode) this.dialRoot.parentNode.removeChild(this.dialRoot);
    const style = document.getElementById(`${PREFIX}style`);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }
}
