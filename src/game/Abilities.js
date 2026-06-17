import * as THREE from "three";

/** Boot id -> movement modifiers. Unknown/standard => neutral. Pure. */
export function bootModifiers(bootId) {
  switch (bootId) {
    case "fast_sprint": return { sprintSpeedMul: 1.35, slideSpeedMul: 1.0, slideDurationMul: 1.0 };
    case "long_slide": return { sprintSpeedMul: 1.0, slideSpeedMul: 1.25, slideDurationMul: 1.8 };
    default: return { sprintSpeedMul: 1.0, slideSpeedMul: 1.0, slideDurationMul: 1.0 };
  }
}

/** Adrenaline triggers below 30% HP when the upgrade is owned. Pure. */
export function isAdrenaline(health, maxHealth, hasUpgrade) {
  if (!hasUpgrade || maxHealth <= 0) return false;
  return health / maxHealth < 0.3;
}

/** Ammo refunded by a point-blank kick kill (Scavenger's Refund). Pure. */
export function computeRefund(magSize, fraction = 0.15) {
  return Math.max(1, Math.floor(magSize * fraction));
}

const ADRENALINE_SPEED_MUL = 1.25;
const POINT_BLANK = 2.2;
const _dir = new THREE.Vector3();

/**
 * Abilities
 * ---------
 * The single home for rule-breaking boot + horror-upgrade logic, on ctx.abilities.
 * Player/Weapon call into it; it reads equipped boot + upgrade levels from
 * ctx.progression and emits "adrenaline" on the bus when the low-HP state flips.
 */
export class Abilities {
  constructor(state) {
    this.state = state;
    this.ctx = null;
    this._adrenaline = false;
    this._mods = bootModifiers("standard");
  }

  setContext(ctx) { this.ctx = ctx; }

  /** Recompute from the equipped boot at level start; subscribe to damage. */
  attach() {
    this.refresh();
    this.state.on("damage", () => this._checkAdrenaline());
    this.state.on("runStart", () => { this._adrenaline = false; this.refresh(); });
  }

  /** Re-read the equipped boot (call when loadout changes / level loads). */
  refresh() {
    const prog = this.state.getProgression();
    this._mods = bootModifiers(prog.boots && prog.boots.equipped);
    this._adrenaline = false;
  }

  _hasUpgrade(id) {
    const up = this.state.getProgression().upgrades || {};
    return (up[id] || 0) > 0;
  }

  get sprintSpeedMul() { return this._mods.sprintSpeedMul * (this._adrenaline ? ADRENALINE_SPEED_MUL : 1); }
  get walkSpeedMul() { return this._adrenaline ? ADRENALINE_SPEED_MUL : 1; }
  get slideSpeedMul() { return this._mods.slideSpeedMul; }
  get slideDurationMul() { return this._mods.slideDurationMul; }
  /** Adrenaline turns the kick into a full 360° clear. */
  get kickFullRadius() { return this._adrenaline; }

  _checkAdrenaline() {
    const p = this.ctx && this.ctx.player;
    if (!p) return;
    const active = isAdrenaline(p.health, p.maxHealth, this._hasUpgrade("adrenaline_leak"));
    if (active !== this._adrenaline) {
      this._adrenaline = active;
      this.state.emit("adrenaline", { active });
    }
  }

  /** Called by Player on a connecting kick. Explosive boots → shockwave. */
  onKick({ point }) {
    const boots = this.state.getProgression().boots;
    if (!boots || boots.equipped !== "explosive_kick" || !point) return;
    const ctx = this.ctx;
    if (ctx.weapon && ctx.weapon.explosionFx) ctx.weapon.explosionFx(point);
    if (ctx.juice) { ctx.juice.spawnImpact(point, "explosion"); ctx.juice.shake(0.18, 160); }
    ctx.audio && ctx.audio.explosion(point, ctx.camera.position);
    ctx.state && ctx.state.emit("explosion", { position: point.clone ? point.clone() : point });
    // Radial damage to nearby living enemies (mirrors barrel logic).
    for (const e of ctx.level.enemies) {
      if (e.dead) continue;
      if (e.position.distanceTo(point) <= 3.2) {
        _dir.copy(e.position).sub(point).setY(0).normalize();
        e.takeDamage(120, _dir, 8);
      }
    }
  }

  /** Called by Player on a kick KILL. Scavenger's Refund tops up the mag. */
  onKickKill({ distance }) {
    if (!this._hasUpgrade("scavenger_refund")) return;
    if (distance > POINT_BLANK) return;
    const ctx = this.ctx;
    if (ctx.weapon && ctx.weapon.addAmmo) {
      ctx.weapon.addAmmo(computeRefund(ctx.weapon.current.mag));
    }
  }
}
