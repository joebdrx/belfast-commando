import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { RetroMaterial } from "./RetroMaterial.js";
import { getObjectSize } from "../utils/three.js";
import { BASE } from "../utils/constants.js";

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
  invader:          { size: 1.85, fit: "height", anchor: "bottom", rotY: Math.PI, darken: 0.75 },
  // Rescuable civilian. Primary path is the rigged getVictimRig() (walk/run);
  // this static-model entry is the fallback if the rig fails to load.
  enemy_victim:     { size: 1.7, fit: "height", anchor: "bottom", rotY: 0 },
  // first-person viewmodels — centred, scaled by their longest axis
  weapon_ak:        { size: 0.62, fit: "max", anchor: "center", rotY: 0 },
  weapon_pistol:    { size: 0.34, fit: "max", anchor: "center", rotY: 0 },
  weapon_shotgun:   { size: 0.58, fit: "max", anchor: "center", rotY: 0 }, // sawed-off boomstick
  // Enemy hand weapons (attached in Enemy._attachWeapon). Sized by longest axis;
  // the blade is auto-oriented to point forward at attach time.
  enemy_knife:      { size: 0.42, fit: "max", anchor: "center", rotY: 0 },
  enemy_machete:    { size: 0.60, fit: "max", anchor: "center", rotY: 0 },
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
  // Wall-mounted landline phone for the safehouse (HUB). The source is modelled
  // lying flat (thin Y axis), so scale by its longest axis to ~0.85m (a real
  // wall phone, proportionate to the room) and let Hub._buildPhone stand it
  // upright + face it into the room. Centre-anchored so it pivots about its own
  // middle when Hub rotates it onto the wall.
  landline_phone:   { size: 0.55, fit: "max", anchor: "center", rotY: 0 },
  // Safehouse bar props (HUB only): a Trinitron CRT + an open ThinkPad, sitting
  // on the back-bar counter. Anchored at their base so they rest on the surface.
  crt_tv:           { size: 0.72, fit: "height", anchor: "bottom", rotY: Math.PI },
  thinkpad:         { size: 0.6, fit: "max", anchor: "bottom", rotY: Math.PI },
  // Belfast exterior building templates (optimized from asset-reference via
  // scripts/optimize-buildings.sh). Provisional; tuned from the in-game audit.
  bldg_terrace:     { size: 12, fit: "height", anchor: "bottom", rotY: 0 },
  bldg_shop:        { size: 10, fit: "height", anchor: "bottom", rotY: 0 },
  bldg_church:      { size: 17, fit: "height", anchor: "bottom", rotY: 0 }, // landmark; taller (spire)
  // Apartment furniture (mobili/*.blend → furn_*.glb via scripts/convert-furniture.sh).
  // Vertex-painted low-poly props; size = the piece's defining real-world dimension.
  furn_bed:         { size: 2.0, fit: "max", anchor: "bottom", rotY: 0 },
  furn_wardrobe:    { size: 2.0, fit: "height", anchor: "bottom", rotY: 0 },
  furn_nightstand:  { size: 0.6, fit: "height", anchor: "bottom", rotY: 0 },
  furn_table:       { size: 1.5, fit: "max", anchor: "bottom", rotY: 0 },
  furn_chair:       { size: 0.9, fit: "height", anchor: "bottom", rotY: 0 },
  furn_bookshelf:   { size: 1.9, fit: "height", anchor: "bottom", rotY: 0 },
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

// Pre-built city model (public/models/city_map.glb, produced by
// scripts/optimize-map.sh). We do NOT use it as level geometry — its buildings
// interlock, so axis-aligned colliders merge into one solid block that seals
// the streets. Instead we render each building to an orthographic "facade"
// texture at load time and clad the procedural buildings with those fronts.
const MAP_SLUG = "city_map";

export class AssetManager {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    this.texLoader = new THREE.TextureLoader();
    this.gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    this.retro = new RetroMaterial({ targetHeight: 240 });
    this.retro.setViewport(window.innerWidth, window.innerHeight);
    this.materials = {};
    this.models = {}; // slug -> normalised template Object3D (cloned per use)
    this.sprites = {}; // name -> THREE.Texture
    this.murals = []; // THREE.Texture[]
    this.facades = []; // [{ texture, aspect }] building fronts baked from the city model
    this.faceTexture = null; // photo face slapped onto enemy heads (non-1.png)
    this.houseSideTexture = null; // grimy tenement facade for building side walls (4h.png)
    this._riggedEnemy = null; // { scene, clips:{walk,run,idle} }
    this._victimRig = null; // { scene, clips:{walk,run}, height } — rescuable civilian
    this._menuActor = null; // { scene, clips:{walk,idle}, height } — safehouse hero + ally NPCs
    this._attackClip = null; // shared melee attack AnimationClip (retargets onto every rig)
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
      this.retro.patchMaterial(this.materials[slug]);
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
          this.retro.applyTextureFilter(tex);
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

