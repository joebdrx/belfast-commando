const BASE = import.meta.env.BASE_URL || "/";
const PREFIX = "bc-load-";

/**
 * LoadingScreen
 * -------------
 * A GTA-style full-screen loading overlay: stacked promo images that each slowly
 * pan/zoom (Ken Burns), cross-fading from one to the next while content streams,
 * with a spinning "LOADING" indicator in the bottom-right corner. The LAST slide
 * is the game cover, which is always the final frame shown before the overlay
 * fades away.
 *
 * Usage:
 *   const ls = new LoadingScreen();
 *   ls.show(["loading/a.jpg", "loading/b.jpg", "loading/cover.jpg"], { minMs: 2600 });
 *   // ...when the content is ready:
 *   await ls.finish(); // pans to the cover, holds, fades out, removes itself
 */
export class LoadingScreen {
  constructor() {
    this._root = null;
    this._layers = [];
    this._video = null;
    this._timer = null;
    this._startAt = 0;
    this._minMs = 0;
    this._finishing = false;
    this._injectStyles();
  }

  _injectStyles() {
    if (document.getElementById(`${PREFIX}style`)) return;
    const style = document.createElement("style");
    style.id = `${PREFIX}style`;
    style.textContent = `
      .${PREFIX}root {
        position: fixed; inset: 0; z-index: 9999; overflow: hidden;
        background: #05060a; opacity: 1; transition: opacity 0.7s ease;
      }
      .${PREFIX}root.${PREFIX}out { opacity: 0; }
      .${PREFIX}img {
        position: absolute; inset: -6%;
        background-size: cover; background-position: center;
        opacity: 0; transition: opacity 0.9s ease;
        will-change: transform, opacity;
      }
      .${PREFIX}img.${PREFIX}on { opacity: 1; }
      /* Slow scan (Ken Burns): a long, gentle pan + zoom. Two variants alternate. */
      .${PREFIX}pan-a { animation: ${PREFIX}kb-a 16s linear infinite alternate; }
      .${PREFIX}pan-b { animation: ${PREFIX}kb-b 16s linear infinite alternate; }
      @keyframes ${PREFIX}kb-a {
        from { transform: scale(1.08) translate(-3%, -2%); }
        to   { transform: scale(1.18) translate(3%, 2%); }
      }
      @keyframes ${PREFIX}kb-b {
        from { transform: scale(1.18) translate(3%, -2%); }
        to   { transform: scale(1.08) translate(-3%, 2%); }
      }
      /* Full-bleed video background (operation loader). */
      .${PREFIX}video {
        position: absolute; inset: 0; width: 100%; height: 100%;
        object-fit: cover; background: #05060a;
      }
      /* Bottom edge vignette so the spinner reads over busy art. */
      .${PREFIX}root::after {
        content: ""; position: absolute; inset: 0; pointer-events: none;
        background: radial-gradient(120% 80% at 50% 35%, transparent 55%, rgba(0,0,0,0.55) 100%);
      }
      /* Bottom-right corner: game logo above a GTA-style spinner. */
      .${PREFIX}corner {
        position: absolute; right: 40px; bottom: 32px; z-index: 2;
        display: flex; flex-direction: column; align-items: flex-end; gap: 12px;
      }
      .${PREFIX}logo {
        width: 300px; max-width: 34vw; height: auto;
        filter: drop-shadow(0 3px 12px rgba(0,0,0,0.85));
      }
      .${PREFIX}spin {
        display: flex; align-items: center; gap: 14px;
        font-family: "Arial Narrow", "Roboto Condensed", sans-serif;
      }
      .${PREFIX}text {
        color: #f0ede8; font-size: 19px; font-weight: 800;
        letter-spacing: 0.34em; text-transform: uppercase;
        text-shadow: 0 2px 8px #000;
      }
      .${PREFIX}text::after { content: ""; animation: ${PREFIX}dots 1.4s steps(4, end) infinite; }
      @keyframes ${PREFIX}dots { 0%{content:"";} 25%{content:".";} 50%{content:"..";} 75%{content:"...";} }
      .${PREFIX}ring {
        width: 34px; height: 34px; border-radius: 50%;
        border: 4px solid rgba(255,255,255,0.18);
        border-top-color: #ff7a1a; border-right-color: #ff7a1a;
        box-shadow: 0 0 10px rgba(255,122,26,0.5);
        animation: ${PREFIX}spin 0.9s linear infinite;
      }
      @keyframes ${PREFIX}spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  /**
   * Show the overlay and start cross-fading through `slides` (URLs relative to the
   * served base). The last slide is treated as the cover (the finale). `minMs` is
   * the minimum time the overlay stays up before finish() is allowed to fade it.
   */
  show(slides = [], { minMs = 2600, logo = null, video = null, videoLoop = true } = {}) {
    if (this._root) this._teardown(true);
    this._finishing = false;
    this._video = null;
    this._startAt = performance.now();
    this._minMs = minMs;

    const root = document.createElement("div");
    root.className = `${PREFIX}root`;

    if (video) {
      // Muted video background (autoplays — muted, so the browser allows it even
      // without a gesture; game music plays underneath). videoLoop:false plays it
      // through once (finish() then waits for it to end).
      const v = document.createElement("video");
      v.className = `${PREFIX}video`;
      v.src = `${BASE}${video}`;
      v.loop = videoLoop;
      v.muted = true; v.setAttribute("muted", ""); // attribute too → reliable muted autoplay
      v.autoplay = true; v.preload = "auto";
      v.playsInline = true; v.setAttribute("playsinline", "");
      root.appendChild(v); // append BEFORE play (a detached video advances its
      this._video = v;     // clock without rendering → flashes only the end frame)
      this._layers = [];
    } else {
      this._layers = slides.map((src, i) => {
        const layer = document.createElement("div");
        layer.className = `${PREFIX}img ${i % 2 ? `${PREFIX}pan-b` : `${PREFIX}pan-a`}`;
        layer.style.backgroundImage = `url("${BASE}${src}")`;
        if (i === 0) layer.classList.add(`${PREFIX}on`);
        root.appendChild(layer);
        return layer;
      });
    }

    // Bottom-right corner: the game logo above the spinner.
    const corner = document.createElement("div");
    corner.className = `${PREFIX}corner`;
    if (logo) {
      const img = document.createElement("img");
      img.className = `${PREFIX}logo`;
      img.src = `${BASE}${logo}`;
      img.alt = "";
      corner.appendChild(img);
    }
    const spin = document.createElement("div");
    spin.className = `${PREFIX}spin`;
    spin.innerHTML = `<div class="${PREFIX}text">Loading</div><div class="${PREFIX}ring"></div>`;
    corner.appendChild(spin);
    root.appendChild(corner);

    document.body.appendChild(root);
    this._root = root;

    // Start the video now it's in the document (retry on canplay in case the first
    // play() is rejected while still buffering).
    if (this._video) {
      const v = this._video;
      const kick = () => { try { v.play(); } catch (_) { /* ignore */ } };
      kick();
      v.addEventListener("canplay", kick, { once: true });
    }

    // Auto-advance through ALL slides while we wait (looping), so a long load keeps
    // scanning art. No slide is reserved as a finale — finish() fades from whatever
    // happens to be showing.
    const n = this._layers.length;
    if (n > 1) {
      let i = 0;
      const SLIDE_MS = 3200;
      this._timer = setInterval(() => {
        if (this._finishing) return;
        i = (i + 1) % n;
        this._showLayer(i);
      }, SLIDE_MS);
    }
  }

  _showLayer(idx) {
    this._layers.forEach((l, i) => l.classList.toggle(`${PREFIX}on`, i === idx));
  }

  /**
   * Finish: pan to the cover (the last slide), hold it, then fade the overlay out
   * and remove it. Resolves once removed. Honours `minMs` (waits the remainder if
   * called too early). Safe to call once.
   */
  finish() {
    if (!this._root || this._finishing) return Promise.resolve();
    this._finishing = true;
    return new Promise((resolve) => {
      let done = false;
      let safety = null;
      const fadeOut = () => {
        if (done) return;
        done = true;
        if (safety) { clearTimeout(safety); safety = null; }
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this._root) this._root.classList.add(`${PREFIX}out`);
        setTimeout(() => { this._teardown(false); resolve(); }, 750);
      };

      // A non-looping video plays ENTIRELY before we fade (operation loader). Wait
      // for the REAL 'ended' event — never a duration guess: v.duration is usually
      // still unknown when finish() runs (the clip hasn't loaded), which faded it
      // out far too early. 'error' + a generous safety net cover playback failure.
      if (this._video && !this._video.loop) {
        const v = this._video;
        if (v.ended) { fadeOut(); return; }
        v.addEventListener("ended", fadeOut, { once: true });
        v.addEventListener("error", fadeOut, { once: true });
        safety = setTimeout(fadeOut, 15000);
        return;
      }

      // Slides / looping video: honour the minimum, then fade from whatever shows.
      const remaining = Math.max(0, this._minMs - (performance.now() - this._startAt));
      safety = setTimeout(fadeOut, remaining);
    });
  }

  _teardown(immediate) {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._video) {
      try { this._video.pause(); this._video.removeAttribute("src"); this._video.load(); } catch (_) { /* gone */ }
      this._video = null;
    }
    if (this._root) { this._root.remove(); this._root = null; }
    this._layers = [];
    if (immediate) this._finishing = false;
  }
}
