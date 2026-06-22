import * as THREE from "three";

const _toPlayer = new THREE.Vector3();
const _flat = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _toVictim = new THREE.Vector3();

/**
 * Extra reach (metres) beyond a melee enemy's `meleeRange` at which it begins to
 * telegraph/replay its attack swing as it closes in. Shared by the enforcer
 * (stepEnforcer) and the grunt (Enemy.update) so the wind-up zone is consistent.
 */
export const MELEE_TELEGRAPH_PAD = 3.5;

/**
 * Quantise animation advance to a fixed frame rate (PS1 stop-motion). Pure.
 * @returns {{advance:number, accum:number}} advance = dt to feed the mixer (0 or 1/fps)
 */
export function animStep(accum, dt, fps) {
  const step = 1 / Math.max(1, fps);
  accum += dt;
  let advance = 0;
  if (accum >= step) {
    advance = step;
    accum -= step;
  }
  return { advance, accum };
}

/** Lateral zig-zag offset for the breacher. Pure. */
export function serpentineOffset(time, amplitude, frequency) {
  return Math.sin(time * frequency * Math.PI * 2) * amplitude;
}

/** Tick a rigged enemy's mixer at its clamped FPS (visual only — never position). */
export function tickAnim(enemy, dt) {
  if (!enemy.mixer || enemy.dead) return;
  const step = 1 / Math.max(1, enemy.animFps || 11);
  let accum = (enemy._animAccum || 0) + dt;
  if (accum >= step) { enemy.mixer.update(step); accum -= step; }
  enemy._animAccum = accum;
}

/**
 * Gunner: a fast, fragile MELEE rusher. Aggros on line-of-sight, beelines toward
 * the player with a light strafe weave, telegraphs the swing as it closes, then
 * circles + melee-strikes on the meleeTimer/meleeCooldown cadence (mirrors the
 * grunt path). No ranged fire. Allocation-free (reuses the module temp vectors).
 */
export function stepGunner(enemy, dt, ctx) {
  const pos = enemy.group.position;
  const playerPos = ctx.player.position;
  _toPlayer.copy(playerPos).sub(pos);
  const dist = _toPlayer.length();
  const see = dist < enemy.sightRange && ctx.level.lineOfSight(enemy.eyePosition(), playerPos);
  enemy.group.rotation.y = Math.atan2(_toPlayer.x, _toPlayer.z);
  _flat.copy(_toPlayer).setY(0).normalize();

  if (!see) {
    enemy._setAnim("idle");
  } else if (dist > enemy.meleeRange) {
    // Charge: beeline + a light lateral weave so the rusher reads as jittery, but
    // the forward closing always dominates so it ends in melee contact.
    pos.addScaledVector(_flat, enemy.runSpeed * dt);
    enemy._strafeT = (enemy._strafeT || 0) - dt;
    if (enemy._strafeT <= 0) {
      enemy._strafeT = 0.45 + Math.random() * 0.4;
      enemy._strafeDir = Math.random() < 0.5 ? -1 : 1;
    }
    _tan.set(-_flat.z, 0, _flat.x).multiplyScalar(enemy._strafeDir);
    pos.addScaledVector(_tan, enemy.speed * dt);
    enemy._setAnim("run");
    // Wind-up: replay the (damage-free) swing as it closes in. Rigged-only —
    // _telegraphSwing no-ops on static enemies.
    if (dist <= enemy.meleeRange + MELEE_TELEGRAPH_PAD) enemy._telegraphSwing(ctx, dt);
  } else {
    // In reach — circle the player and swing on the melee cooldown. _meleeAttack
    // plays the clip + lunge + audio and connects for damage at true meleeRange.
    _tan.set(-_flat.z, 0, _flat.x).multiplyScalar(enemy._strafeDir);
    pos.addScaledVector(_tan, enemy.speed * dt);
    enemy._setAnim("run");
    enemy.meleeTimer -= dt;
    if (enemy.meleeTimer <= 0) {
      enemy.meleeTimer = enemy.meleeCooldown;
      enemy._meleeAttack(ctx);
    }
  }

  // Ease the telegraph/strike lunge back to rest (visual model only). stepGunner
  // returns early in Enemy.update, so its lunge must decay here.
  if (enemy._rigRoot) {
    enemy._lunge = enemy._lunge > 0.001 ? enemy._lunge * Math.max(0, 1 - dt * 9) : 0;
    enemy._rigRoot.position.z = enemy._lunge;
  }
}

/** Enforcer: slow, relentless beeline down the player's bearing, ignores cover. */
export function stepEnforcer(enemy, dt, ctx) {
  const pos = enemy.group.position;
  const playerPos = ctx.player.position;
  _toPlayer.copy(playerPos).sub(pos);
  const dist = _toPlayer.length();
  enemy.group.rotation.y = Math.atan2(_toPlayer.x, _toPlayer.z);
  _flat.copy(_toPlayer).setY(0).normalize();
  if (dist > enemy.meleeRange) {
    pos.addScaledVector(_flat, enemy.runSpeed * dt); // no LOS / no cover routing
    enemy._setAnim("walk");
    // Wind-up: replay the one-shot swing (damage-free) as it closes in, while it
    // keeps beelining. Rigged-only — _telegraphSwing no-ops on static enemies.
    if (dist <= enemy.meleeRange + MELEE_TELEGRAPH_PAD) enemy._telegraphSwing(ctx, dt);
  } else {
    enemy._setAnim("walk");
    enemy.meleeTimer -= dt;
    if (enemy.meleeTimer <= 0) {
      enemy.meleeTimer = enemy.meleeCooldown;
      ctx.audio.enforcerStep(pos, ctx.camera.position);
      if (_toPlayer.setY(0).length() <= enemy.meleeRange + 0.5) {
        ctx.player.damage(enemy.damage);
        ctx.hud.flashDamage();
      }
    }
  }

  // Ease the telegraph lunge back to rest (visual model only). The enforcer
  // returns early in Enemy.update, so its lunge must decay here.
  if (enemy._rigRoot) {
    enemy._lunge = enemy._lunge > 0.001 ? enemy._lunge * Math.max(0, 1 - dt * 9) : 0;
    enemy._rigRoot.position.z = enemy._lunge;
  }
}

