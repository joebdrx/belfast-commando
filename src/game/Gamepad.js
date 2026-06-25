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
 *   Left stick   Move (push to rim = sprint)   Right stick  Look
 *   RT           Fire                          L3           Sprint (hold)
 *   A            Jump                           B           Slide / crouch
 *   X            Reload                         Y           Kick
 *   LB / RB      Prev / next weapon            Start        Pause
 *   Back/Share   Mute
 */
import { joystickToKeys } from "./TouchControls.js";

// Standard-mapping button indices (Xbox and DualShock 4 both report these).
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, RT: 7, BACK: 8, START: 9, L3: 10 };

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
    this._wasMoving = false; // so a centred stick doesn't stomp keyboard WASD
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

    // Move: left stick → movement keys (joystickToKeys owns its own deadzone + rim sprint).
    // Only emit while the stick is deflected (+ one release) so a centred stick with a
    // controller merely plugged in never stomps keyboard WASD.
    const moveKeys = joystickToKeys(pad.axes[0] || 0, pad.axes[1] || 0);
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
    if (rising(BTN.L3)) this._call("onSprintDown"); if (falling(BTN.L3)) this._call("onSprintUp");

    // One-shot actions on the rising edge.
    if (rising(BTN.X)) this._call("onReload");
    if (rising(BTN.RB)) this._call("onSwitch", 1);
    if (rising(BTN.LB)) this._call("onSwitch", -1);
    if (rising(BTN.START)) this._call("onPause");
    if (rising(BTN.BACK)) this._call("onMute");

    this._prev = cur;
  }

  /** Drop held inputs so nothing sticks when leaving live play. @private */
  _release() {
    if (this._fireHeld) { this._fireHeld = false; this._call("onFireUp"); }
    if (this._wasMoving) { this._call("onMove", joystickToKeys(0, 0)); this._wasMoving = false; }
    this._call("onKeyUp", "Space");
    this._call("onKeyUp", "ControlLeft");
    this._call("onKeyUp", "KeyF");
    this._call("onSprintUp");
    this._prev = [];
  }
}
