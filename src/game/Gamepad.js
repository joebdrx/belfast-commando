/**
 * Gamepad
 * -------
 * Xbox and PS4 (DualShock 4) controller support on PC via the W3C Gamepad API.
 * Browsers expose BOTH pads through the same "standard" mapping, so one button/
 * axis layout covers both — there is no per-brand code here.
 *
 * Like TouchControls, this owns NO game objects: it polls the connected pad each
 * frame and reports intent through callbacks set via setHandlers(), which the
 * orchestrator wires to Player/Weapon/pause (the very handlers touch already
 * uses). poll(dt) must be called each frame during live play.
 *
 *   Left stick   Move                          Right stick  Look
 *   LS (L3)      Sprint (hold)                 RT           Fire
 *   A            Jump                           B           Slide / crouch
 *   X            Reload                         Y           Kick
 *   RS (R3)      Interact (E — free civilian)
 *   LB / RB      Prev / next weapon            Start        Pause
 *   Back/Share   Mute
 *
 * Transport-agnostic: wired or Bluetooth makes no difference — once the OS pairs
 * the pad, the browser presents it through the same Gamepad API "standard" map.
 */
import { joystickToKeys } from "./TouchControls.js";

// Standard-mapping button indices (Xbox and DualShock 4 both report these).
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11 };

// Calibration knobs (tune to taste; the physical feel can't be derived on paper).
const LOOK_DEADZONE = 0.18; // right-stick centre slop
const TURN_RATE = 3.2; // radians/sec of look at full right-stick deflection
const TRIGGER_THRESH = 0.4; // RT travel that counts as "firing"

