import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { projectQuadRect } from "../src/game/Hub.js";

// The black-market overlay is laid over the laptop lid using this projection.
// The dolly seats the camera ON the screen's normal, looking at its centre, so a
// head-on quad must project to a centred rect whose aspect matches the quad.
describe("projectQuadRect", () => {
  const VW = 1920, VH = 1080;

  function camOnNormal(center, normal, dist) {
    const cam = new THREE.PerspectiveCamera(34, VW / VH, 0.1, 100);
    cam.position.copy(center).addScaledVector(normal, dist);
    cam.lookAt(center);
    cam.updateMatrixWorld();
    return cam;
  }

  it("projects a head-on quad to a centred rect with the quad's aspect", () => {
    const center = new THREE.Vector3(0.4, 1.25, -2.13);
    const quat = new THREE.Quaternion(); // identity → plane faces +Z, normal = +Z
    const normal = new THREE.Vector3(0, 0, 1);
    const w = 0.55, h = 0.31; // laptop lid dims (aspect ~1.77)
    const cam = camOnNormal(center, normal, 0.62);

    const r = projectQuadRect(cam, center, quat, w, h, VW, VH);

    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    // Centred in the viewport (camera looks straight down the normal at centre).
    expect(r.left + r.width / 2).toBeCloseTo(VW / 2, 0);
    expect(r.top + r.height / 2).toBeCloseTo(VH / 2, 0);
    // On-screen aspect matches the quad's (no y-flip / axis mixups).
    expect(r.width / r.height).toBeCloseTo(w / h, 1);
  });

  it("grows the rect as the camera dollies closer", () => {
    const center = new THREE.Vector3(0, 1, -2);
    const quat = new THREE.Quaternion();
    const normal = new THREE.Vector3(0, 0, 1);
    const far = projectQuadRect(camOnNormal(center, normal, 1.2), center, quat, 0.55, 0.31, VW, VH);
    const near = projectQuadRect(camOnNormal(center, normal, 0.62), center, quat, 0.55, 0.31, VW, VH);
    expect(near.width).toBeGreaterThan(far.width);
  });
});
