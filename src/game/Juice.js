import * as THREE from "three";
import { Particles } from "./Particles.js";

// Intensity clamp for shakes (metres-ish camera offset). The contract suggests
// ~0.05–0.4; we accept a slightly wider 0.02–0.5 band and cap the SUMMED output
// so stacking many shakes can never fling the camera off the rails.
const SHAKE_MIN = 0.02;
const SHAKE_MAX = 0.5;
const SHAKE_SUM_CAP = 0.6;

// Pooled shake slots. Plenty for overlapping hits; new shakes recycle the
// weakest slot so nothing is ever allocated in shake() or update().
const MAX_SHAKES = 8;

// Time scale held during a hitstop, eased back toward 1 as the freeze expires.
const HITSTOP_SCALE = 0.15;

/**
 * Juice
 * -----
 * The game-feel service (CONTRACTS.md §6). Exposes the exact hooks the
 * orchestrator drives — `shake`, `hitStop`, `spawnImpact`, `playSfx`, `update`
 * — and composes a pooled `Particles` emitter.
 *
 * CRITICAL CONTRACT: Juice never touches the camera and never mutates dt. Its
 * `update(dt)` only RETURNS `{ timeScale, shake:{x,y,z,roll} }`. The orchestrator
 * is responsible for (a) multiplying the gameplay dt by `timeScale` (clamped
 * ≥0.05) and (b) ADDING the shake offset to the camera AFTER `player.update`
 * (which rewrites camera.position/quaternion each frame). See INTEGRATION NOTES.
 *
 * Allocation-free hot path: every returned object, the shake slots, and the
 * particle pool are preallocated and mutated in place.
 */
export class Juice {
  /** @param {object|null} ctx shared game context (may be set later via setContext) */
  constructor(ctx = null) {
    this.ctx = null;
    this.particles = null;

    // Preallocated pool of shake slots: {intensity, remaining, duration}. A slot
    // with remaining<=0 is free. No per-event allocation, no per-frame splice.
    this._shakes = [];
    for (let i = 0; i < MAX_SHAKES; i++) {
      this._shakes.push({ intensity: 0, remaining: 0, duration: 1 });
    }

    // Single hitstop timer (the strongest request wins).
    this._hitstop = { remaining: 0, duration: 1 };

    // The reused shake offset object — same reference every frame.
    this._shakeOut = { x: 0, y: 0, z: 0, roll: 0 };
    // The reused return object — orchestrator reads { timeScale, shake } each frame.
    this._out = { timeScale: 1, shake: this._shakeOut };

    if (ctx) this.setContext(ctx);
  }

  /**
   * Wire up (or rewire) the shared context. Lazily creates the Particles pool the
   * first time a scene is available — matches Player/Weapon's setContext pattern.
   * @param {object} ctx must eventually carry `scene`, `audio`, `camera`
   */
  setContext(ctx) {
    this.ctx = ctx;
    if (!this.particles && ctx && ctx.scene) {
      this.particles = new Particles(ctx.scene);
    }
  }

  // ---- hooks (CONTRACTS.md §6) -------------------------------------------

  /**
   * Queue an additive camera shake. Multiple shakes stack (their faded
   * intensities sum, capped). Reuses a pooled slot — no allocation.
   * @param {number} intensity camera offset magnitude (clamped 0.02–0.5)
   * @param {number} ms duration in milliseconds
   */
  shake(intensity, ms) {
    const amt = Math.max(SHAKE_MIN, Math.min(SHAKE_MAX, intensity));
    const dur = Math.max(0.001, ms / 1000);

    // Find a free slot; otherwise recycle the one with the least remaining time.
    let slot = null;
    let weakest = this._shakes[0];
    for (let i = 0; i < MAX_SHAKES; i++) {
      const s = this._shakes[i];
      if (s.remaining <= 0) {
        slot = s;
        break;
      }
      if (s.remaining < weakest.remaining) weakest = s;
    }
    if (!slot) slot = weakest;

    slot.intensity = amt;
    slot.remaining = dur;
    slot.duration = dur;
  }

  /**
   * Request a brief global slow-mo / freeze. The strongest (longest) outstanding
   * request wins; never shortens an active freeze.
   * @param {number} ms freeze duration in milliseconds
   */
  hitStop(ms) {
    const dur = Math.max(0, ms / 1000);
    if (dur > this._hitstop.remaining) {
      this._hitstop.remaining = dur;
      this._hitstop.duration = dur || 1;
    }
  }

