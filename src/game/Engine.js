import * as THREE from "three";

/**
 * Engine
 * ------
 * Owns the Three.js renderer, scene, and the player camera. Sets up a
 * Belfast-style overcast sky, hemisphere/ambient/directional lighting, and
 * exponential fog for a cold, damp urban atmosphere.
 *
 * Kept deliberately lightweight: no shadow maps (expensive) — we lean on
 * hemisphere + fog for cheap, convincing overcast lighting at 60+ FPS.
 */
export class Engine {
  /** @param {HTMLElement} mount */
  constructor(mount) {
    this.mount = mount;

    // --- Renderer ---------------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82; // low-key night exposure
    mount.appendChild(this.renderer.domElement);

    // --- Scene ------------------------------------------------------------
    this.scene = new THREE.Scene();

    // Wet Belfast NIGHT: near-black sky overhead fading to a faint cold blue glow
    // at the horizon (sodium/city light pollution behind the cloud). Sky, fog and
    // far horizon share the dark tone so distance dissolves with no hard edge.
    const skyTop = new THREE.Color(0x05070d);
    const skyBottom = new THREE.Color(0x121826);
    this.scene.background = new THREE.Color(0x0a0e16);
    // Linear fog: clear out to ~10m, fully dark by ~130m (inside the 160 far
    // plane) so the night swallows the distance.
    this.scene.fog = new THREE.Fog(0x0a0e16, 10, 130);

    // --- Camera (the player's eyes) --------------------------------------
    this.camera = new THREE.PerspectiveCamera(
      78,
      window.innerWidth / window.innerHeight,
      0.05,
      160,
    );
    this.camera.position.set(0, 1.7, 0);
    this.scene.add(this.camera);

    this._buildSky(skyTop, skyBottom);
    this._buildLights();
    this._buildRain();

    this._onResize = this.resize.bind(this);
    window.addEventListener("resize", this._onResize);
  }

  /** Gradient sky dome (cheap shader, no textures). */
  _buildSky(top, bottom) {
    const geo = new THREE.SphereGeometry(150, 24, 12);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: top },
        bottomColor: { value: bottom },
        offset: { value: 30 },
        exponent: { value: 0.7 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorldPosition;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorldPosition = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
          float t = pow(max(h, 0.0), exponent);
          gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
        }`,
    });
    const dome = new THREE.Mesh(geo, mat);
    dome.name = "skyDome"; // hidden by AssetManager once the cloud HDRI loads
    this.scene.add(dome);
  }

  _buildLights() {
    // Cold moonlit bounce — deep-blue sky light, near-black ground.
    const hemi = new THREE.HemisphereLight(0x1c2840, 0x050608, 0.45);
    this.scene.add(hemi);

    // The moon: a cool, low directional key from high up for form shading.
    const moon = new THREE.DirectionalLight(0x9fb4d8, 0.55);
    moon.position.set(-30, 70, 25);
    this.scene.add(moon);

    // A very faint warm fill from street lamps, so shadows aren't pure black.
    this.scene.add(new THREE.AmbientLight(0x0c1018, 0.22));
  }

  /** Cheap world-space rain: short vertical streaks recycled around the camera. */
  _buildRain() {
    const COUNT = 2000;
    this._rainCount = COUNT;
    this._rainArea = 40;
    this._rainTop = 22;
    this._rainSpeed = 34;
    const pos = new Float32Array(COUNT * 6); // 2 verts per streak
    for (let i = 0; i < COUNT; i++) {
      const x = (Math.random() - 0.5) * this._rainArea;
      const z = (Math.random() - 0.5) * this._rainArea;
      const y = Math.random() * this._rainTop;
      const len = 0.45 + Math.random() * 0.35;
      const o = i * 6;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      pos[o + 3] = x; pos[o + 4] = y - len; pos[o + 5] = z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.rain = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0x6a7686, transparent: true, opacity: 0.28, fog: true }),
    );
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  /** Advance the rain; keep its box centred on the camera. Called each frame. */
  update(dt) {
    if (!this.rain) return;
    const pos = this.rain.geometry.attributes.position.array;
    const cam = this.camera.position;
    const area = this._rainArea;
    const half = area / 2;
    const drop = this._rainSpeed * dt;
    for (let i = 0; i < this._rainCount; i++) {
      const o = i * 6;
      pos[o + 1] -= drop;
      pos[o + 4] -= drop;
      // Recycle streaks that fall below the player back up to the top.
      if (pos[o + 1] < cam.y - 5) {
        const len = pos[o + 1] - pos[o + 4];
        const topY = cam.y + this._rainTop * (0.2 + Math.random() * 0.8) - 4;
        pos[o + 1] = topY;
        pos[o + 4] = topY - len;
      }
      // Wrap horizontally so the rain box follows the camera.
      let dx = pos[o] - cam.x;
      if (dx > half) { pos[o] -= area; pos[o + 3] -= area; }
      else if (dx < -half) { pos[o] += area; pos[o + 3] += area; }
      let dz = pos[o + 2] - cam.z;
      if (dz > half) { pos[o + 2] -= area; pos[o + 5] -= area; }
      else if (dz < -half) { pos[o + 2] += area; pos[o + 5] += area; }
    }
    this.rain.geometry.attributes.position.needsUpdate = true;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /**
   * Render the world. Pass a `sceneOverride` (e.g. the Hub's own scene) to draw
   * a different scene through the shared camera — used by the HUB game phase.
   */
  render(sceneOverride = null) {
    this.renderer.render(sceneOverride || this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener("resize", this._onResize);
    this.renderer.dispose();
  }
}
