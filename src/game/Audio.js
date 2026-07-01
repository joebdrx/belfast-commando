import { BASE } from "../utils/constants.js";

/**
 * Sampled SFX (public/sfx/). Guns + explosion replace the synth versions; the
 * voice clips are Belfast/satire barks for the player + enemies. Each logical
 * key maps to one served MP3; decoded into AudioBuffers on init().
 */
const SAMPLES = {
  // weapons / explosion (the SMG deliberately reuses the pistol report)
  gun_pistol: "sfx/guns/pistol.mp3",
  gun_shotgun: "sfx/guns/shotgun.mp3",
  reload: "sfx/guns/reload.mp3",
  explosion: "sfx/guns/explosion.mp3",
  // player voice barks
  p_getdafout: "sfx/player/getdafout.mp3",
  p_lookatallthese: "sfx/player/lookatallthese.mp3",
  p_gaesin: "sfx/player/gaesinireland.mp3", // spoken dialogue line (rescue VO)
  // enemy voice barks, split by MODEL type. type1 = the two young "invader"
  // models; type2 = the bald "groomer" + the turbaned "fatstabber". Within each
  // type some lines are taunts (spotting/attacking), others pain (hit/killed).
  t1_coconut: "sfx/enemy/type1/coconut.mp3",
  t1_nobossinafrica: "sfx/enemy/type1/nobossinafrica.mp3",
  t1_rpndiskewl: "sfx/enemy/type1/rpndiskewl.mp3",
  t1_uaregae: "sfx/enemy/type1/uaregae.mp3",
  t1_sopainful: "sfx/enemy/type1/sopainful.mp3",
  t1_notbrping: "sfx/enemy/type1/notbrping.mp3",
  t2_ihearurarases: "sfx/enemy/type2/ihearurarases.mp3",
  t2_bloodyfu: "sfx/enemy/type2/bloodyfu.mp3",
  // Music/ambience decoded into buffers: the drum loops gaplessly (BufferSource)
  // and the whistle plays intermittently. The long traffic ambiences stream via
  // HTMLAudioElement instead (see MUSIC_LOOPS) to avoid huge in-memory PCM.
  music_drum: "sfx/music/drum.mp3",
  music_whistle: "sfx/music/whistle.mp3",
  // Event SFX (Urban Jungle sound pack).
  splat: "sfx/messy-splat.ogg",                  // messy enemy-kill splat
  door_kick: "sfx/door-kick.ogg",                // kicking a door open
  rescue_jingle: "sfx/rescue-civilian-jingle.ogg", // civilian rescued
  victim_scream: "sfx/woman-screaming.ogg",      // looped while a victim is captive
};
// Long looping ambiences — streamed (HTMLAudioElement), not decoded to PCM.
const MUSIC_LOOPS = {
  menu: "sfx/music/menu_ambient.mp3", // main menu (HUB)
  level: "sfx/music/level_ambient.mp3", // during the operation (LEVEL)
};
// Player kill bark. Enemy barks are keyed by model type → {taunt, pain} pools,
// so only that model's voice plays for that model.
const KILL_BARKS = ["p_getdafout"];
const ENEMY_TAUNTS = {
  1: ["t1_coconut", "t1_nobossinafrica", "t1_rpndiskewl", "t1_uaregae"],
  2: ["t2_ihearurarases"],
};
const ENEMY_PAIN = {
  1: ["t1_sopainful", "t1_notbrping"],
  2: ["t2_bloodyfu"],
};

/**
 * Audio
 * -----
 * Synthesized Web Audio for impacts/UI blips, PLUS sampled MP3s (public/sfx/)
 * for gunfire, explosions and the player/enemy voice barks. Samples decode on
 * init(); until ready (or if a file 404s) the procedural fallbacks play, so
 * audio never blocks gameplay. Voice barks are throttled + randomised so they
 * punctuate the action instead of spamming it.
 */
