/**
 * HUD
 * ---
 * Thin wrapper over the DOM overlay declared in index.html. Updates the
 * crosshair, score/combo, timer, health bar, weapon + objective readouts,
 * floating style callouts, damage vignette, and the menu/result overlays.
 */
export class HUD {
  constructor() {
    this.$ = (id) => document.getElementById(id);
    this.score = this.$("hud-score");
    this.combo = this.$("hud-combo");
    this.timer = this.$("hud-timer");
    this.health = this.$("hud-health-fill");
    this.healthText = this.$("hud-health-text");
    this.staminaBar = this.$("hud-stamina");
    this.staminaFill = this.$("hud-stamina-fill");
    this.weapon = this.$("hud-weapon");
    this.ammo = this.$("hud-ammo");
    this.objective = this.$("hud-objective");
    this.opcode = this.$("hud-opcode");
    this.level = this.$("hud-level");
    this.callouts = this.$("hud-callouts");
    this.vignette = this.$("hud-damage");
    this.overlay = this.$("overlay");
    this.overlayTitle = this.$("overlay-title");
    this.overlayBody = this.$("overlay-body");
    this.overlayHint = this.$("overlay-hint");
    this.crosshair = this.$("crosshair");
    this._damageT = 0;
    // Adrenaline distortion layer (built in JS so index.html stays untouched).
    this._adrenaline = document.createElement("div");
    this._adrenaline.id = "hud-adrenaline";
    Object.assign(this._adrenaline.style, {
      position: "fixed", inset: "0", pointerEvents: "none", opacity: "0",
      transition: "opacity 0.25s ease", zIndex: "40",
      boxShadow: "inset 0 0 220px 60px rgba(150,0,0,0.85)",
      background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(40,0,0,0.35) 100%)",
      mixBlendMode: "multiply",
    });
    document.body.appendChild(this._adrenaline);
    this._adrenalinePulse = 0;
    this._adrenalineOn = false;
    this._adrenalineFx = true; // toggled via settings

    // Interact prompt: shown near bottom-middle when the player is within
    // range of a victim (built in JS — index.html stays untouched).
    this._interactPrompt = document.createElement("div");
    this._interactPrompt.id = "hud-interact-prompt";
    Object.assign(this._interactPrompt.style, {
      position: "fixed", bottom: "22%", left: "50%",
      transform: "translateX(-50%)",
      padding: "6px 18px",
      background: "rgba(0,0,0,0.72)",
      color: "#f0a500",
      fontFamily: "'Courier New', monospace",
      fontSize: "13px", fontWeight: "bold",
      letterSpacing: "0.08em", textTransform: "uppercase",
      border: "1px solid #f0a500", borderRadius: "3px",
      pointerEvents: "none", opacity: "0",
      transition: "opacity 0.15s ease", zIndex: "50",
    });
    document.body.appendChild(this._interactPrompt);

