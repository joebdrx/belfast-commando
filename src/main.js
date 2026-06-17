import { Engine } from "./game/Engine.js";
import { AssetManager } from "./game/AssetManager.js";
import { Player } from "./game/Player.js";
import { Weapon } from "./game/Weapon.js";
import { Audio } from "./game/Audio.js";
import { HUD } from "./game/HUD.js";
import { Score } from "./game/Score.js";
import { Steam } from "./utils/steam.js";

// --- Hybrid Gameplay Loop systems (Hub → Level → Results → Hub) -------------
import gameState from "./game/GameState.js";
import Progression from "./game/Progression.js";
import { LevelManager } from "./game/LevelManager.js";
import { Hub } from "./game/Hub.js";
import { Menu } from "./game/Menu.js";
import ComboSystem from "./game/ComboSystem.js";
import FloatingText from "./game/FloatingText.js";
import { Juice } from "./game/Juice.js";
import { PauseMenu } from "./game/PauseMenu.js";
import { Modifiers } from "./game/Modifiers.js";
import { Achievements } from "./game/Achievements.js";

const MAX_DT = 0.05;

const CONTROLS_HTML = `
  <div class="controls-grid">
    <span>Move</span><b>W A S D</b>
    <span>Sprint</span><b>Shift</b>
    <span>Jump</span><b>Space</b>
    <span>Slide</span><b>Ctrl / C (while sprinting)</b>
    <span>Kick</span><b>F</b>
    <span>Shoot</span><b>Left Mouse</b>
    <span>Weapons</span><b>1 2 3 / Q</b>
    <span>Mute</span><b>M</b>
  </div>`;

/**
 * Game
 * ----
 * Top-level controller for the Hybrid Gameplay Loop. Owns the engine + every
 * system and runs the single rAF loop. The game flows through GamePhases:
 *
 *   HUB     — the safehouse (Hub scene + Menu). Spend Resistance Points, read
 *             story logs, launch an operation. No pointer lock.
 *   LEVEL   — an arcade campaign sector (the original FPS gameplay, unchanged).
 *             Clear every invader to ARM the extraction beacon, then reach it.
 *             Pointer-lock loss drops into a transient PAUSED overlay.
 *   RESULTS — score + bonus breakdown + Resistance Points earned. On a clear,
 *             continue to the next sector; on death, return to the Hub with a
 *             partial reward (the marquee roguelite edge case).
 *
 * The original MVP (controls, kick, shooting, enemies, clear-the-sector) lives
 * untouched inside LEVEL. Everything new hooks in via the GameState event bus
 * and the per-frame Juice service.
 */
