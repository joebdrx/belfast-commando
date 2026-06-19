/**
 * TouchControls
 * -------------
 * On-screen controls for touch devices (mobile / tablet). Built ENTIRELY in JS
 * (a root <div> appended to document.body + an injected, class-prefixed <style>
 * block) so it never touches index.html or styles.css — the same convention as
 * Menu / PauseMenu / LoadingScreen.
 *
 * Layout (only shown during LEVEL play on a touch device):
 *   - Left half  → a virtual joystick driving WASD movement (+ sprint at the rim).
 *   - Right half → drag-to-look (feeds Player.applyLook).
 *   - Bottom-right cluster → Fire (hold), Jump, Kick, Reload, Weapon-switch.
 *   - Top-right → Pause.
 *
 * The class owns NO game objects. It reports intent through callbacks set via
 * setHandlers() so the orchestrator wires them to Player/Weapon/pause:
 *   onLook(dx,dy)            – look delta in pixels
 *   onMove(keyMap)           – {KeyW,KeyS,KeyA,KeyD,ShiftLeft} booleans
 *   onKeyDown(code)/onKeyUp  – momentary keys (Space jump, KeyF kick)
 *   onFireDown()/onFireUp()  – primary trigger
 *   onReload()/onSwitch()/onPause()
 *
 * Pointer lock does not exist on touch, so the orchestrator gates input on
 * ctx.touch instead (see _canAct / _computeActive). Desktop never constructs this.
 */

const PREFIX = "bc-touch-";

/**
 * Decide whether to present the touch UI. Real signal = a coarse primary pointer
 * with touch points (phones/tablets); the UA regex is a fallback. A `?touch=1`
 * / `?touch=0` query param force-overrides either way (handy for desktop testing
 * and for users on hybrid devices who want to opt in/out).
 * @returns {boolean}
 */
export function isTouchDevice() {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("touch");
    if (q === "1" || q === "true") return true;
    if (q === "0" || q === "false") return false;
  } catch (_) {
    /* no URL — ignore */
  }
  const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  const hasTouch = "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
  const ua = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile|webOS/i.test(
    navigator.userAgent || "",
  );
  return (coarse && hasTouch) || ua;
}

/**
 * Map a normalised joystick offset (each axis in [-1,1], up = -y) to the movement
 * key booleans the Player already consumes. Pure + side-effect free so it can be
 * unit-tested without a DOM. Pushing the stick to the rim engages sprint.
 * @param {number} dx  -1 (left) … +1 (right)
 * @param {number} dy  -1 (up/forward) … +1 (down/back)
 * @param {{deadzone?:number, sprint?:number}} [opts]
 * @returns {{KeyW:boolean,KeyS:boolean,KeyA:boolean,KeyD:boolean,ShiftLeft:boolean}}
 */
export function joystickToKeys(dx, dy, { deadzone = 0.28, sprint = 0.92 } = {}) {
  let mag = Math.hypot(dx, dy);
  if (mag > 1) {
    dx /= mag;
    dy /= mag;
    mag = 1;
  }
  return {
    KeyW: dy < -deadzone,
    KeyS: dy > deadzone,
    KeyA: dx < -deadzone,
    KeyD: dx > deadzone,
    ShiftLeft: mag >= sprint,
  };
}

/** Movement keys this controller owns — cleared together on release. */
const MOVE_KEYS = ["KeyW", "KeyS", "KeyA", "KeyD", "ShiftLeft"];

export class TouchControls {
  constructor() {
    /** @type {Record<string,Function>} */
    this._handlers = {};
    this._active = false;

    // Active touch identifiers for the two analog inputs (buttons are separate).
    this._moveId = null;
    this._lookId = null;
    this._lookLast = { x: 0, y: 0 };
    this._stickCenter = { x: 0, y: 0 };
    this._stickRadius = 64;

    this._injectStyle();
    this._buildDom();
    this.setActive(false);
  }

  // ---- DOM construction ----------------------------------------------------

