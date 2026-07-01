import * as THREE from "three";

/** World-space bounding-box size of `obj` (fresh Box3 each call — not cached). */
export function getObjectSize(obj) {
  return new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
}
