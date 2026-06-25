import * as THREE from "three";
import { Level } from "./Level.js";
import LEVELS from "../data/levels.json";
import gameState from "./GameState.js";

// Reused scratch so the per-frame distance test never allocates (CONTRACTS §9).
const _tmp = new THREE.Vector3();

/**
 * LevelManager
 * ------------
 * The campaign layer that sits ABOVE the existing procedural `Level`. It does
 * NOT reimplement or modify `Level` — it composes one per campaign entry from
 * `levels.json`, drives the level's per-frame `update`, and adds the single new
 * gameplay beat the campaign needs: an EXTRACTION objective.
 *
 * Flow per level:
 *   1. `loadLevel(i)` builds `new Level(scene, seed, assets)` and a hidden
 *      extraction marker (a glowing flare beam + spinning ring). Emits
 *      `levelStart`.
 *   2. While invaders remain, the marker stays disarmed/hidden.
 *   3. When `level.enemiesRemaining === 0` the marker ARMS (becomes visible and
 *      animates); emits `levelClear` then `extractReady`.
 *   4. When the player walks into the extraction radius, emits `extracted` and
 *      fires the orchestrator's transition callback.
 *
 * IMPORTANT (see INTEGRATION NOTES): the orchestrator calls
 * `levelManager.update(dt, ctx)` INSTEAD of `level.update(dt, ctx)`. This class
 * calls `this.level.update` exactly once so doors + enemies still tick. The
 * orchestrator keeps `ctx.level = levelManager.level` (the real `Level`) so all
 * existing Player/Weapon reads (`ctx.level.enemies`, `.getColliders()`,
 * `.explodeBarrel()`, …) keep working untouched.
 *
 * See CONTRACTS.md §2 (Level API), §3 (events + run.levelId note) and §5
 * (levels.json schema). Event names are LAW: levelStart, levelClear,
 * extractReady, extracted.
 */
export class LevelManager {
  /**
   * @param {THREE.Scene} scene the active LEVEL scene the Level builds into.
   * @param {object|null} assets AssetManager (passed straight to `new Level`).
   * @param {object} state GameState singleton (state + event bus).
   */
  constructor(scene, assets = null, state = gameState) {
    this.scene = scene;
    this.assets = assets;
    this.state = state;

    /** @type {Level|null} */
    this.level = null;
    this._index = 0;
    /** @type {object|null} the active `levels.json` entry. */
    this.entry = null;

    // Extraction objective state.
    this.armed = false; // becomes true once the sector is clear
    this.extracted = false; // becomes true once the player reaches the volume
    /** @type {{center:THREE.Vector3, r:number}|null} */
    this.extraction = null;
    /** @type {THREE.Group|null} visible extraction marker (beam + ring). */
    this.marker = null;
    this._markerTime = 0; // animation accumulator

    // Convenience mirrors of the current Level's deploy transform.
    this.spawn = null;
    this.spawnYaw = 0;

    // Orchestrator-supplied transition callback (set via setOnExtract).
    this._onExtract = null;
  }

  // ---- campaign loading ----------------------------------------------------