class Game {
  constructor() {
    this.engine = new Engine(document.getElementById("app"));
    this.dom = this.engine.renderer.domElement;

    this.hud = new HUD();
    this.audio = new Audio();
    this.score = new Score(this.hud);
    this.player = new Player(this.engine.camera, this.dom);

    // --- Persistent progression: load the save BEFORE anything reads RP. ----
    this.state = gameState;
    this.progression = new Progression(this.state);
    this.progression.load(); // hydrates RP / upgrades / boots / settings (localStorage)

    // Shared PBR materials build instantly (flat fallback); textures + GLBs
    // stream in. Gate "deploy" on this so we never start on the fallback grid.
    this.assets = new AssetManager(this.engine.renderer);
    this.weapon = new Weapon(this.engine.camera, this.engine.scene, this.assets);

    // --- New loop systems --------------------------------------------------
    this.juice = new Juice();
    this.combo = new ComboSystem(this.state);
    this.floating = new FloatingText();
    this.hub = new Hub(this.engine.camera, this.assets);
    this.menu = new Menu();
    this.levelManager = new LevelManager(this.engine.scene, this.assets, this.state);
    this.pauseMenu = new PauseMenu();
    this.modifiers = new Modifiers(this.state);
    this.achievements = new Achievements(this.state);

    this._assetsReady = false;
    this.phase = "HUB"; // HUB | LEVEL | RESULTS
    this.paused = false; // transient pause within LEVEL
    this.time = 0;
    this._lastCombo = 0;
    this._resultsDied = false;
    this._muted = false;

    // Shared context passed to every system each frame. `state`/`bus`/`juice`/
    // `progression` are the new fields the extended combat code reads (guarded).
    this.ctx = {
      dom: this.dom,
      active: false,
      camera: this.engine.camera,
      scene: this.engine.scene,
      audio: this.audio,
      hud: this.hud,
      score: this.score,
      player: this.player,
      weapon: this.weapon,
      level: null,
      time: 0,
      state: this.state,
      bus: this.state,
      juice: this.juice,
      progression: this.progression,
      modifiers: this.modifiers,
      onPlayerDeath: () => this._onDeath(),
      steamFirstKick: () => Steam.unlock("ACH_FIRST_KICK"),
    };
    this.player.setContext(this.ctx);
    this.weapon.setContext(this.ctx);
    this.juice.setContext(this.ctx);
    this.combo.setContext(this.ctx);
    this.floating.setContext(this.ctx);
    this.floating.attach();

    // Apply persisted settings (sensitivity + mute + graphics quality).
    const settings = this.state.getProgression().settings || {};
    if (settings.sensitivity) this.player.sensitivity = settings.sensitivity;
    this._muted = !!settings.muted;
    this.audio.setMuted(this._muted);
    this._applyQuality(settings.quality || "high");

    // Pause menu (replaces the bare PAUSED card) — settings persist live.
    this.pauseMenu.setProviders({ progression: this.progression });
    this.pauseMenu.setOnSettingsChange((s) => {
      this.player.sensitivity = s.sensitivity;
      this._applyQuality(s.quality);
    });
    this.pauseMenu.setHandlers({
      onResume: () => this._requestLock(),
      onRestart: () => this._loadLevel(this.levelManager.currentIndex),
      onQuit: () => this._enterHub(),
    });

    // Achievements: data-driven, bus-subscribing; persist unlocks via progression.
    this.achievements.setContext(this.ctx);
    this.achievements.setProviders({ progression: this.progression });
    this.achievements.attach();

    // Wire the safehouse menu. Upgrades/Story Logs are self-rendered sub-panels
    // inside Menu; we only need the launch + (optional) exit hooks.
    this.menu.setProviders({ progression: this.progression });
    this.menu.setHandlers({
      onStartOperation: () => this._startCampaign(),
      onUpgrades: () => {},
      onStoryLogs: () => {},
      onExit: () => {},
    });

    // Extraction reached → finish the level.
    this.levelManager.setOnExtract(() => this._completeLevel());

    this.assets
      .load(this.engine.scene)
      .then(() => {
        this.weapon._buildViewmodel(); // refresh once gun GLBs are in
        this._assetsReady = true;
        this.menu.refresh();
      })
      .catch((e) => {
        console.warn("[assets]", e);
        this._assetsReady = true; // let the player in on the fallback grid
      });

    this._bindUI();
    this._enterHub();

    this._last = performance.now();
    requestAnimationFrame(this._loop.bind(this));

    if (import.meta.env.DEV) window.__game = this; // dev-only debug handle
  }

  // ---- phase transitions -------------------------------------------------

  /** Enter the safehouse: show the Hub scene + Menu, drop pointer lock + HUD. */
  _enterHub() {
    this.phase = "HUB";
    this.paused = false;
    this.ctx.active = false;
    this.state.setPhase("HUB");
    if (document.pointerLockElement) document.exitPointerLock();
    this.pauseMenu.hide();
    this.modifiers.clear();
    this.hud.setCrosshairActive(false);
    this.hud.hideOverlay();
    this._setHudVisible(false);
    this.hub.show();
    this.menu.refresh();
    this.menu.show();
  }

  /** Menu "Start Operation": begin a fresh campaign run at sector 1. */
  _startCampaign() {
    if (!this._assetsReady) return; // still streaming Belfast; ignore until ready
    this.audio.init();
    this.menu.hide();
    this.hub.hide();
    this.score.resetAll();
    this.state.startRun({ levelIndex: 0 });
    this._loadLevel(0);
  }

