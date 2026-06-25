import * as THREE from "three";
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
import { ShopTerminal } from "./game/ShopTerminal.js";
import ComboSystem from "./game/ComboSystem.js";
import FloatingText from "./game/FloatingText.js";
import { Juice } from "./game/Juice.js";
import { PauseMenu } from "./game/PauseMenu.js";
import { Modifiers } from "./game/Modifiers.js";
import { Achievements } from "./game/Achievements.js";
import { Abilities } from "./game/Abilities.js";
import { Decals } from "./game/Decals.js";
import { LoadingScreen } from "./game/LoadingScreen.js";
import { TouchControls, isTouchDevice } from "./game/TouchControls.js";
import { Gamepad } from "./game/Gamepad.js";

// Per-pixel look speed for the on-screen touch pad (rad/px). Touch drags are
// coarser than mouse motion, so this runs a touch hotter than the mouse default.
const TOUCH_LOOK_SENS = 0.0042;

// GTA-style loading slides — promo art that slow-scans during the pre-menu boot.
const LOADING_LOGO = "ui/bs-logo.png";
const LOADING_SLIDES = [
  "loading/deheader.jpg",
  "loading/skewlstabber.jpg",
  "loading/liestabber.jpg",
  "loading/grommer.jpg",
];
// The pre-operation loading screen plays this looping video (muted) with the logo.
const OPERATION_VIDEO = "loading/operation-loading.mp4";

// Served base ("/" in dev) — backdrops are resolved against it for CSS use.
const BASE = import.meta.env.BASE_URL || "/";
// Result-overlay backdrops: the victory hero art on a clear, and the loading
// stills (picked at random) on death or anywhere else the overlay appears.
const VICTORY_BG = `${BASE}ui/victory.jpg`;
const OVERLAY_BACKDROPS = LOADING_SLIDES.map((s) => `${BASE}${s}`);

