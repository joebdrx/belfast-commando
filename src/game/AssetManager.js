import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

const BASE = import.meta.env.BASE_URL || "/";

/**
 * AssetManager
 * ------------
 * Owns the game's shared PBR materials and the environment map.
 *
 * Design: materials are created SYNCHRONOUSLY with a flat fallback colour, so
 * the level can build immediately (no await in the click→pointer-lock path).
 * `load()` then streams the Poly Haven textures (CC0) onto those same shared
 * material instances as each finishes, so they "pop in" a moment later. If a
 * texture 404s or the app runs without the asset files, the flat colour simply
 * stays — gameplay never breaks.
 *
 * Textures: https://polyhaven.com (CC0). See public/textures/<slug>/.
 */
const DEFS = {
  // slug          fallback   tiling      roughness  metalness   source (Poly Haven)
  brick:      { color: 0x8a4b3a, repeat: [2, 1.6], roughness: 0.95, metalness: 0.0 }, // brick_wall_006
  brick_dark: { color: 0x6e3b2e, repeat: [2, 1.6], roughness: 0.95, metalness: 0.0 }, // brick_wall_02
  tarmac:     { color: 0x2a2e31, repeat: [10, 34], roughness: 0.5, metalness: 0.05, envMapIntensity: 1.7 }, // asphalt_02 (rain-wet)
  concrete:   { color: 0x6b6f72, repeat: [2, 1.6], roughness: 0.9, metalness: 0.0 }, // concrete_wall_004
  crate:      { color: 0x7a5a30, repeat: [1, 1], roughness: 0.8, metalness: 0.0 }, // brown_planks_05
  barrel:     { color: 0x4a6a4a, repeat: [1, 1.4], roughness: 0.6, metalness: 0.4 }, // green_metal_rust
  door:       { color: 0x5a3a22, repeat: [1, 1], roughness: 0.85, metalness: 0.0 }, // green_rough_planks
  roof:       { color: 0x474a4f, repeat: [6, 2], roughness: 0.85, metalness: 0.0 }, // grey_roof_tiles
  pavement:   { color: 0x6e706d, repeat: [2, 16], roughness: 0.92, metalness: 0.0 }, // concrete_pavement
};

/**
 * 3D model registry (AI-generated GLBs in public/models/, meshopt + webp).
 * Each is auto-normalised on load: recentred, scaled to `size`, ground- or
 * centre-anchored. `fit` chooses the axis used for scaling; `rotY` corrects
 * facing. These transforms are the tuning surface — tweak per model.
 */
const MODEL_DEFS = {
  // characters / enemies — stand on the ground, face +Z toward the player.
  // `darken` multiplies base colour so invaders read 25% darker (grimmer, and
  // easier to read as hostile silhouettes against the pale overcast street).
  enemy_soldier:    { size: 1.85, fit: "height", anchor: "bottom", rotY: Math.PI, darken: 0.75 },
  enemy_variant:    { size: 1.85, fit: "height", anchor: "bottom", rotY: Math.PI, darken: 0.75 },
  invader:          { size: 1.85, fit: "height", anchor: "bottom", rotY: Math.PI, darken: 0.75 },
  player_fighter:   { size: 1.85, fit: "height", anchor: "bottom", rotY: Math.PI },
  // first-person viewmodels — centred, scaled by their longest axis
  weapon_ak:        { size: 0.62, fit: "max", anchor: "center", rotY: 0 },
  weapon_pistol:    { size: 0.34, fit: "max", anchor: "center", rotY: 0 },
  viewmodel_hands:  { size: 0.45, fit: "max", anchor: "center", rotY: 0 },
  fp_arms_grip:     { size: 0.55, fit: "max", anchor: "center", rotY: 0 },
  kick_boot:        { size: 0.40, fit: "max", anchor: "center", rotY: 0 },
  // props — stand on the ground
  door_kickable:    { size: 2.55, fit: "height", anchor: "bottom", rotY: 0 },
  barrel_explosive: { size: 1.15, fit: "height", anchor: "bottom", rotY: 0 },
  crate_supply:     { size: 1.05, fit: "height", anchor: "bottom", rotY: 0 },
  sandbag_barricade:{ size: 1.0, fit: "height", anchor: "bottom", rotY: 0 },
  prop_wheelie_bin: { size: 1.1, fit: "height", anchor: "bottom", rotY: 0 },
  prop_traffic_cone:{ size: 0.7, fit: "height", anchor: "bottom", rotY: 0 },
  prop_phone_booth: { size: 2.4, fit: "height", anchor: "bottom", rotY: 0 },
  prop_bicycle:     { size: 1.1, fit: "height", anchor: "bottom", rotY: 0 },
  prop_car:         { size: 1.5, fit: "height", anchor: "bottom", rotY: 0 },
};

