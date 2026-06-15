import { Engine } from "./game/Engine.js";
import { Level } from "./game/Level.js";
import { Player } from "./game/Player.js";
import { Weapon } from "./game/Weapon.js";
import { Audio } from "./game/Audio.js";
import { HUD } from "./game/HUD.js";
import { Score } from "./game/Score.js";
import { Steam } from "./utils/steam.js";

const NUM_LEVELS = 3;
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
 * Top-level controller: owns the engine and all systems, runs the fixed-ish
 * game loop, manages pointer-lock + the menu/play/result state machine, and
 * drives level progression and Steam achievement / leaderboard hooks.
 */
class Game {
  constructor() {
    this.engine = new Engine(document.getElementById("app"));
    this.dom = this.engine.renderer.domElement;

    this.hud = new HUD();
    this.audio = new Audio();
    this.score = new Score(this.hud);
    this.player = new Player(this.engine.camera, this.dom);
    this.weapon = new Weapon(this.engine.camera, this.engine.scene);

    this.state = "menu"; // menu | playing | paused | dead | complete | victory
    this.levelIndex = 0;
    this.level = null;
    this.time = 0;

    // Shared context passed to every system.
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
      onPlayerDeath: () => this._onDeath(),
      steamFirstKick: () => Steam.unlock("ACH_FIRST_KICK"),
    };
    this.player.setContext(this.ctx);
    this.weapon.setContext(this.ctx);

    this._bindUI();
    this._showMenu();

    this._last = performance.now();
    requestAnimationFrame(this._loop.bind(this));
  }

  // ---- state -------------------------------------------------------------

  _showMenu() {
    this.state = "menu";
    this.ctx.active = false;
    this.hud.setCrosshairActive(false);
    this.hud.showOverlay(
      "BELFAST COMMANDO",
      `Kick down the doors. Boot the invaders out of Belfast.<br/>Keep moving — chain kicks and shots for a bigger multiplier.${CONTROLS_HTML}`,
      "Click to deploy",
    );
  }

  _startGame() {
    this.audio.init();
    this.score.resetAll();
    this.levelIndex = 0;
    this._loadLevel(0);
  }

  _loadLevel(index) {
    if (this.level) this.level.dispose();
    this.weapon.reset();
    this.level = new Level(this.engine.scene, index);
    this.ctx.level = this.level;
    this.levelIndex = index;

    this.player.reset(this.level.spawn, 0);
    this.score.reset();

    this.hud.setLevel(index + 1);
    this.hud.setWeapon(this.weapon.current.name);
    this.hud.setObjective("Breach to the exit gate");
    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.hideOverlay();
    this.hud.setCrosshairActive(true);

    this.state = "playing";
    this._requestLock();
    this.audio.voice(["Right lads, let's go!", "Forward, Belfast!", "Boots on, move!"]);
  }

  _completeLevel() {
    this.state = "complete";
    this.ctx.active = false;
    this.hud.setCrosshairActive(false);
    document.exitPointerLock();
    const { bonus, time } = this.score.finishLevel();

    if (this.levelIndex + 1 >= NUM_LEVELS) {
      this._victory();
      return;
    }
    const bestMult = Math.min(5, 1 + this.score.bestCombo * 0.25);
    this.hud.showOverlay(
      `SECTOR ${this.levelIndex + 1} CLEARED`,
      `Time ${time.toFixed(1)}s &nbsp;·&nbsp; Time bonus <b>+${bonus}</b><br/>Score <b>${this.score.total.toLocaleString()}</b> &nbsp;·&nbsp; Best chain <b>×${bestMult.toFixed(
        2,
      )}</b>`,
      "Click for the next sector",
    );
  }

  _victory() {
    this.state = "victory";
    this.ctx.active = false;
    // Show the result immediately; push to Steam in the background.
    this.hud.showOverlay(
      "BELFAST LIBERATED",
      `The invaders are routed.<br/>Final score <b>${this.score.total.toLocaleString()}</b> &nbsp;·&nbsp; Kills <b>${this.score.kills}</b>`,
      "Click to fight again",
    );
    Steam.unlock("ACH_BELFAST_LIBERATED").catch(() => {});
    Steam.submitScore(this.score.total).catch(() => {});
    this.audio.voice(["Belfast is free!", "We did it, so we did!"]);
  }

  _onDeath() {
    if (this.state === "dead") return;
    this.state = "dead";
    this.ctx.active = false;
    this.hud.setCrosshairActive(false);
    document.exitPointerLock();
    this.hud.showOverlay(
      "YOU WENT DOWN",
      `Score <b>${this.score.total.toLocaleString()}</b> &nbsp;·&nbsp; Kills <b>${this.score.kills}</b><br/>Belfast still needs you.`,
      "Click to redeploy",
    );
    Steam.submitScore(this.score.total).catch(() => {});
  }

  // ---- input / pointer lock ---------------------------------------------

  _bindUI() {
    // Click on the overlay or canvas advances state appropriately.
    const onClick = () => this._handlePrimaryClick();
    document.getElementById("overlay").addEventListener("click", onClick);
    this.dom.addEventListener("click", () => {
      if (this.state === "playing" && document.pointerLockElement !== this.dom) {
        this._requestLock();
      }
    });

    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === this.dom;
      if (this.state === "playing" && !locked) {
        // Soft pause when the player tabs out / hits Esc.
        this.state = "paused";
        this.hud.showOverlay("PAUSED", "Take a breather.", "Click to resume");
      } else if (this.state === "paused" && locked) {
        this.state = "playing";
        this.hud.hideOverlay();
      }
      this.ctx.active = this.state === "playing" && locked;
    });

    window.addEventListener("keydown", (e) => {
      if (e.code === "KeyM") {
        this._muted = !this._muted;
        this.audio.setMuted(this._muted);
        this.hud.setObjective(this._muted ? "Muted 🔇" : "Breach to the exit gate");
      }
    });
  }

  _handlePrimaryClick() {
    switch (this.state) {
      case "menu":
        this._startGame();
        break;
      case "paused":
        this._requestLock();
        break;
      case "complete":
        this._loadLevel(this.levelIndex + 1);
        break;
      case "dead":
      case "victory":
        this._startGame();
        break;
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
    let dt = (now - this._last) / 1000;
    this._last = now;
    if (dt > MAX_DT) dt = MAX_DT; // clamp after stalls
    this.time += dt;
    this.ctx.time = this.time;

    if (this.ctx.active) {
      this._update(dt);
    }
    this.hud.update(dt);
    this.engine.render();
  }

  _update(dt) {
    this.score.update(dt);
    this.player.update(dt);
    this.weapon.update(dt);
    this.level.update(dt, this.ctx);

    // HUD readouts
    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.setTimer(this.score.levelTime);
    this.hud.setObjective(
      this.level.enemiesRemaining > 0
        ? `Hostiles: ${this.level.enemiesRemaining}  ·  Reach the exit`
        : "Sector clear — reach the exit!",
    );

    // Win condition: reach the exit gate.
    if (this.level.checkExit(this.player.position)) {
      this._completeLevel();
    }
  }
}

window.addEventListener("DOMContentLoaded", () => new Game());