const MAX_DT = 0.05;

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
    // Pre-menu loading screen up FIRST so it covers the whole boot + asset stream.
    this.loading = new LoadingScreen();
    this.loading.show(LOADING_SLIDES, { minMs: 2800, logo: LOADING_LOGO });
    this._loadingActive = false; // gates LEVEL input while a loading screen is up

    this.engine = new Engine(document.getElementById("app"));
    this.dom = this.engine.renderer.domElement;

    this.hud = new HUD();
    this.hud.setOverlayBackdrops(OVERLAY_BACKDROPS); // random loading still behind result/death cards
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
    // The laptop black-market shop: a CRT terminal overlay opened by dollying the
    // safehouse camera into the ThinkPad. Closing it reverses the dolly.
    this.shop = new ShopTerminal({ progression: this.progression });
    this.shop.setOnClose(() => {
      this.hub.setLaptopScreenVisible(true); // bring the static screen back
      this.menu.show(); // re-open the left safehouse panel
      this.hub.restoreCamera(() => this._setHubLabelsVisible(true));
    });
    this.levelManager = new LevelManager(this.engine.scene, this.assets, this.state);
    this.pauseMenu = new PauseMenu();
    this.modifiers = new Modifiers(this.state);
    this.abilities = new Abilities(this.state);
    this.decals = new Decals(this.engine.scene, 100);
    this.achievements = new Achievements(this.state);

    this._assetsReady = false;
    this.phase = "HUB"; // HUB | LEVEL | RESULTS
    this.paused = false; // transient pause within LEVEL
    this.time = 0;
    this._lastCombo = 0;
    this._resultsDied = false;
    this._muted = false;
    this._sprintHeld = false; // sprint button/L3 held (touch or gamepad) — shared by both

    // Shared context passed to every system each frame. `state`/`bus`/`juice`/
    // `progression` are the new fields the extended combat code reads (guarded).
    this.ctx = {
      dom: this.dom,
      active: false,
      // True on touch devices: input is gated on this instead of pointer lock,
      // which doesn't exist on mobile (see _computeActive / Weapon._canAct).
      touch: isTouchDevice(),
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
      abilities: this.abilities,
      onPlayerDeath: () => this._onDeath(),
      steamFirstKick: () => Steam.unlock("ACH_FIRST_KICK"),
    };
    this.player.setContext(this.ctx);
    this.weapon.setContext(this.ctx);
    this.juice.setContext(this.ctx);
    this.abilities.setContext(this.ctx);
    this.abilities.attach();
    this.decals.setContext(this.ctx);
    this.decals.attach();
    // Drive the HUD distortion from the adrenaline event.
    this.state.on("adrenaline", ({ active }) => this.hud.setAdrenaline(active));
    // Player kill bark + a messy splat on every elimination (splat positional).
    this.state.on("kill", (e) => {
      this.audio.killBark();
      this.audio.splat(e && e.position, this.player.position);
    });
    // Honor the persisted FX toggle (default on).
    const adrFx = this.state.getProgression().settings;
    if (adrFx && adrFx.adrenalineFx === false) this.hud.setAdrenalineFxEnabled(false);
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
      onResume: () => this._resume(),
      onRestart: () => this._loadLevel(this.levelManager.currentIndex),
      onQuit: () => this._enterHub(),
    });

    // Achievements: data-driven, bus-subscribing; persist unlocks via progression.
    this.achievements.setContext(this.ctx);
    this.achievements.setProviders({ progression: this.progression });
    this.achievements.attach();

    // Wire the safehouse menu. Upgrades/Story Logs are self-rendered sub-panels
    // inside Menu; we only need the launch + (optional) exit hooks. The level
    // manager backs the landline level-code dial.
    this.menu.setProviders({ progression: this.progression, levelManager: this.levelManager });
    // Safehouse Settings panel applies live, identical to the pause menu's.
    this.menu.setOnSettingsChange((s) => {
      this.player.sensitivity = s.sensitivity;
      this._applyQuality(s.quality);
    });
    this.menu.setHandlers({
      // "Start Operation" opens the sector-select panel (Menu handles it). These
      // fire from that panel: Continue resumes the campaign position; Deploy jumps
      // to a chosen already-unlocked sector.
      onStartOperation: () => this._startCampaign(),
      onContinue: () => this._startCampaign(),
      onSelectSector: (i) => { this._pendingSkipIndex = i; this._startCampaign(); },
      onUpgrades: () => {},
      onStoryLogs: () => {},
      onExit: () => {},
      // Landline dial accepted a valid code → remember the skip target for the
      // next "Start Operation" (door or button). indexForCode already bypassed
      // the unlock gate. We ALSO pay out RP for that code — but only the first
      // time it's entered (Progression.redeemCode guards against re-farming).
      onCodeAccepted: (index) => {
        this._pendingSkipIndex = index;
        // Reward scales with sector index so later (harder) levels pay more.
        // Upgrades cost 50–300 RP, so 150 + index*100 keeps each code worth a
        // purchase. index 0→150, 1→250, 2→350 ... 6→750.
        const code = this.levelManager.codeForIndex(index);
        const reward = 150 + index * 100;
        const { awarded } = this.progression.redeemCode(code, reward);
        // Unlock every sector up to and including the coded one for the sector
        // selector, and aim "Continue" at it. Persist so it survives a reload.
        const prog = this.state.getProgression();
        prog.unlockedLevels = Math.max(prog.unlockedLevels, index + 1);
        prog.campaignIndex = Math.max(prog.campaignIndex, index);
        this.progression.save();
        this.menu.refresh(); // repaint funds + sector panel if open
        void awarded;
      },
    });

    // Pending level-code skip (null = start the campaign at sector 1).
    this._pendingSkipIndex = null;

    // Safehouse 3D interaction: raycast clicks + project floating labels. Temps
    // are reused every frame so the HUB loop branch never allocates.
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._tmpProj = new THREE.Vector3();
    this._hubLabels = [];
    this._buildHubLabels();
    // World-anchored civilian locators + the level-1 door tutorial tip.
    this._victimLocatorsEl = document.getElementById("victim-locators");
    this._victimLocators = []; // [{ el, fill, victim }]
    this._doorTip = null; // { el } reused for the "F — KICK DOOR DOWN" tip on sector 1
    this._anchorTmp = new THREE.Vector3();
    // Pooled directional markers over the last few remaining invaders (cleanup helper).
    this._enemyMarkersEl = document.getElementById("enemy-markers");
    this._enemyMarkers = []; // pool of [{ el, enemy }] bound by enemy identity

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
      })
      .finally(() => {
        // Pan to the cover, hold, then fade the loading screen to reveal the menu.
        this.loading.finish();
      });

    this._bindUI();
    this._initTouchControls();
    this._initGamepad();
    window.addEventListener("resize", () => {
      this.assets.retro && this.assets.retro.setViewport(window.innerWidth, window.innerHeight);
    });
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
    this.hud.setAdrenaline(false);
    this.hud.setOperationCode(null);
    this._setHudVisible(false);
    this.hub.show();
    this.menu.refresh();
    this.menu.show();
    this._setHubLabelsVisible(true);
    this._setVictimLocatorsVisible(false); // civilian locators are LEVEL-only
    this.audio.setAmbient("HUB"); // menu ambience + drum + intermittent whistle
    this._syncTouchControls(); // hide the on-screen controls in the safehouse
  }

  /**
   * Menu "Start Operation" (button OR safehouse door): begin a campaign run.
   * Starts at sector 1 unless the player dialled a valid level code on the
   * safehouse landline, in which case we skip to that sector (one-shot).
   */
  _startCampaign() {
    if (!this._assetsReady) return; // still streaming Belfast; ignore until ready
    this.audio.init();
    this.menu.hide();
    this.hub.hide();
    this.score.resetAll();
    // Resume the persisted campaign position (next uncleared sector). Legacy saves
    // with no campaignIndex fall back to their furthest-reached sector. A dialed
    // level-code skip still overrides.
    const prog = this.state.getProgression();
    const resumeIndex =
      prog.campaignIndex > 0 ? prog.campaignIndex : Math.max(0, (prog.unlockedLevels || 1) - 1);
    const index =
      this._pendingSkipIndex != null && this._pendingSkipIndex >= 0
        ? this._pendingSkipIndex
        : resumeIndex;
    this._pendingSkipIndex = null; // consume the skip
    this.state.startRun({ levelIndex: index });
    // The FIRST deploy from the safehouse plays the operation intro VIDEO.
    this._deployWithLoading(index, { video: true });
  }

  /**
   * Deploy into a campaign sector behind a loading overlay. `video:true` plays the
   * operation intro clip to completion (the menu→operation start); `video:false`
   * runs the GTA-style image slides — used for every BETWEEN-operation transition.
   * Input stays gated and the heavy 3D render is skipped until the overlay reveals
   * the live scene. Call from a user gesture so _loadLevel's pointer-lock holds.
   */
  _deployWithLoading(index, { video = false } = {}) {
    this._loadingActive = true;
    if (video) {
      this.loading.show([], { logo: LOADING_LOGO, video: OPERATION_VIDEO, videoLoop: false });
    } else {
      this.loading.show(LOADING_SLIDES, { logo: LOADING_LOGO, minMs: 2800 });
    }
    this._loadLevel(index);
    // onReveal turns rendering back on UNDER the still-opaque frozen frame, so the
    // fade dissolves into the live sector instead of flashing a stale menu frame.
    this.loading
      .finish({ onReveal: () => this._revealLevel() })
      .then(() => this._revealLevel());
  }

  /** Lift the loading gate so the loop renders the live sector behind the fade. */
  _revealLevel() {
    if (!this._loadingActive) return; // idempotent (onReveal + finish() both call)
    this._loadingActive = false;
    this.ctx.active = this._computeActive();
    this._syncTouchControls();
  }

  /** Build + deploy into a campaign sector (LEVEL phase). */
  _loadLevel(index) {
    this.weapon.reset();
    // Every operation starts on the pistol, with only owned weapons selectable.
    this.weapon.setOwned(this.progression.getOwnedWeapons());
    this.weapon.setWeaponById("pistol");
    this.juice.reset();
    this._setHubLabelsVisible(false);
    this.pauseMenu.hide();
    this.modifiers.clear(); // drop any previous sector's modifier
    this.abilities.refresh();
    this.hud.setAdrenaline(false);
    this.decals.clear();

    const { entry } = this.levelManager.loadLevel(index);
    this.level = this.levelManager.level;
    this.ctx.level = this.level;
    // World-anchored civilian locators + the level-1 door tip for this sector.
    this._buildVictimLocators();
    this._setVictimLocatorsVisible(true);
    // Level-start title card: sector name + the standing objective. It fades itself
    // out as the loading gate lifts and the live scene reveals.
    const sectorName = (this.levelManager.name || (entry && entry.name) || `Sector ${index + 1}`).toUpperCase();
    this.hud.showTitleCard(`SECTOR ${index + 1} · ${sectorName}`, "Eliminate the Invaders and Save the Civilians");

    // Fresh per-level run stats so the bonus breakdown is per-sector (kills +
    // cumulative score carry across the run; the stat flags do not).
    const run = this.state.getState().run;
    Object.assign(run.stats, {
      damageTaken: 0,
      doorsBreached: 0,
      barrelKills: 0,
      bootKills: 0,
      shotsFired: 0,
      cratesOpened: 0,
      civiliansSaved: 0,
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
    // Surface the operation's 4-digit skip code so the player can note it and
    // dial it from the safehouse landline later (clearly labelled in the HUD).
    this.hud.setOperationCode(this.levelManager.codeForIndex(index));
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
    this._syncTouchControls(); // show on a touch restart; stays hidden behind a loader
    this.audio.setAmbient("LEVEL"); // level ambience (drum continues from the menu)
    // Defer the "look at all these…" bark until the world is actually up and the
    // player can see it: the loop fires it once we're a live, rendered, pointer-
    // locked LEVEL frame and ~1s has elapsed (not during the load transition).
    this._levelBarkAt = this.time + 1.0;
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
    this._syncTouchControls(); // hide the on-screen controls on the results card
    this.state.setPhase("RESULTS");
    this.pauseMenu.hide();
    this.hud.setCrosshairActive(false);
    this.hud.setAdrenaline(false);
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

    // £ reward (CONTRACTS §4), boosted by any run modifier. Kills, crates broken,
    // and civilians saved all feed the end-of-sector payout (kills already counted;
    // crates + civilians added per playtest feedback).
    const s = run.stats || {};
    const base = Math.floor(this.score.total / 100)
      + run.kills * 2
      + run.bestCombo * 2
      + (s.cratesOpened || 0) * 3
      + (s.civiliansSaved || 0) * 10;
    const scoreMul = this.modifiers.getScoreMul();
    const rp = Math.round((died ? base * 0.4 : base) * scoreMul);
    this.state.addCurrency(rp);
    // On a CLEAR, advance the persisted campaign position so the safehouse's
    // "Start Operation" resumes the next uncleared sector. Death leaves it
    // untouched (you retry the same sector).
    if (!died) {
      const prog = this.state.getProgression();
      prog.campaignIndex = Math.min(this.levelManager.currentIndex + 1, this.levelManager.levelCount - 1);
    }
    this.progression.save();
    this.state.endRun({ died });

    const last = !this.levelManager.hasNext();
    const bonusRows = bonuses.length
      ? bonuses.map((b) => `${b.label} <b>+${b.points}</b>`).join(" &nbsp;·&nbsp; ") + "<br/>"
      : "";

    let title;
    if (died) {
      title = "YOU WENT DOWN";
    } else if (last) {
      title = "BELFAST LIBERATED";
      Steam.unlock("ACH_BELFAST_LIBERATED").catch(() => {});
    } else {
      title = `${this.levelManager.name.toUpperCase()} CLEARED`;
    }

    this._resultsDied = died;
    this._resultsCampaignDone = last && !died;

    const outro = died ? "Belfast still needs you." : this.levelManager.outro || "";
    this.hud.showOverlay(
      title,
      `${outro}<br/>${bonusRows}Score <b>${this.score.total.toLocaleString()}</b> &nbsp;·&nbsp; Kills <b>${run.kills}</b><br/>Funds earned <b>+£${rp}</b>`,
      "",
    );
    // Backdrop: a clear shows the victory art, death a random loading still — both
    // with a LIGHT vignette so the background image reads clearly. Must run AFTER
    // showOverlay (which resets the backdrop to its dark default).
    if (!died) {
      this.hud.setOverlayBackground(VICTORY_BG, { center: 0.16, edge: 0.55 });
      this.audio.rescueJingle();
    } else {
      const backdrop = OVERLAY_BACKDROPS[Math.floor(Math.random() * OVERLAY_BACKDROPS.length)];
      this.hud.setOverlayBackground(backdrop, { center: 0.32, edge: 0.7 });
    }

    // Explicit choices: a survivable clear can push on to the next sector; every
    // result can fall back to the safehouse (CONTRACTS: HUB is always reachable).
    const actions = [];
    if (!died && !last) {
      actions.push({ label: "Next Operation", primary: true, onClick: () => this._handleResultsContinue() });
    }
    actions.push({
      label: "Return to Safehouse",
      primary: died || last,
      onClick: () => this._enterHub(),
    });
    this._resultsHasActions = this.hud.setOverlayActions(actions);

    Steam.submitScore(this.score.total).catch(() => {});
  }

  /** Advance from RESULTS: next sector on a clear, else back to the safehouse. */
  _handleResultsContinue() {
    if (this._resultsDied || this._resultsCampaignDone) {
      this._enterHub();
      return;
    }
    if (this.levelManager.hasNext()) {
      // Between operations: GTA-style image slides (no intro video).
      this._deployWithLoading(this.levelManager.nextIndex(), { video: false });
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
    let ratio = Math.min(window.devicePixelRatio || 1, pixelRatio);
    // Mobile GPUs choke on retina-density rendering; cap the cost even on "High"
    // so the on-screen-controls build stays smooth (the menu still tunes quality).
    if (this.ctx.touch) ratio = Math.min(ratio, 1.5);
    this.engine.renderer.setPixelRatio(ratio);
  }

  _bindUI() {
    // First user gesture anywhere unlocks audio (autoplay policy) and starts the
    // current phase's ambience — so the menu music/drum play while browsing.
    const unlockAudio = () => {
      this.audio.init();
      this.audio.setAmbient(this.phase);
    };
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });

    // The #overlay card is used only for PAUSED + RESULTS (HUB uses Menu).
    document.getElementById("overlay").addEventListener("click", () => this._handlePrimaryClick());
    this.dom.addEventListener("click", (e) => {
      if (this.phase === "HUB") {
        this._onHubClick(e);
      } else if (
        !this.ctx.touch && // touch play manages its own activation (no pointer lock)
        this.phase === "LEVEL" &&
        !this.paused &&
        document.pointerLockElement !== this.dom
      ) {
        this._requestLock();
      }
    });

    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === this.dom;
      // Pointer lock is a desktop-only concept; on touch we never request it, so
      // this handler's pause/resume logic must not run there.
      if (this.phase === "LEVEL" && !this.ctx.touch) {
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
      this.ctx.active = this._computeActive();
    });

    window.addEventListener("keydown", (e) => {
      if (e.code === "KeyM") this._toggleMute();
    });
  }

  /** Toggle mute + persist (shared by the M key and the gamepad Back/Share button). */
  _toggleMute() {
    this._muted = !this._muted;
    this.audio.setMuted(this._muted);
    const s = this.state.getProgression().settings;
    if (s) s.muted = this._muted;
    this.progression.save();
    this.hud.setObjective(this._muted ? "Muted 🔇" : "Eliminate all invaders");
  }

  _handlePrimaryClick() {
    if (this.phase === "LEVEL" && this.paused) {
      this._requestLock();
    } else if (this.phase === "RESULTS" && !this._resultsHasActions) {
      // Fallback only: with explicit result buttons present, the player chooses.
      this._handleResultsContinue();
    }
  }

  _requestLock() {
    this.hud.hideOverlay();
    if (this.ctx.touch) {
      // No pointer lock on touch — activate directly (a loader/pause still gates it).
      this.ctx.active = this._computeActive();
      this._syncTouchControls();
      return;
    }
    const p = this.dom.requestPointerLock?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }

  /**
   * Single source of truth for whether LEVEL input is live. Desktop requires
   * pointer lock; touch substitutes ctx.touch (no lock exists on mobile). With
   * touch === false this is identical to the original `… && locked` gate, so
   * desktop behaviour is unchanged.
   */
  _computeActive() {
    const locked = document.pointerLockElement === this.dom;
    return (
      this.phase === "LEVEL" && !this.paused && !this._loadingActive && (locked || this.ctx.touch)
    );
  }

  /** Build + wire the on-screen touch controls. No-op (null) on desktop. */
  /** Intent handlers shared by touch + gamepad (they report the same actions). */
  _inputHandlers() {
    return {
      onLook: (dx, dy) => this.player.applyLook(dx, dy, TOUCH_LOOK_SENS),
      onMove: (keys) => {
        for (const code in keys) this.player.keys[code] = keys[code];
        if (this._sprintHeld) this.player.keys["ShiftLeft"] = true;
      },
      onKeyDown: (code) => { this.player.keys[code] = true; },
      onKeyUp: (code) => { this.player.keys[code] = false; },
      onFireDown: () => {
        this.weapon.triggerHeld = true;
        this.weapon.tryFire();
      },
      onFireUp: () => { this.weapon.triggerHeld = false; },
      onReload: () => this.weapon.reload(),
      onSwitch: (dir = 1) => this.weapon.cycleWeapon(dir),
      onPause: () => this._pauseGame(),
      onMute: () => this._toggleMute(),
      onSprintDown: () => {
        this._sprintHeld = true;
        this.player.keys["ShiftLeft"] = true;
      },
      onSprintUp: () => {
        this._sprintHeld = false;
        this.player.keys["ShiftLeft"] = false;
      },
    };
  }

  _initTouchControls() {
    if (!this.ctx.touch) {
      this.touchControls = null;
      return;
    }
    this.touchControls = new TouchControls();
    // Gamepad emits radian look deltas; touch emits pixels needing TOUCH_LOOK_SENS.
    this.touchControls.setHandlers(this._inputHandlers());
    this._syncTouchControls();
  }

  /** Xbox / PS4 controller support (PC). Polled each frame in the LEVEL loop. */
  _initGamepad() {
    this.gamepad = new Gamepad();
    this.gamepad.setHandlers({
      ...this._inputHandlers(),
      onLook: (dx, dy) => this.player.applyLook(dx, dy, 1), // gamepad pre-scales to radians
    });
    this._syncTouchControls();
  }

  /** Gate the on-screen touch controls + gamepad polling to live LEVEL play. */
  _syncTouchControls() {
    const live = this.phase === "LEVEL" && !this.paused && !this._loadingActive;
    if (this.gamepad) this.gamepad.setActive(live);
    if (this.touchControls) this.touchControls.setActive(live);
  }

  /** Explicit pause (touch Pause button — mobile has no Esc / pointer-lock loss). */
  _pauseGame() {
    if (this.phase !== "LEVEL" || this.paused) return;
    this.paused = true;
    this.state.setPhase("PAUSED");
    this.pauseMenu.show();
    this.ctx.active = false;
    this._syncTouchControls();
  }

  /** Resume from the pause menu. Desktop re-locks the pointer; touch re-activates. */
  _resume() {
    this._sprintHeld = false;
    if (this.ctx.touch) {
      this.paused = false;
      this.state.setPhase("LEVEL");
      this.pauseMenu.hide();
      this.ctx.active = this._computeActive();
      this._syncTouchControls();
    } else {
      this._requestLock(); // desktop: lock → pointerlockchange unpauses
    }
  }

  // ---- safehouse 3D interaction (HUB) ------------------------------------

  /**
   * Build a floating DOM label per hub interactable, once. The labels live in
   * `#hub-labels` (index.html); their world anchors are fixed (hub fixtures
   * never move) so the loop only re-projects them each frame.
   */
  _buildHubLabels() {
    this._hubLabelsEl = this._hubLabelsEl || document.getElementById("hub-labels");
    if (!this._hubLabelsEl) return;
    const interactables = this.hub.getInteractables ? this.hub.getInteractables() : [];
    // Incremental + idempotent: late-streaming fixtures (the laptop registers
    // only once its GLB loads, after this first runs) get a label the moment
    // they appear. _updateHubLabels re-invokes this when the count grows.
    for (let i = this._hubLabels.length; i < interactables.length; i++) {
      const it = interactables[i];
      const el = document.createElement("div");
      el.className = "hub-label";
      el.textContent = it.label;
      el.style.opacity = "0";
      this._hubLabelsEl.appendChild(el);
      this._hubLabels.push({ el, anchor: it.anchor });
    }
  }

  /** Show/hide the whole floating-label layer (HUB only). */
  _setHubLabelsVisible(visible) {
    if (this._hubLabelsEl) this._hubLabelsEl.style.display = visible ? "block" : "none";
  }

  /** Project each interactable's world anchor to screen space (reused temps). */
  _updateHubLabels() {
    // Pick up any fixture that registered after the first build (e.g. the laptop).
    const live = this.hub.getInteractables ? this.hub.getInteractables().length : 0;
    if (live > this._hubLabels.length) this._buildHubLabels();
    if (!this._hubLabels.length) return;
    const cam = this.engine.camera;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const lbl of this._hubLabels) {
      this._tmpProj.copy(lbl.anchor).project(cam);
      const onScreen =
        this._tmpProj.z < 1 &&
        this._tmpProj.x >= -1.05 && this._tmpProj.x <= 1.05 &&
        this._tmpProj.y >= -1.05 && this._tmpProj.y <= 1.05;
      if (!onScreen) {
        lbl.el.style.opacity = "0";
        continue;
      }
      // Clamp within the viewport so edge fixtures (e.g. the wall phone) don't
      // bleed off-screen. Labels are centre-anchored (translateX(-50%)), so keep
      // a half-width margin; also avoid the left options panel (~40% width).
      const half = (lbl.el.offsetWidth || 220) / 2 + 8;
      const px = (this._tmpProj.x * 0.5 + 0.5) * w;
      lbl.el.style.left = `${Math.min(Math.max(px, half), w - half)}px`;
      lbl.el.style.top = `${(-this._tmpProj.y * 0.5 + 0.5) * h}px`;
      lbl.el.style.opacity = "1";
    }
  }

  /** Build a world-anchored locator per civilian + the level-1 door tip. Rebuilt
   *  each level (civilian sets differ). */
  _buildVictimLocators() {
    if (!this._victimLocatorsEl) return;
    this._victimLocatorsEl.replaceChildren();
    this._victimLocators = [];
    this._doorTip = null;
    if (!this.level) return;
    for (const v of this.level.victims) {
      const el = document.createElement("div");
      el.className = "victim-locator";
      el.style.opacity = "0";
      const icon = document.createElement("div");
      icon.className = "vl-icon";
      icon.textContent = "🗣"; // screaming/alert glyph (pulses via CSS)
      const bar = document.createElement("div");
      bar.className = "vl-bar";
      const fill = document.createElement("div");
      fill.className = "vl-fill";
      bar.appendChild(fill);
      el.appendChild(icon);
      el.appendChild(bar);
      this._victimLocatorsEl.appendChild(el);
      this._victimLocators.push({ el, fill, victim: v });
    }
    // Level-1 tutorial: a tip that floats over the nearest unopened door.
    if (this.level.index === 0) {
      const tip = document.createElement("div");
      tip.className = "world-tip";
      tip.textContent = "F — KICK DOOR DOWN";
      tip.style.opacity = "0";
      this._victimLocatorsEl.appendChild(tip);
      this._doorTip = { el: tip };
    }
  }

  /** Show/hide the world-anchored overlay layers (civilian locators + enemy markers; LEVEL only). */
  _setVictimLocatorsVisible(visible) {
    if (this._victimLocatorsEl) this._victimLocatorsEl.style.display = visible ? "block" : "none";
    if (this._enemyMarkersEl) this._enemyMarkersEl.style.display = visible ? "block" : "none";
  }

  /**
   * Directional markers over the last few remaining invaders (≤3) so a straggler
   * hidden in a building or wedged in a corner can always be found and the sector
   * cleared. Edge-clamped so it also points to off-screen / behind-camera enemies.
   */
  _updateEnemyMarkers() {
    if (!this._enemyMarkersEl || !this.level) return;
    const live = this.level.enemies.filter((e) => !e.dead);
    const SHOW_AT = 3;
    const targets = live.length > 0 && live.length <= SHOW_AT ? live : [];
    // Free any marker whose enemy is dead / cleared / no longer a target — so a
    // marker disappears the moment its enemy is killed (markers are bound to a
    // specific enemy, never re-pointed to a different one). Hide via `display`, NOT
    // opacity: the marker's pulse keyframes animate opacity, and a running animation
    // overrides an inline opacity, so an opacity-hidden marker would keep pulsing.
    for (const m of this._enemyMarkers) {
      if (!m.enemy || !targets.includes(m.enemy)) { m.el.style.display = "none"; m.enemy = null; }
    }
    const cam = this.engine.camera;
    const w = window.innerWidth, h = window.innerHeight;
    for (const e of targets) {
      let m = this._enemyMarkers.find((mm) => mm.enemy === e);
      if (!m) {
        m = this._enemyMarkers.find((mm) => !mm.enemy); // reuse a freed marker
        if (!m) {
          const el = document.createElement("div");
          el.className = "enemy-marker";
          el.textContent = "◆";
          el.style.display = "none";
          this._enemyMarkersEl.appendChild(el);
          m = { el, enemy: null };
          this._enemyMarkers.push(m);
        }
        m.enemy = e;
      }
      this._anchorTmp.copy(e.group.position); this._anchorTmp.y += 2.0;
      this._tmpProj.copy(this._anchorTmp).project(cam);
      let px = (this._tmpProj.x * 0.5 + 0.5) * w;
      let py = (-this._tmpProj.y * 0.5 + 0.5) * h;
      if (this._tmpProj.z > 1) { px = w - px; py = h - 24; } // behind camera → mirror to bottom edge
      const mar = 16;
      m.el.style.left = `${Math.min(Math.max(px, mar), w - mar)}px`;
      m.el.style.top = `${Math.min(Math.max(py, mar), h - mar)}px`;
      m.el.style.display = "block";
    }
  }

  /** Project the civilian locators (only while menaced) + the door tip each frame. */
  _updateVictimLocators() {
    if (!this._victimLocatorsEl || !this.level) return;
    const cam = this.engine.camera;
    const w = window.innerWidth, h = window.innerHeight;
    const project = (anchor, el) => {
      this._tmpProj.copy(anchor).project(cam);
      const onScreen = this._tmpProj.z < 1 &&
        this._tmpProj.x >= -1.05 && this._tmpProj.x <= 1.05 &&
        this._tmpProj.y >= -1.05 && this._tmpProj.y <= 1.05;
      if (!onScreen) { el.style.opacity = "0"; return; }
      const half = (el.offsetWidth || 60) / 2 + 6;
      const px = (this._tmpProj.x * 0.5 + 0.5) * w;
      el.style.left = `${Math.min(Math.max(px, half), w - half)}px`;
      el.style.top = `${(-this._tmpProj.y * 0.5 + 0.5) * h}px`;
      el.style.opacity = "1";
    };
    for (const loc of this._victimLocators) {
      const v = loc.victim;
      if (v.rescued || v.dead || v._menacedTimer <= 0) { loc.el.style.opacity = "0"; continue; }
      if (loc.fill) loc.fill.style.width = `${Math.max(0, Math.min(1, v.life / v.maxLife)) * 100}%`;
      this._anchorTmp.copy(v.group.position); this._anchorTmp.y += 1.8;
      project(this._anchorTmp, loc.el);
    }
    if (this._doorTip) {
      let near = null, best = 36; // within 6m
      for (const d of this.level.doors) {
        if (d.open) continue;
        const dx = d.center.x - this.player.position.x, dz = d.center.z - this.player.position.z;
        const ds = dx * dx + dz * dz;
        if (ds < best) { best = ds; near = d; }
      }
      if (near) {
        this._anchorTmp.copy(near.center); this._anchorTmp.y += 0.6;
        project(this._anchorTmp, this._doorTip.el);
      } else {
        this._doorTip.el.style.opacity = "0";
      }
    }
  }

  /** Raycast a HUB cursor click against the hub interactables and dispatch. */
  _onHubClick(e) {
    if (this.phase !== "HUB" || (this.shop && this.shop.isOpen())) return;
    const interactables = this.hub.getInteractables ? this.hub.getInteractables() : [];
    if (!interactables.length) return;

    const rect = this.dom.getBoundingClientRect();
    this._ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._ndc, this.engine.camera);

    const objects = interactables.map((it) => it.object3D);
    const hits = this._raycaster.intersectObjects(objects, true);
    if (!hits.length) return;

    // Walk up the hit object's ancestry to find which interactable it belongs to.
    let node = hits[0].object;
    while (node) {
      const match = interactables.find((it) => it.object3D === node);
      if (match) {
        this._dispatchHubAction(match.id);
        return;
      }
      node = node.parent;
    }
  }

  /** Map a hub interactable id to its action. */
  _dispatchHubAction(id) {
    if (id === "start") {
      this.menu.openSectors(); // open the sector-select panel (Continue / pick a sector)
    } else if (id === "upgrades") {
      this._openLaptopShop();
    } else if (id === "phone") {
      this.menu.openDial();
    }
  }

  /** Click the upgrades fixture → dolly the camera into the laptop, then open
   *  the CRT black-market shop overlay once the dolly settles. */
  _openLaptopShop() {
    if (this.shop.isOpen()) return;
    this._setHubLabelsVisible(false);
    this.menu.hide(); // collapse the left safehouse panel while at the laptop
    this.hub.zoomToLaptop(() => {
      this.hub.setLaptopScreenVisible(false); // the DOM panel becomes the screen
      // Lay the terminal over the lid; the provider re-projects on resize.
      this.shop.open(() => this.hub.laptopScreenRect());
    });
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
      this.gamepad?.poll(realDt); // controller look/move/fire — applied before player.update
      this._update(dt);
      // Apply shake AFTER player.update (Player._applyCamera rewrites the camera
      // every frame, so the offset must be layered on top here, post-update).
      const cam = this.engine.camera;
      cam.position.x += shake.x;
      cam.position.y += shake.y;
      cam.position.z += shake.z;
      if (shake.roll) cam.rotateZ(shake.roll);
      this.floating.update(realDt);
      // Level-start bark: only once we're live + rendered + pointer-locked in the
      // level and the short delay has passed (so it doesn't play over the load).
      if (this._levelBarkAt && this.time >= this._levelBarkAt) {
        this._levelBarkAt = 0;
        this.audio.levelStartBark();
      }
    } else if (this.phase === "HUB") {
      this.hub.update(realDt);
      this._updateHubLabels();
    }

    this.hud.update(dt);
    this.engine.update(dt);
    // While the operation loading screen is up it fully covers the canvas, so skip
    // the heavy 3D render — that frees the main thread for smooth video playback.
    if (!this._loadingActive) {
      this.engine.render(this.phase === "HUB" ? this.hub.scene : null);
    }
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
    // Civilian urgency: top-right status bar (saved count + aggregate wellbeing) +
    // world-anchored locators.
    this.hud.setCivilians(this.level.victimCount || 0, this.level.victimsSaved, this.level.civilianWellbeing);
    this._updateVictimLocators();
    this._updateEnemyMarkers();
  }
}

window.addEventListener("DOMContentLoaded", () => new Game());
