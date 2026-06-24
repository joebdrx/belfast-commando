import * as THREE from "three";
import { Enemy } from "./Enemy.js";
import { EnemyDirector } from "./EnemyDirector.js";
import { footprintCollider, blockPlan } from "./BuildingLayout.js";
import { Victim } from "./Victim.js";
import { buildFacade } from "./BuildingFacade.js";
import FURNITURE from "../data/furniture.json";

const BASE = import.meta.env.BASE_URL || "/";

const _ray = new THREE.Ray();
const _dir = new THREE.Vector3();
const _hit = new THREE.Vector3();

/**
 * Escalation tuning. To keep a sector from going stale while the player hunts the
 * last few stragglers, an ALARM is raised once EITHER the player has been in the
 * sector long enough OR enough of the garrison is down — whichever comes first.
 * On the alarm every living invader starts HUNTING: it abandons its room/idle post
 * and converges on the player even with no line of sight, so the fight comes to you.
 */
export const ALARM_TIME = 50; // seconds in-sector before the garrison mobilises
export const ALARM_KILL_FRAC = 0.5; // ...or once half the garrison is down

/**
 * Door
 * ----
 * A kickable wooden door on a hinge. Closed doors block movement (collider)
 * and line-of-sight. A kick swings it open hard, clears the collider, and
 * awards style points. Placeholder = a slab of "wood".
 */
class Door {
  constructor(hingePos, width, openDir = 1, facing = 0, slabMat = null, slabModel = null) {
    this.width = width;
    this.open = false;
    this.openProgress = 0;
    this.openDir = openDir; // +1 / -1 swing direction
    this.scored = false;

    // Pivot at the hinge; door slab offset so it swings like a real door.
    this.pivot = new THREE.Group();
    this.pivot.position.copy(hingePos);
    this.pivot.rotation.y = facing;
    this._baseFacing = facing; // swing animation pivots around this

    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(width, 2.6, 0.14),
      slabMat || new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.85 }),
    );
    slab.position.set(width / 2, 1.3, 0);
    this.pivot.add(slab);

    // Collider/LOS proxy is ALWAYS the thin slab (model-independent). Compute
    // it from the slab only, before adding the GLB. The pivot's world matrix
    // MUST be updated first — Box3.expandByObject doesn't update parents, so
    // without this the box lands at the slab's LOCAL position (~0.75,1.3,0)
    // instead of the real doorway, making doors un-kickable.
    this.pivot.updateMatrixWorld(true);
    this._closedBox = new THREE.Box3().setFromObject(slab).expandByScalar(0.02);
    this.center = this._closedBox.getCenter(new THREE.Vector3());

    if (slabModel) {
      // Use the AI door leaf for visuals; the slab becomes an invisible proxy.
      slab.visible = false;
      slabModel.position.set(width / 2, 0, 0);
      this.pivot.add(slabModel);
    } else {
      // Handle accent (placeholder door only)
      const handle = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.6, roughness: 0.3 }),
      );
      handle.position.set(width - 0.18, 1.25, 0.1);
      this.pivot.add(handle);
    }
  }

  getCollider() {
    return this.open ? null : this._closedBox;
  }

  kick() {
    if (this.open) return false;
    this.open = true;
    return true;
  }

  update(dt) {
    if (this.open && this.openProgress < 1) {
      this.openProgress = Math.min(1, this.openProgress + dt * 5);
      // Ease-out swing to ~100 degrees.
      const t = 1 - Math.pow(1 - this.openProgress, 3);
      this.pivot.rotation.y = this._baseFacing + this.openDir * t * 1.75;
    }
  }
}

/**
 * Level
 * -----
 * Procedurally assembles an OPEN Belfast quarter: a 3×3 grid of red-brick
 * building blocks separated by a navigable street grid. Each block is an
 * enclosed room (walls + ceiling + pitched roof) entered by kicking its door.
 * Enemies patrol the streets and hole up inside the buildings — the sector is
 * cleared (level complete) only when every invader is down. Difficulty and the
 * enemy count scale with the level index.
 */