/** Breacher: blistering serpentine rush; contact + death both hurt. */
export function stepBreacher(enemy, dt, ctx) {
  const pos = enemy.group.position;
  const playerPos = ctx.player.position;
  _toPlayer.copy(playerPos).sub(pos);
  const dist = _toPlayer.length();
  const see = dist < enemy.sightRange;
  if (see && !enemy._screamed) {
    enemy._screamed = true;
    ctx.audio.enemyScream(pos, ctx.camera.position);
    ctx.state && ctx.state.emit("breacherAggro", { position: pos.clone() });
  }
  enemy.group.rotation.y = Math.atan2(_toPlayer.x, _toPlayer.z);
  _flat.copy(_toPlayer).setY(0).normalize();
  // Serpentine: forward + lateral sine.
  enemy._zigT = (enemy._zigT || 0) + dt;
  const z = enemy.archetypeCfg.zigzag;
  _tan.set(-_flat.z, 0, _flat.x).multiplyScalar(serpentineOffset(enemy._zigT, z.amplitude, z.frequency) * dt);
  pos.addScaledVector(_flat, enemy.runSpeed * dt).add(_tan);
  enemy._setAnim("run");
  // Contact detonation.
  if (Math.hypot(_toPlayer.x, _toPlayer.z) <= enemy.meleeRange) enemy.takeDamage(enemy.health + 50, _flat, 0);
}

/**
 * Victim-menacing idle: the guard faces and "threatens" the held civilian.
 * Periodically plays the REAL one-shot attack swing (clip + lunge + audio) at the
 * victim on a cooldown (~the clip duration). Purely visual — the victim is never
 * in `level.enemies` and `_meleeAttack(ctx, true)` is damage-free, so neither the
 * victim nor the player can be hurt here. Non-rigged guards fall back to the cheap
 * positional jab. Allocation-free; uses module-scope _toVictim temp.
 * @param {import('./Enemy.js').Enemy} enemy
 * @param {number} dt
 * @param {object} ctx
 */
export function menaceVictim(enemy, dt, ctx) {
  // Mark the victim as actively menaced (a short timer the victim decays) — its
  // life drains while this is > 0; the captor only menaces while not alerted.
  enemy._guardingVictim._menacedTimer = 0.3;
  const victimPos = enemy._guardingVictim.group.position;
  _toVictim.copy(victimPos).sub(enemy.group.position).setY(0);
  if (_toVictim.lengthSq() > 0.0001) {
    enemy.group.rotation.y = Math.atan2(_toVictim.x, _toVictim.z);
  }
  // Prefer run clip for a threatening jitter; else walk.
  enemy._setAnim(enemy.actions && enemy.actions.run ? "run" : "walk");

  enemy._menaceTimer = (enemy._menaceTimer || 0) - dt;
  if (enemy._attackAction) {
    // Rigged: swing the full attack animation at the victim on a cooldown.
    if (enemy._menaceTimer <= 0 && !enemy._attacking) {
      enemy._menaceTimer = enemy._attackClipDuration() || 2.0;
      enemy._meleeAttack(ctx, true); // swing + lunge + audio, never damages
    }
  } else if (enemy._menaceTimer <= 0) {
    // Non-rigged fallback: the cheap positional jab (visual only).
    enemy._menaceTimer = 1.1;
    enemy._lunge = 0.5;
    if (ctx.audio && ctx.audio.enemyMelee) {
      ctx.audio.enemyMelee(enemy.group.position, ctx.camera.position);
    }
  }

  // Ease the lunge back to rest (same logic as in Enemy.update's grunt path).
  if (enemy._rigRoot) {
    enemy._lunge = enemy._lunge > 0.001 ? enemy._lunge * Math.max(0, 1 - dt * 9) : 0;
    enemy._rigRoot.position.z = enemy._lunge;
  }
}

/** Breacher death blast: VFX + audio + point-blank AoE to the player. */
export function detonate(enemy, ctx) {
  const pos = enemy.group.position;
  const d = enemy.archetypeCfg.detonate;
  ctx.state && ctx.state.emit("breacherDetonate", { position: pos.clone() });
  if (ctx.juice) {
    ctx.juice.spawnImpact(pos, "explosion");
    ctx.juice.shake(0.25, 200);
  }
  ctx.audio.explosion(pos, ctx.camera.position);
  if (pos.distanceTo(ctx.player.position) <= d.radius) {
    ctx.player.damage(d.damage);
    ctx.hud.flashDamage();
  }
}
