import * as THREE from "three";

const BASE = import.meta.env.BASE_URL || "/";
// Safehouse character display scale — the hero + ally figures are scaled up 25%.
const MENU_CHAR_SCALE = 1.25;

/** Smootherstep (6t^5-15t^4+10t^3): an eased 0→1 ramp for the laptop dolly. */
function smoother(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Hub
 * ---
 * The safehouse: a small, low-poly abandoned Belfast pub / basement that acts
 * as the central menu + progression area for the roguelite loop (GamePhase
 * "HUB"). It is a SELF-CONTAINED `THREE.Scene` with its OWN grim interior
 * lighting + fog, built from the shared AssetManager brick/concrete/crate
 * palette (with flat-colour box fallbacks so it still builds standalone).
 *
 * It does NOT own a renderer or a camera — the Engine owns the one shared
 * camera and hands it in. `show()` poses that camera to a flattering fixed view
 * of the room; the orchestrator renders this scene via `engine.render(hub.scene)`
 * while the game is in HUB. Storing/restoring the camera around HUB is the
 * orchestrator's job; Hub just sets it.
 *
 * Visual palette deliberately echoes Engine.js (hemisphere + dim directional +
 * ambient + FogExp2), pulled darker and warmer for a cramped, smoky interior
 * lit by a single swinging bulb. Two ally NPCs flank the map table: Ruairí
 * (IRA) idles slung-rifle on his back, and Davy (Ulster-Scots) patrols carrying
 * an SMG. A spare SMG also rests on the planning table, and the hero wears one
 * slung across his back.
 */
export class Hub {
  /**
   * @param {THREE.PerspectiveCamera} camera the Engine-owned shared camera
   * @param {import("./AssetManager.js").AssetManager|null} [assets]
   */
  constructor(camera, assets = null) {
    this.camera = camera;
    this.assets = assets;

    /** @type {THREE.Scene} exposed; orchestrator renders this in HUB. */
    this.scene = new THREE.Scene();

    // Materials pulled from the AssetManager are SHARED across the whole game;
    // we must never dispose those. Track them so dispose() can skip them.
    this._sharedMats = new Set();

    // Animated bits captured during build for update(dt).
    /**
     * Ally NPCs. Animated entries carry their own AnimationMixer (and, for the
     * patroller, a back-and-forth path); the primitive fallback uses a gentle bob.
     * @type {Array<{group:THREE.Group, baseY:number, phase:number, mixer?:THREE.AnimationMixer, patrol?:{minX:number,maxX:number,z:number,speed:number,dir:number}}>}
     */
    this.npcs = [];
    /** @type {THREE.AnimationMixer[]} every menu-actor mixer, ticked in update(dt). */
    this._mixers = [];
    this._heroMixer = null;
    this._lamp = null;
    this._lampBase = 8; // base point-light intensity (flickers around this)
    this._bulbMat = null;
    this._heroGroup = null;

    // Belfast wall murals (loaded async) + the spare SMG on the planning table.
    // Tracked so dispose() can free the textures the generic traverse won't.
    /** @type {THREE.Texture[]} */
    this._muralTextures = [];
    this._tableSmg = null;
    this._tableTopY = 0.95;

    // Clickable safehouse fixtures + their projected-label anchors (world space).
    // Anchors are fixed (the fixtures never move; only the camera sways), so they
    // are computed once at build time and projected each frame with no alloc.
    /** @type {Array<{object3D:THREE.Object3D, id:string, label:string, anchor:THREE.Vector3}>} */
    this._interactables = [];

    // Lobby framing (CoD-style): camera sits front-left and looks slightly left
    // into the room so the hero fighter — placed on the RIGHT — reads large in
    // the right portion of the frame, leaving the left for the menu panel.
    this._camBase = new THREE.Vector3(-0.6, 1.5, 1.8); // pushed in a touch from 2.7
    this._lookTarget = new THREE.Vector3(-0.45, 1.12, -2.4);
    this._tmpV = new THREE.Vector3(); // reused each frame — no per-frame alloc
    this._elapsed = 0;
    this._visible = false;

    // --- Laptop "black market" zoom-in (the upgrades shop) ----------------
    // Clicking the upgrades fixture dollies the shared camera from the idle
    // framing into the open ThinkPad screen (narrowing fov for an optical
    // lean-in); a CRT shop overlay then takes over. restoreCamera() reverses it.
    this._laptopFit = null; // {center,normal,quat,w,h} of the lid, cached on place
    this._zooming = false;
    this._restoring = false;
    this._atLaptop = false;
    this._zoomT = 0; // 0 = idle framing, 1 = seated at the screen
    this._zoomDur = 0.85; // seconds
    this._zoomFrom = new THREE.Vector3();
    this._zoomTo = new THREE.Vector3();
    this._zoomLookFrom = new THREE.Vector3();
    this._zoomLookTo = new THREE.Vector3();
    this._tmpLook = new THREE.Vector3();
    this._zoomFovFrom = 78;
    this._zoomFovTo = 34;
    this._arriveCb = null;
    this._restoreCb = null;
    this._reduceMotion = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;

    this._buildAtmosphere();
    this._buildShell();
    this._buildMurals();
    this._buildPortrait();
    this._buildBar();
    this._buildMapTable();
    this._buildBulb();
    this._buildCrates();
    this._buildFurniture();
    this._buildNpcs();
    this._buildHero();
    this._buildDoor();
    this._buildPhone();
  }

  // ---- construction helpers ------------------------------------------------

  /**
   * Shared, textured material from the AssetManager (tracked so it is never
   * disposed), or a flat-colour fallback so the safehouse still builds when run
   * without the asset files. Only request KNOWN slugs — unknown slugs make the
   * AssetManager allocate an untracked throwaway material.
   */
  _mat(slug, color, roughness = 0.9, metalness = 0.0) {
    if (this.assets && this.assets.getMaterial) {
      const m = this.assets.getMaterial(slug);
      if (m) {
        this._sharedMats.add(m);
        return m;
      }
    }
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
  }

  /** Add a box mesh to the scene and return it (thin boxes = double-sided walls). */
  _box(w, h, d, mat, x, y, z) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    return mesh;
  }

  /**
   * Load a hub texture (served from public/), tracked for dispose(). rx/ry > 1
   * tiles it (RepeatWrapping); the default 1×1 clamps. Returns the texture
   * immediately — the image streams in asynchronously and updates the material.
   */
  _loadTex(url, rx = 1, ry = 1) {
    const tex = new THREE.TextureLoader().load(`${BASE}${url}`);
    tex.colorSpace = THREE.SRGBColorSpace;
    if (rx !== 1 || ry !== 1) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(rx, ry);
    }
    tex.anisotropy = 4;
    this._muralTextures.push(tex);
    return tex;
  }

  /** Grim interior background + fog + low-key overcast-style lighting. */
  _buildAtmosphere() {
    this.scene.background = new THREE.Color(0x15171b);
    // Heavier than Engine's open-street haze — a damp, smoky basement.
    this.scene.fog = new THREE.FogExp2(0x0d0f12, 0.055);

    // Cool overcast bounce leaking through grimy windows (mirrors Engine).
    this.scene.add(new THREE.HemisphereLight(0x4a5054, 0x1a1510, 0.55));

    // Weak diffuse key for form shading.
    const key = new THREE.DirectionalLight(0xb9c2c8, 0.28);
    key.position.set(-4, 6, 3);
    this.scene.add(key);

    this.scene.add(new THREE.AmbientLight(0x2a2e31, 0.4));
  }

  /** Floor, ceiling and four enclosing walls (brick + concrete). */
  _buildShell() {
    // Player-supplied red-brick walls + concrete-aggregate floor (menu only —
    // tiled so the photo repeats across the 10m surfaces without obvious stretch).
    const wall = new THREE.MeshStandardMaterial({ map: this._loadTex("textures/hub_brick.jpg", 5, 2), roughness: 0.96 });
    const floorMat = new THREE.MeshStandardMaterial({ map: this._loadTex("textures/hub_ground.jpg", 6, 6), roughness: 0.95 });
    const ceilMat = this._mat("concrete", 0x34373a, 0.95);

    // Room spans X[-5,5], Z[-6,4] (10×10), centred at (0,*,-1), 3.4m tall.
    const H = 3.4;
    const cz = -1;
    this._box(10.4, 0.2, 10.4, floorMat, 0, -0.1, cz); // floor (top at y=0)
    this._box(10.4, 0.2, 10.4, ceilMat, 0, H + 0.1, cz); // ceiling

    this._box(10.4, H, 0.3, wall, 0, H / 2, -6); // back wall (behind the bar)
    this._box(10.4, H, 0.3, wall, 0, H / 2, 4); // front wall (behind the camera)
    this._box(0.3, H, 10.3, wall, -5, H / 2, cz); // left wall
    this._box(0.3, H, 10.3, wall, 5, H / 2, cz); // right wall
  }

  /**
   * Belfast sectarian wall murals, flush on the interior walls. Loaded async via
   * TextureLoader; each panel's plane is built in the onLoad callback (aspect-
   * preserved, unlit so it stays readable in the gloom) and the texture is
   * tracked for dispose(). Room: X[-5,5], Z[-6,4], inner wall faces at ±4.85 /
   * z=-5.85. The loyalist mural sits on the left wall (facing +X); the republican
   * on the back wall above the bar (facing +Z). Load failure → no panel.
   */
  _buildMurals() {
    const loader = new THREE.TextureLoader();
    // [url, centre position, yaw]; size is derived from the image aspect on load.
    const panels = [
      // Republican — back wall (z≈-5.85), above the bar, facing +Z into the room.
      // (The loyalist/Ulster mural on the left wall was removed per request.)
      { url: `${BASE}murals/republican.png`, pos: [-1.4, 1.95, -5.84], rotY: 0 },
    ];
    for (const p of panels) {
      loader.load(
        p.url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          this._muralTextures.push(tex);
          // Preserve aspect; cap the longest side at ~2.3m (readable, in-range).
          const img = tex.image || {};
          const aspect = img.width && img.height ? img.width / img.height : 1;
          const target = 2.3;
          const w = aspect >= 1 ? target : target * aspect;
          const h = aspect >= 1 ? target / aspect : target;
          const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
          const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
          panel.position.set(p.pos[0], p.pos[1], p.pos[2]);
          panel.rotation.y = p.rotY;
          this.scene.add(panel);
        },
        undefined,
        () => {}, // 404 / decode error → wall stays bare
      );
    }
  }

  /**
   * Framed B&W portrait (Pádraig Pearse) on the back wall, right of the republican
   * mural and clear of the bar shelves. The supplied image already includes its
   * own frame; a thin dark box behind it adds physical depth.
   */
  _buildPortrait() {
    const tex = this._loadTex("textures/hub_portrait.jpg");
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x0b0907, roughness: 0.85 });
    this._box(0.72, 0.84, 0.04, frameMat, 1.7, 2.0, -5.82); // depth backing
    const portrait = new THREE.Mesh(
      new THREE.PlaneGeometry(0.66, 0.78),
      new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
    );
    portrait.position.set(1.7, 2.0, -5.79);
    this.scene.add(portrait);
  }

  /**
   * Worn upholstered seating — a 3-seat settee + an armchair — as a tired front-
   * room "lounge" in the open left of the safehouse. Built from primitives
   * (procedural stand-ins for the mobili models, which ship as Blender sources).
   */
  _buildFurniture() {
    // Lounge against the left (stage-left) wall, backs to the brick.
    this._buildSeat({ x: -4.15, z: -2.6, rotY: Math.PI / 2, seats: 3 }); // settee vs left wall
    this._buildSeat({ x: -3.05, z: 0.5, rotY: Math.PI / 2 + 0.55, seats: 1 }); // armchair, angled in
  }

  /**
   * One upholstered seat unit (base + back + arms + loose cushions + feet),
   * centred on its group with depth along local Z (back at -Z). `seats` sets the
   * width (1 = armchair, 3 = settee).
   * @param {{x:number,z:number,rotY?:number,seats?:number}} cfg
   */
  _buildSeat({ x, z, rotY = 0, seats = 1 }) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    const fabric = new THREE.MeshStandardMaterial({ color: 0x5a392c, roughness: 0.93 });   // worn oxblood-brown
    const cushion = new THREE.MeshStandardMaterial({ color: 0x6b4734, roughness: 0.95 });   // slightly lighter
    const footMat = new THREE.MeshStandardMaterial({ color: 0x1a140e, roughness: 0.6 });
    const seatW = seats === 1 ? 0.98 : 1.98;
    const depth = 0.85, seatH = 0.4, backH = 0.86, armW = 0.16;
    const add = (geo, mat, px, py, pz) => {
      const m = new THREE.Mesh(geo, mat); m.position.set(px, py, pz); g.add(m); return m;
    };
    add(new THREE.BoxGeometry(seatW, seatH, depth), fabric, 0, seatH / 2, 0);             // base
    add(new THREE.BoxGeometry(seatW, backH, 0.18), fabric, 0, backH / 2, -depth / 2 + 0.09); // backrest
    for (const sx of [-1, 1]) {
      add(new THREE.BoxGeometry(armW, seatH + 0.16, depth), fabric, sx * (seatW / 2 - armW / 2), (seatH + 0.16) / 2, 0);
    }
    const innerW = seatW - 2 * armW - 0.04, cw = innerW / seats;
    for (let i = 0; i < seats; i++) {
      const cx = -innerW / 2 + cw * (i + 0.5);
      add(new THREE.BoxGeometry(cw - 0.03, 0.12, depth - 0.22), cushion, cx, seatH + 0.06, 0.06);      // seat cushion
      add(new THREE.BoxGeometry(cw - 0.03, 0.32, 0.13), cushion, cx, seatH + 0.24, -depth / 2 + 0.17); // back cushion
    }
    for (const fx of [-1, 1]) for (const fz of [-1, 1]) {
      add(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 6), footMat, fx * (seatW / 2 - 0.1), 0.04, fz * (depth / 2 - 0.1));
    }
    this.scene.add(g);
    return g;
  }

  /** A long pub bar counter against the back wall, with a few bottles. */
  _buildBar() {
    // Player-supplied weathered-plank wood on the counter (menu only).
    const wood = new THREE.MeshStandardMaterial({ map: this._loadTex("textures/hub_wood.jpg", 3, 1), roughness: 0.85 });
    const topMat = new THREE.MeshStandardMaterial({ map: this._loadTex("textures/hub_wood.jpg", 3, 0.4), roughness: 0.8 });
    this._box(7.0, 1.1, 0.6, wood, 0, 0.55, -5.4); // front panel
    this._box(7.2, 0.1, 0.78, topMat, 0, 1.13, -5.38); // overhanging top

    // Bottles — cheap cylinders in muddy bottle-greens/browns.
    const bottleColors = [0x2f4a2a, 0x4a3320, 0x33474a];
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: bottleColors[i],
        roughness: 0.3,
        metalness: 0.1,
      });
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.3, 8), mat);
      bottle.position.set(-1.6 + i * 1.5, 1.3, -5.4);
      this.scene.add(bottle);
    }

    // Dim warm wash over the back bar so the counter, bottles + props read
    // (the bulb over the table doesn't reach this far back).
    const barLight = new THREE.PointLight(0xffcf9a, 2.4, 4.2, 2);
    barLight.position.set(0, 1.85, -5.0);
    this.scene.add(barLight);

    // A Trinitron CRT + an open ThinkPad resting on the counter (streamed GLBs,
    // placed once available via _ensureBarProps()).
    this._barProps = {}; // { crt_tv?, thinkpad? } once each clone is placed
    this._ensureBarProps();
  }

  /**
   * Rest the bar-prop GLBs (CRT TV, laptop) on the counter top once they have
   * streamed in. No-op for any prop already placed or still unavailable; called
   * from _buildBar() + update() so the models swap in as soon as they load. Each
   * is anchored at its base, so y = the counter surface (1.18m).
   */
  _ensureBarProps() {
    if (!this.assets || typeof this.assets.getModel !== "function") return;
    if (!this._barProps) this._barProps = {};
    const place = (slug, x, y, z, yaw) => {
      if (this._barProps[slug]) return;
      const m = this.assets.getModel(slug);
      if (!m) return;
      m.position.set(x, y, z);
      m.rotation.y = yaw; // additional yaw on top of the def's baked rotY
      this.scene.add(m);
      this._barProps[slug] = m;
    };
    place("crt_tv", -2.75, 1.18, -5.42, 0);    // on the bar, left of the bottles, screen into the room
    place("thinkpad", 0.45, 1.0, -1.95, 0.25 + Math.PI); // open on the planning table (surface y≈1.0), turned 180°

    // Glowing "rootkit monitor" UI overlaid on the laptop's screen. The model is a
    // single mesh, so the screen is a separate emissive plane fitted to the lid's
    // front face (centre + normal derived from the geometry, so it stays aligned
    // even if the laptop is moved/rotated).
    if (this._barProps.thinkpad && !this._barProps.laptop_screen) {
      const fit = this._fitLaptopScreen(this._barProps.thinkpad);
      this._laptopFit = fit; // cached for the zoom-in target pose
      const w = fit ? fit.w : 0.55, h = fit ? fit.h : 0.31; // fill the whole lid
      const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: this._loadTex("textures/hub_laptop_screen.jpg"), toneMapped: false }),
      );
      if (fit) {
        screen.position.copy(fit.center).addScaledVector(fit.normal, 0.004); // just proud of the lid
        screen.quaternion.copy(fit.quat);
      } else {
        // Fallback if the geometry probe finds no lid faces (headless / odd model).
        screen.position.set(0.401, 1.252, -2.127);
        screen.rotation.set(0.008, 0.237, 0);
      }
      this.scene.add(screen);
      this._barProps.laptop_screen = screen;
      // The laptop itself is a clickable "upgrades" fixture: clicking it dollies
      // the camera in and opens the black-market shop overlay.
      this._registerInteractable(this._barProps.thinkpad, "upgrades", "Laptop — Black Market", 1.2);
    }
  }

  /**
   * Fit the laptop lid's front (screen) face from its geometry so the emissive
   * screen plane sits flush on, and fills, the open lid. Selects the upper,
   * strongly room-facing triangles (the flat display panel), takes their
   * area-weighted normal, then measures the panel's extent along the screen's
   * own right/up axes to size + centre the plane. Returns {center, normal, quat,
   * w, h} in world space, or null if no such faces are found.
   */
  _fitLaptopScreen(lap) {
    let mesh = null;
    lap.traverse((o) => { if (o.isMesh && o.geometry) mesh = o; });
    if (!mesh) return null;
    mesh.updateWorldMatrix(true, true);
    const wm = mesh.matrixWorld, geo = mesh.geometry, pos = geo.attributes.position, idx = geo.index;
    if (!pos) return null;
    geo.computeBoundingBox();
    const bb = geo.boundingBox.clone().applyMatrix4(wm);
    const yMid = bb.min.y + (bb.max.y - bb.min.y) * 0.35; // lid sits above the keyboard base
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3(), cen = new THREE.Vector3();
    const sumN = new THREE.Vector3(); let sumA = 0;
    const pts = []; // world verts of the accepted (display-panel) triangles
    const tris = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < tris; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(wm);
      b.fromBufferAttribute(pos, i1).applyMatrix4(wm);
      c.fromBufferAttribute(pos, i2).applyMatrix4(wm);
      ab.subVectors(b, a); ac.subVectors(c, a); n.crossVectors(ab, ac);
      const area = n.length() * 0.5;
      if (area <= 1e-9) continue;
      n.normalize();
      cen.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      // Upper region, strongly room-facing (the flat front panel, not the bezel sides).
      if (cen.y > yMid && Math.abs(n.y) < 0.6 && n.z > 0.5) {
        sumN.addScaledVector(n, area); sumA += area;
        pts.push(a.clone(), b.clone(), c.clone());
      }
    }
    if (sumA <= 0 || !pts.length) return null;
    const normal = sumN.multiplyScalar(1 / sumA).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), normal).normalize();
    const up = new THREE.Vector3().crossVectors(normal, right).normalize();
    // Panel extent along the screen's own right/up axes → size + centre.
    const mean = new THREE.Vector3();
    for (const p of pts) mean.add(p);
    mean.multiplyScalar(1 / pts.length);
    const d = new THREE.Vector3();
    let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity;
    for (const p of pts) {
      d.subVectors(p, mean);
      const r = d.dot(right), u = d.dot(up);
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
    }
    const center = mean.clone().addScaledVector(right, (minR + maxR) / 2).addScaledVector(up, (minU + maxU) / 2);
    const lookM = new THREE.Matrix4().lookAt(new THREE.Vector3(), normal.clone().negate(), new THREE.Vector3(0, 1, 0));
    const quat = new THREE.Quaternion().setFromRotationMatrix(lookM);
    return { center, normal, quat, w: maxR - minR, h: maxU - minU };
  }

  /** The planning table: wooden top + legs, a parchment map and a couple of pins. */
  _buildMapTable() {
    // Player-supplied weathered-plank wood on the planning table (menu only).
    const topMat = new THREE.MeshStandardMaterial({ map: this._loadTex("textures/hub_wood.jpg", 2, 1.2), roughness: 0.82 });
    const tableTopY = 0.95;
    this._tableTopY = tableTopY;
    this._box(1.9, 0.1, 1.2, topMat, 0, tableTopY, -2.3); // table top
    for (const [lx, lz] of [[-0.85, -0.5], [0.85, -0.5], [-0.85, 0.5], [0.85, 0.5]]) {
      this._box(0.1, tableTopY, 0.1, topMat, lx, tableTopY / 2, -2.3 + lz);
    }

    // Faded parchment map slapped on top, just proud of the table.
    const mapMat = new THREE.MeshStandardMaterial({ color: 0xb7a98a, roughness: 0.95 });
    const map = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.95), mapMat);
    map.rotation.x = -Math.PI / 2;
    map.position.set(0, tableTopY + 0.06, -2.3);
    this.scene.add(map);

    // An accent route line on the map — the operation board look. (The two red
    // objective pins were removed per request.)
    const routeMat = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6 });
    const route = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.006, 0.02), routeMat);
    route.position.set(0.02, tableTopY + 0.065, -2.25);
    route.rotation.y = 0.5;
    this.scene.add(route);

    // A spare SMG (the weapon_ak model) laid flat across the map. The model
    // streams in lazily, so the actual placement is done by _ensureTableSmg()
    // (called from here + show()/update()) once getModel returns a clone.
    this._ensureTableSmg();
  }

  /**
   * Rest a fresh weapon_ak flat on the planning table at a slight angle, seated
   * flush on the tabletop. No-op once placed or while the model is unavailable
   * (headless / tests / still streaming). Each call uses its OWN model clone.
   */
  _ensureTableSmg() {
    // Intentionally empty — the table no longer holds a spare SMG (removed per
    // request). Kept as a no-op so the existing call sites stay valid.
  }

  /**
   * Attach a fresh weapon_ak (SMG) to a streamed-in menu actor. `mode` "held"
   * parents it barrel-forward to the RightHand bone (a patrolling fighter at the
   * ready); "slung" parents it to the Spine/Spine02 bone lying diagonally across
   * the back. The desired pose is expressed in the actor's own (world) frame and
   * baked into the bone's local space, so the gun keeps its real ~0.62m size and
   * rides the skeleton through any group yaw + animation. Falls back to a fixed
   * offset on the actor group when the bone isn't found. No-op (null) when the
   * model isn't loaded (headless / tests). Each call uses its OWN model clone.
   * @param {{object3D:THREE.Object3D}} actor
   * @param {"held"|"slung"} mode
   */
  _attachActorSmg(actor, mode) {
    if (!actor || !actor.object3D || !this.assets || typeof this.assets.getModel !== "function") return null;
    const mount = this.assets.getModel("weapon_ak");
    if (!mount) return null;

    // Real-world size + scale (unparented → world transform == local transform).
    mount.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(mount).getSize(new THREE.Vector3());
    const worldScale = mount.getWorldScale(new THREE.Vector3());

    // weapon_ak's barrel is its longest axis (native +X). qFwd points it down the
    // actor's forward (+Z); the slung pose keeps the native axes and just rolls it.
    const qFwd = new THREE.Quaternion();
    if (size.y >= size.x && size.y >= size.z) qFwd.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2); // +Y → +Z
    else if (size.x >= size.z) qFwd.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);                 // +X → +Z

    // Per-mode pose, tuned in the actor's local frame (+Z forward, +Y up).
    let poseQuat, offset;
    if (mode === "held") {
      // Carried at the ready in the right hand: barrel forward, muzzle dipped.
      poseQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.22, 0.0, 0.05)).multiply(qFwd);
      offset = new THREE.Vector3(0.0, 0.0, 0.06);
    } else {
      // Slung flat across the back at a diagonal, sitting just behind the torso.
      poseQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.0, 0.0, 0.92));
      offset = new THREE.Vector3(0.0, 0.08, -0.18);
    }

    // Locate the target bone (priority order), traversing the actor rig.
    const want = mode === "held" ? ["RightHand"] : ["Spine02", "Spine"];
    const found = {};
    actor.object3D.traverse((o) => { if (o.isBone && want.includes(o.name)) found[o.name] = o; });
    let bone = null;
    for (const n of want) { if (found[n]) { bone = found[n]; break; } }

    if (!bone) {
      // Fallback: parent to the actor group at a hands/back-height offset.
      actor.object3D.add(mount);
      mount.quaternion.copy(poseQuat);
      if (mode === "held") mount.position.set(0.22, 1.05, 0.18);
      else mount.position.set(0.0, 1.3, -0.16);
      return mount;
    }

    // Express the desired WORLD transform using the actor's actual world
    // orientation (robust whether the group is still at identity or already
    // posed), then bake it into the bone's local space.
    actor.object3D.updateMatrixWorld(true);
    const actorQuat = actor.object3D.getWorldQuaternion(new THREE.Quaternion());
    const worldPos = new THREE.Vector3()
      .setFromMatrixPosition(bone.matrixWorld)
      .add(offset.clone().applyQuaternion(actorQuat));
    const worldQuat = actorQuat.clone().multiply(poseQuat);
    const desired = new THREE.Matrix4().compose(worldPos, worldQuat, worldScale);
    const local = new THREE.Matrix4().copy(bone.matrixWorld).invert().multiply(desired);
    local.decompose(mount.position, mount.quaternion, mount.scale);
    bone.add(mount);
    return mount;
  }

  /** A single swinging bulb on a cord above the table, with a warm point light. */
  _buildBulb() {
    const bulbY = 2.65;
    const bulbX = 0;
    const bulbZ = -2.3;

    this._bulbMat = new THREE.MeshStandardMaterial({
      color: 0xffd9a0,
      emissive: 0xffb347,
      emissiveIntensity: 1.0,
      roughness: 0.4,
    });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), this._bulbMat);
    bulb.position.set(bulbX, bulbY, bulbZ);
    this.scene.add(bulb);

    // Cord up to the ceiling.
    const cordMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.7, 6), cordMat);
    cord.position.set(bulbX, bulbY + 0.4, bulbZ);
    this.scene.add(cord);

    // Warm pool of light. Hemi/ambient guarantee the room reads even if this is
    // mistuned; the point light just adds the cosy safehouse glow + flicker.
    this._lamp = new THREE.PointLight(0xffb45a, this._lampBase, 14, 2);
    this._lamp.position.set(bulbX, bulbY - 0.05, bulbZ);
    this.scene.add(this._lamp);
  }

  /** A short stack of supply crates in the back corner for set-dressing. */
  _buildCrates() {
    const crateMat = this._mat("crate", 0x7a5a30, 0.85);
    const place = (x, y, z, s) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateMat);
      m.position.set(x, y, z);
      m.rotation.y = (x + z) * 0.2; // slight varied yaw, deterministic
      this.scene.add(m);
      return m;
    };
    // The large right-hand crate doubles as the clickable ARMORY (upgrades/arsenal).
    const armory = place(3.9, 0.55, -4.7, 1.1);
    place(3.7, 1.45, -4.8, 0.7);
    place(-4.0, 0.5, -4.9, 1.0);
    this._registerInteractable(armory, "upgrades", "Upgrades — Black Market", 1.15);
  }

  /**
   * Build the two ally NPCs. When the animated menu actor is available BOTH are
   * the SAME rigged model (mirroring the hero): Ruairí (IRA) idles at the table
   * with a rifle slung on his back, while Davy (Ulster-Scots) slowly patrols a
   * short back-and-forth path behind the table carrying his SMG at the ready,
   * turning to face his travel direction. If the actor is unavailable (headless /
   * tests / not yet streamed) each falls back to the low-poly capsule figure.
   */
  _buildNpcs() {
    // Ruairí — a SECOND, distinct player character: the STATIC player-2 model
    // (its rig animation deformed badly), with a subtle procedural breathing bob.
    this._buildNpc({
      x: -2.4,
      z: -3.3,
      yaw: 0.32,
      coat: 0x3c4a32,
      hat: "cap",
      hatColor: 0x1c2018,
      staticModel: "player2_static",
      breathing: true,
    });
    // Davy — Ulster-Scots paramilitary, rust coat, maroon beret. Patrols a short
    // path behind the table (clear of the hero + camera), carrying his SMG.
    this._buildNpc({
      x: 2.4,
      z: -3.3,
      yaw: -0.32,
      coat: 0x5a3a22,
      hat: "beret",
      hatColor: 0x5a1f24,
      patrol: { minX: 1.2, maxX: 3.0, z: -3.7, speed: 0.55, dir: 1 },
    });
    // True once the menu actor (Davy) AND the static player-2 model (Ruairí) are
    // loaded, so the _ensureNpcs rebuild swaps the capsule fallbacks for the reals.
    this._npcsAnimated = !!(
      this.assets &&
      this.assets.hasMenuActor && this.assets.hasMenuActor() &&
      this.assets.hasPlayer2 && this.assets.hasPlayer2()
    );
  }

  /**
   * One ally figure. Prefers the shared animated menu actor (idle, or walk while
   * patrolling); falls back to the inline capsule fighter so the hub still reads
   * headless.
   */
  _buildNpc(cfg) {
    if (cfg.staticModel) { this._buildStaticNpc(cfg); return; }
    const actor = this.assets && typeof this.assets.getMenuActor === "function"
      ? this.assets.getMenuActor()
      : null;
    if (actor) this._buildAnimatedNpc(cfg, actor);
    else this._buildCapsuleNpc(cfg);
  }

  /**
   * A STATIC character model standing as a menu figure (its rig animation is
   * unusable). The mesh is modelled upright + foot-anchored by MODEL_DEFS, so we
   * just place + face it; `cfg.breathing` flags it for a subtle idle bob in
   * update(). Falls back to the capsule until the GLB streams in (the _ensureNpcs
   * rebuild swaps it in).
   */
  _buildStaticNpc(cfg) {
    // player-2 is a skinned mesh shown static (bind pose) — it must be cloned via
    // getPlayer2 (SkeletonUtils); a plain getModel clone collapses skinned meshes.
    const obj = this.assets && typeof this.assets.getPlayer2 === "function"
      ? this.assets.getPlayer2()
      : null;
    if (!obj) { this._buildCapsuleNpc(cfg); return; }
    const group = new THREE.Group();
    group.scale.setScalar(MENU_CHAR_SCALE); // scaled up 25% like the others
    group.add(obj);
    group.position.set(cfg.x, 0, cfg.z);
    group.rotation.y = cfg.yaw + (cfg.faceFlip ? Math.PI : 0); // rig front is +Z
    this.scene.add(group);
    this.npcs.push({ group, baseY: 0, phase: this.npcs.length * 1.7, breathing: !!cfg.breathing });
  }

  /**
   * Animated ally: the shared rigged actor, given an SMG (the patroller carries
   * it at the ready in-hand; the idler wears it slung across the back).
   */
  _buildAnimatedNpc({ x, z, yaw, patrol, faceFlip }, actor) {
    const group = new THREE.Group();
    group.scale.setScalar(MENU_CHAR_SCALE); // menu characters scaled up 25%
    group.add(actor.object3D);

    // Neither menu ally carries a weapon now — the patroller's held SMG was
    // removed per request (the idler already had none).

    // Patroller walks (and faces its travel direction); idler stands and fidgets.
    const clip = patrol ? (actor.clips.walk || actor.clips.idle) : (actor.clips.idle || actor.clips.walk);
    const mixer = this._playActorClip(actor.object3D, clip);

    if (patrol) {
      group.position.set(patrol.minX, 0, patrol.z);
      group.rotation.y = Math.PI / 2; // rig front is +Z → face +X (start dir = +1)
    } else {
      group.position.set(x, 0, z);
      group.rotation.y = yaw + (faceFlip ? Math.PI : 0); // faceFlip if the rig faces away
    }
    this.scene.add(group);

    this.npcs.push({ group, baseY: 0, phase: this.npcs.length * 1.7, mixer, patrol: patrol || undefined });
  }

  /**
   * Swap the primitive capsule allies for the animated menu actor once it has
   * streamed in (the constructor usually runs before the GLB loads, so the
   * allies start as capsules). Mirrors `_ensureHeroModel`. No-op once animated
   * or while the actor is still unavailable.
   */
  _ensureNpcs() {
    if (this._npcsAnimated) return;
    if (!this.assets || typeof this.assets.hasMenuActor !== "function" || !this.assets.hasMenuActor()) return;
    // Tear down the capsule allies (inline geometry + materials), then rebuild.
    for (const n of this.npcs) {
      this.scene.remove(n.group);
      n.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) if (m && m.dispose) m.dispose();
        }
      });
    }
    this.npcs.length = 0;
    this._buildNpcs(); // actor now available → animated allies (mixers pushed to _mixers)
  }

  /** Primitive capsule ally (fallback). Materials are inline so dispose() frees them. */
  _buildCapsuleNpc({ x, z, yaw, coat, hat, hatColor }) {
    const group = new THREE.Group();

    const coatMat = new THREE.MeshStandardMaterial({ color: coat, roughness: 0.85 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.9, 6, 12), coatMat);
    body.position.y = 1.0;
    group.add(body);

    const skinMat = new THREE.MeshStandardMaterial({ color: 0xc99a73, roughness: 0.7 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), skinMat);
    head.position.y = 1.72;
    group.add(head);

    // Headgear for silhouette character.
    const hatMat = new THREE.MeshStandardMaterial({ color: hatColor, roughness: 0.8 });
    if (hat === "cap") {
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.24, 0.12, 12), hatMat);
      crown.position.y = 1.9;
      group.add(crown);
      const brim = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.04, 0.22), hatMat);
      brim.position.set(0, 1.86, 0.18);
      group.add(brim);
    } else {
      const beret = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), hatMat);
      beret.position.y = 1.88;
      beret.rotation.z = 0.18;
      group.add(beret);
    }

    // A slung rifle (thin box) for unmistakable paramilitary silhouette.
    const rifleMat = new THREE.MeshStandardMaterial({ color: 0x20242a, roughness: 0.6, metalness: 0.3 });
    const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.95), rifleMat);
    rifle.position.set(0.18, 1.05, 0.18);
    rifle.rotation.set(0.5, 0.2, 0.3);
    group.add(rifle);

    group.position.set(x, 0, z);
    group.rotation.y = yaw;
    this.scene.add(group);

    // Deterministic per-NPC phase so the two don't bob in lockstep.
    this.npcs.push({ group, baseY: 0, phase: this.npcs.length * 1.7 });
  }

  /**
   * The hero: the player's own fighter, posed standing on the RIGHT of the frame
   * (the lobby centrepiece). Uses the shared animated menu actor (a relaxed
   * standing IDLE) when available, falling back to a primitive commando
   * silhouette so the hub still reads in headless/tests or before the asset
   * streams in. A warm key + cool rim light make the figure pop against the gloom.
   */
  _buildHero() {
    const group = new THREE.Group();
    group.scale.setScalar(MENU_CHAR_SCALE); // scaled up 25% to match the allies
    group.position.set(1.8, 0, -0.6); // front-right, the lobby focal point
    // Face the camera (at ~(-0.6,1.5,2.7)). Rig front is +Z, facing dir =
    // (sin y, cos y); aiming at the camera gives y ≈ -0.5 (slight 3/4 stance).
    group.rotation.y = -0.5;

    const actor = this.assets && typeof this.assets.getMenuActor === "function"
      ? this.assets.getMenuActor() // fresh animated clone or null
      : null;
    if (actor) this._attachHeroActor(group, actor);
    else this._buildHeroFallback(group);

    this.scene.add(group);
    this._heroGroup = group;
    // True once the real animated actor is in place. The hub is usually built
    // before the model stream finishes, so the constructor gets `null` and uses
    // the primitive fallback; `_ensureHeroModel()` (called from show()/update())
    // swaps the real actor in as soon as it is available.
    this._heroIsModel = !!actor;

    // Warm key light raking the hero from front-right (cosy lobby spill).
    const key = new THREE.PointLight(0xffd9a0, 6.0, 7, 2);
    key.position.set(3.4, 2.4, 1.4);
    this.scene.add(key);
    // Cool rim from behind-left to separate the silhouette from the wall.
    const rim = new THREE.PointLight(0x6f8bd6, 3.2, 6, 2);
    rim.position.set(0.4, 2.2, -2.6);
    this.scene.add(rim);
  }

  /** Primitive stand-in hero (balaclava commando with a slung rifle). */
  _buildHeroFallback(group) {
    const coatMat = new THREE.MeshStandardMaterial({ color: 0x2b3138, roughness: 0.82 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 1.0, 6, 12), coatMat);
    body.position.y = 1.05;
    group.add(body);

    const maskMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.7 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 16, 12), maskMat);
    head.position.y = 1.82;
    group.add(head);

    // Amber goggles stripe so the hero reads as the player-faction lead.
    const visorMat = new THREE.MeshStandardMaterial({
      color: 0xff7a1a,
      emissive: 0xff7a1a,
      emissiveIntensity: 0.45,
      roughness: 0.4,
    });
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.07, 0.04), visorMat);
    visor.position.set(0, 1.86, 0.2);
    group.add(visor);

    const rifleMat = new THREE.MeshStandardMaterial({ color: 0x202329, roughness: 0.55, metalness: 0.35 });
    const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 1.05), rifleMat);
    rifle.position.set(-0.2, 1.05, 0.16);
    rifle.rotation.set(-0.4, -0.25, -0.25);
    group.add(rifle);
  }

  /**
   * Parent the animated menu actor under the hero group and play a relaxed
   * standing idle (falling back to walk if no idle clip loaded). The mixer is
   * tracked in `_mixers` for per-frame ticking and `_heroMixer` for disposal.
   */
  _attachHeroActor(group, actor) {
    group.add(actor.object3D);
    // (No back-slung weapon — removed per request.)
    const clip = (actor.clips && (actor.clips.idle || actor.clips.walk)) || null;
    this._heroMixer = this._playActorClip(actor.object3D, clip);
  }

  /**
   * Build + register a looping AnimationMixer for a menu actor and play `clip`
   * with a small per-actor time offset (so multiple idlers don't fidget in
   * lockstep). Tracks it in `_mixers` for per-frame ticking + disposal. Returns
   * the mixer, or null when there is no clip to play.
   */
  _playActorClip(object3D, clip) {
    if (!clip) return null;
    const mixer = new THREE.AnimationMixer(object3D);
    const action = mixer.clipAction(clip);
    action.play();
    action.time = (this._mixers.length * 2.3) % (clip.duration || 1); // desync
    this._mixers.push(mixer);
    return mixer;
  }

  /**
   * A heavy reinforced exit door on the right wall — the clickable "Start
   * Operation" fixture, crowned by a green deployment lamp.
   */
  _buildDoor() {
    const door = new THREE.Group();
    door.position.set(4.86, 0, -3.6); // flush to the right wall (x≈5)
    door.rotation.y = -Math.PI / 2; // face -x, into the room

    const frameMat = this._mat("door", 0x4a3322, 0.7);
    // Player-supplied steel-door photo on the slab front (its own handle/lock).
    const slabMat = new THREE.MeshStandardMaterial({ map: this._loadTex("textures/hub_door.jpg"), roughness: 0.6, metalness: 0.25 });

    // Frame (slightly larger box) + recessed slab.
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.7, 0.16), frameMat);
    frame.position.y = 1.35;
    door.add(frame);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(1.25, 2.45, 0.1), slabMat);
    slab.position.set(0, 1.25, 0.06);
    door.add(slab);

    // Green over-door deployment lamp (emissive + a soft glow).
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0x39ff14,
      emissive: 0x39ff14,
      emissiveIntensity: 0.9,
      roughness: 0.4,
    });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), lampMat);
    lamp.position.set(0, 2.78, 0.12);
    door.add(lamp);

    this.scene.add(door);
    this._registerInteractable(door, "start", "Deploy — Start Operation", 3.0);
  }

  /**
   * A wall-mounted landline phone on the right wall — the clickable fixture that
   * opens the level-code dial. Uses the optimized `landline_phone` GLB when
   * available, with the old procedural cradle as a headless/test fallback. The
   * "phone" interactable (group + anchor) is registered identically either way,
   * so the existing click→dial wiring in main.js is unaffected.
   */
  _buildPhone() {
    const phone = new THREE.Group();
    phone.position.set(4.88, 1.4, -1.6); // right wall, front-of-room
    phone.rotation.y = -Math.PI / 2; // face -x (into the room)

    // Player-supplied payphone photo mounted as the wall phone (replaces the
    // landline GLB in the menu). A brushed-steel housing box gives it depth.
    const housing = new THREE.Mesh(
      new THREE.BoxGeometry(0.58, 1.06, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x8a8e92, roughness: 0.5, metalness: 0.55 }),
    );
    phone.add(housing);
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.52, 1.0),
      new THREE.MeshStandardMaterial({ map: this._loadTex("textures/hub_payphone.jpg"), roughness: 0.5, metalness: 0.3 }),
    );
    face.position.set(0, 0, 0.051); // proud of the housing, facing into the room
    phone.add(face);

    this.scene.add(phone);
    this._phoneGroup = phone;
    this._phoneIsModel = true; // payphone panel IS the final visual — no GLB swap
    this._registerInteractable(phone, "phone", "Landline — Dial Code", 2.0);
  }

  /** Orient + parent the landline GLB inside the wall fixture group. */
  _applyLandlineModel(phone, model) {
    // Stand the wall phone upright and present its face into the room.
    model.rotation.set(Math.PI / 2, 0, 0);
    phone.add(model);
  }

  /** Swap the procedural cradle for the landline GLB once it has streamed in. */
  _ensurePhone() {
    if (this._phoneIsModel || !this._phoneGroup) return;
    if (!this.assets || typeof this.assets.getModel !== "function") return;
    const model = this.assets.getModel("landline_phone");
    if (!model) return;
    for (let i = this._phoneGroup.children.length - 1; i >= 0; i--) {
      const c = this._phoneGroup.children[i];
      this._phoneGroup.remove(c);
      c.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) if (m && m.dispose) m.dispose();
        }
      });
    }
    this._applyLandlineModel(this._phoneGroup, model);
    this._phoneIsModel = true;
  }

  /**
   * Procedural wall-phone fixture (fallback): cradle + keypad + handset + cord.
   * Built into a scaled sub-group so it matches the enlarged GLB (~0.85m tall),
   * keeping the GLB path's scaling independent of the group transform.
   */
  _buildPhoneFallback(phone) {
    const fb = new THREE.Group();
    fb.scale.setScalar(1.85); // 0.46m cradle → ~0.85m, matching MODEL_DEFS size
    phone.add(fb);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.6 });
    const cradle = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.46, 0.16), bodyMat);
    fb.add(cradle);

    // A faint amber keypad face so the phone reads as "interactive".
    const keypadMat = new THREE.MeshStandardMaterial({
      color: 0x3a2a12,
      emissive: 0xff7a1a,
      emissiveIntensity: 0.25,
      roughness: 0.5,
    });
    const keypad = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, 0.03), keypadMat);
    keypad.position.set(0, -0.02, 0.09);
    fb.add(keypad);

    // Handset sitting on top of the cradle.
    const handset = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.07, 0.08), bodyMat);
    handset.position.set(0, 0.27, 0.06);
    fb.add(handset);

    // Coiled cord (a thin torus knot stand-in) dangling below.
    const cordMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.9 });
    const cord = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.018, 6, 14), cordMat);
    cord.position.set(0.1, -0.3, 0.05);
    cord.rotation.x = Math.PI / 2;
    fb.add(cord);
  }

  /**
   * Register a clickable fixture + cache its label anchor (world position with a
   * vertical offset). The anchor is fixed because hub fixtures never move.
   * @param {THREE.Object3D} object3D the (group) to raycast against.
   * @param {string} id dispatch id ("start" | "upgrades" | "phone").
   * @param {string} label floating-label text.
   * @param {number} labelY world-space height for the label anchor.
   */
  _registerInteractable(object3D, id, label, labelY) {
    const anchor = new THREE.Vector3();
    object3D.getWorldPosition(anchor);
    anchor.y = labelY;
    this._interactables.push({ object3D, id, label, anchor });
  }

  /**
   * The clickable safehouse fixtures for the orchestrator's raycast + labels.
   * Each entry: `{ object3D, id, label, anchor }` where `anchor` is the fixed
   * world-space point (do NOT mutate it — copy before projecting).
   * @returns {Array<{object3D:THREE.Object3D, id:string, label:string, anchor:THREE.Vector3}>}
   */
  getInteractables() {
    return this._interactables;
  }

  // ---- runtime API ---------------------------------------------------------

  /** Pose the shared camera to the fixed flattering view and mark the hub live. */
  show() {
    this._visible = true;
    this._elapsed = 0;
    this._ensureHeroModel();
    this._ensureNpcs();
    this._ensurePhone();
    this._ensureTableSmg();
    this._poseCamera();
  }

  /**
   * Swap the primitive fallback hero for the real animated menu actor once it has
   * streamed in. No-op if the actor is already shown or still unavailable.
   */
  _ensureHeroModel() {
    if (this._heroIsModel || !this._heroGroup) return;
    if (!this.assets || typeof this.assets.getMenuActor !== "function") return;
    const actor = this.assets.getMenuActor();
    if (!actor) return; // still streaming / unavailable → keep the fallback
    // Drop the fallback primitives, keep the group's transform.
    for (let i = this._heroGroup.children.length - 1; i >= 0; i--) {
      const c = this._heroGroup.children[i];
      this._heroGroup.remove(c);
      c.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) if (m && m.dispose) m.dispose();
        }
      });
    }
    this._attachHeroActor(this._heroGroup, actor);
    this._heroIsModel = true;
  }

  /** Leaving HUB: stop driving the camera. (Restoring it is the orchestrator's job.) */
  hide() {
    this._visible = false;
  }

  /**
   * Copy the base pose into the camera and aim it at the room. The shared camera
   * is parented to the Engine's scene (not this one), so we refresh its world
   * matrix here — the renderer skips that for a parented camera when rendering a
   * different scene, and the Engine's scene is identity so this is always safe.
   */
  _poseCamera() {
    this.camera.position.copy(this._camBase);
    this.camera.lookAt(this._lookTarget);
    this.camera.updateMatrixWorld();
  }

  /**
   * Subtle life: bulb flicker, slow NPC idle bob, and a very slight camera sway
   * around the base pose. No per-frame allocation — a single temp vector is
   * reused and all maths is in-place.
   * @param {number} dt seconds since last frame
   */
  update(dt) {
    if (!this._visible) return;
    if (!this._heroIsModel) this._ensureHeroModel(); // swap in real fighter once loaded
    if (!this._npcsAnimated) this._ensureNpcs(); // swap allies to the animated actor
    if (!this._phoneIsModel) this._ensurePhone(); // swap in the real landline once loaded
    if (!this._tableSmg) this._ensureTableSmg(); // place the table SMG once loaded
    if (!this._barProps || !this._barProps.crt_tv || !this._barProps.thinkpad) this._ensureBarProps();
    this._elapsed += dt;
    const t = this._elapsed;

    // Bulb flicker — mostly steady with a faint shimmer (no random alloc).
    if (this._lamp) {
      const f = 0.9 + 0.1 * Math.sin(t * 9.0) + 0.04 * Math.sin(t * 23.0);
      this._lamp.intensity = this._lampBase * f;
      if (this._bulbMat) this._bulbMat.emissiveIntensity = f;
    }

    // Advance every menu-actor animation (hero idle + ally idle/walk clips).
    for (let i = 0; i < this._mixers.length; i++) this._mixers[i].update(dt);

    // Drive the allies: the patroller walks back and forth (turning to face its
    // travel direction); primitive-fallback figures get a gentle idle bob.
    // (Animated idlers move themselves via their idle clip.)
    for (let i = 0; i < this.npcs.length; i++) {
      const n = this.npcs[i];
      if (n.patrol) {
        const p = n.patrol;
        n.group.position.x += p.dir * p.speed * dt;
        if (n.group.position.x >= p.maxX) {
          n.group.position.x = p.maxX; p.dir = -1; n.group.rotation.y = -Math.PI / 2; // face -X
        } else if (n.group.position.x <= p.minX) {
          n.group.position.x = p.minX; p.dir = 1; n.group.rotation.y = Math.PI / 2; // face +X
        }
      } else if (n.breathing) {
        // Subtle idle breathing on the static figure: a tiny vertical chest-rise
        // (feet stay planted) + a micro-bob, so it reads as alive without a rig.
        const b = 1 + Math.sin(t * 1.3 + n.phase) * 0.014;
        n.group.scale.y = MENU_CHAR_SCALE * b;
        n.group.position.y = n.baseY + (b - 1) * 0.06;
      } else if (!n.mixer) {
        n.group.position.y = n.baseY + Math.sin(t * 1.4 + n.phase) * 0.025;
      }
    }

    // Camera: dolly into the laptop when summoned, hold the seated pose while the
    // shop is open, or run the idle handheld sway around the fixed framing.
    if (this._zooming || this._restoring) {
      const dir = this._zooming ? 1 : -1;
      this._zoomT = THREE.MathUtils.clamp(this._zoomT + (dir * dt) / this._zoomDur, 0, 1);
      const e = smoother(this._zoomT);
      this._tmpV.lerpVectors(this._zoomFrom, this._zoomTo, e);
      this._tmpLook.lerpVectors(this._zoomLookFrom, this._zoomLookTo, e);
      this.camera.fov = THREE.MathUtils.lerp(this._zoomFovFrom, this._zoomFovTo, e);
      this.camera.updateProjectionMatrix();
      this.camera.position.copy(this._tmpV);
      this.camera.lookAt(this._tmpLook);
      this.camera.updateMatrixWorld();
      if (this._zooming && this._zoomT >= 1) {
        this._zooming = false;
        this._atLaptop = true;
        const cb = this._arriveCb; this._arriveCb = null;
        if (cb) cb();
      } else if (this._restoring && this._zoomT <= 0) {
        this._unseat();
      }
      return;
    }
    if (this._atLaptop) {
      // Seated at the screen — hold the pose with a hair of residual breathing.
      this._tmpV.copy(this._zoomTo);
      this._tmpV.x += Math.sin(t * 0.5) * 0.004;
      this._tmpV.y += Math.sin(t * 0.73) * 0.004;
      this.camera.position.copy(this._tmpV);
      this.camera.lookAt(this._zoomLookTo);
      this.camera.updateMatrixWorld();
      return;
    }

    // Very slight handheld-style camera sway around the fixed pose.
    this._tmpV.copy(this._camBase);
    this._tmpV.x += Math.sin(t * 0.5) * 0.03;
    this._tmpV.y += Math.sin(t * 0.73) * 0.02;
    this.camera.position.copy(this._tmpV);
    this.camera.lookAt(this._lookTarget);
    this.camera.updateMatrixWorld(); // parented camera, foreign scene — see _poseCamera
  }

  /**
   * Dolly the shared camera from the idle framing into the open laptop screen
   * and narrow the fov for an optical lean-in. `onArrive` fires once seated (the
   * orchestrator opens the CRT shop overlay there). Honours reduced-motion by
   * snapping straight to the seated pose. No-op if already zooming/seated.
   * @param {Function} [onArrive]
   */
  zoomToLaptop(onArrive) {
    if (this._zooming || this._atLaptop) { if (onArrive) onArrive(); return; }
    this._ensureBarProps(); // make sure the laptop + its screen fit are placed
    const fit = this._laptopFit;
    this._zoomLookTo.copy(fit ? fit.center : new THREE.Vector3(0.40, 1.25, -2.13));
    if (fit) this._zoomTo.copy(fit.center).addScaledVector(fit.normal, 0.62);
    else this._zoomTo.set(0.55, 1.30, -1.52);
    this._zoomFrom.copy(this.camera.position);
    this._zoomLookFrom.copy(this._lookTarget);
    this._zoomFovFrom = this.camera.fov;
    this._arriveCb = onArrive || null;
    this._zoomT = 0;
    if (this._reduceMotion) {
      this._zoomT = 1;
      this._zooming = true; // a single update() tick seats it + fires onArrive
      return;
    }
    this._zooming = true;
  }

  /**
   * Reverse the dolly back to the idle framing + fov. `onDone` fires once the
   * camera is home (the orchestrator re-shows the hub labels there).
   * @param {Function} [onDone]
   */
  restoreCamera(onDone) {
    if (!this._atLaptop && !this._zooming) { if (onDone) onDone(); return; }
    this._restoreCb = onDone || null;
    this._atLaptop = false;
    this._zooming = false;
    this._restoring = true;
    if (this._reduceMotion) this._zoomT = 0; // snap home on the next tick
  }

  /** Finish a restore: clear flags, return the fov, fire the done callback. */
  _unseat() {
    this._restoring = false;
    this._atLaptop = false;
    this._zooming = false;
    this.camera.fov = this._zoomFovFrom || 78;
    this.camera.updateProjectionMatrix();
    const cb = this._restoreCb; this._restoreCb = null;
    if (cb) cb();
  }

  /**
   * Free this hub's geometry and its INLINE materials. Materials borrowed from
   * the AssetManager are shared game-wide and are skipped.
   */
  dispose() {
    // Stop + unbind every menu-actor mixer (hero + allies) before tearing down.
    for (let i = 0; i < this._mixers.length; i++) {
      const m = this._mixers[i];
      m.stopAllAction();
      if (m._root) m.uncacheRoot(m._root);
    }
    this._mixers.length = 0;
    this._heroMixer = null;

    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m && m.dispose && !this._sharedMats.has(m)) m.dispose();
        }
      }
    });
    // Mural textures aren't reached by the geometry/material traverse above.
    for (let i = 0; i < this._muralTextures.length; i++) {
      const t = this._muralTextures[i];
      if (t && t.dispose) t.dispose();
    }
    this._muralTextures.length = 0;

    while (this.scene.children.length) this.scene.remove(this.scene.children[0]);
    this.npcs.length = 0;
    this._interactables.length = 0;
    this._heroGroup = null;
    this._tableSmg = null;
    this._barProps = null;
    this._lamp = null;
    this._bulbMat = null;
  }
}