  /** Build + deploy into a campaign sector (LEVEL phase). */
  _loadLevel(index) {
    this.weapon.reset();
    this.juice.reset();
    this.pauseMenu.hide();
    this.modifiers.clear(); // drop any previous sector's modifier

    const { entry } = this.levelManager.loadLevel(index);
    this.level = this.levelManager.level;
    this.ctx.level = this.level;

    // Fresh per-level run stats so the bonus breakdown is per-sector (kills +
    // cumulative score carry across the run; the stat flags do not).
    const run = this.state.getState().run;
    Object.assign(run.stats, {
      damageTaken: 0,
      doorsBreached: 0,
      barrelKills: 0,
      bootKills: 0,
      shotsFired: 0,
      noDamage: true,
      levelTime: 0,
    });
    run.combo = 0;
    run.bestCombo = 0;
    this._lastCombo = 0;
    this.combo.resetLevel();

    // Apply the persisted "Thick Skin" upgrade to max health before reset.
    const hpBonus = this.progression.getUpgradeEffectValue("thick_skin");
    this.player.maxHealth = Math.round(100 * (1 + hpBonus));
    this.player.reset(this.levelManager.spawn, this.levelManager.spawnYaw || 0);
    this.score.reset();

    // Roll + apply a per-run modifier (e.g. "Rainy Night") AFTER spawn/reset, so
    // it scales the fresh enemies + player knobs.
    this.modifiers.maybeRoll(entry);
    this.modifiers.applyToLevel(this.level, this.player);
    const mod = this.modifiers.getActive();

    // Unlock story content as the campaign progresses.
    const prog = this.state.getProgression();
    prog.unlockedLevels = Math.max(prog.unlockedLevels, index + 1);
    this.progression.save();

    this.hud.setLevel(index + 1);
    this.hud.setWeapon(this.weapon.current.name);
    this.hud.setAmmo(this.weapon.ammo[this.weapon.index], this.weapon.current.mag, false);
    this.hud.setObjective(
      mod ? `${entry.intro || "Eliminate all invaders"}  ·  ⚠ ${mod.name}` : entry.intro || "Eliminate all invaders",
    );
    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.hideOverlay();
    this.hud.setCrosshairActive(true);
    this._setHudVisible(true);

    this.phase = "LEVEL";
    this.paused = false;
    this.state.setPhase("LEVEL");
    this._requestLock();
    this.audio.voice(["Right lads, let's go!", "Forward, Belfast!", "Boots on, move!"]);
  }

  /** Extraction reached — the sector is won. */
  _completeLevel() {
    if (this.phase !== "LEVEL") return;
    this._toResults(false);
  }

  /** Player died mid-sector — run ends with a partial reward. */
  _onDeath() {
    if (this.phase !== "LEVEL") return;
    this._toResults(true);
  }

  /**
   * RESULTS: roll up the sector — apply end-of-level bonuses to the score,
   * bank Resistance Points (full on a clear, 40% on death), persist, and show
   * the breakdown overlay.
   */
  _toResults(died) {
    this.phase = "RESULTS";
    this.paused = false;
    this.ctx.active = false;
    this.state.setPhase("RESULTS");
    this.pauseMenu.hide();
    this.hud.setCrosshairActive(false);
    if (document.pointerLockElement) document.exitPointerLock();

    const run = this.state.getState().run;
    this.state.recordStat("levelTime", this.score.levelTime);

    const entry = this.levelManager.entry || {};
    const par = Number.isFinite(entry.par) ? entry.par : 45;

    // Bonuses only on a clear (you didn't earn them if you went down).
    const bonuses = died ? [] : this.combo.computeBonuses(run, par);
    const bonusSum = bonuses.reduce((a, b) => a + b.points, 0);
    if (bonusSum) {
      this.score.total += bonusSum;
      this.hud.setScore(this.score.total, this.score.combo, this.score.multiplier);
    }
    run.score = this.score.total;

    // Resistance Points reward (CONTRACTS §4), boosted by any run modifier.
    // Uses the per-sector best combo (run.bestCombo), not the cross-run total.
    const base = Math.floor(this.score.total / 100) + run.kills * 2 + run.bestCombo * 2;
    const scoreMul = this.modifiers.getScoreMul();
    const rp = Math.round((died ? base * 0.4 : base) * scoreMul);
    this.state.addCurrency(rp);
    this.progression.save();
    this.state.endRun({ died });

    const last = !this.levelManager.hasNext();
    const bonusRows = bonuses.length
      ? bonuses.map((b) => `${b.label} <b>+${b.points}</b>`).join(" &nbsp;·&nbsp; ") + "<br/>"
      : "";

    let title;
    let hint;
    if (died) {
      title = "YOU WENT DOWN";
      hint = "Click to fall back to the safehouse";
    } else if (last) {
      title = "BELFAST LIBERATED";
      hint = "Click to return to the safehouse";
      Steam.unlock("ACH_BELFAST_LIBERATED").catch(() => {});
    } else {
      title = `${this.levelManager.name.toUpperCase()} CLEARED`;
      hint = "Click for the next sector";
    }

    const outro = died ? "Belfast still needs you." : this.levelManager.outro || "";
    this.hud.showOverlay(
      title,
      `${outro}<br/>${bonusRows}Score <b>${this.score.total.toLocaleString()}</b> &nbsp;·&nbsp; Kills <b>${run.kills}</b><br/>Resistance Points earned <b>+${rp}</b>`,
      hint,
    );
    Steam.submitScore(this.score.total).catch(() => {});

    this._resultsDied = died;
    this._resultsCampaignDone = last && !died;
  }

