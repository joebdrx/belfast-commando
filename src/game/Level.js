import * as THREE from "three";
import { Enemy } from "./Enemy.js";

const _ray = new THREE.Ray();
const _dir = new THREE.Vector3();
const _hit = new THREE.Vector3();

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
  constructor(scene, index = 0, assets = null) {
    this.scene = scene;
    this.index = index;
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
    /** @type {Array<{root:THREE.Object3D, hitbox:THREE.Box3, collider:THREE.Box3, pos:THREE.Vector3, exploded:boolean}>} */
    this.barrels = [];

    this.spawn = new THREE.Vector3(-12, 1.7, 38);
    this.spawnYaw = 0; // procedural grid faces -Z into the street
    this.exit = null; // no exit gate — clearing the sector completes the level

    // Pull shared, textured materials from the AssetManager when present;
    // otherwise fall back to flat colours so the level still builds.
    this._materials = {
      brick: this._mat("brick", 0x8a4b3a, 0.95),
      brickDark: this._mat("brick_dark", 0x6e3b2e, 0.95),
      tarmac: this._mat("tarmac", 0x33373b, 1.0),
      concrete: this._mat("concrete", 0x6b6f72, 0.9),
      crate: this._mat("crate", 0x7a5a30, 0.8),
      barrel: this._mat("barrel", 0x355e3b, 0.6, 0.3),
      door: this._mat("door", 0x5a3a22, 0.85),
      roof: this._mat("roof", 0x474a4f, 0.85),
      pavement: this._mat("pavement", 0x6e706d, 0.92),
      // Flat architectural materials (windows, kerbs, paint, hills, ceilings).
      glass: new THREE.MeshStandardMaterial({ color: 0x121a1f, roughness: 0.16, metalness: 0.2, envMapIntensity: 1.6 }),
      frame: new THREE.MeshStandardMaterial({ color: 0xb6bbbd, roughness: 0.7 }),
      kerb: new THREE.MeshStandardMaterial({ color: 0x8b8e8b, roughness: 0.92 }),
      paint: new THREE.MeshStandardMaterial({ color: 0xeae6da, roughness: 0.55 }),
      hill: new THREE.MeshStandardMaterial({ color: 0x3a4138, roughness: 1.0 }),
      ceiling: new THREE.MeshStandardMaterial({ color: 0x4a4d4f, roughness: 0.95 }),
      // Grimy tenement photo clad onto the long side walls (null → plain brick).
      sideHouse: assets && assets.getHouseSideTexture && assets.getHouseSideTexture()
        ? new THREE.MeshStandardMaterial({ map: assets.getHouseSideTexture(), roughness: 0.92, metalness: 0 })
        : null,
    };

    // Grid geometry shared across builders. Buildings are tall, long terraces:
    // narrow frontage (X) and a long run (Z), so they line the north–south
    // streets the player walks down.
    this.WALL_H = 15; // 3× the original 5m
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

    const rng = mulberry32(2024 + this.index * 131);

    // --- 3×3 terraced blocks: enclosed rooms with kickable doors. ---------
    // Roughly half the blocks hide an invader; the rest are empty rooms to
    // breach. Street enemies (added below) guarantee a fight regardless.
    for (const cz of COORDS_Z) {
      for (const cx of COORDS_X) {
        const enemyCount = 2 + (rng() < 0.5 ? 1 : 0); // 2–3 occupied rooms per building
        this._buildBlock(cx, cz, enemyCount, rng);
      }
    }

    // --- Street network paint + far horizon. ------------------------------
    this._buildRoadPaint();
    this._buildBackdrop();

    // --- Street cover: crates + explosive barrels in the open lanes. ------
    const coverCount = 6 + this.index * 2;
    let placed = 0;
    for (let guard = 0; placed < coverCount && guard < coverCount * 20; guard++) {
      const x = (rng() - 0.5) * GRID_HALF_X * 2;
      const z = (rng() - 0.5) * GRID_HALF_Z * 2;
      if (!this._inStreet(x, z)) continue;
      if (rng() < 0.5) {
        this._prop("crate_supply", x, z, 1.1, 1.1, 1.1, () => {
          const m = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), this._materials.crate);
          m.position.set(x, 0.55, z);
          this.group.add(m);
        });
      } else {
        this._addBarrel(x, z);
      }
      placed++;
    }

    // Burnt-out car roadblock at the cross-street intersection (cover + LOS).
    this._buildCar(PITCH_X / 2, 0);

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
    const wallH = this.WALL_H;
    const doorW = 1.7;
    const brick = this._materials.brick;
    const brickDark = this._materials.brickDark;

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
      this._materials.concrete,
    );
    f.rotation.x = -Math.PI / 2;
    f.position.set(cx, 0.13, cz);
    this.group.add(f);

    // End walls (short, N & S) + solid back long wall + room-dividing cross walls.
    this._box(this.BLOCK_W, wallH, t, brick, cx, wallH / 2, cz - halfL, { los: true });
    this._box(this.BLOCK_W, wallH, t, brick, cx, wallH / 2, cz + halfL, { los: true });
    this._box(t, wallH, this.BLOCK_L, brick, backWallX, wallH / 2, cz, { los: true });
    for (let i = 1; i < N; i++) {
      this._box(this.BLOCK_W, wallH, t, brickDark, cx, wallH / 2, cz - halfL + i * roomLen, { los: true });
    }

    // Door long wall: solid segments between the per-room doorways, plus lintels.
    let segStart = cz - halfL;
    for (let i = 0; i <= N; i++) {
      const segEnd = i < N ? roomZ(i) - doorW / 2 : cz + halfL;
      const segLen = segEnd - segStart;
      if (segLen > 0.02) {
        this._box(t, wallH, segLen, brick, doorWallX, wallH / 2, (segStart + segEnd) / 2, { los: true });
      }
      if (i < N) {
        this._box(t, wallH - 2.7, doorW, brickDark, doorWallX, 2.7 + (wallH - 2.7) / 2, roomZ(i), { collider: false });
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
      const door = new Door(hinge, doorW, -doorSide, facing, this._materials.door, null);
      this.group.add(door.pivot);
      this.doors.push(door);
      this.colliders.push(door._closedBox);
      this.losBlockers.push(door._closedBox);
    }

    // Ceiling, pitched roof + chimneys.
    const ceil = new THREE.Mesh(
      new THREE.BoxGeometry(this.BLOCK_W, t, this.BLOCK_L),
      this._materials.ceiling,
    );
    ceil.position.set(cx, wallH + t / 2 - 0.05, cz);
    this.group.add(ceil);
    this._buildRoof(cx, cz);
    this._buildChimney(cx, cz);

    // --- Cladding: tenement photo on the long sides, model facades on the ends.
    if (this._materials.sideHouse) {
      const backRotY = doorSide === 1 ? -Math.PI / 2 : Math.PI / 2;
      const doorRotY = doorSide === 1 ? Math.PI / 2 : -Math.PI / 2;
      // Solid back wall — one panel.
      this._sideWall(backWallX - doorSide * 0.31, wallH / 2, cz, backRotY, this.BLOCK_L, wallH);
      // Door wall — a panel per solid segment (doorways stay open).
      let s = cz - halfL;
      for (let i = 0; i <= N; i++) {
        const e = i < N ? roomZ(i) - doorW / 2 : cz + halfL;
        if (e - s > 0.4) {
          this._sideWall(doorWallX + doorSide * 0.31, wallH / 2, (s + e) / 2, doorRotY, e - s, wallH);
        }
        if (i < N) s = roomZ(i) + doorW / 2;
      }
    }
    if (this._facades.length) {
      this._addFacade(cx, wallH / 2, cz - halfL - 0.32, Math.PI, this.BLOCK_W); // north end
      this._addFacade(cx, wallH / 2, cz + halfL + 0.32, 0, this.BLOCK_W); // south end
    }

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

  /** Pitched gable roof, ridge running along Z (the long axis) over the terrace. */
  _buildRoof(cx, cz) {
    const halfW = this.BLOCK_W / 2;
    const wallH = this.WALL_H;
    const rise = 2.6;
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
    const ridgeY = this.WALL_H + 2.6;
    const halfL = this.BLOCK_L / 2;
    for (const oz of [-halfL * 0.6, -halfL * 0.1, halfL * 0.45]) {
      const stack = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.5, 0.8), this._materials.brick);
      stack.position.set(cx, ridgeY + 0.55, cz + oz);
      this.group.add(stack);
      for (const ox of [-0.2, 0.2]) {
        const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.35, 8), this._materials.kerb);
        pot.position.set(cx + ox, ridgeY + 1.45, cz + oz);
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
    const baseR = Math.max(this.GRID_HALF_X, this.GRID_HALF_Z) + 62; // beyond the buildings
    const n = 22;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = baseR + (i % 3) * 12;
      const hill = new THREE.Mesh(new THREE.SphereGeometry(30, 12, 8), this._materials.hill);
      hill.scale.set(2.2, 0.6 + (i % 4) * 0.12, 1);
      hill.position.set(Math.cos(a) * r, -14, Math.sin(a) * r);
      this.group.add(hill);
    }
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

    // Phone booth on a corner pavement.
    place("prop_phone_booth", -this.PITCH_X / 2 + 1.2, this.GRID_HALF_Z - 6, 0, [0.5, 0.5, 2.4]);

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

  _addEnemy(pos, opts = {}) {
    // ALL enemies use the rigged + animated invader; fall back to the static
    // invader GLB, then placeholder geometry.
    if (this.assets) {
      opts = { ...opts, flashTex: this.assets.getSprite("muzzle_flash") };
      const rigged = this.assets.getRiggedEnemy();
      if (rigged) {
        opts.rigged = rigged;
      } else {
        const model = this.assets.getModel("invader");
        if (model) opts.model = model;
      }
    }
    const e = new Enemy(pos, opts);
    this.group.add(e.group);
    this.enemies.push(e);
  }

  _buildCar(x, z) {
    const model = this.assets && this.assets.getModel("prop_car");
    if (model) {
      model.position.set(x, 0, z);
      model.rotation.y = 0; // broadside across the street (roadblock; length runs along X)
      this.group.add(model);
      // Model-independent collider + LOS footprint (cover), matching the broadside footprint.
      const box = new THREE.Box3(
        new THREE.Vector3(x - 2.1, 0, z - 1.0),
        new THREE.Vector3(x + 2.1, 1.5, z + 1.0),
      );
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

  update(dt, ctx) {
    for (const d of this.doors) d.update(dt);
    for (const e of this.enemies) e.update(dt, ctx);
  }

  dispose() {
    this._disposed = true;
    this.scene.remove(this.group);
    // `_materials` may be owned by the AssetManager and reused across levels —
    // only dispose them if THIS level created its own flat-colour fallbacks.
    const shared = new Set(Object.values(this._materials));
    if (!this.assets) shared.forEach((m) => m.dispose());
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