  /**
   * Spawn an impact particle burst (routes to the pooled emitter). No-op until
   * the Particles pool exists (i.e. before a scene-bearing ctx is set).
   * @param {THREE.Vector3} position world-space origin
   * @param {"kick"|"explosion"|"blood"|"spark"} type
   */
  spawnImpact(position, type) {
    if (this.particles) this.particles.emit(position, type);
  }

  /**
   * Play a synthesized SFX by id, delegating to the existing Audio service.
   * Documented id set: "kick" | "explosion" | "hit" | "kill" | "switch" | "ui".
   * Unknown ids warn + no-op (never throw). Spatial cues (explosion) fall back to
   * Audio's non-positional default; the orchestrator can call ctx.audio directly
   * when it has a real source position to pass.
   * @param {string} id documented SFX id
   */
  playSfx(id) {
    const audio = this.ctx && this.ctx.audio;
    if (!audio) return;
    switch (id) {
      case "kick":
        audio.kick();
        break;
      case "explosion":
        // No source position available through this hook → use Audio's default
        // (non-positional) volume. Listener is the camera if Audio wants one.
        audio.explosion();
        break;
      case "hit":
        audio.hit();
        break;
      case "kill":
        audio.kill();
        break;
      case "switch":
        audio.switchWeapon();
        break;
      case "ui":
        audio.uiBlip();
        break;
      default:
        console.warn(`[Juice] playSfx: unknown id "${id}"`);
    }
  }

  /**
   * Per-frame tick. Decays shakes + hitstop, advances particles, and RETURNS the
   * reused `{ timeScale, shake }` object. Allocation-free.
   *
   * IMPORTANT: pass the REAL (unscaled) frame dt so timers stay wall-clock; the
   * orchestrator applies the returned timeScale to the GAMEPLAY dt itself.
   * @param {number} dt real seconds since last frame
   * @returns {{timeScale:number, shake:{x:number,y:number,z:number,roll:number}}}
   */
  update(dt) {
    // --- Shakes: decay each slot, accumulate faded intensity ----------------
    let sum = 0;
    for (let i = 0; i < MAX_SHAKES; i++) {
      const s = this._shakes[i];
      if (s.remaining <= 0) continue;
      s.remaining -= dt;
      if (s.remaining <= 0) {
        s.remaining = 0;
        continue;
      }
      sum += s.intensity * (s.remaining / s.duration); // fade 1 → 0 over its life
    }
    if (sum > SHAKE_SUM_CAP) sum = SHAKE_SUM_CAP;

    // Cheap per-frame jitter; mutate the SAME offset object every frame. When
    // sum is 0 the offset is exactly 0,0,0,0 (decays cleanly to rest).
    const o = this._shakeOut;
    o.x = (Math.random() * 2 - 1) * sum;
    o.y = (Math.random() * 2 - 1) * sum;
    o.z = (Math.random() * 2 - 1) * sum * 0.5;
    o.roll = (Math.random() * 2 - 1) * sum * 0.6;

    // --- Hitstop: decay + ease the time scale back toward 1 -----------------
    let timeScale = 1;
    if (this._hitstop.remaining > 0) {
      this._hitstop.remaining -= dt;
      if (this._hitstop.remaining <= 0) {
        this._hitstop.remaining = 0;
      } else {
        // Ease from HITSTOP_SCALE back up to 1 as the freeze runs out.
        const k = 1 - this._hitstop.remaining / this._hitstop.duration; // 0 → 1
        timeScale = HITSTOP_SCALE + (1 - HITSTOP_SCALE) * k;
      }
    }
    this._out.timeScale = timeScale;

    // Advance the cosmetic particle pool with the same dt Juice received.
    if (this.particles) this.particles.update(dt);

    return this._out;
  }

  /** Hide all live particles without tearing down the pool (e.g. on level reset). */
  reset() {
    for (let i = 0; i < MAX_SHAKES; i++) this._shakes[i].remaining = 0;
    this._hitstop.remaining = 0;
    if (this.particles) this.particles.clear();
  }

  /** Tear down the particle pool. */
  dispose() {
    if (this.particles) {
      this.particles.dispose();
      this.particles = null;
    }
  }
}