/** One-axis deadzone: 0 inside `dz`, rescaled to keep the full [0,1] range outside. */
export function applyDeadzone(v, dz = LOOK_DEADZONE) {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

export class Gamepad {
  constructor() {
    this._handlers = {};
    this._active = false;
    this._prev = []; // previous per-button pressed states (rising/falling edges)
    this._fireHeld = false;
    this._sprintActive = false; // LT/L3 sprint state (LT is analog, edge-detected here)
    this._wasMoving = false; // so a centred stick doesn't stomp keyboard WASD
    // Menu-navigation state (pollMenu): focus index over the open menu's buttons.
    this._navRoot = null;
    this._navIndex = 0;
    this._navCount = -1;
    this._navPrev = [];
    this._navLatch = false;
    this._navEngaged = false; // becomes true only once the pad is actually used in a menu
    this._navStyled = false;
  }

  /** Wire intent callbacks (same shape as TouchControls, plus onMute + onSwitch(dir)). */
  setHandlers(handlers = {}) {
    this._handlers = handlers || {};
  }

  /** Gate polling to live LEVEL play. Leaving play releases any held inputs. */
  setActive(v) {
    if (this._active === v) return;
    this._active = v;
    if (!v) this._release();
  }

  /** True if any standard-mapping pad is currently connected (for a connect hint). */
  isConnected() {
    return this._pads().some((p) => p && p.connected);
  }

  _pads() {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return [];
    return Array.from(navigator.getGamepads() || []);
  }

  _call(name, ...args) {
    const fn = this._handlers[name];
    if (typeof fn === "function") fn(...args);
  }

  /** First connected pad, preferring the standard mapping. */
  _pick() {
    let fallback = null;
    for (const p of this._pads()) {
      if (!p || !p.connected) continue;
      if (p.mapping === "standard") return p;
      fallback = fallback || p;
    }
    return fallback;
  }

  /** Read the chosen pad and emit intents. `dt` in real seconds (look is framerate-independent). */
  poll(dt) {
    if (!this._active) return;
    const pad = this._pick();
    if (!pad) { this._prev = []; return; }

    const prev = this._prev;
    const cur = pad.buttons.map((b) => !!(b && b.pressed));
    const rising = (i) => cur[i] && !prev[i];
    const falling = (i) => !cur[i] && prev[i];

    // Look: right stick → look velocity. Squared response for fine aim near centre.
    let lx = applyDeadzone(pad.axes[2] || 0);
    let ly = applyDeadzone(pad.axes[3] || 0);
    lx *= Math.abs(lx); ly *= Math.abs(ly);
    if (lx || ly) this._call("onLook", lx * TURN_RATE * dt, ly * TURN_RATE * dt);

    // Move: left stick → movement keys. joystickToKeys auto-sprints at the rim,
    // but on a controller that drains stamina just by moving — so clear it and let
    // the LS (L3) click be the deliberate sprint button instead. Only emit while
    // deflected (+ one release) so a centred-but-plugged-in pad never stomps WASD.
    const moveKeys = joystickToKeys(pad.axes[0] || 0, pad.axes[1] || 0);
    moveKeys.ShiftLeft = false; // no auto-sprint from stick deflection
    const moving = moveKeys.KeyW || moveKeys.KeyS || moveKeys.KeyA || moveKeys.KeyD;
    if (moving || this._wasMoving) this._call("onMove", moveKeys);
    this._wasMoving = moving;

    // Fire: edge-detected on the analog right trigger.
    const rt = pad.buttons[BTN.RT] ? pad.buttons[BTN.RT].value : 0;
    const fire = rt >= TRIGGER_THRESH || cur[BTN.RT];
    if (fire && !this._fireHeld) { this._fireHeld = true; this._call("onFireDown"); }
    else if (!fire && this._fireHeld) { this._fireHeld = false; this._call("onFireUp"); }

    // Held actions follow button state via key up/down edges.
    if (rising(BTN.A)) this._call("onKeyDown", "Space"); if (falling(BTN.A)) this._call("onKeyUp", "Space");
    if (rising(BTN.B)) this._call("onKeyDown", "ControlLeft"); if (falling(BTN.B)) this._call("onKeyUp", "ControlLeft");
    if (rising(BTN.Y)) this._call("onKeyDown", "KeyF"); if (falling(BTN.Y)) this._call("onKeyUp", "KeyF");
    if (rising(BTN.R3)) this._call("onKeyDown", "KeyE"); if (falling(BTN.R3)) this._call("onKeyUp", "KeyE");

    // Sprint: LS (left-stick click / L3) — a deliberate hold, not automatic.
    const sprint = cur[BTN.L3];
    if (sprint && !this._sprintActive) { this._sprintActive = true; this._call("onSprintDown"); }
    else if (!sprint && this._sprintActive) { this._sprintActive = false; this._call("onSprintUp"); }

    // One-shot actions on the rising edge.
    if (rising(BTN.X)) this._call("onReload");
    if (rising(BTN.RB)) this._call("onSwitch", 1);
    if (rising(BTN.LB)) this._call("onSwitch", -1);
    if (rising(BTN.START)) this._call("onPause");
    if (rising(BTN.BACK)) this._call("onMute");

    this._prev = cur;
  }

  /**
   * Menu navigation: call each frame while a DOM menu is open (pause, safehouse,
   * laptop shop, results). Drives focus among the menu's visible <button>s and
   * fires their EXISTING click handlers — no per-menu rewrite. D-pad / left stick
   * move the highlight, A activates, B calls onBack. `root` is the open menu's
   * container element; pass the same one each frame (a change resets focus).
   * ponytail: flat top-to-bottom focus list, one step per press (no auto-repeat).
   */
  pollMenu(root, onBack) {
    const pad = this._pick();
    if (!pad || !root) { this._navRoot = null; return; }
    this._ensureNavStyle();
    const items = Array.from(root.querySelectorAll("button")).filter((b) => !b.disabled && b.offsetParent !== null);
    if (!items.length) { this._navRoot = root; this._navCount = 0; return; }
    // Reset when the menu (or its re-rendered view) changes. _navEngaged stays off
    // until the player actually uses the pad, so a merely-connected controller never
    // hijacks focus from a mouse/keyboard player.
    if (root !== this._navRoot) {
      this._navRoot = root; this._navIndex = 0; this._navPrev = []; this._navEngaged = false;
    }
    if (items.length !== this._navCount) { this._navCount = items.length; this._navIndex = 0; }
    this._navIndex = Math.min(this._navIndex, items.length - 1);

    const cur = pad.buttons.map((b) => !!(b && b.pressed));
    const prev = this._navPrev;
    const rose = (i) => cur[i] && !prev[i];

    // d-pad: one step per press. Left stick: latched (push past 0.5, recentre to repeat).
    const sx = applyDeadzone(pad.axes[0] || 0, 0.5);
    const sy = applyDeadzone(pad.axes[1] || 0, 0.5);
    let dir = 0;
    if (rose(12) || rose(14)) dir = -1;
    else if (rose(13) || rose(15)) dir = 1;
    else if (!this._navLatch) {
      if (sy <= -0.5 || sx <= -0.5) { dir = -1; this._navLatch = true; }
      else if (sy >= 0.5 || sx >= 0.5) { dir = 1; this._navLatch = true; }
    }
    if (Math.abs(sx) < 0.3 && Math.abs(sy) < 0.3) this._navLatch = false;

    // Engage only on real input; until then don't touch focus (mouse/kb stay in
    // control). The engaging press only reveals focus — it never activates, so a
    // first A-press can't fire the default button by surprise.
    let justEngaged = false;
    if (!this._navEngaged) {
      if (dir || rose(0) || rose(1)) { this._navEngaged = true; justEngaged = true; }
      else { this._navPrev = cur; return; }
    }
    if (dir) this._navIndex = (this._navIndex + dir + items.length) % items.length;

    const focused = items[this._navIndex];
    items.forEach((b) => b.classList.toggle("gp-nav-focus", b === focused));
    if (focused && typeof document !== "undefined" && document.activeElement !== focused) {
      try { focused.focus({ preventScroll: true }); } catch (e) { /* not focusable yet */ }
      if (focused.scrollIntoView) focused.scrollIntoView({ block: "nearest" });
    }
    if (!justEngaged) {
      if (rose(0) && focused) focused.click();                // A → activate
      if (rose(1) && typeof onBack === "function") onBack();  // B → back / close
    }

    this._navPrev = cur;
  }

  /** Inject the focus-highlight style once (orange ring matching the game accent). */
  _ensureNavStyle() {
    if (this._navStyled || typeof document === "undefined") return;
    this._navStyled = true;
    const s = document.createElement("style");
    s.textContent =
      ".gp-nav-focus{outline:2px solid #ff7a1a !important;outline-offset:2px;" +
      "box-shadow:0 0 0 3px rgba(255,122,26,0.4) !important;border-radius:4px;}";
    document.head.appendChild(s);
  }

  /** Drop held inputs so nothing sticks when leaving live play. @private */
  _release() {
    if (this._fireHeld) { this._fireHeld = false; this._call("onFireUp"); }
    if (this._wasMoving) { this._call("onMove", joystickToKeys(0, 0)); this._wasMoving = false; }
    this._call("onKeyUp", "Space");
    this._call("onKeyUp", "ControlLeft");
    this._call("onKeyUp", "KeyF");
    this._call("onKeyUp", "KeyE");
    if (this._sprintActive) { this._sprintActive = false; this._call("onSprintUp"); }
    this._prev = [];
  }
}
