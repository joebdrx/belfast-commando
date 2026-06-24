import gameState from "./GameState.js";
import { WEAPONS } from "./Weapon.js";

/**
 * ShopTerminal
 * ------------
 * The black-market arms board, rendered as a fullscreen DOM overlay styled like a
 * seized CRT laptop terminal on the dark web ("THE FALLS ROAD"). The camera has
 * already dollied into the in-world laptop screen by the time open() is called,
 * so THIS overlay *is* that screen.
 *
 * Built ENTIRELY in JS (a root <div> on document.body + a single id-guarded,
 * class-prefixed <style> block) so it never touches index.html or styles.css. It
 * mounts LAZILY on the first open() — importing the module touches no DOM, so it
 * stays safe in a headless/Node test environment (it only imports the pure
 * GameState singleton + the WEAPONS stat table). open()/close() are the only
 * methods that run real DOM/animation code, and they only ever run in-browser.
 *
 * Currency + listings follow CONTRACTS.md: the live "Resistance Points" balance is
 * read from the GameState singleton (shown as an escrow crypto wallet); all
 * buy/equip mutation goes through the injected `progression` provider, every call
 * of which is guarded so a null provider (or a missing method) degrades to an
 * empty-but-styled screen and never throws.
 */

const PREFIX = "bc-shop-";

/** Weapon stat lookup by id — listWeapons() omits raw stats, so the DMG/RPM/MAG strip comes from here. */
const WEAPON_STATS = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));

/** Category tabs: stable key + ASCII label (counts are appended live). */
const TABS = [
  { key: "weapons", label: "HARDWARE" },
  { key: "upgrades", label: "WETWORK MODS" },
  { key: "boots", label: "FOOTWORK" },
];
const TAB_LABEL = Object.fromEntries(TABS.map((t) => [t.key, t.label]));

/** Boot-log copy streamed line-by-line on power-on (last line flips amber→green). */
const BOOT_LINES = [
  "BELFAST-OS v7.2 (codename: BOGSIDE)",
  "> mounting /dev/rootkit ... ok",
  "> routing through 7 relays ........ ok",
  "> PGP handshake with quartermaster ... TRUSTED",
  "> wallet unlocked · escrow online",
  "[ connection established — welcome back, volunteer ]",
];

/** Transient footer chatter for successful transactions. */
const BUY_MSG = "> tx broadcast ... 1 confirmation ... package dispatched. tell no one.";
const EQUIP_MSG = "> loadout updated. mind how you go.";
const DISCONNECT_MSG = "> wiping session ... this conversation never happened.";

/** reason → {text, kind} footer notice copy for a refused buy/equip. */
const TX_ERRORS = {
  broke: { text: "> insufficient escrow. come back when you've earned it, son.", kind: "err" },
  locked: { text: "> locked. vouch for the prerequisite hardware first.", kind: "err" },
  owned: { text: "> already in your locker — nothing to sell you there.", kind: "warn" },
  notOwned: { text: "> you don't own those yet. buy them first.", kind: "err" },
  maxed: { text: "> nothing left to sell you here.", kind: "warn" },
  unknown: { text: "> tx rejected by the relay. try again.", kind: "err" },
};

