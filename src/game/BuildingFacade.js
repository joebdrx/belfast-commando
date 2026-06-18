/**
 * BuildingFacade
 * --------------
 * Cheap, proportionate facade detailing for building walls: a window grid laid
 * out per storey, a ground-floor door, and a parapet roof cap. The layout math
 * (`planWindows`, `planDoor`) is pure and unit-tested; `buildFacade` turns a plan
 * into flat THREE meshes parented under one Group (caller adds it to the scene).
 *
 * Coordinates: a face is described in its own 2D frame — `u` runs along the wall
 * width (0 = centre), `v` is height above the ground (0 = street). `buildFacade`
 * places that frame at a world `center` (street-level wall midpoint) rotated by
 * `orientationY` so +Z (the plane normal) points out of the building.
 */

/**
 * Lay out a proportionate window grid for a wall face.
 * @param {number} faceW  wall width (m)
 * @param {number} faceH  wall height (m)
 * @param {{storeyH?:number,colW?:number,margin?:number,doorClear?:boolean,doorHalf?:number}} [opts]
 * @returns {{cols:number, rows:number, positions:Array<{u:number,v:number,w:number,h:number}>}}
 */
export function planWindows(faceW, faceH, opts = {}) {
  const { storeyH = 3, colW = 2.2, margin = 0.6, doorClear = true, doorHalf = 0.7, minRow = 0 } = opts;
  const rows = Math.max(0, Math.floor(faceH / storeyH));
  const usableW = faceW - 2 * margin;
  const cols = usableW >= colW ? Math.floor(usableW / colW) : 0;
  const positions = [];
  if (rows === 0 || cols === 0) return { cols, rows, positions };

  const colSpacing = usableW / cols; // even spacing of column centres
  const winW = colW * 0.55;          // fixed window size → doubling width adds columns
  const winH = storeyH * 0.5;
  // minRow skips lower storeys (e.g. a wall whose ground floor has real doors).
  for (let r = Math.max(0, minRow); r < rows; r++) {
    const v = r * storeyH + storeyH * 0.55; // centre height within the storey
    for (let c = 0; c < cols; c++) {
      const u = -usableW / 2 + colSpacing * (c + 0.5);
      // Leave the ground-storey centre clear so the door isn't covered.
      if (doorClear && r === 0 && Math.abs(u) < doorHalf + winW / 2) continue;
      positions.push({ u, v, w: winW, h: winH });
    }
  }
  return { cols, rows, positions };
}

/**
 * A centred ground-floor door, or null if the face is too narrow to hold one.
 * @returns {{u:number,w:number,h:number} | null}
 */
export function planDoor(faceW, faceH, opts = {}) {
  const { doorW = 1.1, doorH = 2.1, margin = 0.3 } = opts;
  if (faceW < doorW + 2 * margin) return null;
  return { u: 0, w: doorW, h: doorH };
}

/**
 * Build the facade meshes for one wall face and return them under a Group.
 * @param {object} THREE  the three module (injected so this stays unit-testable)
 * @param {{glass?:any, glassLit?:any, door?:any, roof?:any}} materials
 * @param {{width:number, height:number, orientationY:number, center:{x:number,y:number,z:number}}} face
 * @param {object} [opts]  forwarded to planWindows/planDoor
 * @returns {object} THREE.Group of window/door/roof-cap meshes
 */
export function buildFacade(THREE, materials, face, opts = {}) {
  const { width, height, orientationY = 0, center } = face;
  const group = new THREE.Group();
  group.position.set(center.x, center.y, center.z);
  group.rotation.y = orientationY;

  const OUT = 0.06; // outward offset so flat detail never z-fights the wall
  const glass = materials.glass || new THREE.MeshStandardMaterial({ color: 0x10141a, roughness: 0.25, metalness: 0.1 });
  const glassLit = materials.glassLit || glass;
  const doorMat = materials.door || new THREE.MeshStandardMaterial({ color: 0x4a3422, roughness: 0.85 });
  const roofMat = materials.roof || new THREE.MeshStandardMaterial({ color: 0x33373b, roughness: 0.9 });

  const door = opts.noDoor ? null : planDoor(width, height, opts);
  const win = planWindows(width, height, { ...opts, doorClear: !!door });

  // Windows — share two geometries by size; ~1 in 4 lit (deterministic by cell).
  const geoCache = new Map();
  const winGeo = (w, h) => {
    const k = `${w.toFixed(3)}x${h.toFixed(3)}`;
    let g = geoCache.get(k);
    if (!g) { g = new THREE.PlaneGeometry(w, h); geoCache.set(k, g); }
    return g;
  };
  win.positions.forEach((p, i) => {
    const lit = i % 4 === 0;
    const m = new THREE.Mesh(winGeo(p.w, p.h), lit ? glassLit : glass);
    m.position.set(p.u, p.v, OUT);
    group.add(m);
  });

  // Ground-floor door.
  if (door) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(door.w, door.h), doorMat);
    m.position.set(door.u, door.h / 2, OUT);
    group.add(m);
  }

  // Parapet roof cap — a thin lip along the top edge to kill the bare wall top.
  // Skipped for walls that already have a pitched roof above them.
  if (!opts.noRoofCap) {
    const capH = 0.45;
    const cap = new THREE.Mesh(new THREE.BoxGeometry(width + 0.2, capH, 0.6), roofMat);
    cap.position.set(0, height - capH / 2, OUT);
    group.add(cap);
  }

  return group;
}