export class Level {
  constructor(scene, index = 0, assets = null, layoutSeed = null) {
    this.scene = scene;
    this.index = index; // campaign DIFFICULTY index (counts, mix, stat scaling)
    // Per-run procedural-placement seed, DECOUPLED from difficulty. Defaults to
    // the old index-derived formula so existing 3-arg callers/tests reproduce the
    // identical layout; LevelManager passes a fresh random seed per deploy so
    // enemy/victim/cover placement varies every run.
    this.layoutSeed = (layoutSeed != null ? layoutSeed : 2024 + (index >>> 0) * 131) >>> 0;
    this.assets = assets;
    this.group = new THREE.Group();
    scene.add(this.group);

    /** @type {THREE.Box3[]} static + door colliders for movement */
    this.colliders = [];
    /** @type {THREE.Box3[]} blockers for line-of-sight (walls, car, doors) */
    this.losBlockers = [];
    /** @type {Door[]} */
    this.doors = [];
    /** @type {Enemy[]} */
    this.enemies = [];
    /** @type {Victim[]} */
    this.victims = [];
    // Rescued civilians that have since fled off-screen and been spliced out of
    // `this.victims`. Tracked persistently so the "saved" count + wellbeing bar
    // don't drop when a rescued civilian despawns.
    this._savedDespawned = 0;
    // Escalation state (see ALARM_TIME / ALARM_KILL_FRAC). Once raised, every living
    // invader hunts the player. `_initialEnemies` is captured lazily on the first
    // alarm tick so it counts the fully-spawned garrison.
    this.alarmRaised = false;
    this._combatTime = 0;
    this._initialEnemies = null;
    // Archetype mix scales with sector index. Deterministic enough; uses the
    // global RNG so each run varies. Drives _addEnemy when no archetype is given.
    this._director = new EnemyDirector(index || 0);
    /** @type {Array<{root:THREE.Object3D, hitbox:THREE.Box3, collider:THREE.Box3, pos:THREE.Vector3, exploded:boolean}>} */
    this.barrels = [];
    /** @type {Array<{root:THREE.Object3D, hitbox:THREE.Box3, collider:THREE.Box3, pos:THREE.Vector3, opened:boolean, loot:object}>} */
    this.crates = [];

    this.spawn = new THREE.Vector3(-12, 1.7, 38);
    this.spawnYaw = 0; // procedural grid faces -Z into the street
    this.exit = null; // no exit gate — clearing the sector completes the level

    // Pull shared, textured materials from the AssetManager when present;
    // otherwise fall back to flat colours so the level still builds.
    this._materials = {
      brick: this._mat("brick", 0x8a4b3a, 0.95),
      brickDark: this._mat("brick_dark", 0x6e3b2e, 0.95),
      // Real asphalt photo for the street (Urban Jungle), kept slightly wet via
      // low roughness so the scene's env map still glistens in the rain.
      tarmac: this._texMat("textures/urban/asphalt.jpg", { repeat: [10, 30], roughness: 0.55, metalness: 0.05, color: 0x33373b }),
      concrete: this._mat("concrete", 0x6b6f72, 0.9),
      crate: this._mat("crate", 0x7a5a30, 0.8),
      barrel: this._mat("barrel", 0x355e3b, 0.6, 0.3),
      door: this._mat("door", 0x5a3a22, 0.85),
      roof: this._mat("roof", 0x474a4f, 0.85),
      pavement: this._mat("pavement", 0x6e706d, 0.92),
      // Flat architectural materials (windows, kerbs, paint, hills, ceilings).
      glass: new THREE.MeshStandardMaterial({ color: 0x121a1f, roughness: 0.16, metalness: 0.2, envMapIntensity: 1.6 }),
      // A faintly-lit window variant — a deterministic ~1/4 of facade windows use
      // this so terraces read as inhabited rather than uniformly dark.
      glassLit: new THREE.MeshStandardMaterial({ color: 0x2a2410, emissive: 0xffb347, emissiveIntensity: 0.5, roughness: 0.3, metalness: 0.1 }),
      frame: new THREE.MeshStandardMaterial({ color: 0xb6bbbd, roughness: 0.7 }),
      kerb: new THREE.MeshStandardMaterial({ color: 0x8b8e8b, roughness: 0.92 }),
      paint: new THREE.MeshStandardMaterial({ color: 0xeae6da, roughness: 0.55 }),
      hill: new THREE.MeshStandardMaterial({ color: 0x3a4138, roughness: 1.0 }),
      ceiling: new THREE.MeshStandardMaterial({ color: 0x4a4d4f, roughness: 0.95 }),
      // Domestic interior surfaces — a real plaster photo on the walls + a wood
      // floor so the low-ceiling rooms read as lived-in apartments, not bare brick.
      apartmentWall: this._texMat("textures/urban/plaster.jpg", { repeat: [3, 1.5], roughness: 0.97, color: 0xc4baa6 }),
      apartmentFloor: new THREE.MeshStandardMaterial({ color: 0x5a3f28, roughness: 0.7, metalness: 0 }),
      apartmentCeiling: new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.96 }),
      // Grimy tenement photo clad onto the long side walls (null → plain brick).
      sideHouse: assets && assets.getHouseSideTexture && assets.getHouseSideTexture()
        ? new THREE.MeshStandardMaterial({ map: assets.getHouseSideTexture(), roughness: 0.92, metalness: 0 })
        : null,
    };

    // Curated real brick photos (Urban Jungle) used to vary building exteriors —
    // each building picks one (see _pickBuildingMat) so the terraces never repeat.
    this._urbanBricks = ["brick_red", "brick_mixed", "brick_weathered", "brick_clean", "brick_grey"]
      .map((n) => this._texMat(`textures/urban/${n}.jpg`, { repeat: [2, 1.8], roughness: 0.95, color: 0x8a5a44 }));

    // Urban Jungle detail textures (one material per image; used as windows on
    // facades, varied door leaves, and wall/ground decals).
    const tex = (n, o) => this._texMat(`textures/urban/${n}.jpg`, o);
    // A mix of LIT (warm glow at night) and dark windows so the terraces read as
    // inhabited after dark.
    this._windowMats = ["win_1", "win_2", "win_3", "win_4", "win_5"].map((n, i) =>
      tex(n, {
        repeat: [1, 1], roughness: 0.35, metalness: 0.1, color: 0x99a0a4,
        emissive: i % 2 === 0 ? { color: 0xffca6e, intensity: 0.85 } : null,
      }));
    this._doorMats = ["door_1", "door_2", "door_3", "door_4", "door_5"]
      .map((n) => tex(n, { repeat: [1, 1], roughness: 0.8, color: 0x9a8f80 }));
    this._signMats = ["sign_1", "sign_2", "sign_3", "sign_4", "sign_5"]
      .map((n) => tex(n, { repeat: [1, 1], roughness: 0.6, color: 0xc8c4bc }));
    this._graffitiMats = ["graf_1", "graf_2", "graf_3", "graf_4", "graf_5"]
      .map((n) => tex(n, { repeat: [1, 1], roughness: 0.9, color: 0xa9a4a0 }));
    this._gratingMats = ["grate_1", "grate_2", "grate_3", "grate_4"]
      .map((n) => tex(n, { repeat: [1, 1], roughness: 0.85, metalness: 0.3, color: 0x6a6a6a }));
    this._groundMats = {
      gravel: tex("ground_gravel", { repeat: [5, 5], roughness: 0.97, color: 0x7a7068 }),
      crack: tex("ground_crack", { repeat: [4, 4], roughness: 0.95, color: 0x55585b }),
      grass: tex("grass", { repeat: [1, 1], roughness: 1.0, color: 0x4a5a32 }), // tiled per-strip via geometry UVs
    };
    // Belfast sectarian murals (Ulster loyalist + IRA republican) — alternated
    // along the boundary walls.
    this._muralMats = ["mural_ulster", "mural_ira"]
      .map((n) => tex(n, { repeat: [1, 1], roughness: 0.9, color: 0xb0aaa2 }));

    // Grid geometry shared across builders. Buildings are tall, long terraces:
    // narrow frontage (X) and a long run (Z), so they line the north–south
    // streets the player walks down.
    this.CEIL_H = 3.2; // interior apartment ceiling height
    this.WALL_H = 3.6; // exterior wall height — sits just above the ceiling so the
                       // roof caps right on top (no hollow shell above the room)
    this.BLOCK_W = 14; // frontage width (X)
    this.BLOCK_L = 56; // 4× the original 14m run (Z)
    this.STREET = 10; // lane width between blocks
    this.PITCH_X = this.BLOCK_W + this.STREET; // 24
    this.PITCH_Z = this.BLOCK_L + this.STREET; // 66
    this.COORDS_X = [-this.PITCH_X, 0, this.PITCH_X]; // 3 columns: -24, 0, +24
    this.COORDS_Z = [-this.PITCH_Z / 2, this.PITCH_Z / 2]; // 2 rows: -33, +33
    this.GRID_HALF_X = this.PITCH_X + this.BLOCK_W / 2; // 31
    this.GRID_HALF_Z = this.PITCH_Z / 2 + this.BLOCK_L / 2; // 61

    this._build();
  }

  // ---- construction helpers ------------------------------------------------

  /** Shared textured material from AssetManager, or a flat-colour fallback. */
  _mat(slug, color, roughness = 0.9, metalness = 0.0) {
    if (this.assets) return this.assets.getMaterial(slug);
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
  }

  /**
   * A standalone textured material that streams a `public/`-served image onto a
   * flat-colour fallback (so the level builds instantly, texture pops in). Used
   * for the curated "Urban Jungle" textures that aren't in the AssetManager DEFS.
   */
  _texMat(path, { repeat = [1, 1], roughness = 0.95, metalness = 0.0, color = 0x9a8a7a, emissive = null } = {}) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    if (emissive) {
      mat.emissive = new THREE.Color(emissive.color ?? 0xffffff);
      mat.emissiveIntensity = emissive.intensity ?? 0.3;
    }
    new THREE.TextureLoader().load(`${BASE}${path}`, (tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(repeat[0], repeat[1]);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      if (this.assets && this.assets.retro && this.assets.retro.applyTextureFilter) {
        this.assets.retro.applyTextureFilter(tex);
      }
      mat.map = tex;
      mat.color.set(0xffffff); // let the texture show its true colours
      if (emissive) mat.emissiveMap = tex; // window self-glows with its own image at night
      mat.needsUpdate = true;
    });
    return mat;
  }

  /**
   * Place a flat textured decal slightly proud of a surface (sign/graffiti on a
   * wall, or grating/grass on the ground). `ground:true` lays it flat; otherwise
   * it's a vertical panel oriented by `rotY` (same convention as _brickWall).
   * polygonOffset keeps it from z-fighting the surface it sits on.
   */
  _decal(mat, x, y, z, rotY, w, h, { ground = false } = {}) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.set(x, y, z);
    if (ground) m.rotation.x = -Math.PI / 2;
    else m.rotation.y = rotY;
    m.renderOrder = 1;
    this.group.add(m);
    return m;
  }

  /** Deterministic pick from an array, seeded by a position + salt (no per-frame RNG). */
  _pick(arr, x, z, salt = 0) {
    if (!arr || !arr.length) return null;
    const k = Math.abs(Math.round(x * 7.3 + z * 3.1) + (this.index | 0) + salt);
    return arr[k % arr.length];
  }

  /**
   * Sparingly stamp a graffiti panel and/or a sign onto a wall face (street-side).
   * `(centerX, centerZ, rotY)` is the wall's ground-line centre + outward facing
   * (same convention as _brickWall); `w`/`h` are the face size. Deterministic, so
   * the same sector always decorates the same walls.
   */
  _decorateWall(centerX, centerZ, rotY, w, h, salt = 0) {
    if (w < 3) return;
    const g = new THREE.Group();
    g.position.set(centerX, 0, centerZ);
    g.rotation.y = rotY;
    const OUT = 0.08;
    const seed = Math.abs(Math.round(centerX + centerZ * 1.7) + (this.index | 0) + salt);
    // Graffiti — roughly half of eligible walls get one, low on the wall.
    if (this._graffitiMats.length && seed % 2 === 0) {
      const gm = this._graffitiMats[seed % this._graffitiMats.length];
      const gw = Math.min(3.4, w * 0.45), gh = Math.min(2.0, h * 0.6);
      const span = Math.max(0.1, w - gw - 0.6);
      const u = ((seed * 7) % Math.floor(span * 10)) / 10 - span / 2;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(gw, gh), gm);
      m.position.set(u, gh / 2 + 0.25, OUT);
      m.renderOrder = 1;
      g.add(m);
    }
    // Sign — about a third of walls, at head height.
    if (this._signMats.length && seed % 3 === 1) {
      const sm = this._signMats[(seed + 2) % this._signMats.length];
      const sw = 0.85, sh = 1.0;
      const span = Math.max(0.1, w - sw - 0.6);
      const u = ((seed * 13) % Math.floor(span * 10)) / 10 - span / 2;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), sm);
      m.position.set(u, Math.min(2.0, h - 0.6), OUT);
      m.renderOrder = 1;
      g.add(m);
    }
    if (g.children.length) this.group.add(g);
  }

  /**
   * Ground detailing, placed where it makes sense rather than at random:
   *   • GRASS — a continuous straight verge butting each boundary wall (the
   *     neglected back-alley behind the outer buildings), one long plane per wall.
   *   • GRATES / drains sit in the inner traffic lanes (between the column blocks).
   * Deterministic per sector; grates skip building footprints.
   */
  _scatterGroundDetails() {
    const inStreet = (x, z) => {
      for (const b of this.colliders) {
        if (b.max.y < 1) continue; // ground/pavement slabs — ignore
        if (x > b.min.x - 0.5 && x < b.max.x + 0.5 && z > b.min.z - 0.5 && z < b.max.z + 0.5) return false;
      }
      return true;
    };
    let seed = 4321 + (this.index | 0) * 131;
    const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const put = (mat, x, z, s, y = 0.15) => { if (mat && inStreet(x, z)) this._decal(mat, x, y, z, 0, s, s, { ground: true }); };

    const HX = this.GRID_HALF_X, HZ = this.GRID_HALF_Z; // outer building edges (31, 61)
    const BX = HX + 12, BZ = HZ + 12;                    // boundary wall (43, 73) — matches _buildBoundary

    // --- Continuous grass verge butting each boundary wall (a straight strip, not
    // patches). One long plane per wall; UVs tiled by size so grass never stretches.
    const grass = this._groundMats.grass;
    const VERGE = 5; // strip width (m), sitting just inside the wall
    const TILE = 4;  // metres of ground per grass-texture tile
    const strip = (cx2, cz2, w, d) => {
      const geo = new THREE.PlaneGeometry(w, d);
      const uv = geo.attributes.uv;
      const su = Math.max(1, w / TILE), sv = Math.max(1, d / TILE);
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
      uv.needsUpdate = true;
      const m = new THREE.Mesh(geo, grass);
      m.rotation.x = -Math.PI / 2;
      m.position.set(cx2, 0.15, cz2);
      m.renderOrder = 1;
      this.group.add(m);
    };
    strip(BX - VERGE / 2, 0, VERGE, 2 * BZ);   // east wall (x=+BX): strip runs along Z
    strip(-BX + VERGE / 2, 0, VERGE, 2 * BZ);  // west wall
    strip(0, BZ - VERGE / 2, 2 * BX, VERGE);   // north wall (z=+BZ): strip runs along X
    strip(0, -BZ + VERGE / 2, 2 * BX, VERGE);  // south wall

    // --- Storm drains/grates along the inner north-south traffic lanes (sparing). ---
    if (this._gratingMats.length) {
      let grates = 0;
      for (const lx of [-this.PITCH_X / 2, this.PITCH_X / 2]) { // ~±12, between columns
        for (let z = -HZ + 12; z <= HZ - 12 && grates < 6; z += 28) {
          if (inStreet(lx, z)) { put(this._pick(this._gratingMats, lx, z, grates), lx, z, 1.1 + rng() * 0.5, 0.152); grates++; }
        }
      }
    }
  }

  /**
   * Street lamps down the inner lanes: a dark pole with an arm reaching over the
   * street, a glowing warm bulb, and a warm PointLight that pools light on the wet
   * road at night. `armDir` (+1/-1) is the world-X direction the arm reaches.
   * Kept to a handful of lights (no shadows) for performance.
   */
  _streetLamp(x, z, armDir = 1) {
    const POLE_H = 4.8;
    const poleMat = this._lampPoleMat || (this._lampPoleMat =
      new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.6, metalness: 0.6 }));
    const bulbMat = this._lampBulbMat || (this._lampBulbMat =
      new THREE.MeshStandardMaterial({ color: 0xffe2b0, emissive: 0xffb158, emissiveIntensity: 2.4, roughness: 0.4 }));
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, POLE_H, 8), poleMat);
    pole.position.y = POLE_H / 2;
    g.add(pole);
    const ax = armDir * 0.75;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(ax) + 0.1, 0.09, 0.09), poleMat);
    arm.position.set(ax / 2, POLE_H - 0.2, 0);
    g.add(arm);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.32, 8), poleMat);
    head.position.set(ax, POLE_H - 0.36, 0);
    g.add(head);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), bulbMat);
    bulb.position.set(ax, POLE_H - 0.52, 0);
    g.add(bulb);
    const light = new THREE.PointLight(0xffb259, 16, 24, 2); // warm, decays over ~24m
    light.position.set(ax, POLE_H - 0.55, 0);
    g.add(light);
    this.group.add(g);
    // Thin collider so the player can't walk through the post.
    this.colliders.push(new THREE.Box3(
      new THREE.Vector3(x - 0.22, 0, z - 0.22), new THREE.Vector3(x + 0.22, POLE_H, z + 0.22),
    ));
  }

  /** Place street lamps zig-zagging down the two inner N-S lanes + by the spawn. */
  _buildStreetLamps() {
    const lx = this.PITCH_X / 2; // ~12, lane centre between the column blocks
    const zs = [-42, -14, 14, 42];
    for (const lane of [-lx, lx]) {
      zs.forEach((z, i) => {
        const edge = i % 2 === 0 ? -3.5 : 3.5; // alternate sides of the lane
        this._streetLamp(lane + edge, z, edge < 0 ? 1 : -1); // arm reaches over the street
      });
    }
    // Two lamps lighting the spawn approach so the player doesn't start in the dark.
    this._streetLamp(this.spawn.x - 5, this.spawn.z - 5, 1);
    this._streetLamp(this.spawn.x + 5, this.spawn.z - 5, -1);
  }

  _box(w, h, d, mat, x, y, z, { collider = true, los = false } = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    if (collider) {
      const box = new THREE.Box3().setFromObject(mesh);
      this.colliders.push(box);
      if (los) this.losBlockers.push(box);
    }
    return mesh;
  }

  _build() {
    // Building fronts captured from the city model (empty array → plain brick).
    this._facades = this.assets && this.assets.hasFacades && this.assets.hasFacades()
      ? this.assets.getFacades()
      : [];
    this._facadeN = 0;
    this._buildProcedural();
  }

  _buildProcedural() {
    const { COORDS_X, COORDS_Z, PITCH_X, PITCH_Z, GRID_HALF_X, GRID_HALF_Z } = this;

    // --- Ground: wet tarmac covering the whole quarter + the spawn approach.
    const groundSize = (Math.max(GRID_HALF_X, GRID_HALF_Z) + 30) * 2;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      this._materials.tarmac,
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, 0);
    this.group.add(floor);

    // Player deploys on the southern street, facing north down the terraces.
    this.spawn = new THREE.Vector3(-PITCH_X / 2, 1.7, GRID_HALF_Z + 7);

    const rng = mulberry32(this.layoutSeed);

    // --- 3×3 terraced blocks: enclosed rooms with kickable doors. ---------
    // Roughly half the blocks hide an invader; the rest are empty rooms to
    // breach. Street enemies (added below) guarantee a fight regardless.
    COORDS_Z.forEach((cz, row) => {
      COORDS_X.forEach((cx, col) => {
        const plan = blockPlan(col, row, this.index);
        if (plan.kind === "interior") {
          const enemyCount = 2 + (rng() < 0.5 ? 1 : 0);
          this._buildBlock(cx, cz, enemyCount, rng);
        } else {
          this._buildModelBlock(cx, cz, plan.template, rng);
        }
      });
    });

    // --- Street network paint + far horizon. ------------------------------
    this._buildRoadPaint();
    this._buildBackdrop();
    this._buildBoundary();

    // --- Ground detailing: grass patches, grates, and cracked/gravel variety
    // scattered across the open streets (after buildings so footprints are known).
    this._scatterGroundDetails();

    // --- Warm street lamps pooling light down the lanes (night). ---
    this._buildStreetLamps();

    // --- Street cover: crates + explosive barrels in the open lanes. ------
    const coverCount = 6 + this.index * 2;
    let placed = 0;
    for (let guard = 0; placed < coverCount && guard < coverCount * 20; guard++) {
      const x = (rng() - 0.5) * GRID_HALF_X * 2;
      const z = (rng() - 0.5) * GRID_HALF_Z * 2;
      if (!this._inStreet(x, z)) continue;
      if (rng() < 0.5) {
        this._addCrate(x, z, rng);
      } else {
        this._addBarrel(x, z);
      }
      placed++;
    }

    // Burnt-out car roadblocks at the two cross-street intersections (cover + LOS).
    this._buildCar(PITCH_X / 2, 0);
    this._buildCar(-PITCH_X / 2, 0);

    // --- Street enemies patrolling the open grid. -------------------------
    const streetEnemies = 12 + this.index * 3;
    let spawned = 0;
    for (let guard = 0; spawned < streetEnemies && guard < streetEnemies * 30; guard++) {
      const x = (rng() - 0.5) * GRID_HALF_X * 2;
      const z = (rng() - 0.5) * GRID_HALF_Z * 2;
      if (!this._inStreet(x, z)) continue;
      if (Math.hypot(x - this.spawn.x, z - this.spawn.z) < 9) continue; // not on top of spawn
      const patrol = [
        new THREE.Vector3(x, 0, z - 3.5),
        new THREE.Vector3(x, 0, z + 3.5),
      ];
      this._addEnemy(new THREE.Vector3(x, 0, z), { patrol });
      spawned++;
    }

    // --- Set-dressing props + sectarian wall murals. ----------------------
    this._setDressing(rng);
    this._addMurals(rng);

    // --- Rescuable victims held by enemies. --------------------------------
    this._spawnVictims(rng);
  }

  /**
   * Spawn 2–3 rescuable civilians:
   *   • At least one INSIDE an interior building (near block centre, a captor enemy beside them).
   *   • At least one in a STREET (with 2 attacker enemies nearby).
   * Victims are pushed to `this.victims`, NEVER to `this.enemies`.
   * @param {()=>number} rng  Seeded RNG from _buildProcedural.
   */
  _spawnVictims(rng) {
    const { PITCH_X, PITCH_Z } = this;

    // Helper: add a victim at (vx, vz). Prefer the rigged (animated) victim so
    // she runs rather than slides; fall back to a static model, then a capsule.
    const addVictim = (vx, vz) => {
      const rig = this.assets && this.assets.getVictimRig && this.assets.getVictimRig();
      const opts = rig ? { rig } : { model: this.assets && this.assets.getModel("enemy_victim") };
      const v = new Victim(new THREE.Vector3(vx, 0, vz), opts);
      this.group.add(v.group);
      this.victims.push(v);
      return v;
    };

    // --- Interior victim ---------------------------------------------------
    // Interior blocks at col0/row1 (cx=-24, cz=+33) and col2/row0 (cx=+24, cz=-33).
    // Pick one at random via the seeded RNG.
    const interiorCentres = [
      { x: -PITCH_X, z: PITCH_Z / 2 },
      { x: PITCH_X,  z: -PITCH_Z / 2 },
    ];
    const ic = interiorCentres[rng() < 0.5 ? 0 : 1];
    // Place the victim slightly inside the footprint, offset from dead centre.
    const ivx = ic.x + (rng() - 0.5) * 3;
    const ivz = ic.z + (rng() - 0.5) * 10;
    const iv = addVictim(ivx, ivz);
    // Tag the last-added enemy as a captor: it menaces `victim`, with a random
    // initial taunt timer so multiple captors never strike in lockstep (D2).
    const tagCaptor = (victim) => {
      const e = this.enemies[this.enemies.length - 1];
      e._guardingVictim = victim;
      e._menaceTimer = 0.4 + rng() * 1.6;
    };
    // One captor enemy ~2m to the side — tagged so it menaces the victim.
    this._addEnemy(new THREE.Vector3(ivx + 1.5, 0, ivz), {});
    tagCaptor(iv);

    // --- Street victim(s) --------------------------------------------------
    // 1–2 street victims (level 0 → 1, higher levels → 2).
    const streetCount = this.index > 0 ? 2 : 1;
    let placed = 0;
    for (let guard = 0; placed < streetCount && guard < streetCount * 40; guard++) {
      const vx = (rng() - 0.5) * this.GRID_HALF_X * 1.8;
      const vz = (rng() - 0.5) * this.GRID_HALF_Z * 1.8;
      if (!this._inStreet(vx, vz)) continue;
      // Keep away from the player spawn.
      if (Math.hypot(vx - this.spawn.x, vz - this.spawn.z) < 12) continue;
      const sv = addVictim(vx, vz);
      // Two attacker enemies — both tagged so they menace the victim (staggered).
      this._addEnemy(new THREE.Vector3(vx + 2.0, 0, vz), {});
      tagCaptor(sv);
      this._addEnemy(new THREE.Vector3(vx - 2.0, 0, vz + 1.0), {});
      tagCaptor(sv);
      placed++;
    }
    // Total civilians this sector started with (denominator for the HUD bar text).
    this.victimCount = this.victims.length;
  }

  /**
   * One terraced building, subdivided along its long axis into a row of small
   * enclosed rooms. Each room is its own sealed box (cross-walls between them)
   * with a kickable door on the street-facing long side, and is clad outside
   * with the grimy tenement photo. A few rooms garrison an invader.
   */
  _buildBlock(cx, cz, enemyCount, rng) {
    const halfW = this.BLOCK_W / 2; // X half (frontage)
    const halfL = this.BLOCK_L / 2; // Z half (run)
    const t = 0.6;
    const wallH = this.WALL_H; // tall exterior brick shell (cladding + roof)
    const ceilH = this.CEIL_H; // low interior apartment ceiling
    const doorW = 1.7;
    const wall = this._materials.apartmentWall; // interior plaster room walls

    // Subdivide the long run (Z) into N small rooms; doors face the inner street.
    const N = 7;
    const roomLen = this.BLOCK_L / N;
    const doorSide = cx < 0 ? 1 : -1; // +1 = east wall, -1 = west wall
    const doorWallX = cx + doorSide * halfW;
    const backWallX = cx - doorSide * halfW;
    const roomZ = (i) => cz - halfL + roomLen * (i + 0.5);

    // Pavement apron (walk-over slab, no collider) + interior floor.
    const pave = new THREE.Mesh(
      new THREE.BoxGeometry(this.BLOCK_W + 3, 0.12, this.BLOCK_L + 3),
      this._materials.pavement,
    );
    pave.position.set(cx, 0.06, cz);
    this.group.add(pave);
    const f = new THREE.Mesh(
      new THREE.PlaneGeometry(this.BLOCK_W - 0.4, this.BLOCK_L - 0.4),
      this._materials.apartmentFloor,
    );
    f.rotation.x = -Math.PI / 2;
    f.position.set(cx, 0.13, cz);
    this.group.add(f);

    // Interior room shell rises only to the low apartment ceiling (CEIL_H); the
    // tall brick exterior is the separate cladding below. The door opening matches
    // the 2.6m kickable door, with a short lintel up to the ceiling.
    const DOOR_OPEN = 2.6;
    const lintelH = Math.max(0.1, ceilH - DOOR_OPEN);

    // End walls (short, N & S) + solid back long wall + room-dividing cross walls.
    this._box(this.BLOCK_W, ceilH, t, wall, cx, ceilH / 2, cz - halfL, { los: true });
    this._box(this.BLOCK_W, ceilH, t, wall, cx, ceilH / 2, cz + halfL, { los: true });
    this._box(t, ceilH, this.BLOCK_L, wall, backWallX, ceilH / 2, cz, { los: true });
    for (let i = 1; i < N; i++) {
      this._box(this.BLOCK_W, ceilH, t, wall, cx, ceilH / 2, cz - halfL + i * roomLen, { los: true });
    }

    // Door long wall: solid segments between the per-room doorways, plus lintels.
    let segStart = cz - halfL;
    for (let i = 0; i <= N; i++) {
      const segEnd = i < N ? roomZ(i) - doorW / 2 : cz + halfL;
      const segLen = segEnd - segStart;
      if (segLen > 0.02) {
        this._box(t, ceilH, segLen, wall, doorWallX, ceilH / 2, (segStart + segEnd) / 2, { los: true });
      }
      if (i < N) {
        this._box(t, lintelH, doorW, wall, doorWallX, DOOR_OPEN + lintelH / 2, roomZ(i), { collider: false });
        segStart = roomZ(i) + doorW / 2;
      }
    }

    // A kickable door per room, hinged in the long wall, swinging inward.
    const facing = doorSide === 1 ? -Math.PI / 2 : Math.PI / 2;
    for (let i = 0; i < N; i++) {
      const dz = roomZ(i);
      const hinge = doorSide === 1
        ? new THREE.Vector3(doorWallX, 0, dz - doorW / 2)
        : new THREE.Vector3(doorWallX, 0, dz + doorW / 2);
      const doorMat = this._pick(this._doorMats, dz, cz, i) || this._materials.door;
      const door = new Door(hinge, doorW, -doorSide, facing, doorMat, null);
      this.group.add(door.pivot);
      this.doors.push(door);
      this.colliders.push(door._closedBox);
      this.losBlockers.push(door._closedBox);
    }

    // Low apartment ceiling caps the playable room; the pitched roof + chimneys
    // sit up at the tall exterior shell height (the dead space between is hidden).
    const ceil = new THREE.Mesh(
      new THREE.BoxGeometry(this.BLOCK_W, t, this.BLOCK_L),
      this._materials.apartmentCeiling,
    );
    ceil.position.set(cx, ceilH + t / 2 - 0.05, cz);
    this.group.add(ceil);
    this._buildRoof(cx, cz);
    this._buildChimney(cx, cz);

    // --- Cladding: continuous exterior wall on every face (long sides + ends), at
    // a real-world scale (no stretching). The material varies per building (brick /
    // dark brick / concrete) so neighbours differ.
    const clad = this._pickBuildingMat(cx, cz);
    const backRotY = doorSide === 1 ? -Math.PI / 2 : Math.PI / 2;
    const doorRotY = doorSide === 1 ? Math.PI / 2 : -Math.PI / 2;
    // Solid back long wall — one panel.
    this._brickWall(backWallX - doorSide * 0.31, wallH / 2, cz, backRotY, this.BLOCK_L, wallH, clad);
    // Door long wall — a panel per solid segment, plus a brick LINTEL above each
    // doorway (the door is only DOOR_OPEN tall; clad the strip above so there's no
    // bare gap over the door).
    let s = cz - halfL;
    for (let i = 0; i <= N; i++) {
      const e = i < N ? roomZ(i) - doorW / 2 : cz + halfL;
      if (e - s > 0.4) {
        this._brickWall(doorWallX + doorSide * 0.31, wallH / 2, (s + e) / 2, doorRotY, e - s, wallH, clad);
      }
      if (i < N) {
        const above = wallH - DOOR_OPEN;
        if (above > 0.05) {
          this._brickWall(doorWallX + doorSide * 0.31, DOOR_OPEN + above / 2, roomZ(i), doorRotY, doorW, above, clad);
        }
        s = roomZ(i) + doorW / 2;
      }
    }
    // End (short) walls — same cladding material, so the whole shell matches.
    this._brickWall(cx, wallH / 2, cz - halfL - 0.32, Math.PI, this.BLOCK_W, wallH, clad); // north end faces -Z
    this._brickWall(cx, wallH / 2, cz + halfL + 0.32, 0, this.BLOCK_W, wallH, clad); // south end faces +Z
    this._cornerPosts(cx, cz, wallH, clad); // close the corner seams

    // Facade detailing (windows/door) so the brick shell reads as a real terrace.
    // These buildings have a pitched roof, so no parapet cap. The door wall keeps
    // its ground floor clear (the kickable doors live there) — windows above only.
    this._addWindowFacade(doorWallX + doorSide * 0.32, cz, doorRotY, this.BLOCK_L, wallH, { minRow: 1, noDoor: true, noRoofCap: true });
    this._addWindowFacade(backWallX - doorSide * 0.32, cz, backRotY, this.BLOCK_L, wallH, { noRoofCap: true });
    this._addWindowFacade(cx, cz - halfL - 0.33, Math.PI, this.BLOCK_W, wallH, { noRoofCap: true });
    this._addWindowFacade(cx, cz + halfL + 0.33, 0, this.BLOCK_W, wallH, { noRoofCap: true });

    // Graffiti / signs on the gable end walls.
    this._decorateWall(cx, cz - halfL - 0.34, Math.PI, this.BLOCK_W, wallH, 5);
    this._decorateWall(cx, cz + halfL + 0.34, 0, this.BLOCK_W, wallH, 9);

    // Garrison `enemyCount` distinct random rooms (released when their door breaks).
    const order = [];
    for (let i = 0; i < N; i++) order.push(i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let k = 0; k < Math.min(enemyCount, N); k++) {
      this._addEnemy(new THREE.Vector3(cx, 0, roomZ(order[k])), {});
    }

    // Furnish each room as a low apartment (data-driven layout, door approach +
    // centre captor/victim slot kept clear; colliders on the large pieces).
    for (let i = 0; i < N; i++) this._furnishRoom(cx, roomZ(i), doorSide);
  }

  /**
   * Place the apartment furniture layout in one interior breach-room. X is
   * mirrored by `doorSide` so pieces always line the back/side walls, never the
   * door approach. A missing GLB is skipped (the room just gets less furniture).
   */
  _furnishRoom(cx, rz, doorSide) {
    if (!this.assets || typeof this.assets.getModel !== "function") return;
    for (const p of FURNITURE) {
      const m = this.assets.getModel(p.slug);
      if (!m) continue;
      const wx = cx + doorSide * p.x;
      const wz = rz + p.z;
      m.position.set(wx, 0, wz);
      m.rotation.y = (p.rotY || 0) * doorSide;
      this.group.add(m);
      if (p.collider) {
        this.colliders.push(new THREE.Box3(
          new THREE.Vector3(wx - p.w / 2, 0, wz - p.d / 2),
          new THREE.Vector3(wx + p.w / 2, 1.6, wz + p.d / 2),
        ));
      }
    }
  }

  /**
   * Exterior block: a SOLID brick terrace building. The old approach tiled GLB
   * models with gaps + non-uniform scaling, which read as a hollow, stretched,
   * gap-riddled mass (black voids between tiles, no texture coverage). Instead we
   * build a closed brick box — four continuous proportionate-UV brick faces + a
   * solid roof slab + a street-facing window/door facade — so every block reads
   * as one solid, fully-textured structure at the lowered WALL_H. One footprint
   * collider keeps the street grid walkable.
   */
  _buildModelBlock(cx, cz, slug, rng) {
    const halfW = this.BLOCK_W / 2;
    const halfL = this.BLOCK_L / 2;
    const h = this.WALL_H;

    // Pavement apron (matches the interior blocks' look; walk-over, no collider).
    const pave = new THREE.Mesh(
      new THREE.BoxGeometry(this.BLOCK_W + 3, 0.12, this.BLOCK_L + 3),
      this._materials.pavement,
    );
    pave.position.set(cx, 0.06, cz);
    this.group.add(pave);

    // Street-facing side: east column faces -X, west +X, middle +X. frontSign is
    // the outward X direction of the front face.
    const frontSign = cx > 0.5 ? -1 : 1;
    const frontX = cx + frontSign * halfW;
    const backX = cx - frontSign * halfW;

    // Four CONTINUOUS faces (proportionate UVs via _brickWall → no stretch), each
    // one panel spanning the whole face so the texture covers it with no gaps/voids.
    // The wall material varies per building (brick / dark brick / concrete).
    const wallMat = this._pickBuildingMat(cx, cz);
    this._brickWall(frontX + frontSign * 0.05, h / 2, cz, frontSign * Math.PI / 2, this.BLOCK_L, h, wallMat);
    this._brickWall(backX - frontSign * 0.05, h / 2, cz, -frontSign * Math.PI / 2, this.BLOCK_L, h, wallMat);
    this._brickWall(cx, h / 2, cz - halfL - 0.05, Math.PI, this.BLOCK_W, h, wallMat);
    this._brickWall(cx, h / 2, cz + halfL + 0.05, 0, this.BLOCK_W, h, wallMat);
    this._cornerPosts(cx, cz, h, wallMat); // close the corner seams

    // Solid roof slab caps the top (no open/black top edge).
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(this.BLOCK_W + 0.5, 0.5, this.BLOCK_L + 0.5),
      this._materials.roof,
    );
    roof.position.set(cx, h + 0.2, cz);
    this.group.add(roof);

    // Street-facing facade: window grid + ground door (parapet cap skipped — the
    // roof slab already caps it). Sits just in front of the brick face.
    this._addWindowFacade(frontX + frontSign * 0.12, cz, frontSign * Math.PI / 2, this.BLOCK_L, h, { noRoofCap: true });

    // Graffiti + signs along the front (split into thirds so the long terrace gets
    // a few scattered marks rather than one).
    const dRotY = frontSign * Math.PI / 2;
    for (const off of [-this.BLOCK_L / 3, 0, this.BLOCK_L / 3]) {
      this._decorateWall(frontX + frontSign * 0.14, cz + off, dRotY, this.BLOCK_L / 3, h, Math.round(off));
    }

    // One clean footprint collider + LOS blocker for the whole block.
    const box = footprintCollider(cx, cz, this.BLOCK_W, h, this.BLOCK_L);
    this.colliders.push(box);
    this.losBlockers.push(box);
  }

  /**
   * Lift any over-dark baked building material so it doesn't read as near-black
   * at distance — detect a charred/near-black surface by name or colour and warm
   * it with a flat emissive floor. Idempotent via a userData flag (model
   * materials are shared across getModel clones, so this runs once per material).
   */
  _brightenBuildingModel(root) {
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || !m.color || (m.userData && m.userData._bcLit)) continue;
        const maxc = Math.max(m.color.r, m.color.g, m.color.b);
        const charred = /black|char|burn|soot|coal|ash/i.test(m.name || "");
        if (charred || maxc < 0.3) {
          m.color.setRGB(1.0, 0.84, 0.72);
          if (m.emissive) m.emissive.setHex(0x3a2a1e);
          m.emissiveIntensity = 1.0;
          m.userData._bcLit = true;
          m.needsUpdate = true;
        }
      }
    });
  }

  /**
   * A photo-textured panel on a long side wall. UVs are scaled to real size so
   * the tenement facade tiles at a steady ~11m width and fills the storey height
   * once, regardless of the panel's length.
   */
  _sideWall(x, y, z, rotY, w, h) {
    const geo = new THREE.PlaneGeometry(w, h);
    const uv = geo.attributes.uv;
    const rx = Math.max(1, w / 11);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * rx, uv.getY(i));
    uv.needsUpdate = true;
    const mesh = new THREE.Mesh(geo, this._materials.sideHouse);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotY;
    this.group.add(mesh);
  }

  /**
   * A BRICK-clad wall panel. UVs are scaled to a steady real-world brick size
   * (~TILE_M metres per texture tile on both axes) so bricks never stretch on
   * tall/long walls — final tiling = geometry UV × the brick map's own repeat.
   * Shared brick material (one draw material); per-panel geometry UVs do the
   * scaling, so tall and long walls all read at the same brick scale.
   */
  _brickWall(x, y, z, rotY, w, h, mat = this._materials.brick) {
    const TILE_M = 4; // metres of wall per brick-texture tile
    const rep = mat && mat.map && mat.map.repeat ? mat.map.repeat : { x: 1, y: 1 };
    const geo = new THREE.PlaneGeometry(w, h);
    const uv = geo.attributes.uv;
    const sx = Math.max(1, (w / TILE_M) / (rep.x || 1));
    const sy = Math.max(1, (h / TILE_M) / (rep.y || 1));
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
    uv.needsUpdate = true;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotY;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Pick an exterior wall material for a building, deterministically from its grid
   * position + sector index, so neighbouring buildings differ (red brick / dark
   * brick / grey concrete). All are loaded from public/textures/<slug>/.
   */
  _pickBuildingMat(cx, cz) {
    // The 5 real-brick photos plus grey concrete → 6 distinct building skins.
    const mats = [...this._urbanBricks, this._materials.concrete];
    const k = Math.abs(Math.round(cx / 7) + Math.round(cz / 7) * 3 + (this.index | 0));
    return mats[k % mats.length];
  }

  /**
   * Solid brick posts at a block's four corners. The single-plane wall faces meet
   * at the corners with a thin seam/gap; a small box at each corner closes it so
   * the building reads as a continuous solid mass from every angle.
   */
  _cornerPosts(cx, cz, h, mat) {
    const hw = this.BLOCK_W / 2, hl = this.BLOCK_L / 2, t = 0.55;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(t, h, t), mat || this._materials.brick);
        post.position.set(cx + sx * hw, h / 2, cz + sz * hl);
        this.group.add(post);
      }
    }
  }

  /**
   * Stamp a proportionate facade (window grid + optional door + roof cap) onto a
   * wall face so buildings read as real. `(x, z)` is the wall's ground-line
   * centre, `rotY` orients it outward (same convention as _brickWall), `w`/`h`
   * are the face size. `opts` flows to BuildingFacade (e.g. `{ doorClear:true }`
   * to skip the door for walls that already have kickable doors).
   */
  _addWindowFacade(x, z, rotY, w, h, opts = {}) {
    const group = buildFacade(THREE, {
      glass: this._materials.glass,
      glassLit: this._materials.glassLit,
      windows: this._windowMats, // real window photos instead of plain glass quads
      door: this._materials.door,
      roof: this._materials.roof,
    }, { width: w, height: h, orientationY: rotY, center: { x, y: 0, z } }, { salt: Math.round((x + z) / 7), ...opts });
    this.group.add(group);
    return group;
  }

  /** Pitched gable roof, ridge running along Z (the long axis) over the terrace. */
  _buildRoof(cx, cz) {
    const halfW = this.BLOCK_W / 2;
    const wallH = this.WALL_H;
    const rise = 1.6; // gentle pitch, proportionate to the low walls
    const slopeLen = Math.hypot(rise, halfW);
    const angle = Math.atan2(rise, halfW);
    for (const sgn of [-1, 1]) {
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(slopeLen, 0.18, this.BLOCK_L + 0.8),
        this._materials.roof,
      );
      panel.position.set(cx + (sgn * halfW) / 2, wallH + rise / 2, cz);
      panel.rotation.z = -sgn * angle; // outer eave dips, ridge lifts to centre
      this.group.add(panel);
    }
    // Ridge cap along the apex.
    const ridge = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.22, this.BLOCK_L + 0.9),
      this._materials.kerb,
    );
    ridge.position.set(cx, wallH + rise, cz);
    this.group.add(ridge);
  }

  /** Brick chimney stacks with pots, spaced along the long ridge. */
  _buildChimney(cx, cz) {
    const ridgeY = this.WALL_H + 1.6; // the lowered pitched-roof ridge height
    const halfL = this.BLOCK_L / 2;
    const STACK_H = 0.9; // short stacks that sit ON the ridge, not towering above
    for (const oz of [-halfL * 0.6, -halfL * 0.1, halfL * 0.45]) {
      const stack = new THREE.Mesh(new THREE.BoxGeometry(0.7, STACK_H, 0.7), this._materials.brick);
      stack.position.set(cx, ridgeY + STACK_H / 2 - 0.1, cz + oz);
      this.group.add(stack);
      for (const ox of [-0.18, 0.18]) {
        const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.28, 8), this._materials.kerb);
        pot.position.set(cx + ox, ridgeY + STACK_H + 0.04, cz + oz);
        this.group.add(pot);
      }
    }
  }

  /**
   * A surface-mounted sash window centred at (x,y,z) on a wall whose outward
   * normal is (nx,nz). The frame sits just proud of the wall's outer face.
   */
  _addWindow(x, y, z, nx, nz) {
    const fw = 1.0, fh = 1.3;
    const spanX = nz !== 0; // normal ±Z → the wall runs along X
    const frameGeo = spanX
      ? new THREE.BoxGeometry(fw + 0.15, fh + 0.15, 0.1)
      : new THREE.BoxGeometry(0.1, fh + 0.15, fw + 0.15);
    const frame = new THREE.Mesh(frameGeo, this._materials.frame);
    frame.position.set(x + nx * 0.32, y, z + nz * 0.32);
    this.group.add(frame);

    const glass = new THREE.Mesh(new THREE.PlaneGeometry(fw, fh), this._materials.glass);
    glass.position.set(x + nx * 0.37, y, z + nz * 0.37);
    glass.rotation.y = spanX ? (nz > 0 ? 0 : Math.PI) : (nx > 0 ? Math.PI / 2 : -Math.PI / 2);
    this.group.add(glass);

    const sill = new THREE.Mesh(
      spanX ? new THREE.BoxGeometry(fw + 0.3, 0.1, 0.18) : new THREE.BoxGeometry(0.18, 0.1, fw + 0.3),
      this._materials.kerb,
    );
    sill.position.set(x + nx * 0.3, y - fh / 2 - 0.1, z + nz * 0.3);
    this.group.add(sill);
  }

  /**
   * Clad a wall face with the next building-front texture captured from the city
   * model. The facade tiles horizontally at its own aspect so windows stay
   * correctly proportioned, and alpha-cuts its border so the brick wall shows
   * through the silhouette gaps (e.g. above a pitched roofline).
   */
  _addFacade(x, y, z, rotY, w) {
    const facade = this._facades[this._facadeN++ % this._facades.length];
    if (!facade) return;
    const h = this.WALL_H;
    const tex = facade.texture.clone();
    tex.needsUpdate = true;
    tex.wrapS = THREE.RepeatWrapping;
    // Sample at the wall's aspect so windows never stretch horizontally: wide
    // terraces (<1) show a centred crop of a few bays; narrow fronts (>1) tile
    // across the long wall. Vertically the front fills the tall storey height.
    const rep = Math.min(4, Math.max(0.2, (w / h) / (facade.aspect || 1)));
    tex.repeat.x = rep;
    tex.offset.x = (1 - rep) / 2;
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.92,
      metalness: 0,
      alphaTest: 0.5,
      depthWrite: true,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    plane.position.set(x, y, z);
    plane.rotation.y = rotY;
    this.group.add(plane);
  }

  /** Dashed centre lines down every street lane in the grid. */
  _buildRoadPaint() {
    const { COORDS_X, COORDS_Z, GRID_HALF_X, GRID_HALF_Z } = this;
    // Lane centres sit in the gaps between rows/columns.
    const mids = (c) => c.slice(1).map((v, i) => (v + c[i]) / 2);
    for (const sx of mids(COORDS_X)) { // north–south lanes
      for (let z = -GRID_HALF_Z; z <= GRID_HALF_Z; z += 3.2) {
        const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 1.6), this._materials.paint);
        dash.rotation.x = -Math.PI / 2;
        dash.position.set(sx, 0.03, z);
        this.group.add(dash);
      }
    }
    for (const sz of mids(COORDS_Z)) { // east–west cross-streets
      for (let x = -GRID_HALF_X; x <= GRID_HALF_X; x += 3.2) {
        const dash = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.16), this._materials.paint);
        dash.rotation.x = -Math.PI / 2;
        dash.position.set(x, 0.03, sz);
        this.group.add(dash);
      }
    }
  }

  /** Distant hazy hills ringing the quarter, far off on the horizon. */
  _buildBackdrop() {
    // Faint, far hills form the horizon. (The old city-model skyline ring was
    // removed — the boundary facades + fog carry the edge of the world now.)
    const baseR = Math.max(this.GRID_HALF_X, this.GRID_HALF_Z) + 150;
    const n = 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const hill = new THREE.Mesh(new THREE.SphereGeometry(30, 10, 6), this._materials.hill);
      hill.scale.set(2.6, 0.5, 1);
      hill.position.set(Math.cos(a) * baseR, -16, Math.sin(a) * baseR);
      this.group.add(hill);
    }
  }

  /**
   * Belfast peace-wall boundary: a closed rectangle of VISIBLE ~5m cement slabs
   * (the actual barrier that contains the player) crowned with razor barbwire,
   * backed by recessed exterior building models that tower above the wall.
   */
  _buildBoundary() {
    const BX = this.GRID_HALF_X + 12; // ~43 — just past the outer blocks
    const BZ = this.GRID_HALF_Z + 12; // ~73 — past the spawn approach (z≈68)
    const WH = 5; // visible cement wall height — buildings still tower above it
    const T = 0.6; // slab thickness
    const wall = this._materials.concrete;
    // Closed rectangle of visible concrete slabs, flush on each boundary plane.
    // These ARE the barrier (colliders + LOS blockers): a 5m wall is far taller
    // than the 1.7m player, so containment is preserved. Slabs span the full
    // boundary length so there is no gap. The recessed facades below sit ~0.6m
    // inside the plane (the slab's inner face is ~0.3m inside) → no coplanar
    // faces, so no z-fighting; the taller buildings read clearly above the wall.
    this._box(2 * BX, WH, T, wall, 0, WH / 2, -BZ, { los: true });
    this._box(2 * BX, WH, T, wall, 0, WH / 2, BZ, { los: true });
    this._box(T, WH, 2 * BZ, wall, -BX, WH / 2, 0, { los: true });
    this._box(T, WH, 2 * BZ, wall, BX, WH / 2, 0, { los: true });
    // Razor / concertina barbwire crowning the wall tops.
    this._buildBarbwire(BX, BZ, WH);
    // Clad with exterior building models — RECESSED so they read as facades on
    // the barrier. Each model's body is pushed fully OUTWARD past the wall so
    // only its front face shows; nothing protrudes inward for the player to clip
    // through. Spaced tightly so the facades read as a continuous street wall.
    if (!this.assets) return;
    const TPL = ["bldg_terrace", "bldg_shop", "bldg_church"];
    let n = 0;
    const _box = new THREE.Box3();
    // out = outward sign on `axis`; barrier = wall coordinate. Place the model,
    // then shift it along `axis` so its INNER face (toward the play area) lands
    // ~0.6m inside the wall plane — robust to off-centre pivots, deep naves and
    // spires, so no building body ever protrudes into the street.
    const clad = (x, z, faceY, axis, out) => {
      const slug = TPL[n++ % TPL.length];
      const m = this.assets.getModel(slug);
      if (!m) return;
      m.rotation.y = faceY;
      m.position.set(x, 0, z);
      m.updateMatrixWorld(true);
      _box.setFromObject(m);
      const innerFace = out > 0 ? _box.min[axis] : _box.max[axis];
      const wallC = axis === "x" ? BX : BZ;
      // Push the model fully BEHIND the wall (inner face 0.3m OUTSIDE the barrier
      // plane) so the facade never protrudes into the street — only the building's
      // upper storeys show above the 5m wall.
      const target = (out > 0 ? wallC : -wallC) + out * 0.3;
      m.position[axis] += target - innerFace;
      this._brightenBuildingModel(m); // lift any over-dark baked material
      this.group.add(m);
    };
    const STEP = 11;
    for (let x = -BX + 6; x <= BX - 6; x += STEP) {
      clad(x, -BZ, 0, "z", -1); // south wall: facade faces +Z (inward), body pushed -Z
      clad(x, BZ, Math.PI, "z", 1); // north wall: facade faces -Z, body pushed +Z
    }
    for (let z = -BZ + 6; z <= BZ - 6; z += STEP) {
      clad(-BX, z, Math.PI / 2, "x", -1); // west wall: facade faces +X
      clad(BX, z, -Math.PI / 2, "x", 1); // east wall: facade faces -X
    }

    // Big Belfast sectarian murals along the boundary walls (Ulster / IRA,
    // alternating), with the odd sign/graffiti between them.
    const muralH = Math.min(4.4, WH - 0.4);
    let mi = 0;
    const mural = (mx, mz, rotY) => {
      const mat = this._muralMats[mi++ % this._muralMats.length];
      if (!mat) return;
      const g = new THREE.Group();
      g.position.set(mx, 0, mz);
      g.rotation.y = rotY;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(muralH, muralH), mat);
      m.position.set(0, muralH / 2 + 0.3, 0.12);
      m.renderOrder = 2;
      g.add(m);
      this.group.add(g);
    };
    for (let x = -BX + 22; x <= BX - 22; x += 30) {
      mural(x, -BZ + 0.36, 0);       // south wall faces +Z
      mural(x, BZ - 0.36, Math.PI);  // north wall faces -Z
    }
    for (let z = -BZ + 22; z <= BZ - 22; z += 34) {
      mural(-BX + 0.36, z, Math.PI / 2);  // west wall faces +X
      mural(BX - 0.36, z, -Math.PI / 2);  // east wall faces -X
    }
    // A few signs/graffiti in the gaps between murals (sparser than the murals).
    for (let x = -BX + 38; x <= BX - 38; x += 44) {
      this._decorateWall(x, -BZ + 0.35, 0, 12, WH, 31);
      this._decorateWall(x, BZ - 0.35, Math.PI, 12, WH, 41);
    }
    for (let z = -BZ + 38; z <= BZ - 38; z += 50) {
      this._decorateWall(-BX + 0.35, z, Math.PI / 2, 12, WH, 51);
      this._decorateWall(BX - 0.35, z, -Math.PI / 2, 12, WH, 61);
    }
  }

  /**
   * Cheap concertina razor-wire crowning the cement boundary walls. Two
   * InstancedMeshes (one draw call each): low-poly torus "coils" strung along
   * each wall top, plus thin angled support posts leaning outward over the edge.
   * Purely decorative — no colliders.
   */
  _buildBarbwire(BX, BZ, topY) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, metalness: 0.6, roughness: 0.5 });
    // Each run: `axis` is the direction the wall (and the wire) runs along.
    const runs = [
      { axis: "x", fixed: -BZ, from: -BX, to: BX },
      { axis: "x", fixed: BZ, from: -BX, to: BX },
      { axis: "z", fixed: -BX, from: -BZ, to: BZ },
      { axis: "z", fixed: BX, from: -BZ, to: BZ },
    ];
    const COIL_STEP = 0.9;
    const POST_STEP = 4.5;
    // Count instances up front so each InstancedMesh is exactly sized.
    let coilN = 0;
    let postN = 0;
    for (const r of runs) {
      const len = r.to - r.from;
      coilN += Math.max(1, Math.floor(len / COIL_STEP)) + 1;
      postN += Math.max(1, Math.floor(len / POST_STEP)) + 1;
    }
    const coils = new THREE.InstancedMesh(new THREE.TorusGeometry(0.34, 0.035, 5, 8), mat, coilN);
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.95, 0.06), mat, postN);
    const d = new THREE.Object3D();
    const coilY = topY + 0.34; // coil rests on the wall top
    let ci = 0;
    let pi = 0;
    for (const r of runs) {
      const len = r.to - r.from;
      const along = r.axis;
      const outward = r.fixed < 0 ? -1 : 1; // away from the map centre
      const nCoil = Math.max(1, Math.floor(len / COIL_STEP));
      for (let i = 0; i <= nCoil; i++) {
        const t = r.from + (len * i) / nCoil;
        d.position.set(along === "x" ? t : r.fixed, coilY, along === "x" ? r.fixed : t);
        // Orient the coil so its axis follows the run (concertina look).
        d.rotation.set(0, along === "x" ? Math.PI / 2 : 0, 0);
        d.updateMatrix();
        coils.setMatrixAt(ci++, d.matrix);
      }
      const nPost = Math.max(1, Math.floor(len / POST_STEP));
      for (let i = 0; i <= nPost; i++) {
        const t = r.from + (len * i) / nPost;
        d.position.set(along === "x" ? t : r.fixed, topY + 0.45, along === "x" ? r.fixed : t);
        // Lean the post outward over the wall edge.
        if (along === "x") d.rotation.set(outward * 0.4, 0, 0);
        else d.rotation.set(0, 0, -outward * 0.4);
        d.updateMatrix();
        posts.setMatrixAt(pi++, d.matrix);
      }
    }
    coils.instanceMatrix.needsUpdate = true;
    posts.instanceMatrix.needsUpdate = true;
    coils.frustumCulled = false;
    posts.frustumCulled = false;
    this.group.add(coils);
    this.group.add(posts);
  }

  /** True when (x,z) is in a street lane, not inside a building footprint. */
  _inStreet(x, z) {
    const mx = this.BLOCK_W / 2 + 0.8;
    const mz = this.BLOCK_L / 2 + 0.8;
    for (const cz of this.COORDS_Z) {
      for (const cx of this.COORDS_X) {
        if (Math.abs(x - cx) < mx && Math.abs(z - cz) < mz) return false;
      }
    }
    return true;
  }

  /**
   * Place a prop using its AI-generated GLB when available (ground-anchored at
   * x,z), else run the fallback geometry builder. Always registers an AABB
   * collider of the given footprint so gameplay collision is model-independent.
   */
  _prop(slug, x, z, w, h, d, makeFallback) {
    const model = this.assets && this.assets.getModel(slug);
    if (model) {
      model.position.set(x, 0, z);
      this.group.add(model);
    } else {
      makeFallback();
    }
    this.colliders.push(
      new THREE.Box3(
        new THREE.Vector3(x - w / 2, 0, z - d / 2),
        new THREE.Vector3(x + w / 2, h, z + d / 2),
      ),
    );
  }

  /** Paint sectarian murals onto the street-facing (east) faces of blocks. */
  _addMurals(rng) {
    const murals = this.assets ? this.assets.getMurals() : [];
    if (!murals.length) return;
    const halfW = this.BLOCK_W / 2;
    const halfL = this.BLOCK_L / 2;
    let count = 0;
    const maxMurals = 4 + this.index;
    for (const cz of this.COORDS_Z) {
      for (const cx of this.COORDS_X) {
        if (count >= maxMurals || rng() > 0.5) continue;
        const tex = murals[(rng() * murals.length) | 0];
        const size = 3.0 + rng() * 1.6;
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(size, size),
          new THREE.MeshStandardMaterial({
            map: tex,
            roughness: 0.95,
            metalness: 0,
            polygonOffset: true,
            polygonOffsetFactor: -2,
          }),
        );
        // Just proud of the long east wall's outer face, facing the street.
        const oz = (rng() - 0.5) * halfL; // anywhere along the long terrace
        mesh.position.set(cx + halfW + 0.33, 0.2 + size / 2, cz + oz);
        mesh.rotation.y = -Math.PI / 2;
        this.group.add(mesh);
        count++;
      }
    }
  }

  /** Scatter purely-visual AI props through the streets (big ones get colliders). */
  _setDressing(rng) {
    if (!this.assets) return;
    const { GRID_HALF_X, GRID_HALF_Z } = this;
    const place = (slug, x, z, ry, footprint) => {
      const m = this.assets.getModel(slug);
      if (!m) return;
      m.position.set(x, 0, z);
      m.rotation.y = ry;
      this.group.add(m);
      if (footprint) {
        const [hw, hd, h] = footprint;
        this.colliders.push(
          new THREE.Box3(
            new THREE.Vector3(x - hw, 0, z - hd),
            new THREE.Vector3(x + hw, h, z + hd),
          ),
        );
      }
    };

    // Phone booth standing ON the pavement apron at the east edge of the
    // cx=-24 block (apron x∈[-32.5,-15.5]; building face at x=-17), facing the
    // street. x=-16.2 sits in the ~1.5m pavement strip, clear of the building.
    place("prop_phone_booth", -16.2, 52, -Math.PI / 2, [0.5, 0.5, 2.4]);

    // Heavier, collidable street furniture for cover + a populated feel. Each
    // sits on a pavement edge (just off a building face) or in an open lane,
    // with a footprint collider [hw(x), hd(z), h(y)] hugging the model. Traffic
    // cones stay collider-free (footprint null). Positions are hand-placed and
    // verified against the block/apron spans so nothing clips a building.
    const furniture = [
      ["prop_wheelie_bin", -16.2, 24.0, -Math.PI / 2, [0.34, 0.34, 1.0]],
      ["prop_wheelie_bin", -16.2, 25.3, -Math.PI / 2, [0.34, 0.34, 1.0]],
      ["prop_wheelie_bin", 8.0, -22.0, Math.PI / 2, [0.34, 0.34, 1.0]],
      ["prop_wheelie_bin", -8.0, 40.0, -Math.PI / 2, [0.34, 0.34, 1.0]],
      ["prop_bicycle", -16.3, -20.0, 0, [0.26, 0.9, 1.0]],
      ["prop_bicycle", 16.3, 30.0, 0, [0.26, 0.9, 1.0]],
      ["crate_supply", -12.0, 14.0, 0.3, [0.55, 0.55, 1.1]],
      ["crate_supply", 12.0, -14.0, -0.4, [0.55, 0.55, 1.1]],
      ["sandbag_barricade", -12.0, 48.0, 0, [0.9, 0.55, 1.0]],
      ["sandbag_barricade", 12.0, 18.0, Math.PI / 2, [0.55, 0.9, 1.0]],
      ["prop_traffic_cone", -12.0, 11.0, 0, null],
      ["prop_traffic_cone", -12.0, 17.0, 0, null],
      ["prop_traffic_cone", 12.0, -11.0, 0, null],
    ];
    for (const [slug, fx, fz, fry, fp] of furniture) place(slug, fx, fz, fry, fp);

    // Sandbag barricades as occasional street cover.
    for (let i = 0; i < 2 + this.index; i++) {
      let x, z, guard = 0;
      do {
        x = (rng() - 0.5) * GRID_HALF_X * 2;
        z = (rng() - 0.5) * GRID_HALF_Z * 2;
      } while (!this._inStreet(x, z) && guard++ < 30);
      place("sandbag_barricade", x, z, rng() * Math.PI, [0.9, 0.55, 1.0]);
    }

    // Gutter clutter — walk-through decoration (no collider).
    const clutter = ["prop_wheelie_bin", "prop_traffic_cone", "prop_bicycle"];
    for (let i = 0; i < 8 + this.index * 2; i++) {
      let x, z, guard = 0;
      do {
        x = (rng() - 0.5) * GRID_HALF_X * 2;
        z = (rng() - 0.5) * GRID_HALF_Z * 2;
      } while (!this._inStreet(x, z) && guard++ < 30);
      const slug = clutter[(rng() * clutter.length) | 0];
      place(slug, x, z, rng() * Math.PI * 2, null);
    }
  }

  /** A shootable/kickable explosive barrel (tracked for the explosion system). */
  _addBarrel(x, z) {
    const w = 0.9, h = 1.2, d = 0.9;
    let root;
    const model = this.assets && this.assets.getModel("barrel_explosive");
    if (model) {
      model.position.set(x, 0, z);
      this.group.add(model);
      root = model;
    } else {
      root = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, h, 12), this._materials.barrel);
      root.position.set(x, h / 2, z);
      this.group.add(root);
    }
    const collider = new THREE.Box3(
      new THREE.Vector3(x - w / 2, 0, z - d / 2),
      new THREE.Vector3(x + w / 2, h, z + d / 2),
    );
    this.colliders.push(collider);
    const hitbox = new THREE.Box3(
      new THREE.Vector3(x - 0.5, 0, z - 0.5),
      new THREE.Vector3(x + 0.5, 1.35, z + 0.5),
    );
    this.barrels.push({ root, hitbox, collider, pos: new THREE.Vector3(x, 0.6, z), exploded: false });
  }

  /** Detonate a barrel: VFX + sound, radial damage to enemies/player, chain. */
  explodeBarrel(barrel, ctx) {
    if (this._disposed || !barrel || barrel.exploded) return;
    barrel.exploded = true;

    // Remove visual + movement collider.
    this.group.remove(barrel.root);
    const ci = this.colliders.indexOf(barrel.collider);
    if (ci >= 0) this.colliders.splice(ci, 1);
    this._activeColliders = null; // invalidate getColliders() cache

    ctx.weapon.explosionFx(barrel.pos);
    ctx.audio.explosion(barrel.pos, ctx.camera.position);
    ctx.score.add(40, "BOOM!");
    // Bus event (position-carrying) + heavy juice for the detonation.
    if (ctx.state) ctx.state.emit("explosion", { position: barrel.pos.clone() });
    if (ctx.juice) ctx.juice.shake(0.4, 380);

    const R = 5.0;
    const _v = new THREE.Vector3();
    for (const e of this.enemies) {
      if (e.dead) continue;
      const dist = e.position.distanceTo(barrel.pos);
      if (dist < R) {
        _v.copy(e.position).sub(barrel.pos).setY(0).normalize();
        const falloff = 1 - dist / R;
        const wasAlive = !e.dead;
        e.takeDamage(200 * falloff, _v, 12 * falloff);
        // Credit a demolition kill to the run (DEMOLITION bonus + kill count).
        if (wasAlive && e.dead && ctx.state) {
          ctx.state.addKill({ position: e.position.clone(), isBarrel: true });
        }
      }
    }
    // Splash the player if too close.
    const pd = ctx.player.position.distanceTo(barrel.pos);
    if (pd < R * 0.7) {
      ctx.player.damage(Math.round(35 * (1 - pd / (R * 0.7))));
      ctx.hud.flashDamage();
    }
    // Chain nearby barrels with a small delay.
    for (const other of this.barrels) {
      if (!other.exploded && other.pos.distanceTo(barrel.pos) < R * 0.8) {
        setTimeout(() => this.explodeBarrel(other, ctx), 90);
      }
    }
  }

  /**
   * A supply crate: same destructible shape as a barrel, but kicking/shooting it
   * BREAKS it open and drops loot instead of exploding. Loot is pre-rolled off the
   * seeded layout RNG so it's deterministic within a run.
   */
  _addCrate(x, z, rng) {
    const w = 1.1, h = 1.1, d = 1.1;
    let root;
    const model = this.assets && this.assets.getModel("crate_supply");
    if (model) {
      model.position.set(x, 0, z);
      this.group.add(model);
      root = model;
    } else {
      root = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this._materials.crate);
      root.position.set(x, h / 2, z);
      this.group.add(root);
    }
    const collider = new THREE.Box3(
      new THREE.Vector3(x - w / 2, 0, z - d / 2),
      new THREE.Vector3(x + w / 2, h, z + d / 2),
    );
    this.colliders.push(collider);
    const hitbox = new THREE.Box3(
      new THREE.Vector3(x - 0.6, 0, z - 0.6),
      new THREE.Vector3(x + 0.6, 1.15, z + 0.6),
    );
    const r = rng ? rng() : Math.random();
    const loot = r < 0.45 ? { type: "ammo", amount: 12, text: "+AMMO" }
      : r < 0.75 ? { type: "rp", amount: 10, text: "+£10" }
        : { type: "health", amount: 25, text: "+25 HP" };
    this.crates.push({ root, hitbox, collider, pos: new THREE.Vector3(x, 0.6, z), opened: false, loot });
  }

  /** Break a crate open: remove it, hand the player its loot, and pop feedback. */
  openCrate(crate, ctx) {
    if (this._disposed || !crate || crate.opened) return;
    crate.opened = true;
    ctx.state && ctx.state.bumpStat && ctx.state.bumpStat("cratesOpened"); // feeds end-of-sector £
    this.group.remove(crate.root);
    const ci = this.colliders.indexOf(crate.collider);
    if (ci >= 0) this.colliders.splice(ci, 1);
    this._activeColliders = null; // invalidate getColliders() cache (same as explodeBarrel)

    const loot = crate.loot;
    if (loot.type === "ammo") ctx.weapon.addAmmo(loot.amount);
    else if (loot.type === "rp") ctx.state && ctx.state.addCurrency(loot.amount);
    else if (loot.type === "health") ctx.player.heal(loot.amount);

    ctx.score.add(25, "SUPPLIES");
    ctx.audio.loot();
    if (ctx.juice) {
      ctx.juice.shake(0.12, 120);
      ctx.juice.spawnImpact(crate.pos, "spark");
    }
    // Bus event (position-carrying) → floating "+LOOT" popup.
    ctx.state && ctx.state.emit("loot", { text: loot.text, position: crate.pos.clone() });
  }

  _addEnemy(pos, opts = {}) {
    if (!opts.archetype) opts.archetype = this._director.next();
    // ALL enemies use the rigged + animated invader; fall back to the static
    // invader GLB, then placeholder geometry.
    if (this.assets) {
      opts = { ...opts };
      // Every archetype uses a rigged + animated enemy (its own walk/run/attack
      // clips), falling back to the static invader GLB, then placeholder geometry.
      const rigged = this.assets.getRiggedEnemy(opts.archetype);
      if (rigged) {
        opts.rigged = rigged;
      } else {
        const model = this.assets.getModel("invader");
        if (model) opts.model = model;
      }
      // Arm every enemy with a blade to lunge with — no archetype is ranged, so a
      // pistol is never assigned. Enforcer swings a machete; everyone else rushes
      // in with a knife. EXCEPTION: a rig whose weapon is baked into the mesh (the
      // grrom-2 cleaver grunt) gets no separate blade.
      if (!(rigged && rigged.builtInWeapon)) {
        const wslug = opts.archetype === "enforcer" ? "enemy_machete" : "enemy_knife";
        const wmodel = this.assets.getModel(wslug);
        if (wmodel) opts.weapon = { object3D: wmodel, kind: "blade" };
      }
    }
    const e = new Enemy(pos, opts);
    // Per-sector difficulty scaling (keyed on the campaign index, NOT the layout
    // seed). Multiplies the freshly-loaded archetype stats so later sectors are
    // tougher AND faster, not just more numerous. Enforcer scales too but stays
    // kick-immune. Stacks with any per-run Modifier (applied post-build in main).
    const diff = this.index | 0;
    if (diff > 0) {
      const hpMul = Math.min(2.0, 1 + diff * 0.15); // sector 6 → ~1.9x health
      const spdMul = Math.min(1.4, 1 + diff * 0.05); // sector 6 → 1.3x speed
      e.health *= hpMul;
      e.speed *= spdMul;
      e.runSpeed *= spdMul;
    }
    this.group.add(e.group);
    this.enemies.push(e);
  }

  _buildCar(x, z) {
    const model = this.assets && this.assets.getModel("prop_car");
    if (model) {
      model.position.set(x, 0, z);
      model.rotation.y = 0; // broadside across the street (roadblock; length runs along X)
      this.group.add(model);
      // Tight collider + LOS box fitted to the actual (normalised) model rather
      // than a hardcoded oversized AABB — prop_car is height-fit to 1.5m.
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model).expandByScalar(0.05);
      this.colliders.push(box);
      this.losBlockers.push(box);
    } else {
      // Placeholder: axis-aligned chassis + head-height cabin.
      this._box(2.0, 0.9, 4.2, new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.9 }), x, 0.7, z, { los: true });
      this._box(1.8, 0.7, 2.0, new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 }), x, 1.45, z, { los: true });
    }
  }

  // ---- runtime API ---------------------------------------------------------

  /** Active movement colliders (open-door boxes removed). Cached per frame. */
  getColliders() {
    // Rebuild only when the set of open doors changes (kicks are rare).
    let openCount = 0;
    for (const d of this.doors) if (d.open) openCount++;
    if (this._activeColliders && openCount === this._openCount) {
      return this._activeColliders;
    }
    this._openCount = openCount;
    const openBoxes = new Set();
    for (const d of this.doors) if (d.open) openBoxes.add(d._closedBox);
    this._activeColliders = this.colliders.filter((b) => !openBoxes.has(b));
    return this._activeColliders;
  }

  /** True if nothing blocks the segment a→b (used by enemy AI). */
  lineOfSight(a, b) {
    _dir.copy(b).sub(a);
    const maxDist = _dir.length();
    _dir.normalize();
    _ray.set(a, _dir);
    for (const box of this.losBlockers) {
      // Skip opened doors.
      let skip = false;
      for (const d of this.doors) {
        if (d._closedBox === box && d.open) { skip = true; break; }
      }
      if (skip) continue;
      if (_ray.intersectBox(box, _hit)) {
        if (a.distanceTo(_hit) < maxDist) return false;
      }
    }
    return true;
  }

  /** Retained for compatibility; the grid has no exit gate (clear to win). */
  checkExit() {
    return false;
  }

  get enemiesRemaining() {
    return this.enemies.filter((e) => !e.dead).length;
  }

  /** Civilians still alive + unrescued (drives the HUD bar + locators). */
  get victimsRemaining() {
    return this.victims.filter((v) => !v.rescued && !v.dead).length;
  }

  /** Aggregate remaining civilian life (sum) — the top-right bar's numerator. */
  get victimLifeTotal() {
    let t = 0;
    for (const v of this.victims) if (!v.rescued && !v.dead) t += Math.max(0, v.life);
    return t;
  }

  /** Aggregate max civilian life across the still-at-risk civilians. */
  get victimLifeMax() {
    let t = 0;
    for (const v of this.victims) if (!v.rescued && !v.dead) t += v.maxLife;
    return t;
  }

  /** Civilians the player has rescued this sector (the HUD "X/total saved" count).
   *  Includes rescued civilians that have already fled off-screen + despawned. */
  get victimsSaved() {
    return this._savedDespawned + this.victims.filter((v) => v.rescued).length;
  }

  /** Overall civilian wellbeing in [0,1]: rescued = 1, dead = 0, at-risk = life/maxLife,
   *  averaged over all civilians. Drives the top-right bar — it stays full when every
   *  civilian is saved (so it never reads as if they were lost), counting rescued
   *  civilians that have already despawned. */
  get civilianWellbeing() {
    if (!this.victimCount) return 0;
    let sum = this._savedDespawned; // each despawned-rescued civilian counts as full
    for (const v of this.victims) {
      if (v.rescued) sum += 1;
      else if (!v.dead) sum += Math.max(0, Math.min(1, v.life / v.maxLife));
    }
    return sum / this.victimCount;
  }

  /**
   * Advance the escalation clock and raise the alarm the moment a threshold trips.
   * Pure of any ctx side-effects (so it's unit-testable) — returns true ONLY on the
   * frame the alarm is newly raised, leaving the caller to fire the HUD/audio cue.
   * @param {number} dt seconds
   * @returns {boolean} true exactly once, when the alarm flips on
   */
  tickAlarm(dt) {
    if (this.alarmRaised) return false;
    if (this._initialEnemies == null) this._initialEnemies = this.enemies.length;
    this._combatTime += dt;
    const remaining = this.enemiesRemaining;
    if (remaining === 0) return false; // sector already clear — nothing to mobilise
    const killed = this._initialEnemies - remaining;
    const frac = this._initialEnemies > 0 ? killed / this._initialEnemies : 0;
    if (this._combatTime >= ALARM_TIME || frac >= ALARM_KILL_FRAC) {
      this.alarmRaised = true;
      for (const e of this.enemies) if (!e.dead) e._hunting = true;
      return true;
    }
    return false;
  }

  update(dt, ctx) {
    for (const d of this.doors) d.update(dt);
    // Mobilise the garrison once the escalation threshold trips, then announce it.
    if (this.tickAlarm(dt) && ctx) {
      if (ctx.hud) ctx.hud.showDialogue("⚠ ALARM RAISED — invaders are converging on your position", 4200);
      if (ctx.audio && ctx.audio.enemyScream && ctx.player) {
        ctx.audio.enemyScream(ctx.player.position, ctx.camera ? ctx.camera.position : ctx.player.position);
      }
      if (ctx.state) ctx.state.emit("alarmRaised", {});
    }
    for (const e of this.enemies) e.update(dt, ctx);
    // Victims: tick then splice out any that have despawned off-screen.
    for (let i = this.victims.length - 1; i >= 0; i--) {
      const v = this.victims[i];
      v.update(dt, ctx);
      if (v.removed) {
        // Only rescued civilians despawn (dead ones stay as corpses); keep crediting
        // them as saved after they leave the array.
        if (v.rescued) this._savedDespawned += 1;
        this.group.remove(v.group);
        v.dispose();
        this.victims.splice(i, 1);
      }
    }
  }

  dispose() {
    this._disposed = true;
    this.scene.remove(this.group);
    // `_materials` may be owned by the AssetManager and reused across levels —
    // only dispose them if THIS level created its own flat-colour fallbacks.
    const shared = new Set(Object.values(this._materials));
    if (!this.assets) shared.forEach((m) => m.dispose());
    // Dispose victims (geometry/materials they own, if any).
    for (const v of this.victims) v.dispose(this.scene);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      // Inline (per-mesh) materials still need disposing; skip the shared ones.
      if (o.material && o.material.dispose && !shared.has(o.material)) {
        o.material.dispose();
      }
    });
  }
}

/** Tiny deterministic PRNG so levels are stable across reloads. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
