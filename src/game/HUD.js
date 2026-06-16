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
    this.weapon = this.$("hud-weapon");
    this.ammo = this.$("hud-ammo");
    this.objective = this.$("hud-objective");
    this.level = this.$("hud-level");
    this.callouts = this.$("hud-callouts");
    this.vignette = this.$("hud-damage");
    this.overlay = this.$("overlay");
    this.overlayTitle = this.$("overlay-title");
    this.overlayBody = this.$("overlay-body");
    this.overlayHint = this.$("overlay-hint");
    this.crosshair = this.$("crosshair");
    this._damageT = 0;
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
  }
}