  /** Advance from RESULTS: next sector on a clear, else back to the safehouse. */
  _handleResultsContinue() {
    if (this._resultsDied || this._resultsCampaignDone) {
      this._enterHub();
      return;
    }
    if (this.levelManager.hasNext()) {
      this._loadLevel(this.levelManager.nextIndex());
    } else {
      this._enterHub();
    }
  }

  // ---- input / pointer lock ---------------------------------------------

  /** Toggle the in-game HUD corners (hidden in HUB, shown in LEVEL/RESULTS). */
  _setHudVisible(visible) {
    const hud = document.getElementById("hud");
    if (hud) hud.style.display = visible ? "" : "none";
  }

  /** Apply the graphics-quality setting to the renderer pixel ratio. */
  _applyQuality(quality) {
    const { pixelRatio } = this.pauseMenu.qualityToRenderer(quality);
    this.engine.renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatio));
  }

  _bindUI() {
    // The #overlay card is used only for PAUSED + RESULTS (HUB uses Menu).
    document.getElementById("overlay").addEventListener("click", () => this._handlePrimaryClick());
    this.dom.addEventListener("click", () => {
      if (this.phase === "LEVEL" && !this.paused && document.pointerLockElement !== this.dom) {
        this._requestLock();
      }
    });

    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === this.dom;
      if (this.phase === "LEVEL") {
        if (!locked && !this.paused) {
          // Soft pause when the player tabs out / hits Esc → the pause menu.
          this.paused = true;
          this.state.setPhase("PAUSED");
          this.pauseMenu.show();
        } else if (locked && this.paused) {
          this.paused = false;
          this.state.setPhase("LEVEL");
          this.pauseMenu.hide();
        }
      }
      this.ctx.active = this.phase === "LEVEL" && !this.paused && locked;
    });

    window.addEventListener("keydown", (e) => {
      if (e.code === "KeyM") {
        this._muted = !this._muted;
        this.audio.setMuted(this._muted);
        const s = this.state.getProgression().settings;
        if (s) s.muted = this._muted;
        this.progression.save();
        this.hud.setObjective(this._muted ? "Muted 🔇" : "Eliminate all invaders");
      }
    });
  }

  _handlePrimaryClick() {
    if (this.phase === "LEVEL" && this.paused) {
      this._requestLock();
    } else if (this.phase === "RESULTS") {
      this._handleResultsContinue();
    }
  }

  _requestLock() {
    this.hud.hideOverlay();
    const p = this.dom.requestPointerLock?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }

  // ---- main loop ---------------------------------------------------------

  _loop(now) {
    requestAnimationFrame(this._loop.bind(this));
    let realDt = (now - this._last) / 1000;
    this._last = now;
    if (realDt > MAX_DT) realDt = MAX_DT; // clamp after stalls

    // Juice drives time-scale (hitstop) + a camera shake offset. It advances the
    // particle pool internally, so the loop never ticks particles separately.
    const { timeScale, shake } = this.juice.update(realDt);
    const dt = realDt * Math.max(0.05, timeScale);
    this.time += dt;
    this.ctx.time = this.time;

    if (this.phase === "LEVEL" && this.ctx.active) {
      this._update(dt);
      // Apply shake AFTER player.update (Player._applyCamera rewrites the camera
      // every frame, so the offset must be layered on top here, post-update).
      const cam = this.engine.camera;
      cam.position.x += shake.x;
      cam.position.y += shake.y;
      cam.position.z += shake.z;
      if (shake.roll) cam.rotateZ(shake.roll);
      this.floating.update(realDt);
    } else if (this.phase === "HUB") {
      this.hub.update(realDt);
    }

    this.hud.update(dt);
    this.engine.update(dt);
    this.engine.render(this.phase === "HUB" ? this.hub.scene : null);
  }

  _update(dt) {
    this.score.update(dt);
    this.player.update(dt);
    this.weapon.update(dt);
    // LevelManager ticks the Level (doors + enemies) exactly once and runs the
    // extraction beacon; on reaching the beacon it fires _completeLevel().
    this.levelManager.update(dt, this.ctx);

    // Bridge the live combo to the run state so the STYLE bonus, FloatingText,
    // and combo-driven systems see it — without touching the existing Score code.
    if (this.score.combo !== this._lastCombo) {
      this.state.setCombo(this.score.combo);
      this._lastCombo = this.score.combo;
    }

    // HUD readouts
    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.setTimer(this.score.levelTime);
    const remaining = this.level.enemiesRemaining;
    this.hud.setObjective(
      remaining > 0 ? `Invaders remaining: ${remaining}` : "Sector clear — reach the extraction beacon!",
    );
  }
}

window.addEventListener("DOMContentLoaded", () => new Game());