  _injectStyle() {
    const id = `${PREFIX}style`;
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      .${PREFIX}root {
        position: fixed; inset: 0; z-index: 26;
        touch-action: none; -webkit-user-select: none; user-select: none;
        -webkit-tap-highlight-color: transparent;
        font-family: "Arial Narrow", "Inter", system-ui, sans-serif;
      }
      .${PREFIX}root.${PREFIX}hidden { display: none; }
      /* Analog half-zones are invisible touch targets (the joystick + look pad). */
      .${PREFIX}zone { position: absolute; top: 0; bottom: 0; }
      .${PREFIX}zone-move { left: 0; width: 50%; }
      .${PREFIX}zone-look { right: 0; width: 50%; }
      /* Virtual joystick (bottom-left). */
      .${PREFIX}stick {
        position: absolute; left: 30px; bottom: calc(30px + env(safe-area-inset-bottom, 0px));
        width: 128px; height: 128px; border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.20);
        background: radial-gradient(circle, rgba(255,255,255,0.06), rgba(255,255,255,0.02));
        box-shadow: 0 2px 14px rgba(0,0,0,0.5);
      }
      .${PREFIX}knob {
        position: absolute; left: 50%; top: 50%;
        width: 58px; height: 58px; border-radius: 50%;
        transform: translate(-50%, -50%);
        background: radial-gradient(circle at 38% 32%, #ffb061, #ff7a1a 70%);
        border: 2px solid rgba(255,255,255,0.45);
        box-shadow: 0 2px 10px rgba(0,0,0,0.6);
        transition: transform 0.06s linear;
      }
      /* Action buttons (pointer-events so they intercept their own taps). */
      .${PREFIX}btn {
        position: absolute; pointer-events: auto;
        display: flex; align-items: center; justify-content: center;
        border-radius: 50%; color: #f5f2ec;
        font-size: 13px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
        background: rgba(20,22,25,0.55);
        border: 2px solid rgba(255,122,26,0.55);
        box-shadow: 0 2px 12px rgba(0,0,0,0.55);
        text-shadow: 0 1px 2px rgba(0,0,0,0.8);
      }
      .${PREFIX}btn.${PREFIX}down { background: rgba(255,122,26,0.42); border-color: #ff7a1a; }
      .${PREFIX}fire {
        right: calc(34px + env(safe-area-inset-right, 0px));
        bottom: calc(46px + env(safe-area-inset-bottom, 0px));
        width: 104px; height: 104px; font-size: 15px;
        border-color: rgba(248,81,73,0.7); background: rgba(60,18,16,0.5);
      }
      .${PREFIX}fire.${PREFIX}down { background: rgba(248,81,73,0.45); border-color: #f85149; }
      .${PREFIX}jump {
        right: calc(150px + env(safe-area-inset-right, 0px));
        bottom: calc(74px + env(safe-area-inset-bottom, 0px));
        width: 76px; height: 76px;
      }
      .${PREFIX}kick {
        right: calc(60px + env(safe-area-inset-right, 0px));
        bottom: calc(160px + env(safe-area-inset-bottom, 0px));
        width: 76px; height: 76px;
      }
      .${PREFIX}reload {
        right: calc(154px + env(safe-area-inset-right, 0px));
        bottom: calc(168px + env(safe-area-inset-bottom, 0px));
        width: 62px; height: 62px; font-size: 12px;
      }
      .${PREFIX}wpn {
        right: calc(40px + env(safe-area-inset-right, 0px));
        bottom: calc(252px + env(safe-area-inset-bottom, 0px));
        width: 62px; height: 62px; font-size: 12px;
      }
      .${PREFIX}pause {
        pointer-events: auto;
        top: calc(16px + env(safe-area-inset-top, 0px));
        right: calc(50% - 26px);
        width: 52px; height: 38px; border-radius: 8px;
        display: flex; align-items: center; justify-content: center;
        color: #f5f2ec; font-size: 16px; font-weight: 800;
        background: rgba(20,22,25,0.55); border: 1px solid rgba(255,122,26,0.5);
        box-shadow: 0 2px 10px rgba(0,0,0,0.5);
      }
      .${PREFIX}pause.${PREFIX}down { background: rgba(255,122,26,0.4); }
    `;
    document.head.appendChild(style);
  }

  _el(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  _buildDom() {
    // Start hidden — setActive(true) reveals it only during live LEVEL play.
    this.root = this._el("div", `${PREFIX}root ${PREFIX}hidden`);

    // Analog zones (transparent). Listeners are bound to root and classified by
    // where each touch STARTS, so multi-touch (move + look + buttons) coexists.
    this.root.appendChild(this._el("div", `${PREFIX}zone ${PREFIX}zone-move`));
    this.root.appendChild(this._el("div", `${PREFIX}zone ${PREFIX}zone-look`));

    // Joystick.
    this._stick = this._el("div", `${PREFIX}stick`);
    this._knob = this._el("div", `${PREFIX}knob`);
    this._stick.appendChild(this._knob);
    this.root.appendChild(this._stick);

    // Action buttons.
    this._fire = this._makeButton(`${PREFIX}fire`, "Fire");
    this._jump = this._makeButton(`${PREFIX}jump`, "Jump");
    this._kick = this._makeButton(`${PREFIX}kick`, "Kick");
    this._reload = this._makeButton(`${PREFIX}reload`, "Rld");
    this._wpn = this._makeButton(`${PREFIX}wpn`, "Wpn");
    this._pause = this._makeButton(`${PREFIX}pause`, "❚❚");
    for (const b of [this._fire, this._jump, this._kick, this._reload, this._wpn, this._pause]) {
      this.root.appendChild(b);
    }

    document.body.appendChild(this.root);

    this._bindButtons();
    this._bindAnalog();
  }

  _makeButton(cls, label) {
    return this._el("div", `${PREFIX}btn ${cls}`, label);
  }

  // ---- button wiring -------------------------------------------------------

  /** A press-and-hold button. `onDown`/`onUp` fire once per press; visual feedback. */
  _holdButton(el, onDown, onUp) {
    const press = (e) => {
      e.preventDefault();
      e.stopPropagation(); // keep the look/move zones from also grabbing this touch
      el.classList.add(`${PREFIX}down`);
      if (onDown) onDown();
    };
    const release = (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove(`${PREFIX}down`);
      if (onUp) onUp();
    };
    el.addEventListener("touchstart", press, { passive: false });
    el.addEventListener("touchend", release, { passive: false });
    el.addEventListener("touchcancel", release, { passive: false });
  }

  _bindButtons() {
    this._holdButton(this._fire, () => this._call("onFireDown"), () => this._call("onFireUp"));
    this._holdButton(this._jump, () => this._call("onKeyDown", "Space"), () => this._call("onKeyUp", "Space"));
    this._holdButton(this._kick, () => this._call("onKeyDown", "KeyF"), () => this._call("onKeyUp", "KeyF"));
    // Reload / weapon-switch / pause are one-shot on press.
    this._holdButton(this._reload, () => this._call("onReload"), null);
    this._holdButton(this._wpn, () => this._call("onSwitch"), null);
    this._holdButton(this._pause, () => this._call("onPause"), null);
  }

  // ---- analog (joystick + look) wiring -------------------------------------

  _bindAnalog() {
    this._onTouchStart = (e) => this._handleStart(e);
    this._onTouchMove = (e) => this._handleMove(e);
    this._onTouchEnd = (e) => this._handleEnd(e);
    this.root.addEventListener("touchstart", this._onTouchStart, { passive: false });
    this.root.addEventListener("touchmove", this._onTouchMove, { passive: false });
    this.root.addEventListener("touchend", this._onTouchEnd, { passive: false });
    this.root.addEventListener("touchcancel", this._onTouchEnd, { passive: false });
  }

  _handleStart(e) {
    const half = window.innerWidth / 2;
    for (const t of e.changedTouches) {
      if (t.clientX < half && this._moveId === null) {
        // Movement: anchor the joystick at its fixed base centre.
        this._moveId = t.identifier;
        const r = this._stick.getBoundingClientRect();
        this._stickCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        this._stickRadius = r.width / 2;
        this._updateStick(t.clientX, t.clientY);
        e.preventDefault();
      } else if (t.clientX >= half && this._lookId === null) {
        // Look: track incremental drag from this anchor.
        this._lookId = t.identifier;
        this._lookLast = { x: t.clientX, y: t.clientY };
        e.preventDefault();
      }
    }
  }

  _handleMove(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === this._moveId) {
        this._updateStick(t.clientX, t.clientY);
        e.preventDefault();
      } else if (t.identifier === this._lookId) {
        const dx = t.clientX - this._lookLast.x;
        const dy = t.clientY - this._lookLast.y;
        this._lookLast = { x: t.clientX, y: t.clientY };
        this._call("onLook", dx, dy);
        e.preventDefault();
      }
    }
  }

  _handleEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === this._moveId) {
        this._moveId = null;
        this._resetStick();
        e.preventDefault();
      } else if (t.identifier === this._lookId) {
        this._lookId = null;
        e.preventDefault();
      }
    }
  }

  /** Move the knob and emit the derived movement keys. */
  _updateStick(x, y) {
    let ox = x - this._stickCenter.x;
    let oy = y - this._stickCenter.y;
    const r = this._stickRadius || 64;
    const mag = Math.hypot(ox, oy);
    if (mag > r) {
      ox = (ox / mag) * r;
      oy = (oy / mag) * r;
    }
    this._knob.style.transform = `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px))`;
    this._call("onMove", joystickToKeys(ox / r, oy / r));
  }

  /** Recenter the knob and release all movement keys. */
  _resetStick() {
    this._knob.style.transform = "translate(-50%, -50%)";
    const released = {};
    for (const k of MOVE_KEYS) released[k] = false;
    this._call("onMove", released);
  }

  _call(name, ...args) {
    const fn = this._handlers[name];
    if (typeof fn === "function") fn(...args);
  }

  // ---- public API ----------------------------------------------------------

  /** Wire intent callbacks (see the class doc for the full list). */
  setHandlers(handlers = {}) {
    this._handlers = { ...this._handlers, ...handlers };
  }

  /** Show/hide the controls. Hiding releases any held inputs so nothing sticks. */
  setActive(on) {
    on = !!on;
    if (on === this._active) return;
    this._active = on;
    this.root.classList.toggle(`${PREFIX}hidden`, !on);
    if (!on) this._releaseAll();
  }

  /** Drop every held input (on hide / pause) so movement + fire never stick. */
  _releaseAll() {
    this._moveId = null;
    this._lookId = null;
    this._resetStick();
    this._fire.classList.remove(`${PREFIX}down`);
    this._jump.classList.remove(`${PREFIX}down`);
    this._kick.classList.remove(`${PREFIX}down`);
    this._call("onFireUp");
    this._call("onKeyUp", "Space");
    this._call("onKeyUp", "KeyF");
  }

  get active() {
    return this._active;
  }

  dispose() {
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    const style = document.getElementById(`${PREFIX}style`);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }
}

export default TouchControls;
