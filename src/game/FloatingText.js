import * as THREE from "three";
import gameState from "./GameState.js";

/**
 * FloatingText
 * ------------
 * World-anchored floating score/label popups ("KILL", "BREACH!", "BOOM!") that
 * rise + fade above the point where an event happened. Subscribes to the bus
 * (kill / breach / explosion) and projects each popup's world position to screen
 * each frame via `ctx.camera`.
 *
 * Performance (CONTRACTS.md §7, §9): a fixed POOL of reusable DOM nodes is built
 * once; events recycle nodes instead of creating them, and `update(dt)` reuses a
 * single scratch Vector3 — NO per-frame allocation, hard-capped concurrency.
 *
 * This is the only piece of Agent D's work that needs the DOM + three.js, so it
 * is kept out of the Node-side self-test (syntax-checked only).
 */

const POOL_SIZE = 14; // hard cap on concurrent popups
const LIFE = 0.9; // seconds a popup lives
const RISE = 0.9; // metres a popup floats upward over its life
const STYLE_ID = "bc-float-style";

class FloatingText {
  constructor() {
    /** Use the singleton bus directly; FloatingText is setup/UI code. */
    this.state = gameState;
    /** @type {object|null} shared context — needs `ctx.camera` for projection. */
    this.ctx = null;
    this._unsubs = [];
    this._attached = false;
    this._ownsStyle = false;
    // Reused across all projections to avoid per-frame allocation.
    this._scratch = new THREE.Vector3();

    this._injectStyle();

    // Full-screen, click-through layer that hosts every popup.
    this.layer = document.createElement("div");
    this.layer.className = "bc-float-layer";
    document.body.appendChild(this.layer);

    // Preallocate the pool — each entry owns one hidden DOM node + a world anchor.
    this.pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const el = document.createElement("div");
      el.className = "bc-float-item";
      this.layer.appendChild(el);
      this.pool.push({ el, active: false, life: 0, maxLife: LIFE, world: new THREE.Vector3() });
    }
  }

  /** Store the shared context (needs `ctx.camera`). Matches Player/Weapon. */
  setContext(ctx) {
    this.ctx = ctx;
  }

  /**
   * Subscribe to the combat bus events that carry a world `position`. Idempotent.
   * (Score events are intentionally skipped: they carry no position, so they
   * cannot be world-anchored — the HUD callout handles those.)
   */
  attach() {
    if (this._attached) return;
    this._attached = true;
    this._unsubs.push(
      this.state.on("kill", (p) => this._spawn(this._killLabel(p), p && p.position)),
      this.state.on("breach", (p) => this._spawn("BREACH!", p && p.position)),
      this.state.on("explosion", (p) => this._spawn("BOOM!", p && p.position)),
      this.state.on("loot", (p) => this._spawn((p && p.text) || "LOOT", p && p.position)),
    );
  }

  /** Pick the popup label for a kill, matching the game's voice (Weapon/Player). */
  _killLabel(p) {
    if (p && p.isKick) return "BOOT KILL!";
    if (p && p.isBarrel) return "KABOOM!";
    return "KILL";
  }

  /**
   * Activate a pooled popup at `position`. No-op when the payload has no usable
   * position (some emitters omit it). Recycles the dying-soonest popup when the
   * pool is saturated, so we never allocate and never exceed the cap.
   * @param {string} text
   * @param {{x:number,y:number,z:number}=} position
   */
  _spawn(text, position) {
    if (!position) return;
    const p = this._acquire();
    p.el.textContent = text;
    p.world.set(position.x, position.y, position.z);
    p.life = LIFE;
    p.maxLife = LIFE;
    p.active = true;
    // Positioned + revealed by the next update(); kept hidden until then so it
    // never flashes at a stale screen location.
  }

  /** @returns {object} a free pool entry, recycling the oldest if all are busy. */
  _acquire() {
    let oldest = null;
    for (const p of this.pool) {
      if (!p.active) return p;
      if (!oldest || p.life < oldest.life) oldest = p;
    }
    return oldest; // pool full — steal the one closest to death
  }

  /**
   * Advance, float, fade, and reproject every active popup. Culls expired ones
   * back to the pool. Reuses a single scratch vector; allocates nothing.
   * @param {number} dt seconds
   */
  update(dt) {
    const camera = this.ctx && this.ctx.camera;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        p.el.style.display = "none";
        continue;
      }
      if (!camera) continue; // no camera yet — keep ticking, stay hidden

      const frac = p.life / p.maxLife; // 1 → 0 over the popup's life
      const rise = (1 - frac) * RISE; // floats upward in world space
      // Project world anchor (+ rise) to normalized device coords, then to px.
      this._scratch.set(p.world.x, p.world.y + rise, p.world.z).project(camera);
      if (this._scratch.z > 1) {
        // Behind the camera — hide but keep the life ticking.
        p.el.style.display = "none";
        continue;
      }
      const x = (this._scratch.x * 0.5 + 0.5) * w;
      const y = (-this._scratch.y * 0.5 + 0.5) * h;
      p.el.style.display = "block";
      p.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      // Hold near full then fade out over the final stretch of life.
      p.el.style.opacity = Math.min(1, frac * 2.2).toFixed(3);
    }
  }

  /** Inject the scoped stylesheet once (shared across instances). */
  _injectStyle() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.bc-float-layer {
  position: fixed;
  inset: 0;
  z-index: 9;
  pointer-events: none;
  overflow: hidden;
}
.bc-float-item {
  position: absolute;
  left: 0;
  top: 0;
  display: none;
  opacity: 0;
  white-space: nowrap;
  transform: translate(-50%, -50%);
  will-change: transform, opacity;
  font-family: "Arial Narrow", "Inter", system-ui, sans-serif;
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #ff7a1a;
  text-shadow: 0 0 8px rgba(255, 122, 26, 0.72), 0 2px 4px rgba(0, 0, 0, 0.85);
}`;
    document.head.appendChild(style);
    this._ownsStyle = true;
  }

  /** Unsubscribe, tear down the DOM layer, and remove our injected style. */
  dispose() {
    for (const off of this._unsubs) {
      try {
        off();
      } catch (err) {
        console.warn("[FloatingText] unsubscribe failed:", err);
      }
    }
    this._unsubs.length = 0;
    this._attached = false;
    if (this.layer && this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
    this.layer = null;
    this.pool = [];
    if (this._ownsStyle) {
      const style = document.getElementById(STYLE_ID);
      if (style && style.parentNode) style.parentNode.removeChild(style);
      this._ownsStyle = false;
    }
  }
}

export default FloatingText;
export { FloatingText };