    // 3D models, 2D sprites, and the rigged enemies run alongside.
    await Promise.all([...jobs, this.loadModels(), this.loadSprites(), this.loadMurals(), this._loadRiggedEnemy(), this._loadArchetypeRigs(), this._loadAttackClip(), this._loadMenuActor(), this._loadPlayer2(), this.loadFace(), this.loadHouseSide()]);

    // ponytail: heavy, level-only scene dressing streams DETACHED (off the await)
    // so the loading screen + first deploy aren't gated on ~21MB. Each degrades
    // gracefully until it lands and is swapped in: the city_map facade bake (15MB)
    // → plain brick walls, sky.hdr → the gradient sky dome, overcast.hdr → lights-
    // only IBL. A fast first deploy inside this window simply looks plainer.
    if (scene) {
      this._loadEnvironment(scene).catch(() => {});
      this._loadSky(scene).catch(() => {});
    }
    this.captureFacades().catch(() => {});
  }

  /** Load the photo face that gets billboarded onto each enemy's head. */
  async loadFace() {
    const tex = await this._loadTexture(`${BASE}non-1.png`, { srgb: true });
    if (tex) {
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      this.faceTexture = tex;
    }
  }

  /** Load the grimy tenement facade used to clad the long building side walls. */
  async loadHouseSide() {
    const tex = await this._loadTexture(`${BASE}house_side.png`, { srgb: true });
    if (tex) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping; // tiled along the terrace
      this.houseSideTexture = tex;
    }
  }

  getHouseSideTexture() {
    return this.houseSideTexture;
  }

  /**
   * Load + normalise the optional pre-built city map. Scaled so its tallest
   * point is MAP_TARGET_HEIGHT metres, recentred on X/Z, and dropped so its
   * lowest point (the street) sits at y=0. Missing file → `this.map` stays
   * null and the Level falls back to the procedural grid.
   */
  /**
   * Render each building in the city model to an orthographic front-elevation
   * texture (transparent background). Buildings are grouped by their `bat{N}`
   * name prefix; we hide every other building while capturing one, so the
   * model's interlocking geometry never bleeds into a facade. The model is
   * disposed afterwards — only the facade canvases are kept.
   */
  async captureFacades() {
    let gltf;
    try {
      gltf = await this.gltfLoader.loadAsync(`${BASE}models/${MAP_SLUG}.glb`);
    } catch {
      this.facades = [];
      return;
    }
    const root = gltf.scene;
    root.updateWorldMatrix(true, true);

    // Group meshes by building prefix (bat1, bat2, …) and accumulate world bbox.
    const groups = new Map();
    root.traverse((o) => {
      if (!o.isMesh) return;
      const m = (o.name || "").match(/^(bat\d+)/i);
      if (!m) return;
      const key = m[1].toLowerCase();
      let g = groups.get(key);
      if (!g) { g = { meshes: [], box: new THREE.Box3() }; groups.set(key, g); }
      g.meshes.push(o);
      o.geometry.computeBoundingBox();
      g.box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) { if (mat) { mat.transparent = false; mat.depthWrite = true; mat.alphaTest = 0.4; } }
      o.visible = false; // hidden by default; shown one building at a time
    });

    // Even, bright capture lighting so facades read as clean diffuse textures.
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0xbfc4c8, 1.3));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(0.4, 1, 0.7);
    scene.add(sun);
    scene.add(root);

    // Save renderer state — capture must not perturb the live game render.
    const prevTarget = this.renderer.getRenderTarget();
    const prevTone = this.renderer.toneMapping;
    const prevClear = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x000000, 0); // transparent background

    const cam = new THREE.OrthographicCamera();
    cam.up.set(0, 1, 0);
    this.facades = [];

    for (const g of groups.values()) {
      const size = g.box.getSize(new THREE.Vector3());
      const center = g.box.getCenter(new THREE.Vector3());
      if (size.y < 1e-3) continue;
      // Facade runs along the longer horizontal axis; capture perpendicular to it.
      const alongX = size.x >= size.z;
      const width = alongX ? size.x : size.z;
      const height = size.y;
      const depth = (alongX ? size.z : size.x) || 1;
      const normal = alongX ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);

      cam.left = -width / 2; cam.right = width / 2;
      cam.top = height / 2; cam.bottom = -height / 2;
      cam.near = 0.01; cam.far = depth * 2 + 20;
      cam.position.copy(center).add(normal.clone().multiplyScalar(depth / 2 + 4));
      cam.lookAt(center);
      cam.updateProjectionMatrix();

      const texH = 512;
      const texW = Math.min(1024, Math.max(64, Math.round(texH * (width / height))));
      const rt = new THREE.WebGLRenderTarget(texW, texH, { colorSpace: THREE.SRGBColorSpace });

      g.meshes.forEach((me) => (me.visible = true));
      this.renderer.setRenderTarget(rt);
      this.renderer.clear();
      this.renderer.render(scene, cam);
      g.meshes.forEach((me) => (me.visible = false));

      const buf = new Uint8Array(texW * texH * 4);
      this.renderer.readRenderTargetPixels(rt, 0, 0, texW, texH, buf);
      rt.dispose();

      // Copy into a canvas, flipping vertically (GL origin is bottom-left).
      const canvas = document.createElement("canvas");
      canvas.width = texW; canvas.height = texH;
      const cctx = canvas.getContext("2d");
      const img = cctx.createImageData(texW, texH);
      for (let y = 0; y < texH; y++) {
        const sy = texH - 1 - y;
        for (let x = 0; x < texW; x++) {
          const si = (sy * texW + x) * 4, di = (y * texW + x) * 4;
          img.data[di] = buf[si]; img.data[di + 1] = buf[si + 1];
          img.data[di + 2] = buf[si + 2]; img.data[di + 3] = buf[si + 3];
        }
      }
      cctx.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      this.facades.push({ texture: tex, aspect: width / height });
    }

    // Restore renderer; free the model (geometry + materials + textures).
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.toneMapping = prevTone;
    this.renderer.setClearColor(prevClear, prevAlpha);
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) { if (m) { if (m.map) m.map.dispose(); m.dispose(); } }
      }
    });
  }

  hasFacades() {
    return this.facades.length > 0;
  }

  /** Baked building-front textures: [{ texture, aspect }]. */
  getFacades() {
    return this.facades;
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
        height = getObjectSize(base.scene).y || 1.7;
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

  /**
   * Load the shared melee attack clip ONCE (anim_attack.glb — an animation-only
   * GLB, mesh stripped at build time). Its tracks target the same bone names as
   * walk/run, so this single clip retargets onto every rigged enemy. We rename
   * the clip "attack" so it can't collide with the walk/run clip names, and only
   * read animations[0]. Missing file → stays null and enemies simply skip the
   * attack animation.
   */
  async _loadAttackClip() {
    try {
      const gltf = await this.gltfLoader.loadAsync(`${BASE}models/anim_attack.glb`);
      const clip = gltf.animations[0] || null;
      if (clip) clip.name = "attack";
      this._attackClip = clip;
    } catch {
      this._attackClip = null;
    }
  }

  /**
   * Per-archetype rigged + animated enemy models (each its own Meshy character,
   * so grunt/gunner/breacher/enforcer read as distinct enemy types). Each base
   * GLB carries its walk clip (animations[0]); a tiny armature GLB adds the run
   * clip on the same skeleton. Height is measured WITH the walk clip applied
   * (the rig's bind-pose bbox is tiny — see _loadRiggedEnemy).
   */
  /**
   * Load one rigged character: a base GLB (walk clip = animations[0]) + an armature
   * run clip on the same skeleton. Returns {scene, clips:{walk,run}, height} with
   * height measured WITH the walk clip applied (bind-pose bbox is tiny).
   */
  async _loadRig(meshSlug, runSlug, darken = 0.85) {
    const base = await this.gltfLoader.loadAsync(`${BASE}models/${meshSlug}.glb`);
    const clips = {};
    if (base.animations[0]) clips.walk = base.animations[0];
    if (runSlug) {
      const run = await this.gltfLoader.loadAsync(`${BASE}models/${runSlug}.glb`).catch(() => null);
      if (run && run.animations[0]) clips.run = run.animations[0];
    }
    base.scene.traverse((o) => {
      if (o.isMesh) o.frustumCulled = false; // skinned bounds animate; avoid pop-out
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        if (!m) continue;
        if (m.metalness !== undefined) m.metalness = 0;
        if (m.color && darken !== 1) m.color.multiplyScalar(darken);
        m.needsUpdate = true;
      }
    });
    let height = 1.7;
    if (clips.walk) {
      const tmp = new THREE.AnimationMixer(base.scene);
      tmp.clipAction(clips.walk).play();
      tmp.update(0.2);
      base.scene.updateMatrixWorld(true);
      height = getObjectSize(base.scene).y || 1.7;
      tmp.stopAllAction();
    }
    return { scene: base.scene, clips, height };
  }

  async _loadArchetypeRigs() {
    this._rigs = {};
    // Loaded character models. enemy_grunt=stabber (the cleaver fighter),
    // enemy_enforcer=groomer (bald older man), enemy_fatstabber (turbaned heavy),
    // enemy_gunner=invader2 (young street guy, back in the pool). invader1
    // (enemy_breacher) stays retired.
    const RIGS = ["grunt", "enforcer", "fatstabber", "gunner"];
    await Promise.all(RIGS.map(async (slug) => {
      try { this._rigs[slug] = await this._loadRig(`enemy_${slug}`, `anim_${slug}_run`); }
      catch { /* missing → dropped from the pool below */ }
    }));
    // Unified ENEMY MODEL POOL: the MODEL is decoupled from the archetype, so
    // EVERY enemy type spawns a random model from this pool (wide variety). Each
    // entry carries a `soundType` (1 or 2) that drives which voice-bark pool the
    // enemy uses — only that model's type lines play for it.
    //   type1 = stabber / invader2 (young street guys)
    //   type2 = groomer (bald man) / fatstabber (turbaned heavy)
    this._modelPool = [
      { rig: this._rigs.grunt, soundType: 1 }, // stabber
      { rig: this._rigs.gunner, soundType: 1 }, // invader2 (re-added)
      { rig: this._rigs.enforcer, soundType: 2 }, // groomer
      { rig: this._rigs.fatstabber, soundType: 2 }, // fatstabber
    ].filter((e) => e.rig);
    // Rescuable civilian: same Meshy rig pipeline (walk + run armature). darken=1
    // keeps her natural-coloured so she reads as a civilian, not an enemy.
    this._victimRig = await this._loadRig("enemy_victim", "anim_victim_run", 1.0).catch(() => null);
  }

  /**
   * A fresh animated enemy instance: normalised Object3D + its animation clips.
   * Prefers the archetype's own rig (distinct enemy type); falls back to the
   * generic rigged invader (which wears the photo face). The per-archetype models
   * have their own heads, so they do NOT get the shared photo face.
   */
  getRiggedEnemy(archetype) {
    // The MODEL is independent of the archetype: pick a random model from the
    // unified pool (so every enemy type has the full variety). The archetype only
    // drives behaviour/stats elsewhere. `soundType` rides along so the enemy uses
    // the matching voice-bark pool.
    let entry = null;
    if (this._modelPool && this._modelPool.length) {
      entry = this._modelPool[Math.floor(Math.random() * this._modelPool.length)];
    }
    const rig = entry ? entry.rig : this._riggedEnemy;
    const soundType = entry ? entry.soundType : 1;
    const distinct = !!entry; // pool models have their own heads (no photo face)
    if (!rig) return null;
    const inner = cloneSkeleton(rig.scene);
    // The rig's natural front is +Z, which is what Enemy's facing math
    // (group.rotation.y = atan2(toPlayer)) expects — so NO 180° flip.
    inner.rotation.y = 0;
    const wrap = new THREE.Group();
    wrap.add(inner);
    // Scale by the measured animated height (NOT the misleading geometry bbox).
    wrap.scale.setScalar(1.85 / (rig.height || 1.7));
    if (!distinct) this._attachFace(wrap); // only the generic invader wears the photo face
    // Add the shared one-shot melee attack clip (retargets onto this rig's
    // bones) without mutating the rig's shared clips object.
    const clips = this._attackClip ? { ...rig.clips, attack: this._attackClip } : rig.clips;
    return { object3D: wrap, clips, soundType };
  }

  /**
   * Load the safehouse (HUB) menu actor: one skinned, animated humanoid used for
   * BOTH the hero centrepiece and the ally NPCs. Mirrors _loadRig — a base GLB
   * carrying the WALK clip (animations[0]) plus a small standing IDLE/fidget clip
   * (Confused_Scratch) on the same skeleton, retargeted by bone name. Height is
   * measured WITH the walk clip applied (the rig's bind-pose bbox is tiny — see
   * _loadRiggedEnemy). Missing file → stays null and Hub uses its primitives.
   */
  async _loadMenuActor() {
    try {
      const base = await this.gltfLoader.loadAsync(`${BASE}models/menu_actor.glb`);
      const clips = {};
      if (base.animations[0]) clips.walk = base.animations[0];
      const idle = await this.gltfLoader.loadAsync(`${BASE}models/anim_menu_idle.glb`).catch(() => null);
      if (idle && idle.animations[0]) clips.idle = idle.animations[0];
      base.scene.traverse((o) => {
        if (o.isMesh) o.frustumCulled = false; // skinned bounds animate; avoid pop-out
        const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of mats) {
          if (!m) continue;
          if (m.metalness !== undefined) m.metalness = 0;
          m.needsUpdate = true;
        }
      });
      let height = 1.7;
      if (clips.walk) {
        const tmp = new THREE.AnimationMixer(base.scene);
        tmp.clipAction(clips.walk).play();
        tmp.update(0.2);
        base.scene.updateMatrixWorld(true);
        height = getObjectSize(base.scene).y || 1.7;
        tmp.stopAllAction();
      }
      this._menuActor = { scene: base.scene, clips, height };
    } catch {
      this._menuActor = null;
    }
  }

  hasMenuActor() {
    return !!this._menuActor;
  }

  /** Player-2 used STATIC: a skinned mesh shown in its bind/rest pose (its own
   *  animation deformed badly). Loaded like a rig so it can be SkeletonUtils-
   *  cloned (a plain clone collapses skinned meshes); Hub adds a breathing bob. */
  async _loadPlayer2() {
    try {
      const base = await this.gltfLoader.loadAsync(`${BASE}models/player2_static.glb`);
      base.scene.traverse((o) => {
        if (o.isMesh) o.frustumCulled = false;
        const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of mats) { if (m && m.metalness !== undefined) { m.metalness = 0; m.needsUpdate = true; } }
      });
      // Measure height with the baked clip briefly applied (bind-pose bbox is tiny).
      let height = 1.7;
      const clip = base.animations[0];
      if (clip) {
        const tmp = new THREE.AnimationMixer(base.scene);
        tmp.clipAction(clip).play();
        tmp.update(0.01);
        base.scene.updateMatrixWorld(true);
        height = getObjectSize(base.scene).y || 1.7;
        tmp.stopAllAction();
      }
      this._player2 = { scene: base.scene, height };
    } catch {
      this._player2 = null;
    }
  }

  hasPlayer2() {
    return !!this._player2;
  }

  /** A fresh SkeletonUtils clone of player-2, wrapped + scaled to ~1.8m, shown in
   *  bind/rest pose (no mixer). Front is +Z. Returns null when unavailable. */
  getPlayer2() {
    if (!this._player2) return null;
    const inner = cloneSkeleton(this._player2.scene);
    inner.rotation.y = 0;
    const wrap = new THREE.Group();
    wrap.add(inner);
    wrap.scale.setScalar(1.8 / (this._player2.height || 1.7));
    return wrap;
  }

  /**
   * A fresh animated menu actor for the safehouse: a SkeletonUtils clone wrapped
   * in a group and scaled to a natural ~1.8m height, plus its shared clips. The
   * rig's natural front is +Z (same as the enemy rigs), so callers face it by
   * rotating the wrapping group. Each caller drives its OWN AnimationMixer on the
   * returned object3D (clones share the AnimationClip data harmlessly). Returns
   * null when the GLB is unavailable (headless / tests) → Hub uses primitives.
   * @returns {{object3D:THREE.Group, clips:{walk?:THREE.AnimationClip, idle?:THREE.AnimationClip}}|null}
   */
  getMenuActor() {
    if (!this._menuActor) return null;
    const inner = cloneSkeleton(this._menuActor.scene);
    inner.rotation.y = 0; // rig front is +Z; callers rotate the wrap to aim it
    const wrap = new THREE.Group();
    wrap.add(inner);
    wrap.scale.setScalar(1.8 / (this._menuActor.height || 1.7));
    return { object3D: wrap, clips: this._menuActor.clips };
  }

  /**
   * The rescuable civilian, rigged + animated (walk while captive, run on flee).
   * Mirrors getRiggedEnemy/getMenuActor: a FRESH per-instance SkeletonUtils clone
   * wrapped in a group and height-normalised to ~1.7m using the height measured
   * WITH the walk clip applied (the bind-pose bbox is tiny — see _loadRig). The
   * rig's natural front is +Z, so Victim faces her by rotating the wrap group. The
   * clips ({walk, run}) are shared (read-only) across clones. Null (→ static model
   * fallback in Level) if the rig failed to load (e.g. missing GLB / headless).
   * @returns {{ object3D: THREE.Object3D, clips: object } | null}
   */
  getVictimRig() {
    if (!this._victimRig) return null;
    const inner = cloneSkeleton(this._victimRig.scene);
    inner.rotation.y = 0; // rig front is +Z; Victim aims her by rotating the wrap
    const wrap = new THREE.Group();
    wrap.add(inner);
    // Scale by the measured ANIMATED height (NOT the misleading tiny bind bbox).
    wrap.scale.setScalar(1.7 / (this._victimRig.height || 1.7));
    return { object3D: wrap, clips: this._victimRig.clips };
  }

  /**
   * Parent a photo-face quad to the head bone so it tracks the animation. The
   * desired transform is built in the wrap's (metre-scale) world frame — at the
   * head, nudged forward, facing the rig's +Z front — then expressed in the
   * bone's local space so it rides along as the skeleton poses/animates.
   */
  _attachFace(wrap) {
    if (!this.faceTexture) return;
    let head = null, fallback = null;
    wrap.traverse((o) => {
      if (!o.isBone) return;
      if (o.name === "headfront") head = o;
      else if (o.name === "Head") fallback = o;
    });
    head = head || fallback;
    if (!head) return;

    wrap.updateMatrixWorld(true);
    const headPos = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
    const SIZE = 0.44;
    const desired = new THREE.Matrix4().compose(
      headPos.add(new THREE.Vector3(0, 0.09, 0.05)), // up + onto the face
      new THREE.Quaternion(), // face +Z (the enemy's forward, toward the player)
      new THREE.Vector3(SIZE, SIZE, SIZE),
    );
    const local = new THREE.Matrix4().copy(head.matrixWorld).invert().multiply(desired);

    const face = new THREE.Mesh(this._faceGeometry(), this._faceMaterial());
    face.frustumCulled = false;
    local.decompose(face.position, face.quaternion, face.scale);
    head.add(face);
  }

  /**
   * A curved (spherical-cap) sheet, shared across enemies. The photo keeps its
   * flat 0..1 UVs but the surface bulges forward at the centre and wraps back at
   * the edges, so it conforms to the head's shape instead of standing off as a
   * flat card. The transparent corners of the cut-out simply wrap out of sight.
   */
  _faceGeometry() {
    if (this._faceGeo) return this._faceGeo;
    const geo = new THREE.PlaneGeometry(1, 1, 24, 24);
    const p = geo.attributes.position;
    const Rc = 0.7; // cap radius (unit space) — smaller = more wrap
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i);
      const r2 = Math.min(x * x + y * y, Rc * Rc * 0.998);
      p.setZ(i, -(Rc - Math.sqrt(Rc * Rc - r2)));
    }
    p.needsUpdate = true;
    geo.computeVertexNormals();
    this._faceGeo = geo;
    return geo;
  }

  _faceMaterial() {
    if (!this._faceMat) {
      this._faceMat = new THREE.MeshBasicMaterial({
        map: this.faceTexture,
        transparent: true,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
        depthWrite: true,
      });
    }
    return this._faceMat;
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
    if (!tpl) return null;
    return this.retro.patchObject(tpl.clone(true));
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
          // NIGHT: keep IBL very dim so the overcast HDRI doesn't daylight the
          // scene — just a faint cold sheen on wet/metal surfaces.
          if ("environmentIntensity" in scene) scene.environmentIntensity = 0.12;
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
          // NIGHT: crush the overcast cloud HDRI to a near-black night sky.
          if ("backgroundIntensity" in scene) scene.backgroundIntensity = 0.06;
          if ("backgroundBlurriness" in scene) scene.backgroundBlurriness = 0.06;
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
