/**
 * Score
 * -----
 * Arcade scoring with a decaying combo multiplier. Every offensive action
 * (shot, hit, kill, breach, boot) bumps the combo and refreshes a 3s window.
 * Points are scaled by the live multiplier; chaining actions keeps it alive.
 * Also tracks level time for an end-of-level time bonus.
 */
const COMBO_WINDOW = 3.0;

export class Score {
  constructor(hud) {
    this.hud = hud;
    this.total = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.bestCombo = 0;
    this.levelTime = 0;
    this.kills = 0;
    this._lastLabel = "";
  }

  reset() {
    this.combo = 0;
    this.comboTimer = 0;
    this.levelTime = 0;
  }

  resetAll() {
    this.total = 0;
    this.bestCombo = 0;
    this.kills = 0;
    this.reset();
  }

  get multiplier() {
    // 1.0x, then +0.25x per chained action, capped at 5x.
    return Math.min(5, 1 + this.combo * 0.25);
  }

  /**
   * @param {number} base    base points
   * @param {string} label   floating callout (BREACH!, KILL, ...)
   * @param {boolean} quiet   true = combo bump without a big callout
   */
  add(base, label = "", quiet = false) {
    // Every offensive action chains — kicks, hits, kills, and shots alike.
    this.combo += 1;
    this.comboTimer = COMBO_WINDOW;
    this.bestCombo = Math.max(this.bestCombo, this.combo);

    const gained = Math.round(base * this.multiplier);
    this.total += gained;
    if (label === "KILL" || label === "BOOT KILL!") this.kills += 1;

    if (label) {
      this._lastLabel = label;
      this.hud && this.hud.popCallout(label, gained, this.multiplier);
    }
    this.hud && this.hud.setScore(this.total, this.combo, this.multiplier);
  }

  /** Award a time bonus for finishing a level quickly. */
  finishLevel() {
    const bonus = Math.max(0, Math.round((45 - this.levelTime) * 50));
    this.total += bonus;
    this.hud && this.hud.setScore(this.total, this.combo, this.multiplier);
    return { bonus, time: this.levelTime };
  }

  update(dt) {
    this.levelTime += dt;
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.combo = 0;
        this.hud && this.hud.setScore(this.total, this.combo, this.multiplier);
      }
    }
  }
}