  /**
   * Dispose any current level/marker and compose the campaign entry at `index`.
   * The index is clamped to the valid range so callers can pass `nextIndex()`
   * without bounds-checking.
   * @param {number} index 0-based campaign index.
   * @returns {{level:Level, entry:object}}
   */
  loadLevel(index) {
    // Clamp/validate against the authored campaign.
    const i = Math.max(0, Math.min(LEVELS.length - 1, index | 0));
    const entry = LEVELS[i];

    // Tear down the previous level + marker before building the next.
    if (this.level) {
      this.level.dispose();
      this.level = null;
    }
    this._disposeMarker();

    // Difficulty keys off the campaign index `i` (counts, archetype mix, stat
    // scaling); the LAYOUT gets a fresh per-run seed so enemy/victim/cover
    // placement varies every deploy (keeps the deterministic mulberry32 within a run).
    const layoutSeed = (Math.random() * 0xffffffff) >>> 0;
    this.level = new Level(this.scene, i, this.assets, layoutSeed);
    this._index = i;
    this.entry = entry;

    // Reset extraction state for the fresh sector.
    this.armed = false;
    this.extracted = false;
    this._markerTime = 0;

    // Extraction volume: authored point, else run-back-to-spawn default.
    const ex = entry.extraction;
    const center = ex
      ? new THREE.Vector3(ex.x, 0, ex.z)
      : new THREE.Vector3(this.level.spawn.x, 0, this.level.spawn.z);
    const r = ex && typeof ex.r === "number" ? ex.r : 4;
    this.extraction = { center, r };
    this._buildMarker(center, r);

    // Mirror the level deploy transform for the orchestrator.
    this.spawn = this.level.spawn;
    this.spawnYaw = this.level.spawnYaw || 0;

    // Publish the run identity, then announce the level (CONTRACTS §3).
    const run = this.state.getState().run;
    run.levelId = entry.id;
    run.levelIndex = i;
    this.state.emit("levelStart", { levelId: entry.id, index: i });

    return { level: this.level, entry };
  }

  /**
   * Build the extraction marker: a translucent additive flare beam with a
   * spinning ground ring. Added hidden (disarmed) and only shown once armed.
   */
  _buildMarker(center, r) {
    const group = new THREE.Group();
    group.position.set(center.x, 0, center.z);
    group.visible = false; // disarmed: hidden until the sector is clear

    // Extraction-flare green; additive + no depth-write so it reads as light.
    const glow = 0x39ff14;

    const beamMat = new THREE.MeshBasicMaterial({
      color: glow,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    // A tall searchlight column that shoots well up into the sky, widening as it
    // rises, so the extraction point reads as a landmark from clear across the
    // sector (not just a low stub near the ground).
    const BEAM_H = 70;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 0.5, BEAM_H, 16, 1, true), beamMat);
    beam.position.y = BEAM_H / 2;
    group.add(beam);

    // Spinning ground ring sized to the trigger radius so the volume is legible.
    const ringMat = new THREE.MeshBasicMaterial({
      color: glow,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ringPivot = new THREE.Group();
    ringPivot.position.y = 0.25;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.max(1.2, r * 0.7), 0.14, 8, 36), ringMat);
    ring.rotation.x = -Math.PI / 2; // lay flat on the street
    ringPivot.add(ring);
    group.add(ringPivot);

    this.scene.add(group);
    this.marker = group;
    this._beamMat = beamMat;
    this._ringPivot = ringPivot;
  }

