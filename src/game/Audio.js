/**
 * Audio
 * -----
 * Zero-asset sound: everything is synthesized with the Web Audio API, so the
 * MVP ships no binary files. Gunshots, kick thuds, hits and UI blips are
 * procedural. Optional "voice lines" use the browser SpeechSynthesis API for
 * placeholder Belfast banter (best-effort; silently skipped if unavailable).
 */
export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.voiceEnabled = true;
    this._lastVoice = 0;
  }

  /** Must be called from a user gesture (Start click) to satisfy autoplay. */
  init() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      this.enabled = false;
      return;
    }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
  }

  setMuted(muted) {
    if (this.master) this.master.gain.value = muted ? 0 : 0.5;
    this.enabled = !muted;
  }

  _now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  _noise(duration) {
    const len = Math.floor(this.ctx.sampleRate * duration);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  _env(node, gain, attack, decay) {
    const t = this._now();
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g);
    g.connect(this.master);
    // Detach from the graph once the envelope finishes so GainNodes don't
    // accumulate on `master` over a long session (Web Audio won't GC a node
    // while it still has an active connection to the destination).
    setTimeout(() => {
      try {
        g.disconnect();
      } catch (_) {
        /* already gone */
      }
    }, (attack + decay) * 1000 + 120);
    return g;
  }

  gunshot(weapon = "Sidearm") {
    if (!this._ok()) return;
    const dur = weapon === "Boomstick" ? 0.28 : 0.12;
    const noise = this._noise(dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(weapon === "Boomstick" ? 1800 : 3200, this._now());
    noise.connect(lp);
    this._env(lp, weapon === "Boomstick" ? 0.9 : 0.55, 0.001, dur);
    noise.start();
    noise.stop(this._now() + dur + 0.02);
    // Low thump body
    this._tone(weapon === "Boomstick" ? 90 : 140, 0.08, 0.4, "square");
  }

  kick() {
    if (!this._ok()) return;
    // Heavy low thud
    this._tone(70, 0.18, 0.7, "sine", 38);
    const n = this._noise(0.08);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 600;
    n.connect(lp);
    this._env(lp, 0.5, 0.001, 0.08);
    n.start();
    n.stop(this._now() + 0.1);
  }

  kickWhiff() {
    if (!this._ok()) return;
    const n = this._noise(0.18);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900;
    n.connect(bp);
    this._env(bp, 0.18, 0.01, 0.18);
    n.start();
    n.stop(this._now() + 0.2);
  }

  slide() {
    if (!this._ok()) return;
    const n = this._noise(0.5);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(2500, this._now());
    bp.frequency.exponentialRampToValueAtTime(400, this._now() + 0.5);
    n.connect(bp);
    this._env(bp, 0.25, 0.02, 0.5);
    n.start();
    n.stop(this._now() + 0.55);
  }

  hit() {
    this._tone(220, 0.05, 0.2, "square");
  }

  kill() {
    if (!this._ok()) return;
    this._tone(330, 0.06, 0.25, "triangle");
    this._tone(160, 0.1, 0.4, "sine", 70);
    this.voice(["Down ye go!", "Get in!", "That's yer lot!", "Wise up!"]);
  }

  enemyShot(enemyPos, listenerPos) {
    if (!this._ok()) return;
    // Crude distance attenuation for positional feel.
    const d = enemyPos.distanceTo(listenerPos);
    const vol = Math.max(0.05, Math.min(0.4, 8 / (d + 4)));
    const noise = this._noise(0.1);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2400;
    noise.connect(lp);
    this._env(lp, vol, 0.001, 0.1);
    noise.start();
    noise.stop(this._now() + 0.12);
  }

  /** Enemy melee swing — a whoosh plus a low thud, distance-attenuated. */
  enemyMelee(pos, listenerPos) {
    if (!this._ok()) return;
    const d = pos.distanceTo(listenerPos);
    const vol = Math.max(0.06, Math.min(0.45, 9 / (d + 4)));
    const n = this._noise(0.14);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(900, this._now());
    bp.frequency.exponentialRampToValueAtTime(400, this._now() + 0.14);
    n.connect(bp);
    this._env(bp, vol, 0.004, 0.14);
    n.start();
    n.stop(this._now() + 0.16);
    this._tone(130, vol * 0.8, 0.16, "sine", 70);
  }

  switchWeapon() {
    this._tone(600, 0.03, 0.06, "square");
    this._tone(900, 0.03, 0.06, "square");
  }

  uiBlip() {
    this._tone(520, 0.02, 0.08, "square");
  }

  /** Magazine reload — two mechanical clicks (mag out, mag in). */
  reload() {
    if (!this._ok()) return;
    this._click(0);
    this._click(0.18);
  }

  /** Empty-chamber dry-fire click. */
  dryFire() {
    this._click(0, 0.5);
  }

  _click(delay = 0, gain = 0.35) {
    if (!this._ok()) return;
    const n = this._noise(0.03);
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1800;
    n.connect(hp);
    const t = this._now() + delay;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    hp.connect(g);
    g.connect(this.master);
    n.start(t);
    n.stop(t + 0.05);
    setTimeout(() => { try { g.disconnect(); } catch (_) {} }, (delay + 0.1) * 1000 + 60);
  }

  /** Barrel explosion — low boom + noise blast. */
  explosion(pos, listenerPos) {
    if (!this._ok()) return;
    let vol = 0.9;
    if (pos && listenerPos) vol = Math.max(0.2, Math.min(0.95, 14 / (pos.distanceTo(listenerPos) + 6)));
    // Low boom sweep
    this._tone(120, vol, 0.6, "sine", 38);
    // Noise blast
    const n = this._noise(0.5);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2200, this._now());
    lp.frequency.exponentialRampToValueAtTime(200, this._now() + 0.5);
    n.connect(lp);
    this._env(lp, vol * 0.8, 0.002, 0.5);
    n.start();
    n.stop(this._now() + 0.55);
  }

  /** Steady downward synth note as a generic tone. */
  _tone(freq, gain, decay, type = "sine", endFreq = null) {
    if (!this._ok()) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    const t = this._now();
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + decay);
    this._env(o, gain, 0.002, decay);
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  /** Best-effort placeholder voice line via the browser's TTS. */
  voice(lines) {
    if (!this.voiceEnabled || !window.speechSynthesis) return;
    const now = performance.now();
    if (now - this._lastVoice < 2500) return; // throttle
    if (Math.random() > 0.4) return; // don't spam every kill
    this._lastVoice = now;
    const u = new SpeechSynthesisUtterance(lines[(Math.random() * lines.length) | 0]);
    u.rate = 1.05;
    u.pitch = 0.9;
    u.volume = 0.9;
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (_) {
      /* ignore */
    }
  }

  _ok() {
    return this.enabled && this.ctx;
  }
}
