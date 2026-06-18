import * as THREE from "three";

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
 * (IRA, green armband) and Davy (Ulster-Scots, orange armband).
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

    // Clickable safehouse fixtures + their projected-label anchors (world space).
    // Anchors are fixed (the fixtures never move; only the camera sways), so they
    // are computed once at build time and projected each frame with no alloc.
    /** @type {Array<{object3D:THREE.Object3D, id:string, label:string, anchor:THREE.Vector3}>} */
    this._interactables = [];

    // Lobby framing (CoD-style): camera sits front-left and looks slightly left
    // into the room so the hero fighter — placed on the RIGHT — reads large in
    // the right portion of the frame, leaving the left for the menu panel.
    this._camBase = new THREE.Vector3(-0.6, 1.5, 2.7);
    this._lookTarget = new THREE.Vector3(-0.45, 1.12, -2.4);
    this._tmpV = new THREE.Vector3(); // reused each frame — no per-frame alloc
    this._elapsed = 0;
    this._visible = false;

    this._buildAtmosphere();
    this._buildShell();
    this._buildBar();
    this._buildMapTable();
    this._buildBulb();
    this._buildCrates();
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
    const wall = this._mat("brick", 0x6e3b2e, 0.95);
    const floorMat = this._mat("concrete", 0x44484c, 0.95);
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

  /** A long pub bar counter against the back wall, with a few bottles. */
  _buildBar() {
    const wood = this._mat("crate", 0x3f2a18, 0.8);
    const topMat = this._mat("door", 0x5a3a22, 0.6);
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
  }

  /** The planning table: wooden top + legs, a parchment map and a couple of pins. */
  _buildMapTable() {
    const topMat = this._mat("crate", 0x4a3320, 0.82);
    const tableTopY = 0.95;
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

    // Two red objective pins + an accent route line — the operation board look.
    const pinMat = new THREE.MeshStandardMaterial({
      color: 0xc0392b,
      roughness: 0.5,
      emissive: 0xc0392b,
      emissiveIntensity: 0.25,
    });
    for (const [px, pz] of [[-0.4, -0.2], [0.45, 0.25]]) {
      const pin = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), pinMat);
      pin.position.set(px, tableTopY + 0.09, -2.3 + pz);
      this.scene.add(pin);
    }
    const routeMat = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6 });
    const route = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.006, 0.02), routeMat);
    route.position.set(0.02, tableTopY + 0.065, -2.25);
    route.rotation.y = 0.5;
    this.scene.add(route);
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
    this._registerInteractable(armory, "upgrades", "Armory", 1.15);
  }

  /**
   * Build the two ally NPCs. When the animated menu actor is available BOTH are
   * the SAME rigged model (mirroring the hero): Ruairí (IRA, green armband) idles
   * at the table, while Davy (Ulster-Scots, orange armband) slowly patrols a short
   * back-and-forth path behind the table, turning to face his travel direction.
   * If the actor is unavailable (headless / tests / not yet streamed) each falls
   * back to the original low-poly capsule figure with a gentle idle bob.
   */
  _buildNpcs() {
    // Ruairí — IRA fighter, olive-green coat, green armband, dark flat cap. Idles.
    this._buildNpc({
      x: -2.4,
      z: -3.3,
      yaw: 0.32,
      coat: 0x3c4a32,
      band: 0x2f9e44,
      hat: "cap",
      hatColor: 0x1c2018,
    });
    // Davy — Ulster-Scots paramilitary, rust coat, orange armband, maroon beret.
    // Patrols a short path behind the table (clear of the hero + camera).
    this._buildNpc({
      x: 2.4,
      z: -3.3,
      yaw: -0.32,
      coat: 0x5a3a22,
      band: 0xe07b1a,
      hat: "beret",
      hatColor: 0x5a1f24,
      patrol: { minX: 1.2, maxX: 3.0, z: -3.7, speed: 0.55, dir: 1 },
    });
    // True once the allies are the animated actor (vs. the capsule fallback).
    this._npcsAnimated = !!(this.assets && typeof this.assets.hasMenuActor === "function" && this.assets.hasMenuActor());
  }

  /**
   * One ally figure. Prefers the shared animated menu actor (idle, or walk while
   * patrolling); falls back to the inline capsule fighter so the hub still reads
   * headless. A small emissive faction armband is added as a subtle accent.
   */
  _buildNpc(cfg) {
    const actor = this.assets && typeof this.assets.getMenuActor === "function"
      ? this.assets.getMenuActor()
      : null;
    if (actor) this._buildAnimatedNpc(cfg, actor);
    else this._buildCapsuleNpc(cfg);
  }

  /** Animated ally: the shared rigged actor + a faction armband accent. */
  _buildAnimatedNpc({ x, z, yaw, band, patrol }, actor) {
    const group = new THREE.Group();
    group.add(actor.object3D);

    // Faction armband — a faintly emissive ring at chest height (subtle accent
    // that rides with the body group; not bound to the animating arm bone).
    const bandMat = new THREE.MeshStandardMaterial({
      color: band,
      roughness: 0.5,
      emissive: band,
      emissiveIntensity: 0.2,
    });
    const armband = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.035, 8, 16), bandMat);
    armband.position.y = 1.3;
    armband.rotation.x = Math.PI / 2;
    group.add(armband);

    // Patroller walks (and faces its travel direction); idler stands and fidgets.
    const clip = patrol ? (actor.clips.walk || actor.clips.idle) : (actor.clips.idle || actor.clips.walk);
    const mixer = this._playActorClip(actor.object3D, clip);

    if (patrol) {
      group.position.set(patrol.minX, 0, patrol.z);
      group.rotation.y = Math.PI / 2; // rig front is +Z → face +X (start dir = +1)
    } else {
      group.position.set(x, 0, z);
      group.rotation.y = yaw;
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
  _buildCapsuleNpc({ x, z, yaw, coat, band, hat, hatColor }) {
    const group = new THREE.Group();

    const coatMat = new THREE.MeshStandardMaterial({ color: coat, roughness: 0.85 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.9, 6, 12), coatMat);
    body.position.y = 1.0;
    group.add(body);

    const skinMat = new THREE.MeshStandardMaterial({ color: 0xc99a73, roughness: 0.7 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), skinMat);
    head.position.y = 1.72;
    group.add(head);

    // Faction armband — a faintly emissive ring so the colour reads in the gloom.
    const bandMat = new THREE.MeshStandardMaterial({
      color: band,
      roughness: 0.5,
      emissive: band,
      emissiveIntensity: 0.2,
    });
    const armband = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.055, 8, 16), bandMat);
    armband.position.y = 1.32;
    armband.rotation.x = Math.PI / 2;
    group.add(armband);

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
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.55, metalness: 0.4 });

    // Frame (slightly larger box) + recessed slab.
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.7, 0.16), frameMat);
    frame.position.y = 1.35;
    door.add(frame);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(1.25, 2.45, 0.1), slabMat);
    slab.position.set(0, 1.25, 0.06);
    door.add(slab);

    // Push-bar + a riveted reinforcement strip.
    const barMat = new THREE.MeshStandardMaterial({ color: 0x6a6e73, roughness: 0.4, metalness: 0.6 });
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.1, 0.08), barMat);
    bar.position.set(0, 1.15, 0.13);
    door.add(bar);

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

    const model = this.assets && typeof this.assets.getModel === "function"
      ? this.assets.getModel("landline_phone")
      : null;
    if (model) this._applyLandlineModel(phone, model);
    else this._buildPhoneFallback(phone);

    this.scene.add(phone);
    this._phoneGroup = phone;
    // Hub is usually built before the GLB streams in → starts as the procedural
    // cradle; `_ensurePhone()` (show()/update()) swaps the real model in later.
    this._phoneIsModel = !!model;
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

  /** Procedural wall-phone fixture (fallback): cradle + keypad + handset + cord. */
  _buildPhoneFallback(phone) {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.6 });
    const cradle = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.46, 0.16), bodyMat);
    phone.add(cradle);

    // A faint amber keypad face so the phone reads as "interactive".
    const keypadMat = new THREE.MeshStandardMaterial({
      color: 0x3a2a12,
      emissive: 0xff7a1a,
      emissiveIntensity: 0.25,
      roughness: 0.5,
    });
    const keypad = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, 0.03), keypadMat);
    keypad.position.set(0, -0.02, 0.09);
    phone.add(keypad);

    // Handset sitting on top of the cradle.
    const handset = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.07, 0.08), bodyMat);
    handset.position.set(0, 0.27, 0.06);
    phone.add(handset);

    // Coiled cord (a thin torus knot stand-in) dangling below.
    const cordMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.9 });
    const cord = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.018, 6, 14), cordMat);
    cord.position.set(0.1, -0.3, 0.05);
    cord.rotation.x = Math.PI / 2;
    phone.add(cord);
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
      } else if (!n.mixer) {
        n.group.position.y = n.baseY + Math.sin(t * 1.4 + n.phase) * 0.025;
      }
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
    while (this.scene.children.length) this.scene.remove(this.scene.children[0]);
    this.npcs.length = 0;
    this._interactables.length = 0;
    this._heroGroup = null;
    this._lamp = null;
    this._bulbMat = null;
  }
}