    // Dialogue bubble: bottom-centre, dark panel + orange accent (same palette
    // as the interact prompt). Auto-hides via _dialogueT timer in update().
    this._dialogue = document.createElement("div");
    this._dialogue.id = "hud-dialogue";
    Object.assign(this._dialogue.style, {
      position: "fixed", bottom: "10%", left: "50%",
      transform: "translateX(-50%)",
      maxWidth: "480px", padding: "10px 22px",
      background: "rgba(12,12,18,0.88)",
      color: "#e8c87a",
      fontFamily: "'Courier New', monospace",
      fontSize: "14px", lineHeight: "1.6",
      border: "2px solid #f0a500", borderRadius: "4px",
      pointerEvents: "none", opacity: "0",
      transition: "opacity 0.25s ease", zIndex: "50",
      textAlign: "center",
    });
    document.body.appendChild(this._dialogue);
    this._dialogueT = 0;
  }

  setScore(total, combo, mult) {
    if (this.score) this.score.textContent = total.toLocaleString();
    if (this.combo) {
      if (combo > 1) {
        this.combo.textContent = `${combo} CHAIN  ×${mult.toFixed(2)}`;
        this.combo.classList.add("active");
      } else {
        this.combo.textContent = "";
        this.combo.classList.remove("active");
      }
    }
  }

  setTimer(seconds) {
    if (!this.timer) return;
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(1).padStart(4, "0");
    this.timer.textContent = `${m}:${s}`;
  }

  setHealth(hp, max = 100) {
    const pct = Math.max(0, Math.min(1, hp / max));
    if (this.health) {
      this.health.style.width = `${pct * 100}%`;
      this.health.style.background =
        pct > 0.5 ? "#3fb950" : pct > 0.25 ? "#d29922" : "#f85149";
    }
    if (this.healthText) this.healthText.textContent = `${Math.ceil(hp)} HP`;
  }

  /** Sprint stamina bar: blue normally, amber when low, red + pulsing when exhausted. */
  setStamina(value, max = 100, exhausted = false) {
    if (!this.staminaFill) return;
    const pct = Math.max(0, Math.min(1, value / max));
    this.staminaFill.style.width = `${pct * 100}%`;
    this.staminaFill.style.background = exhausted ? "#f85149" : pct < 0.3 ? "#d29922" : "#54b3d6";
    if (this.staminaBar) this.staminaBar.classList.toggle("exhausted", exhausted);
  }

  setWeapon(name) {
    if (this.weapon) this.weapon.textContent = name;
  }

  setAmmo(current, mag, reloading) {
    if (!this.ammo) return;
    if (reloading) {
      this.ammo.textContent = "RELOADING…";
      this.ammo.classList.add("reloading");
    } else {
      this.ammo.textContent = `${current} / ${mag}`;
      this.ammo.classList.remove("reloading");
      this.ammo.classList.toggle("low", current <= Math.ceil(mag * 0.25));
    }
  }

  setLevel(n) {
    if (this.level) this.level.textContent = `BELFAST · SECTOR ${n}`;
  }

  setObjective(text) {
    if (this.objective) this.objective.textContent = text;
  }

  /**
   * Show (or clear) the current operation's 4-digit skip code so the player can
   * note it down and dial it from the safehouse phone later. Pass null to clear.
   * @param {string|null} code
   */
  setOperationCode(code) {
    if (!this.opcode) return;
    this.opcode.textContent = code ? `OPERATION CODE: ${code}` : "";
  }

  popCallout(label, points, mult) {
    if (!this.callouts) return;
    const el = document.createElement("div");
    el.className = "callout";
    el.innerHTML = `<span class="callout-label">${label}</span><span class="callout-pts">+${points}${
      mult > 1 ? ` ×${mult.toFixed(1)}` : ""
    }</span>`;
    this.callouts.appendChild(el);
    // Auto-remove after the CSS animation.
    setTimeout(() => el.remove(), 1000);
    // Cap DOM nodes.
    while (this.callouts.childElementCount > 6) {
      this.callouts.firstElementChild.remove();
    }
  }

  flashDamage() {
    this._damageT = 0.35;
  }

  setCrosshairActive(active) {
    if (this.crosshair) this.crosshair.style.opacity = active ? "1" : "0";
  }

  /** Enable/disable the low-HP distortion FX (settings toggle; default on). */
  setAdrenalineFxEnabled(enabled) {
    this._adrenalineFx = enabled !== false;
    if (!this._adrenalineFx) {
      this._adrenalineOn = false;
      this._adrenaline.style.opacity = "0";
      document.getElementById("hud") && (document.getElementById("hud").style.filter = "");
    }
  }

  /** Toggle the adrenaline state (desaturate HUD + pulsing red vignette). The
   *  health readout stays legible — distort, don't blackout. */
  setAdrenaline(active) {
    if (!this._adrenalineFx) return;
    this._adrenalineOn = !!active;
    const hud = document.getElementById("hud");
    if (hud) hud.style.filter = active ? "grayscale(0.85) contrast(1.1)" : "";
    if (!active) this._adrenaline.style.opacity = "0";
  }

  /**
   * Show or hide the interact prompt (e.g. "Press E to free the civilian").
   * Pass `null` or falsy to hide.
   * @param {string|null} text
   */
  setInteractPrompt(text) {
    if (!this._interactPrompt) return;
    if (text) {
      this._interactPrompt.textContent = text;
      this._interactPrompt.style.opacity = "1";
    } else {
      this._interactPrompt.style.opacity = "0";
    }
  }

  /**
   * Show a timed dialogue bubble at the bottom of the screen.
   * @param {string} text
   * @param {number} [ms=3200]  Auto-hide delay in milliseconds.
   */
  showDialogue(text, ms = 3200) {
    if (!this._dialogue) return;
    this._dialogue.textContent = text;
    this._dialogue.style.opacity = "1";
    this._dialogueT = ms / 1000;
  }

  showOverlay(title, body, hint) {
    if (!this.overlay) return;
    this.overlayTitle.innerHTML = title;
    this.overlayBody.innerHTML = body;
    this.overlayHint.innerHTML = hint || "";
    this.overlay.classList.remove("hidden");
  }

  hideOverlay() {
    if (this.overlay) this.overlay.classList.add("hidden");
  }

  update(dt) {
    if (this._damageT > 0) {
      this._damageT -= dt;
      if (this.vignette) this.vignette.style.opacity = Math.max(0, this._damageT / 0.35) * 0.8;
    }
    if (this._adrenalineOn) {
      this._adrenalinePulse += dt * 5;
      const o = 0.45 + Math.sin(this._adrenalinePulse) * 0.25;
      this._adrenaline.style.opacity = String(o);
    }
    // Dialogue auto-hide timer.
    if (this._dialogueT > 0) {
      this._dialogueT -= dt;
      if (this._dialogueT <= 0 && this._dialogue) {
        this._dialogue.style.opacity = "0";
      }
    }
  }
}