export class ShopTerminal {
  /**
   * @param {{progression?: any}} [opts] the progression provider (may be set
   *   later via setProvider). Construction touches NO DOM — the terminal mounts
   *   lazily on the first open().
   */
  constructor({ progression } = {}) {
    this._progression = progression || null;
    /** @type {(()=>void)|null} fired AFTER the power-off animation completes. */
    this._onClose = null;
    this._open = false;
    this._closing = false;
    this._mounted = false;
    /** Active category: "weapons" | "upgrades" | "boots". */
    this._tab = "weapons";
    /** Outstanding power/boot-log timers, cleared on close() so nothing fires after teardown. */
    this._timers = [];
    /** @type {(()=>({left,top,width,height}|null))|null} when set, the terminal is
     *  laid over the laptop screen (embedded mode) instead of full-screen. */
    this._rectProvider = null;
    // Re-project on resize, but on the NEXT frame so the engine's own resize
    // handler updates the camera aspect first (else the rect lags one resize).
    this._onResize = () => {
      if (!this._open) return;
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => { if (this._open) this._applyRect(); });
      else this._applyRect();
    };
    if (typeof window !== "undefined") window.addEventListener("resize", this._onResize);
  }

  // ---- public API ----------------------------------------------------------

  /** (Re)set the progression provider; re-renders in place if currently open. */
  setProvider(progression) {
    this._progression = progression || null;
    if (this._open && this._mounted) this._renderActive();
  }

  /**
   * Register the callback fired AFTER the power-off animation finishes (so the
   * orchestrator can dolly the camera back out / restore control).
   * @param {()=>void} fn
   */
  setOnClose(fn) {
    this._onClose = typeof fn === "function" ? fn : null;
  }

  /** @returns {boolean} whether the terminal is currently shown. */
  isOpen() {
    return this._open;
  }

  /**
   * Mount (first call only), run the CRT power-on sequence, render the active tab.
   * @param {(()=>({left,top,width,height}|null))} [rectProvider] when supplied,
   *   lay the terminal over this viewport rect (the laptop screen) instead of
   *   full-screen; re-queried on resize. Omit for the standalone full-screen CRT.
   */
  open(rectProvider = null) {
    this._ensureMounted();
    this._clearTimers();
    this._closing = false;
    this._open = true;
    this._tab = "weapons";
    this._footerMsg("", "");
    this.root.classList.remove(`${PREFIX}hidden`);
    this._rectProvider = typeof rectProvider === "function" ? rectProvider : null;
    this._applyRect();
    this._renderActive(); // build listings now; they're revealed after the boot-log
    this._powerOn();
  }

  /**
   * Embedded mode: size + position the root over the laptop-screen rect so the UI
   * reads as the ThinkPad's display, with the 3D model framing it. Falls back to
   * full-screen when no provider is set or the rect is unavailable (headless / fit
   * not ready yet). @private
   */
  _applyRect() {
    const root = this.root;
    if (!root) return;
    const rect = this._rectProvider ? this._rectProvider() : null;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
      root.classList.remove(`${PREFIX}embedded`);
      root.style.cssText = ""; // back to the stylesheet's fixed full-screen rect
      return;
    }
    root.classList.add(`${PREFIX}embedded`);
    root.style.inset = "auto";
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    root.style.width = `${rect.width}px`;
    root.style.height = `${rect.height}px`;
  }

  /** Play the power-off collapse, then hide the root and fire onClose(). */
  close() {
    if (!this._open || this._closing) return;
    this._closing = true;
    this._footerMsg(DISCONNECT_MSG, "warn");
    this._clearTimers();

    const finish = () => {
      this.root.classList.add(`${PREFIX}hidden`);
      this.root.classList.remove(`${PREFIX}embedded`);
      this.root.style.cssText = ""; // drop embedded inline pos; stylesheet rules resume
      this._rectProvider = null;
      this._power.classList.remove(`${PREFIX}on`, `${PREFIX}off`);
      this._open = false;
      this._closing = false;
      if (typeof this._onClose === "function") {
        try {
          this._onClose();
        } catch (err) {
          console.warn("[ShopTerminal] onClose threw:", err);
        }
      }
    };

    if (this._prefersReducedMotion()) {
      finish();
      return;
    }
    // Restart the collapse keyframe (bright line → shrinking dot), then hide.
    this._power.classList.remove(`${PREFIX}on`);
    void this._power.offsetWidth; // reflow so the .off animation re-fires
    this._power.classList.add(`${PREFIX}off`);
    this._timers.push(setTimeout(finish, 320));
  }

  // ---- mounting ------------------------------------------------------------

  /** Build the style block + DOM exactly once. */
  _ensureMounted() {
    if (this._mounted) return;
    this._injectStyle();
    this._buildDom();
    this._mounted = true;
  }

  /** Helper: create an element with an optional class + text. */
  _el(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  /** Inject the scoped stylesheet once (id-guarded so re-mounting is safe). */
  _injectStyle() {
    const styleId = `${PREFIX}style`;
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      /* ---- root + CRT bezel ------------------------------------------------ */
      .${PREFIX}root {
        position: fixed; inset: 0; z-index: 120;
        background: radial-gradient(ellipse at center, #0a0c0a 0%, #020303 100%);
        font-family: "Courier New","Consolas","DejaVu Sans Mono",monospace;
        color: #33ff66;
      }
      .${PREFIX}root.${PREFIX}hidden { display: none; }

      /* ---- embedded mode: laid over the laptop lid ------------------------ */
      /* Drop the freestanding CRT tube/bezel and let the phosphor screen fill
         the panel so it reads as the ThinkPad's own display; the 3D model frames
         it. (Root pos/size are set inline from the projected screen rect.) */
      .${PREFIX}root.${PREFIX}embedded { background: transparent; }
      .${PREFIX}root.${PREFIX}embedded .${PREFIX}crt {
        inset: 0; border-radius: 5px; padding: 0; background: var(--scr-bg);
        box-shadow: inset 0 0 36px 10px rgba(0,0,0,0.75);
      }
      .${PREFIX}root.${PREFIX}embedded .${PREFIX}screen { border-radius: 5px; }

      /* The tube: rounded glass, a chunky dark bezel (layered box-shadow:
         outer drop + ridge + inset tube falloff). CSS custom props live here. */
      .${PREFIX}crt {
        --p-green:#33ff66; --p-green-d:#1f8f3e; --p-amber:#ffb000; --p-cyan:#4fd6ff; --p-red:#ff3b30;
        --scr-bg:#04130a; --scr-bg2:#061a0e; --line:rgba(51,255,102,0.22); --glow:0 0 6px rgba(51,255,102,0.45);
        position: absolute; inset: 2.4vmin;
        border-radius: 22px / 34px;
        padding: clamp(12px, 2.4vmin, 30px);
        background: #0c0f0c;
        box-shadow:
          0 30px 90px rgba(0,0,0,0.9),
          0 6px 22px rgba(0,0,0,0.8),
          0 0 0 2px #000,
          0 0 0 9px #1a1c1a,
          0 0 0 10px #050505,
          inset 0 0 70px 18px rgba(0,0,0,0.85),
          inset 0 0 160px 36px rgba(0,0,0,0.55);
      }

      /* The glass: clips everything, holds the radial phosphor bg + the
         scanline/vignette pseudo overlays. */
      .${PREFIX}screen {
        position: relative; width: 100%; height: 100%;
        overflow: hidden;
        border-radius: 14px / 22px;
        background: radial-gradient(ellipse at center, var(--scr-bg2) 0%, var(--scr-bg) 72%, #020a05 100%);
        color: var(--p-green);
        text-shadow: 0 0 2px currentColor, 0 0 6px rgba(51,255,102,0.5);
      }
      /* Scanlines (multiply over the content; never a click target). */
      .${PREFIX}screen::before {
        content: ""; position: absolute; inset: 0; z-index: 5; pointer-events: none;
        background: repeating-linear-gradient(rgba(0,0,0,0) 0 1px, rgba(0,0,0,0.28) 1px 3px);
        mix-blend-mode: multiply;
      }
      /* Vignette (corner falloff). */
      .${PREFIX}screen::after {
        content: ""; position: absolute; inset: 0; z-index: 4; pointer-events: none;
        background: radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.75) 100%);
      }
      /* Faint taller "rolling refresh" bar drifting top→bottom on a 7s loop. */
      .${PREFIX}roll {
        position: absolute; left: 0; right: 0; top: 0; height: 18%; z-index: 6; pointer-events: none;
        background: linear-gradient(rgba(120,255,170,0) 0%, rgba(120,255,170,0.06) 50%, rgba(120,255,170,0) 100%);
        animation: ${PREFIX}roll 7s linear infinite;
      }
      @keyframes ${PREFIX}roll { 0% { transform: translateY(-120%); } 100% { transform: translateY(720%); } }
      /* White discharge flash used by the power on/off transitions. */
      .${PREFIX}flash {
        position: absolute; inset: 0; z-index: 7; pointer-events: none; opacity: 0;
        background: #d8ffe6;
      }
      .${PREFIX}power.${PREFIX}on ~ .${PREFIX}flash { animation: ${PREFIX}flash-on 0.62s ease-out both; }
      .${PREFIX}power.${PREFIX}off ~ .${PREFIX}flash { animation: ${PREFIX}flash-off 0.32s ease-in both; }
      @keyframes ${PREFIX}flash-on { 0% { opacity: 0.7; } 20% { opacity: 0.4; } 100% { opacity: 0; } }
      @keyframes ${PREFIX}flash-off { 0%,68% { opacity: 0; } 84% { opacity: 0.55; } 100% { opacity: 0; } }

      /* ---- power scale wrapper (CRT turn-on / turn-off) -------------------- */
      .${PREFIX}power { position: absolute; inset: 0; z-index: 1; transform-origin: center center; }
      .${PREFIX}power.${PREFIX}on  { animation: ${PREFIX}poweron 0.62s cubic-bezier(0.2,0.7,0.2,1) both; }
      .${PREFIX}power.${PREFIX}off { animation: ${PREFIX}poweroff 0.32s ease-in both; }
      @keyframes ${PREFIX}poweron {
        0%   { transform: scaleX(1.25) scaleY(0.0016); filter: brightness(4); }
        16%  { transform: scaleX(1) scaleY(0.004); filter: brightness(3.4); }
        46%  { transform: scaleX(1) scaleY(1.06); filter: brightness(1.7); }
        72%  { transform: scaleX(1) scaleY(0.985); filter: brightness(1.12); }
        100% { transform: scaleX(1) scaleY(1); filter: brightness(1); }
      }
      @keyframes ${PREFIX}poweroff {
        0%   { transform: scaleX(1) scaleY(1); filter: brightness(1); }
        45%  { transform: scaleX(1) scaleY(0.0035); filter: brightness(3.2); }
        78%  { transform: scaleX(0.0016) scaleY(0.0035); filter: brightness(6); }
        100% { transform: scaleX(0) scaleY(0); filter: brightness(9); opacity: 0; }
      }

      /* ---- flicker layer (subtle, always-on except reduced-motion) --------- */
      .${PREFIX}flicker { position: absolute; inset: 0; animation: ${PREFIX}flicker 0.11s steps(2,jump-none) infinite; }
      @keyframes ${PREFIX}flicker {
        0%   { opacity: 0.94; filter: brightness(0.98); }
        50%  { opacity: 1; filter: brightness(1.04); }
        100% { opacity: 0.92; filter: brightness(0.97); }
      }

      /* ---- scroll region + custom thin green scrollbar -------------------- */
      .${PREFIX}scroll {
        position: absolute; inset: 0;
        overflow-y: auto; overflow-x: hidden;
        scrollbar-width: thin; scrollbar-color: var(--p-green-d) transparent;
      }
      .${PREFIX}scroll::-webkit-scrollbar { width: 8px; }
      .${PREFIX}scroll::-webkit-scrollbar-track { background: rgba(0,0,0,0.3); }
      .${PREFIX}scroll::-webkit-scrollbar-thumb {
        background: var(--p-green-d); box-shadow: inset 0 0 4px rgba(51,255,102,0.6);
      }
      .${PREFIX}content {
        min-height: 100%; display: flex; flex-direction: column;
        padding: 0 clamp(10px,2.4vw,28px);
        font-size: clamp(12px, 1.5vmin, 15px); line-height: 1.5;
        opacity: 0; transition: opacity 0.22s ease;
        animation: ${PREFIX}surge 5.4s ease-in-out infinite; /* rare brightness pop */
      }
      @keyframes ${PREFIX}surge {
        0%,90%,100% { filter: brightness(1); }
        93% { filter: brightness(1.2); }
        96% { filter: brightness(0.95); }
      }

      /* ---- sticky status header ------------------------------------------- */
      .${PREFIX}header {
        position: sticky; top: 0; z-index: 3;
        padding: 12px 0 8px;
        background: linear-gradient(var(--scr-bg) 72%, rgba(4,19,10,0));
      }
      .${PREFIX}status {
        display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
      }
      .${PREFIX}status-l { display: flex; align-items: center; gap: 14px; }
      .${PREFIX}wordmark {
        color: var(--p-amber); font-weight: 700; letter-spacing: 0.12em;
        text-shadow: 0 0 6px rgba(255,176,0,0.5);
      }
      .${PREFIX}online { color: var(--p-green); letter-spacing: 0.12em; font-size: 0.85em; }
      .${PREFIX}dot { color: var(--p-green); animation: ${PREFIX}blink 1.6s steps(1) infinite; }
      .${PREFIX}status-c { color: var(--p-green-d); font-size: 0.85em; letter-spacing: 0.06em; }
      .${PREFIX}wallet {
        color: var(--p-amber); font-weight: 700; letter-spacing: 0.08em;
        text-shadow: 0 0 6px rgba(255,176,0,0.5);
      }
      .${PREFIX}prompt { margin-top: 6px; color: var(--p-green-d); font-size: 0.9em; }
      .${PREFIX}caret { color: var(--p-green); animation: ${PREFIX}blink 1s steps(1) infinite; }
      @keyframes ${PREFIX}blink { 0%,49% { opacity: 1; } 50%,100% { opacity: 0; } }

      /* ---- category tabs --------------------------------------------------- */
      .${PREFIX}tabs {
        display: flex; flex-wrap: wrap; gap: 8px;
        padding: 8px 0 12px; margin-bottom: 14px;
        border-bottom: 1px solid var(--line);
      }
      .${PREFIX}tab {
        font: inherit; cursor: pointer;
        color: var(--p-green); background: transparent;
        border: 1px solid var(--line); padding: 6px 12px; letter-spacing: 0.06em;
        text-shadow: var(--glow);
        transition: color 0.12s, background 0.12s, border-color 0.12s;
      }
      .${PREFIX}tab:hover { color: var(--p-cyan); border-color: var(--p-cyan); text-shadow: 0 0 8px rgba(79,214,255,0.6); }
      .${PREFIX}tab-active, .${PREFIX}tab-active:hover {
        color: #04130a; background: var(--p-green); border-color: var(--p-green);
        text-shadow: none; font-weight: 700;
      }

      /* ---- listing grid (1-up narrow / 2-up wide) ------------------------- */
      .${PREFIX}grid { display: grid; grid-template-columns: 1fr; gap: 12px; flex: 1 1 auto; }
      @media (min-width: 760px) { .${PREFIX}grid { grid-template-columns: 1fr 1fr; } }
      .${PREFIX}card {
        border: 1px solid var(--line);
        background: linear-gradient(rgba(51,255,102,0.03), rgba(0,0,0,0));
        padding: 12px 14px; display: flex; flex-direction: column; gap: 6px;
        box-shadow: inset 0 0 12px rgba(51,255,102,0.05);
      }
      .${PREFIX}card-name {
        color: var(--p-amber); font-weight: 700; letter-spacing: 0.06em; font-size: 1.05em;
        text-shadow: 0 0 6px rgba(255,176,0,0.45);
      }
      .${PREFIX}card-stats { color: var(--p-cyan); font-size: 0.85em; letter-spacing: 0.04em; text-shadow: 0 0 5px rgba(79,214,255,0.4); }
      .${PREFIX}card-desc { color: var(--p-green); opacity: 0.85; font-size: 0.9em; }
      .${PREFIX}card-vendor { color: var(--p-green-d); font-size: 0.82em; letter-spacing: 0.03em; }
      .${PREFIX}card-ability { color: var(--p-cyan); font-size: 0.85em; letter-spacing: 0.04em; }
      .${PREFIX}card-pips { color: var(--p-green); letter-spacing: 0.18em; font-size: 0.92em; }
      .${PREFIX}card-foot {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        margin-top: 6px; padding-top: 8px; border-top: 1px dashed var(--line);
      }
      .${PREFIX}price { color: var(--p-amber); font-weight: 700; letter-spacing: 0.06em; text-shadow: 0 0 6px rgba(255,176,0,0.4); }

      /* Bracketed text actions (not pills); hover adds a "> " prefix + cyan glow. */
      .${PREFIX}act {
        font: inherit; cursor: pointer; background: transparent; border: none;
        color: var(--p-green); padding: 4px; letter-spacing: 0.06em; text-align: right;
        text-shadow: var(--glow); transition: color 0.12s, text-shadow 0.12s;
      }
      .${PREFIX}act:not(:disabled):hover { color: var(--p-cyan); text-shadow: 0 0 8px rgba(79,214,255,0.7); }
      .${PREFIX}act:not(:disabled):hover::before { content: "> "; }
      .${PREFIX}act-red { color: var(--p-red); text-shadow: 0 0 6px rgba(255,59,48,0.5); }
      .${PREFIX}act:disabled, .${PREFIX}act-off { color: var(--p-green-d); cursor: default; text-shadow: none; }
      .${PREFIX}act-red.${PREFIX}act-off { color: var(--p-red); opacity: 0.7; }

      .${PREFIX}empty {
        grid-column: 1 / -1; border: 1px dashed var(--line);
        padding: 24px 16px; text-align: center; color: var(--p-green-d); letter-spacing: 0.05em;
      }

      /* ---- sticky footer --------------------------------------------------- */
      .${PREFIX}footer {
        position: sticky; bottom: 0; z-index: 3; margin-top: 14px;
        padding: 8px 0 12px; border-top: 1px solid var(--line);
        background: linear-gradient(rgba(4,19,10,0), var(--scr-bg) 36%);
        display: flex; flex-direction: column; gap: 6px;
      }
      .${PREFIX}msg { min-height: 1.2em; color: var(--p-amber); font-size: 0.9em; letter-spacing: 0.03em; }
      .${PREFIX}msg-ok { color: var(--p-green); text-shadow: var(--glow); }
      .${PREFIX}msg-err { color: var(--p-red); text-shadow: 0 0 6px rgba(255,59,48,0.5); }
      .${PREFIX}msg-warn { color: var(--p-amber); }
      .${PREFIX}crawl { overflow: hidden; white-space: nowrap; color: var(--p-green-d); font-size: 0.82em; }
      .${PREFIX}crawl-track { display: inline-block; white-space: nowrap; animation: ${PREFIX}crawl 26s linear infinite; }
      @keyframes ${PREFIX}crawl { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
      .${PREFIX}disconnect {
        align-self: flex-start; font: inherit; cursor: pointer; background: transparent;
        border: 1px solid var(--p-amber); color: var(--p-amber);
        padding: 6px 12px; letter-spacing: 0.08em; text-shadow: 0 0 6px rgba(255,176,0,0.4);
        transition: color 0.12s, background 0.12s;
      }
      .${PREFIX}disconnect:hover { color: #04130a; background: var(--p-amber); text-shadow: none; }

      /* ---- boot-log overlay (visible only during the power-on type sequence) */
      .${PREFIX}boot {
        position: absolute; inset: 0; z-index: 2;
        padding: clamp(14px,4vmin,40px);
        color: var(--p-amber); font-size: clamp(12px,1.6vmin,15px); line-height: 1.7;
        text-shadow: 0 0 6px rgba(255,176,0,0.5); background: var(--scr-bg); overflow: hidden;
      }
      .${PREFIX}boot-line { white-space: pre-wrap; }
      .${PREFIX}boot-ok { color: var(--p-green); text-shadow: var(--glow); margin-top: 6px; }

      /* ---- reduced motion: drop the dolly/flicker/typing, keep a soft fade -- */
      @media (prefers-reduced-motion: reduce) {
        .${PREFIX}power, .${PREFIX}flicker, .${PREFIX}roll, .${PREFIX}flash,
        .${PREFIX}content, .${PREFIX}dot, .${PREFIX}caret, .${PREFIX}crawl-track {
          animation: none !important;
        }
        .${PREFIX}roll { display: none; }
      }
    `;
    document.head.appendChild(style);
  }

  /** Build the root → bezel → glass → (power → flicker → scroll → content) tree + overlays. */
  _buildDom() {
    this.root = this._el("div", `${PREFIX}root ${PREFIX}hidden`);
    this._crt = this._el("div", `${PREFIX}crt`);
    this._screen = this._el("div", `${PREFIX}screen`);
    this._crt.appendChild(this._screen);
    this.root.appendChild(this._crt);

    // Scale wrapper (turn-on/off) → flicker layer → scroll region → content.
    this._power = this._el("div", `${PREFIX}power`);
    this._flicker = this._el("div", `${PREFIX}flicker`);
    this._scroll = this._el("div", `${PREFIX}scroll`);
    this._content = this._el("div", `${PREFIX}content`);

    this._content.appendChild(this._buildHeader());
    this._content.appendChild(this._buildTabs());
    this._grid = this._el("div", `${PREFIX}grid`);
    this._content.appendChild(this._grid);
    this._content.appendChild(this._buildFooter());

    this._scroll.appendChild(this._content);
    this._flicker.appendChild(this._scroll);
    this._power.appendChild(this._flicker);
    this._screen.appendChild(this._power);

    // Boot-log overlay (hidden between power-ons).
    this._boot = this._el("div", `${PREFIX}boot`);
    this._boot.style.display = "none";
    this._screen.appendChild(this._boot);

    // Non-interactive effect overlays (must follow .power for the flash sibling rule).
    this._screen.appendChild(this._el("div", `${PREFIX}roll`));
    this._flash = this._el("div", `${PREFIX}flash`);
    this._screen.appendChild(this._flash);

    document.body.appendChild(this.root);
  }

  /** Sticky header: ASCII wordmark + ONLINE, onion route, wallet, and a cosmetic shell prompt. */
  _buildHeader() {
    const head = this._el("div", `${PREFIX}header`);

    const status = this._el("div", `${PREFIX}status`);

    const left = this._el("div", `${PREFIX}status-l`);
    left.appendChild(this._el("span", `${PREFIX}wordmark`, "╪ THE FALLS ROAD ╪"));
    const online = this._el("span", `${PREFIX}online`);
    online.appendChild(this._el("span", `${PREFIX}dot`, "●"));
    online.appendChild(document.createTextNode(" ONLINE"));
    left.appendChild(online);

    const mid = this._el("div", `${PREFIX}status-c`, "route: 7 hops · TOR · 211ms");

    const right = this._el("div", `${PREFIX}status-r`);
    this._walletEl = this._el("span", `${PREFIX}wallet`, this._walletText());
    right.appendChild(this._walletEl);

    status.appendChild(left);
    status.appendChild(mid);
    status.appendChild(right);
    head.appendChild(status);

    const prompt = this._el("div", `${PREFIX}prompt`);
    prompt.appendChild(document.createTextNode("root@belfast:~/market$ "));
    prompt.appendChild(this._el("span", `${PREFIX}caret`, "▋"));
    head.appendChild(prompt);
    return head;
  }

  /** Category tab strip (ASCII segmented). Counts are filled in by _renderActive(). */
  _buildTabs() {
    const wrap = this._el("div", `${PREFIX}tabs`);
    this._tabBtns = {};
    for (const t of TABS) {
      const btn = this._el("button", `${PREFIX}tab`, `[ ${t.label} (0) ]`);
      btn.type = "button";
      btn.addEventListener("click", () => this._setTab(t.key));
      this._tabBtns[t.key] = btn;
      wrap.appendChild(btn);
    }
    return wrap;
  }

  /** Sticky footer: transient message line + looping disclaimer crawl + DISCONNECT. */
  _buildFooter() {
    const foot = this._el("div", `${PREFIX}footer`);

    this._msgEl = this._el("div", `${PREFIX}msg`);
    foot.appendChild(this._msgEl);

    const crawl = this._el("div", `${PREFIX}crawl`);
    const track = this._el("div", `${PREFIX}crawl-track`);
    const text = "All sales final · No refunds · No grasses · Prices in good faith and bad intentions";
    // Duplicate the text so the -50% translate loops seamlessly.
    track.appendChild(this._el("span", null, text + "  ·  "));
    track.appendChild(this._el("span", null, text + "  ·  "));
    crawl.appendChild(track);
    foot.appendChild(crawl);

    const dc = this._el("button", `${PREFIX}disconnect`, "[ ◂ DISCONNECT ]");
    dc.type = "button";
    dc.addEventListener("click", () => this.close());
    foot.appendChild(dc);
    return foot;
  }

  // ---- power sequence ------------------------------------------------------

  /** Run the CRT turn-on: tube expand → typed boot-log → listings fade up. */
  _powerOn() {
    this._power.classList.remove(`${PREFIX}off`);

    if (this._prefersReducedMotion()) {
      // Reduced motion: skip the dolly/flicker/typing; just fade the listings in.
      this._boot.style.display = "none";
      this._content.style.opacity = "0";
      requestAnimationFrame(() => {
        this._content.style.opacity = "1";
      });
      return;
    }

    this._content.style.opacity = "0";
    this._boot.style.display = "block";
    this._boot.replaceChildren();
    void this._power.offsetWidth; // restart the turn-on keyframe
    this._power.classList.remove(`${PREFIX}on`);
    void this._power.offsetWidth;
    this._power.classList.add(`${PREFIX}on`);

    // Start typing once the tube has finished expanding (~440ms in).
    this._timers.push(
      setTimeout(
        () =>
          this._typeBootLog(() => {
            this._boot.style.display = "none";
            this._content.style.opacity = "1";
          }),
        440,
      ),
    );
  }

  /** Reveal BOOT_LINES one at a time, then call `done` after a short beat. */
  _typeBootLog(done) {
    let i = 0;
    const step = () => {
      if (i >= BOOT_LINES.length) {
        this._timers.push(setTimeout(done, 260));
        return;
      }
      const line = this._el("div", `${PREFIX}boot-line`, BOOT_LINES[i]);
      if (i === BOOT_LINES.length - 1) line.classList.add(`${PREFIX}boot-ok`);
      this._boot.appendChild(line);
      i += 1;
      this._timers.push(setTimeout(step, 95));
    };
    step();
  }

  /** Cancel every outstanding power/boot-log timer (so nothing fires post-close). */
  _clearTimers() {
    for (const t of this._timers) clearTimeout(t);
    this._timers.length = 0;
  }

  /** @returns {boolean} whether the OS asks us to cut the motion. */
  _prefersReducedMotion() {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  // ---- rendering -----------------------------------------------------------

  /** Switch the active category and re-render the grid. */
  _setTab(key) {
    if (this._tab === key) return;
    this._tab = key;
    this._renderActive();
  }

  /**
   * Repaint the tab counts/active state + the grid for the active tab, and the
   * wallet. Degrades to an empty-but-styled screen when the provider is absent.
   */
  _renderActive() {
    if (!this._mounted) return;

    const weapons = this._safeList("listWeapons");
    const upgrades = this._safeList("listUpgrades");
    const boots = this._safeList("listBoots");

    // Tab labels (with live counts) + active inversion.
    this._setTabLabel("weapons", weapons.length);
    this._setTabLabel("upgrades", upgrades.length);
    this._setTabLabel("boots", boots.length);
    for (const key of Object.keys(this._tabBtns)) {
      this._tabBtns[key].classList.toggle(`${PREFIX}tab-active`, key === this._tab);
    }

    // Grid: rebuild the dynamic cards from scratch (createElement, not innerHTML).
    this._grid.replaceChildren();
    let cards = [];
    if (this._tab === "weapons") {
      const nameById = Object.fromEntries(weapons.map((w) => [w.id, w.name]));
      cards = weapons.map((w) => this._weaponCard(w, nameById));
    } else if (this._tab === "upgrades") {
      cards = upgrades.map((u) => this._upgradeCard(u));
    } else {
      cards = boots.map((b) => this._bootCard(b));
    }
    if (!cards.length) this._grid.appendChild(this._emptyCard());
    else for (const c of cards) this._grid.appendChild(c);

    this._updateWallet();
  }

  /** Set a tab button's bracketed label + count. */
  _setTabLabel(key, n) {
    const btn = this._tabBtns[key];
    if (btn) btn.textContent = `[ ${TAB_LABEL[key]} (${n}) ]`;
  }

  /** A placeholder card shown when a category has no stock (or no provider). */
  _emptyCard() {
    return this._el("div", `${PREFIX}empty`, "// quartermaster offline — no stock on the wire right now.");
  }

  /** Shared action-button factory. `red` for LOCKED labels; `disabled` greys it out. */
  _actionBtn(label, onClick, { disabled = false, red = false } = {}) {
    const btn = this._el("button", `${PREFIX}act`, label);
    btn.type = "button";
    if (red) btn.classList.add(`${PREFIX}act-red`);
    if (disabled) {
      btn.disabled = true;
      btn.classList.add(`${PREFIX}act-off`);
    } else if (onClick) {
      btn.addEventListener("click", onClick);
    }
    return btn;
  }

  /**
   * HARDWARE card: name, a stat strip pulled from WEAPON_STATS, a vendor blurb +
   * fake reputation line, price, and a context-aware action. The BUY action stays
   * clickable even when unaffordable so the in-fiction "insufficient escrow" error
   * can fire on click.
   * @param {object} w a listWeapons() entry.
   * @param {Record<string,string>} nameById id → display name (for prereq labels).
   */
  _weaponCard(w, nameById) {
    const card = this._el("div", `${PREFIX}card`);
    card.appendChild(this._el("div", `${PREFIX}card-name`, w.name || w.id || "Unknown"));

    const stat = WEAPON_STATS[w.id];
    if (stat) {
      const strip =
        `DMG ${stat.damage} · RPM ${stat.rpm} · MAG ${stat.mag}` +
        (stat.auto ? " · AUTO" : "") +
        (stat.pellets > 1 ? " · x" + stat.pellets : "");
      card.appendChild(this._el("div", `${PREFIX}card-stats`, strip));
    }
    if (w.desc) card.appendChild(this._el("div", `${PREFIX}card-desc`, w.desc));
    card.appendChild(this._el("div", `${PREFIX}card-vendor`, "vendor: Quartermaster_99 ★★★★☆ · 1.2k deals"));

    const foot = this._el("div", `${PREFIX}card-foot`);
    foot.appendChild(this._el("div", `${PREFIX}price`, `RP ⏃ ${this._num(w.cost)}`));

    let btn;
    if (w.owned) {
      btn = this._actionBtn("✓ IN YOUR LOCKER", null, { disabled: true });
    } else if (w.locked) {
      const req = (w.requires && nameById[w.requires]) || w.requires || "another piece";
      btn = this._actionBtn(`[ LOCKED — vouch for ${req} first ]`, null, { disabled: true, red: true });
    } else {
      btn = this._actionBtn("[ BUY ]", () => this._tx("buyWeapon", w.id, "buy"));
    }
    foot.appendChild(btn);
    card.appendChild(foot);
    return card;
  }

  /**
   * WETWORK MODS card: name, desc, a level-pip row, the next-level price, and an
   * INSTALL action (or MAXED, disabled).
   * @param {object} u a listUpgrades() entry.
   */
  _upgradeCard(u) {
    const card = this._el("div", `${PREFIX}card`);
    card.appendChild(this._el("div", `${PREFIX}card-name`, u.name || u.id || "Mod"));
    if (u.desc) card.appendChild(this._el("div", `${PREFIX}card-desc`, u.desc));

    const level = this._num(u.level);
    const maxLevel = Math.max(1, this._num(u.maxLevel));
    const maxed = u.maxed != null ? !!u.maxed : level >= maxLevel;
    const filled = Math.max(0, Math.min(level, maxLevel));
    const pips = "■".repeat(filled) + "□".repeat(Math.max(0, maxLevel - filled));
    card.appendChild(this._el("div", `${PREFIX}card-pips`, `LVL ${pips} ${level}/${maxLevel}`));

    const foot = this._el("div", `${PREFIX}card-foot`);
    const hasCost = Number.isFinite(u.cost);
    foot.appendChild(this._el("div", `${PREFIX}price`, maxed || !hasCost ? "RP ⏃ —" : `RP ⏃ ${u.cost}`));

    const btn = maxed
      ? this._actionBtn("MAXED", null, { disabled: true })
      : this._actionBtn("[ INSTALL ]", () => this._tx("buyUpgrade", u.id, "buy"));
    foot.appendChild(btn);
    card.appendChild(foot);
    return card;
  }

  /**
   * FOOTWORK card: name, desc, the granted ability, price, and a BUY → EQUIP →
   * ✓ EQUIPPED action progression.
   * @param {object} b a listBoots() entry.
   */
  _bootCard(b) {
    const card = this._el("div", `${PREFIX}card`);
    card.appendChild(this._el("div", `${PREFIX}card-name`, b.name || b.id || "Boots"));
    if (b.desc) card.appendChild(this._el("div", `${PREFIX}card-desc`, b.desc));
    card.appendChild(this._el("div", `${PREFIX}card-ability`, `ABILITY: ${b.ability || "—"}`));

    const foot = this._el("div", `${PREFIX}card-foot`);
    foot.appendChild(this._el("div", `${PREFIX}price`, `RP ⏃ ${this._num(b.cost)}`));

    let btn;
    if (b.equipped) {
      btn = this._actionBtn("✓ EQUIPPED", null, { disabled: true });
    } else if (b.owned) {
      btn = this._actionBtn("[ EQUIP ]", () => this._tx("equipBoot", b.id, "equip"));
    } else {
      btn = this._actionBtn("[ BUY ]", () => this._tx("buyBoot", b.id, "buy"));
    }
    foot.appendChild(btn);
    card.appendChild(foot);
    return card;
  }

  // ---- transactions + wallet ----------------------------------------------

  /**
   * Dispatch a provider mutation and react to the result. On success: re-render
   * the active tab (which repaints the wallet too) + a confirmation line. On
   * failure: surface the deadpan reason in the footer.
   * @param {"buyWeapon"|"buyUpgrade"|"buyBoot"|"equipBoot"} method
   * @param {string} id  listing id.
   * @param {"buy"|"equip"} kind  picks the success message.
   */
  _tx(method, id, kind) {
    const res = this._invoke(method, id);
    if (res && res.ok) {
      this._renderActive();
      this._footerMsg(kind === "equip" ? EQUIP_MSG : BUY_MSG, "ok");
    } else {
      const reason = (res && res.reason) || "unknown";
      const e = TX_ERRORS[reason] || TX_ERRORS.unknown;
      this._footerMsg(e.text, e.kind);
      this._updateWallet(); // balance is unchanged, but keep it authoritative
    }
  }

  /**
   * Call a provider mutation defensively. A missing provider / method / a throw
   * all normalise to a `{ok:false, reason:"unknown"}` so callers never crash.
   * @returns {{ok:boolean, reason?:string, level?:number}}
   */
  _invoke(method, ...args) {
    const p = this._progression;
    if (!p || typeof p[method] !== "function") return { ok: false, reason: "unknown" };
    try {
      const r = p[method](...args);
      return r == null ? { ok: false, reason: "unknown" } : r;
    } catch (err) {
      console.warn(`[ShopTerminal] progression.${method} threw:`, err);
      return { ok: false, reason: "unknown" };
    }
  }

  /** Read a provider list getter defensively, always returning an array. */
  _safeList(method) {
    const p = this._progression;
    if (!p || typeof p[method] !== "function") return [];
    try {
      const r = p[method]();
      return Array.isArray(r) ? r : [];
    } catch (err) {
      console.warn(`[ShopTerminal] progression.${method} threw:`, err);
      return [];
    }
  }

  /** Live Resistance Points balance, read fresh from the GameState singleton. */
  _walletBalance() {
    const prog = gameState.getProgression();
    return prog && Number.isFinite(prog.resistancePoints) ? prog.resistancePoints : 0;
  }

  /** The formatted wallet string ("BALANCE: RP ⏃ N"). */
  _walletText() {
    return `BALANCE: RP ⏃ ${this._walletBalance()}`;
  }

  /** Repaint the wallet readout from the singleton (called after every purchase). */
  _updateWallet() {
    if (this._walletEl) this._walletEl.textContent = this._walletText();
  }

  /** Paint the transient footer message line. `kind` = "" | "ok" | "warn" | "err". */
  _footerMsg(text, kind = "") {
    if (!this._msgEl) return;
    this._msgEl.textContent = text || "";
    this._msgEl.className = `${PREFIX}msg`;
    if (kind === "ok") this._msgEl.classList.add(`${PREFIX}msg-ok`);
    else if (kind === "err") this._msgEl.classList.add(`${PREFIX}msg-err`);
    else if (kind === "warn") this._msgEl.classList.add(`${PREFIX}msg-warn`);
  }

  /** Coerce a possibly-missing numeric field to a finite number (default 0). */
  _num(v) {
    return Number.isFinite(v) ? v : 0;
  }

  // ---- teardown ------------------------------------------------------------

  /** Tear down: cancel timers, remove the DOM root, and drop the injected style. */
  dispose() {
    this._clearTimers();
    this._open = false;
    this._closing = false;
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    const style = document.getElementById(`${PREFIX}style`);
    if (style && style.parentNode) style.parentNode.removeChild(style);
    this._mounted = false;
  }
}

export default ShopTerminal;
