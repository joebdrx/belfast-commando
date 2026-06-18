import * as THREE from "three";

const _toPlayer = new THREE.Vector3();
const _flat = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _toVictim = new THREE.Vector3();

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

/** Gunner: hold standoff range, strafe erratically, telegraph + hitscan. */
export function stepGunner(enemy, dt, ctx) {
  const a = enemy.archetypeCfg.ranged;
  const pos = enemy.group.position;
  const playerPos = ctx.player.position;
  _toPlayer.copy(playerPos).sub(pos);
  const dist = _toPlayer.length();
  const see = dist < enemy.sightRange && ctx.level.lineOfSight(enemy.eyePosition(), playerPos);
  enemy.group.rotation.y = Math.atan2(_toPlayer.x, _toPlayer.z);
  _flat.copy(_toPlayer).setY(0).normalize();

  if (see) {
    // Keep distance: back off if too close, advance if too far.
    if (dist < a.standoff - 3) pos.addScaledVector(_flat, -enemy.runSpeed * dt);
    else if (dist > a.standoff + 3) pos.addScaledVector(_flat, enemy.runSpeed * dt);
    // Erratic strafe.
    enemy._strafeT = (enemy._strafeT || 0) - dt;
    if (enemy._strafeT <= 0) {
      enemy._strafeT = a.strafeInterval;
      enemy._strafeDir = Math.random() < 0.5 ? -1 : 1;
    }
    _tan.set(-_flat.z, 0, _flat.x).multiplyScalar(enemy._strafeDir);
    pos.addScaledVector(_tan, enemy.speed * dt);
    enemy._setAnim("run");
    // Fire on interval (telegraph handled by the muzzle flash decay already in Enemy).
    enemy._fireT = (enemy._fireT || a.fireInterval) - dt;
    if (enemy._fireT <= 0) {
      enemy._fireT = a.fireInterval;
      enemy._flashTime = 0.06;
      enemy.flash.material.opacity = 1;
      ctx.player.damage(a.damage);
      ctx.hud.flashDamage();
      ctx.audio.enemyShot(pos, ctx.camera.position);
      ctx.state && ctx.state.emit("enemyShot", { position: pos.clone(), dir: _flat.clone() });
    }
  } else {
    enemy._setAnim("idle");
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
 * Triggers a visual melee lunge jab every ~1.1 s — NO damage to the victim.
 * Allocation-free; uses module-scope _toVictim temp.
 * @param {import('./Enemy.js').Enemy} enemy
 * @param {number} dt
 * @param {object} ctx
 */
export function menaceVictim(enemy, dt, ctx) {
  const victimPos = enemy._guardingVictim.group.position;
  _toVictim.copy(victimPos).sub(enemy.group.position).setY(0);
  if (_toVictim.lengthSq() > 0.0001) {
    enemy.group.rotation.y = Math.atan2(_toVictim.x, _toVictim.z);
  }
  // Prefer run clip for a threatening jitter; else walk.
  enemy._setAnim(enemy.actions && enemy.actions.run ? "run" : "walk");

  // Periodic lunge jab (visual only — does NOT damage the victim).
  enemy._menaceTimer = (enemy._menaceTimer || 0) - dt;
  if (enemy._menaceTimer <= 0) {
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