  /** Remove + free the current marker (geometry + the additive materials). */
  _disposeMarker() {
    if (!this.marker) return;
    this.scene.remove(this.marker);
    this.marker.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    });
    this.marker = null;
    this._beamMat = null;
    this._ringPivot = null;
  }

  // ---- per-frame -----------------------------------------------------------

  /**
   * Drive the campaign for one frame. The orchestrator calls THIS instead of
   * `level.update`, so we tick the Level exactly once here, then run the
   * extraction state machine.
   * @param {number} dt seconds.
   * @param {object} ctx shared loop context (needs `ctx.player`).
   */
  update(dt, ctx) {
    if (!this.level) return;

    // Tick doors + enemies (the one and only call into the Level each frame).
    this.level.update(dt, ctx);

    // Arm the extraction the instant the last invader drops.
    if (!this.armed && this.level.enemiesRemaining === 0) {
      this.armed = true;
      if (this.marker) this.marker.visible = true;
      if (ctx && ctx.hud) ctx.hud.showTitleCard("Invaders Rooted Out", "Go to extraction beacon");
      this.state.emit("levelClear", { stats: this.state.getState().run.stats });
      this.state.emit("extractReady", {});
    }

    // Animate + test the trigger only while armed and not yet extracted.
    if (this.armed && this.marker) {
      this._markerTime += dt;
      this._ringPivot.rotation.y += dt * 1.4; // slow spin
      // Pulse the beam so it reads as a live beacon.
      this._beamMat.opacity = 0.4 + 0.22 * Math.sin(this._markerTime * 3.2);
    }

    if (this.armed && !this.extracted) {
      const p = ctx.player && ctx.player.position;
      if (p) {
        const c = this.extraction.center;
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        if (dx * dx + dz * dz <= this.extraction.r * this.extraction.r) {
          this.extracted = true;
          this.state.emit("extracted", {});
          if (this._onExtract) this._onExtract();
        }
      }
    }
  }

  /**
   * Register the orchestrator's transition callback fired once the player
   * reaches the extraction volume. Keeps LevelManager free of any main.js import.
   * @param {Function} fn
   */
  setOnExtract(fn) {
    this._onExtract = fn;
  }

  // ---- getters / delegates -------------------------------------------------

  /** @returns {string} current level display name. */
  get name() {
    return this.entry ? this.entry.name : "";
  }

  /** @returns {string} in-character mission intro line. */
  get intro() {
    return this.entry ? this.entry.intro : "";
  }

  /** @returns {string} in-character mission outro line. */
  get outro() {
    return this.entry ? this.entry.outro : "";
  }

  /** @returns {number} active campaign index. */
  get currentIndex() {
    return this._index;
  }

  /** @returns {boolean} true when another campaign level follows this one. */
  hasNext() {
    return this._index + 1 < LEVELS.length;
  }

  /** @returns {number} index to load next (clamped to the last level). */
  nextIndex() {
    return Math.min(this._index + 1, LEVELS.length - 1);
  }

  /** @returns {number} total authored campaign levels. */
  get levelCount() {
    return LEVELS.length;
  }

  // ---- level codes (skip-to-level) -----------------------------------------

  /**
   * The 4-digit skip code for the campaign entry at `index`.
   * @param {number} index 0-based campaign index.
   * @returns {string|null} the code, or null if `index` is out of range.
   */
  codeForIndex(index) {
    const i = index | 0;
    if (i < 0 || i >= LEVELS.length) return null;
    const entry = LEVELS[i];
    return entry && entry.code != null ? String(entry.code) : null;
  }

  /**
   * The campaign index whose code matches `code`. Normalizes by trimming and
   * comparing as a string, and bypasses the `unlockedLevels` gate entirely
   * (codes are meant to skip ahead).
   * @param {string} code the entered 4-digit code.
   * @returns {number} the matching 0-based index, or -1 if none matches.
   */
  indexForCode(code) {
    if (code == null) return -1;
    const want = String(code).trim();
    if (!want) return -1;
    for (let i = 0; i < LEVELS.length; i++) {
      const c = LEVELS[i] && LEVELS[i].code;
      if (c != null && String(c).trim() === want) return i;
    }
    return -1;
  }

  /** @returns {number} live invader count (delegates to the Level). */
  get enemiesRemaining() {
    return this.level ? this.level.enemiesRemaining : 0;
  }

  /** Active movement colliders (delegates to the Level; for player physics). */
  getColliders() {
    return this.level ? this.level.getColliders() : [];
  }

  // Convenience pass-throughs so a caller holding the manager can still reach
  // the Level's arrays. The orchestrator keeps `ctx.level = this.level`, so the
  // existing Player/Weapon code reads the real Level directly — these are extra.
  /** @returns {import("./Level.js").Level['doors']} */
  get doors() {
    return this.level ? this.level.doors : [];
  }

  get enemies() {
    return this.level ? this.level.enemies : [];
  }

  get barrels() {
    return this.level ? this.level.barrels : [];
  }

  // ---- teardown ------------------------------------------------------------

  /** Dispose the current level and remove the extraction marker from the scene. */
  dispose() {
    if (this.level) {
      this.level.dispose();
      this.level = null;
    }
    this._disposeMarker();
  }
}
