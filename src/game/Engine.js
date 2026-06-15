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
    this.renderer.toneMappingExposure = 1.05;
    mount.appendChild(this.renderer.domElement);

    // --- Scene ------------------------------------------------------------
    this.scene = new THREE.Scene();

    // Overcast Belfast grey — cold blue-grey haze.
    const skyTop = new THREE.Color(0x8b97a1);
    const skyBottom = new THREE.Color(0xb9c2c7);
    this.scene.background = skyBottom.clone();
    this.scene.fog = new THREE.FogExp2(0xaab3b8, 0.022);

    // --- Camera (the player's eyes) --------------------------------------
    this.camera = new THREE.PerspectiveCamera(
      78,
      window.innerWidth / window.innerHeight,
      0.05,
      400,
    );
    this.camera.position.set(0, 1.7, 0);
    this.scene.add(this.camera);

    this._buildSky(skyTop, skyBottom);
    this._buildLights();

    this._onResize = this.resize.bind(this);
    window.addEventListener("resize", this._onResize);
  }

  /** Gradient sky dome (cheap shader, no textures). */
  _buildSky(top, bottom) {
    const geo = new THREE.SphereGeometry(300, 24, 12);
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
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  _buildLights() {
    // Bright sky / muddy ground bounce — the bread-and-butter overcast look.
    const hemi = new THREE.HemisphereLight(0xbcc6cc, 0x4a4036, 1.05);
    this.scene.add(hemi);

    // Weak, diffuse "sun" hidden behind cloud — just enough for form shading.
    const sun = new THREE.DirectionalLight(0xdfe6ea, 0.6);
    sun.position.set(-40, 60, -20);
    this.scene.add(sun);

    this.scene.add(new THREE.AmbientLight(0x404548, 0.4));
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener("resize", this._onResize);
    this.renderer.dispose();
  }
}