// 2D sprite textures (AI-generated). VFX use a black background (additive
// blending → black vanishes); decals use a white background (multiply blending
// → white vanishes, the dark mark shows). Blending is set by the consumer.
const SPRITES = {
  muzzle_flash: "vfx/muzzle_flash.png",
  kick_impact: "vfx/kick_impact.png",
  blood: "vfx/blood.png",
  bullet_hole: "vfx/bullet_hole.png",
};

// Belfast sectarian wall murals, applied to building walls.
const MURALS = ["murals/republican.png", "murals/loyalist.png"];

export class AssetManager {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    this.texLoader = new THREE.TextureLoader();
    this.gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    this.materials = {};
    this.models = {}; // slug -> normalised template Object3D (cloned per use)
    this.sprites = {}; // name -> THREE.Texture
    this.murals = []; // THREE.Texture[]
    this._riggedEnemy = null; // { scene, clips:{walk,run,idle} }
    this.loaded = 0;
    this.total = Object.keys(DEFS).length;

    // Build every shared material up-front with its fallback colour.
    for (const [slug, def] of Object.entries(DEFS)) {
      this.materials[slug] = new THREE.MeshStandardMaterial({
        color: def.color,
        roughness: def.roughness,
        metalness: def.metalness,
        envMapIntensity: def.envMapIntensity ?? 1,
      });
    }
  }

  /** Stable shared material for a slug (created in the constructor). */
  getMaterial(slug) {
    return this.materials[slug] || new THREE.MeshStandardMaterial({ color: 0x888888 });
  }

  _loadTexture(url, { srgb = false, repeat = [1, 1] } = {}) {
    return new Promise((resolve) => {
      this.texLoader.load(
        url,
        (tex) => {
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.repeat.set(repeat[0], repeat[1]);
          tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
          if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
          resolve(tex);
        },
        undefined,
        () => resolve(null), // 404 / decode error → keep flat fallback
      );
    });
  }

  /**
   * Stream textures onto the shared materials, and (optionally) set up the
   * overcast environment map for image-based lighting. Fire-and-forget; the
   * caller does not need to await it.
   * @param {THREE.Scene} scene
   * @param {(loaded:number,total:number)=>void} [onProgress]
   */
  async load(scene, onProgress) {
    const jobs = Object.entries(DEFS).map(async ([slug, def]) => {
      const dir = `${BASE}textures/${slug}/`;
      const [diffuse, normal, rough] = await Promise.all([
        this._loadTexture(`${dir}diffuse.jpg`, { srgb: true, repeat: def.repeat }),
        this._loadTexture(`${dir}normal.jpg`, { repeat: def.repeat }),
        this._loadTexture(`${dir}rough.jpg`, { repeat: def.repeat }),
      ]);
      const mat = this.materials[slug];
      if (diffuse) {
        mat.map = diffuse;
        mat.color.set(0xffffff); // let the texture show its true colours
      }
      if (normal) mat.normalMap = normal;
      if (rough) mat.roughnessMap = rough;
      mat.needsUpdate = true;
      this.loaded += 1;
      onProgress && onProgress(this.loaded, this.total);
    });

    // Environment map, 3D models, 2D sprites, and the rigged enemy run alongside.
    const envJob = scene ? this._loadEnvironment(scene) : Promise.resolve();
    const skyJob = scene ? this._loadSky(scene) : Promise.resolve();
    await Promise.all([...jobs, envJob, skyJob, this.loadModels(), this.loadSprites(), this.loadMurals(), this._loadRiggedEnemy()]);
  }

  /** Load wall-mural textures. */
  async loadMurals() {
    const jobs = MURALS.map(async (rel, i) => {
      const tex = await this._loadTexture(`${BASE}${rel}`, { srgb: true });
      if (tex) this.murals[i] = tex;
    });
    await Promise.all(jobs);
  }

  /** Loaded mural textures (skips any that failed). */
  getMurals() {
    return this.murals.filter(Boolean);
  }

  /** Load the skinned, animated enemy (mesh + walk/run/idle clips). */
  async _loadRiggedEnemy() {
    try {
      const base = await this.gltfLoader.loadAsync(`${BASE}models/enemy_rigged.glb`);
      const clips = {};
      if (base.animations[0]) clips.walk = base.animations[0];
      const run = await this.gltfLoader.loadAsync(`${BASE}models/anim_run.glb`).catch(() => null);
      if (run && run.animations[0]) clips.run = run.animations[0];
      const idle = await this.gltfLoader.loadAsync(`${BASE}models/anim_idle.glb`).catch(() => null);
      if (idle && idle.animations[0]) clips.idle = idle.animations[0];
      // Normalise materials (kill hunyuan-style full metalness if present).
      base.scene.traverse((o) => {
        if (o.isMesh) o.frustumCulled = false; // skinned bounds animate; avoid pop-out
        const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of mats) {
          if (!m) continue;
          if (m.metalness !== undefined) m.metalness = 0;
          // 25% darker — grimmer invaders, read as hostile silhouettes. Clones
          // share these materials, so darkening the source once covers them all.
          if (m.color) m.color.multiplyScalar(0.75);
          m.needsUpdate = true;
        }
      });
      // Measure the TRUE animated height. This rig's geometry bounding box is
      // tiny (~0.017m); the SKELETON poses it to ~1.7m, so we must measure with
      // a clip applied — otherwise the normalisation scale explodes the mesh.
      let height = 1.7;
      if (clips.walk) {
        const tmp = new THREE.AnimationMixer(base.scene);
        tmp.clipAction(clips.walk).play();
        tmp.update(0.2);
        base.scene.updateMatrixWorld(true);
        height = new THREE.Box3().setFromObject(base.scene).getSize(new THREE.Vector3()).y || 1.7;
        tmp.stopAllAction();
      }
      this._riggedEnemy = { scene: base.scene, clips, height };
    } catch {
      this._riggedEnemy = null;
    }
  }

  hasRiggedEnemy() {
    return !!this._riggedEnemy;
  }

  /** A fresh clone of the rigged character for use as first-person arms,
   *  with its bones exposed by name for posing. */
  getFpArms() {
    if (!this._riggedEnemy) return null;
    const object3D = cloneSkeleton(this._riggedEnemy.scene);
    const bones = {};
    object3D.traverse((o) => {
      if (o.isBone) bones[o.name] = o;
    });
    return { object3D, bones, height: this._riggedEnemy.height || 1.7 };
  }

  /** A fresh animated enemy instance: normalised Object3D + its animation clips. */
  getRiggedEnemy() {
    if (!this._riggedEnemy) return null;
    const inner = cloneSkeleton(this._riggedEnemy.scene);
    // The rig's natural front is +Z, which is what Enemy's facing math
    // (group.rotation.y = atan2(toPlayer)) expects — so NO 180° flip.
    inner.rotation.y = 0;
    const wrap = new THREE.Group();
    wrap.add(inner);
    // Scale by the measured animated height (NOT the misleading geometry bbox).
    // The model is already feet-at-origin and centred at natural scale.
    wrap.scale.setScalar(1.85 / (this._riggedEnemy.height || 1.7));
    return { object3D: wrap, clips: this._riggedEnemy.clips };
  }

  /** Load the 2D VFX/decal sprite textures. */
  async loadSprites() {
    const jobs = Object.entries(SPRITES).map(async ([name, rel]) => {
      const tex = await this._loadTexture(`${BASE}${rel}`, { srgb: true });
      if (tex) this.sprites[name] = tex;
    });
    await Promise.all(jobs);
  }

  /** Shared sprite texture, or null if unavailable. */
  getSprite(name) {
    return this.sprites[name] || null;
  }

  /** Load + normalise every GLB. Missing files just leave the slug absent. */
  async loadModels() {
    const jobs = Object.entries(MODEL_DEFS).map(async ([slug, def]) => {
      try {
        const gltf = await this.gltfLoader.loadAsync(`${BASE}models/${slug}.glb`);
        this.models[slug] = this._prepareModel(gltf.scene, def);
      } catch {
        /* no GLB → caller falls back to placeholder geometry */
      }
    });
    await Promise.all(jobs);
  }

  /** Recenter + scale + orient a loaded model into a reusable template. */
  _prepareModel(root, def) {
    root.rotation.y = def.rotY || 0;
    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const basis = def.fit === "max" ? Math.max(size.x, size.y, size.z) : size.y;
    const scale = (def.size || 1) / (basis || 1);

    // Recenter on X/Z; anchor Y to feet (bottom) or middle (center).
    root.position.x = -center.x;
    root.position.z = -center.z;
    root.position.y = def.anchor === "center" ? -center.y : -box.min.y;

    const wrap = new THREE.Group();
    wrap.add(root);
    wrap.scale.setScalar(scale);
    wrap.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = true;
      // hunyuan's `enable_pbr` exports these as fully metallic (metalness=1,
      // no metalness map). A solid-metal surface has no diffuse colour and only
      // shows environment reflections — so faces/normals pointing at a dark part
      // of the overcast HDRI render as a black box. These are cloth/skin/plastic
      // placeholders, so force them non-metallic and reasonably rough.
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || m.metalness === undefined) continue;
        m.metalness = 0;
        if (m.roughness !== undefined) m.roughness = Math.min(1, Math.max(0.6, m.roughness));
        if (def.darken && m.color) m.color.multiplyScalar(def.darken);
        m.needsUpdate = true;
      }
    });
    return wrap;
  }

  /** A fresh clone of a normalised model, or null if it wasn't available. */
  getModel(slug) {
    const tpl = this.models[slug];
    return tpl ? tpl.clone(true) : null;
  }

  hasModel(slug) {
    return !!this.models[slug];
  }

  /** Overcast HDRI → PMREM → scene.environment (subtle PBR reflections). */
  async _loadEnvironment(scene) {
    return new Promise((resolve) => {
      new RGBELoader().load(
        `${BASE}hdri/overcast.hdr`,
        (hdr) => {
          const pmrem = new THREE.PMREMGenerator(this.renderer);
          const envMap = pmrem.fromEquirectangular(hdr).texture;
          scene.environment = envMap;
          // Keep IBL subtle so it complements (not replaces) the scene lights
          // and the stylised gradient sky stays as the background.
          if ("environmentIntensity" in scene) scene.environmentIntensity = 0.35;
          hdr.dispose();
          pmrem.dispose();
          resolve();
        },
        undefined,
        () => resolve(), // no HDRI → lights-only, still fine
      );
    });
  }

  /** Overcast-cloud HDRI as the visible sky background (replaces gradient dome). */
  async _loadSky(scene) {
    return new Promise((resolve) => {
      new RGBELoader().load(
        `${BASE}hdri/sky.hdr`,
        (hdr) => {
          hdr.mapping = THREE.EquirectangularReflectionMapping;
          scene.background = hdr;
          if ("backgroundIntensity" in scene) scene.backgroundIntensity = 0.85;
          if ("backgroundBlurriness" in scene) scene.backgroundBlurriness = 0.04;
          // Hide the placeholder gradient dome now that real clouds are up.
          const dome = scene.getObjectByName("skyDome");
          if (dome) dome.visible = false;
          resolve();
        },
        undefined,
        () => resolve(), // no sky HDRI → keep the gradient dome
      );
    });
  }
}