export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.voiceEnabled = true;
    this._lastVoice = 0;
    /** @type {Object<string, AudioBuffer>} decoded sample buffers by key. */
    this.buffers = {};
    this._samplesLoaded = false;
    // Separate cooldowns so a player bark and an enemy bark can still overlap,
    // but multiple enemies (or rapid kills) don't stack into noise.
    this._playerVoiceAt = 0;
    this._enemyVoiceAt = 0;
    // Music/ambience state.
    this._musicGain = null;
    this._ambientEls = null; // { menu:{el,gain}, level:{el,gain} }
    this._drumSource = null; // gapless looping bodhrán
    this._whistleTimer = null; // intermittent whistle scheduler
    this._ambientPhase = null;
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
    // Dedicated VOICE bus: every spoken bark + dialogue VO routes here so voices
    // share one knob, independent of guns/SFX. Sits slightly under master so the
    // (now-lowered) barks and the dialogue clip read clearly without blaring.
    this._voiceGain = this.ctx.createGain();
    this._voiceGain.gain.value = 0.9;
    this._voiceGain.connect(this.master);
    this._loadSamples();
    this._initMusic();
  }

  /** Build the music sub-graph + the streamed ambience elements (once). All music
   *  routes through `_musicGain` → master, so mute (master gain) silences it too. */
  _initMusic() {
    if (this._musicGain || !this.ctx) return;
    this._musicGain = this.ctx.createGain();
    this._musicGain.gain.value = 0.8; // whole music bed sits under SFX/voice
    this._musicGain.connect(this.master);
    this._ambientEls = {};
    for (const [key, rel] of Object.entries(MUSIC_LOOPS)) {
      try {
        const el = new window.Audio(`${BASE}${rel}`);
        el.loop = true;
        el.preload = "auto";
        const src = this.ctx.createMediaElementSource(el);
        const g = this.ctx.createGain();
        // Loudness-normalised tracks → these are the artistic mix levels. The
        // LEVEL traffic sits lower so gunfire dominates during the operation.
        g.gain.value = key === "level" ? 0.42 : 0.55;
        src.connect(g);
        g.connect(this._musicGain);
        this._ambientEls[key] = { el, gain: g };
      } catch (_) { /* element unsupported → skip */ }
    }
  }

  /**
   * Drive the phase-appropriate ambience. The bodhrán DRUM plays continuously in
   * BOTH the menu and the level (started once, never stopped). The traffic
   * ambience swaps menu↔level. The WHISTLE plays intermittently in the menu only
   * (never a continuous loop). Safe to call before init() (no-op until audio is up).
   */
  setAmbient(phase) {
    if (!this._ok() || !this._ambientEls) return;
    this._ambientPhase = phase;
    this._startDrum(); // continuous in both menu + level
    if (phase === "HUB") {
      this._loop("menu", true);
      this._loop("level", false);
      this._scheduleWhistle();
    } else if (phase === "LEVEL") {
      this._loop("level", true);
      this._loop("menu", false);
      this._stopWhistle();
    } else {
      this._loop("menu", false);
      this._loop("level", false);
      this._stopWhistle();
    }
  }

  _loop(key, on) {
    const a = this._ambientEls && this._ambientEls[key];
    if (!a) return;
    if (on) { a.el.play().catch(() => {}); } else { a.el.pause(); }
  }

  /** Start the gapless looping bodhrán (idempotent). */
  _startDrum() {
    if (this._drumSource || !this.buffers.music_drum) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.music_drum;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0.45; // subtle bodhrán bed under everything else
    src.connect(g);
    g.connect(this._musicGain);
    src.start();
    this._drumSource = src;
  }

  /** Schedule the intermittent whistle: play, then silence for a random spell,
   *  then play again — never a continuous loop. Menu only. */
  _scheduleWhistle() {
    if (this._whistleTimer) return;
    const playOnce = () => {
      if (this._ambientPhase !== "HUB") { this._whistleTimer = null; return; }
      this._playBuffer("music_whistle", { gain: 0.5 });
      // next: after the ~8.5s melody + a 14–38s gap of quiet.
      const wait = 8500 + 14000 + Math.random() * 24000;
      this._whistleTimer = setTimeout(playOnce, wait);
    };
    this._whistleTimer = setTimeout(playOnce, 5000); // first one a few seconds in
  }

  _stopWhistle() {
    if (this._whistleTimer) { clearTimeout(this._whistleTimer); this._whistleTimer = null; }
  }

  /** Fetch + decode every MP3 in SAMPLES into this.buffers (best-effort). */
  async _loadSamples() {
    if (this._samplesLoaded || !this.ctx) return;
    this._samplesLoaded = true;
    await Promise.all(
      Object.entries(SAMPLES).map(async ([key, rel]) => {
        try {
          const res = await fetch(`${BASE}${rel}`);
          if (!res.ok) return;
          const arr = await res.arrayBuffer();
          this.buffers[key] = await this.ctx.decodeAudioData(arr);
        } catch (_) {
          /* missing/undecodable → synth fallback */
        }
      }),
    );
  }

  /**
   * Play a decoded sample. Returns true if it played, false if the buffer isn't
   * ready (so callers can fall back to a synth). `pos`+`listenerPos` give crude
   * distance attenuation; otherwise `gain` is used flat.
   */
  _playBuffer(key, { gain = 0.8, pos = null, listenerPos = null, rate = 1, destination = null } = {}) {
    if (!this._ok() || !this.buffers[key]) return false;
    let vol = gain;
    if (pos && listenerPos) {
      const d = pos.distanceTo(listenerPos);
      vol = Math.max(0.05, Math.min(gain, (gain * 10) / (d + 8)));
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[key];
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    g.connect(destination || this.master);
    src.start();
    src.onended = () => { try { g.disconnect(); } catch (_) { /* gone */ } };
    return true;
  }

  /**
   * Play a randomised voice bark from `pool`, gated by a shared cooldown +
   * probability so barks punctuate rather than spam. `player` picks which
   * cooldown channel; positional args attenuate enemy barks.
   */
  _bark(pool, { player = false, chance = 1, cooldown = 3, gain = 0.9, pos = null, listenerPos = null } = {}) {
    if (!this._ok()) return;
    const now = this._now();
    const last = player ? this._playerVoiceAt : this._enemyVoiceAt;
    if (now - last < cooldown) return;
    if (Math.random() > chance) return;
    const key = pool[(Math.random() * pool.length) | 0];
    // Route every bark through the voice bus so it shares the dialogue knob.
    if (!this._playBuffer(key, { gain, pos, listenerPos, destination: this._voiceGain })) return;
    if (player) this._playerVoiceAt = now; else this._enemyVoiceAt = now;
  }

  /** Player bark after an elimination (random, throttled). */
  killBark() {
    this._bark(KILL_BARKS, { player: true, chance: 0.4, cooldown: 3.5, gain: 0.6 });
  }

  /** Player one-liner as an operation begins ("look at all these…"). */
  levelStartBark() {
    this._bark(["p_lookatallthese"], { player: true, chance: 1, cooldown: 0, gain: 0.65 });
  }

  /** An actual spoken dialogue line (e.g. on a civilian rescue) — sits clearly on
   *  the voice bus above the lowered gunfire, so the player can make it out. */
  dialogueVO() {
    this._playBuffer("p_gaesin", { gain: 1.0, destination: this._voiceGain });
  }

  /** Enemy taunt when it attacks the player — voiced by the model's type pool.
   *  Routed through the voice bus; the source MP3s are loudness-normalised so all
   *  enemy lines play at the same level. */
  enemyTaunt(pos, listenerPos, type = 1) {
    this._bark(ENEMY_TAUNTS[type] || ENEMY_TAUNTS[1], { chance: 0.5, cooldown: 2.2, gain: 0.75, pos, listenerPos });
  }

  /** Enemy pain cry when hit or killed — voiced by the model's type pool. */
  enemyPain(pos, listenerPos, type = 1) {
    this._bark(ENEMY_PAIN[type] || ENEMY_PAIN[1], { chance: 0.55, cooldown: 1.6, gain: 0.7, pos, listenerPos });
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
    // Sampled gunfire: Boomstick → shotgun; everything else (pistol AND SMG) →
    // the pistol report, fired on every shot.
    const key = weapon === "Boomstick" ? "gun_shotgun" : "gun_pistol";
    // Gunshots sit under the voices now (shotgun 0.55, pistol/SMG 0.42) so the
    // dialogue VO + barks aren't drowned.
    if (this._playBuffer(key, { gain: weapon === "Boomstick" ? 0.55 : 0.42 })) return;
    // Fallback: synth report (matched levels).
    const dur = weapon === "Boomstick" ? 0.28 : 0.12;
    const noise = this._noise(dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(weapon === "Boomstick" ? 1800 : 3200, this._now());
    noise.connect(lp);
    this._env(lp, weapon === "Boomstick" ? 0.55 : 0.34, 0.001, dur);
    noise.start();
    noise.stop(this._now() + dur + 0.02);
    // Low thump body
    this._tone(weapon === "Boomstick" ? 90 : 140, 0.08, 0.4, "square");
  }

  /** Bright pickup chime when a supply crate is broken open. */
  loot() {
    if (!this._ok()) return;
    this._tone(660, 0.16, 0.16, "triangle", 990); // upward glide
    this._tone(990, 0.1, 0.18, "triangle");        // sparkle overtone
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
    // Confirmation sting only — the spoken kill bark is the sampled player voice
    // (killBark), fired from the "kill" bus event in main.js.
    this._tone(330, 0.06, 0.25, "triangle");
    this._tone(160, 0.1, 0.4, "sine", 70);
  }

  /** Messy splat on an enemy kill (sampled). Positional if pos/listener given. */
  splat(pos = null, listenerPos = null) {
    if (!this._ok()) return;
    this._playBuffer("splat", { gain: 0.9, pos, listenerPos });
  }

  /** Door-kick thump (sampled), falling back to the synth boot thud. */
  doorKick() {
    if (!this._ok()) return;
    if (this._playBuffer("door_kick", { gain: 0.95 })) return;
    this.kick();
  }

  /** Celebratory jingle when a civilian is rescued (sampled). */
  rescueJingle() {
    if (!this._ok()) return;
    this._playBuffer("rescue_jingle", { gain: 0.85 });
  }

  /**
   * Start a looping sample (e.g. a captive victim's scream). Returns a small
   * controller `{ setVolume(v), stop() }`, or null if audio/buffer isn't ready —
   * the caller retries next frame. The loop routes through `master`, so mute
   * silences it too.
   */
  startLoop(key, { gain = 0.5 } = {}) {
    if (!this._ok() || !this.buffers[key]) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[key];
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.master);
    src.start();
    let stopped = false;
    return {
      setVolume: (v) => { if (!stopped) { try { g.gain.value = Math.max(0, v); } catch (_) { /* gone */ } } },
      stop: () => {
        if (stopped) return;
        stopped = true;
        try { src.stop(); } catch (_) { /* already stopped */ }
        try { g.disconnect(); } catch (_) { /* gone */ }
      },
    };
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

  /** Breacher aggro shriek — noise burst with a falling, dissonant tone. */
  enemyScream(pos, listenerPos) {
    if (!this._ok()) return;
    const d = pos.distanceTo(listenerPos);
    const vol = Math.max(0.08, Math.min(0.5, 11 / (d + 4)));
    const n = this._noise(0.4);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(1600, this._now());
    bp.frequency.exponentialRampToValueAtTime(500, this._now() + 0.4);
    n.connect(bp);
    this._env(bp, vol, 0.01, 0.4);
    n.start();
    n.stop(this._now() + 0.45);
    this._tone(740, vol * 0.7, 0.4, "sawtooth", 220);
  }

  /** Enforcer footfall — a heavy, distance-attenuated low thud. */
  enforcerStep(pos, listenerPos) {
    if (!this._ok()) return;
    const d = pos.distanceTo(listenerPos);
    const vol = Math.max(0.1, Math.min(0.6, 12 / (d + 5)));
    this._tone(55, vol, 0.35, "sine", 30);
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

  /** Magazine reload — sampled, else two mechanical clicks (mag out, mag in). */
  reload() {
    if (!this._ok()) return;
    if (this._playBuffer("reload", { gain: 0.7 })) return;
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

  /** Barrel/breacher explosion — sampled boom, else synth boom + noise blast. */
  explosion(pos, listenerPos) {
    if (!this._ok()) return;
    if (this._playBuffer("explosion", { gain: 0.95, pos, listenerPos })) return;
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
