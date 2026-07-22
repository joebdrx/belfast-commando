import * as THREE from "three";

/** Cache byte signatures because a shared GLB geometry may appear hundreds of times. */
const GEOMETRY_SIGNATURES = new WeakMap();

function hashBytes(bytes, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function attributeSignature(attribute) {
  const array = attribute.array;
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  const h1 = hashBytes(bytes, 0x811c9dc5).toString(36);
  const h2 = hashBytes(bytes, 0x9e3779b9).toString(36);
  return `${array.constructor.name}:${attribute.itemSize}:${attribute.normalized ? 1 : 0}:${array.length}:${h1}:${h2}`;
}

/**
 * Content signature, rather than UUID, lets separately-created but byte-identical
 * BoxGeometry/PlaneGeometry instances share one InstancedMesh safely.
 */
function geometrySignature(geometry) {
  const cached = GEOMETRY_SIGNATURES.get(geometry);
  if (cached) return cached;

  const attrs = Object.keys(geometry.attributes).sort()
    .map((name) => `${name}=${attributeSignature(geometry.attributes[name])}`)
    .join("|");
  const index = geometry.index ? attributeSignature(geometry.index) : "none";
  const groups = geometry.groups.map((g) => `${g.start}:${g.count}:${g.materialIndex}`).join(",");
  const signature = `${geometry.type}|${index}|${attrs}|${groups}|${geometry.drawRange.start}:${geometry.drawRange.count}`;
  GEOMETRY_SIGNATURES.set(geometry, signature);
  return signature;
}

function hasExcludedAncestor(object, excludedRoots) {
  for (let node = object; node; node = node.parent) {
    if (excludedRoots.has(node)) return true;
  }
  return false;
}

function isBatchable(mesh, excludedRoots) {
  if (!mesh.isMesh || mesh.isSkinnedMesh || mesh.isInstancedMesh) return false;
  if (!mesh.visible || !mesh.geometry || !mesh.geometry.attributes.position) return false;
  if (!mesh.material || Array.isArray(mesh.material)) return false;
  if (mesh.material.transparent || mesh.material.opacity < 1) return false;
  if (mesh.children.length || hasExcludedAncestor(mesh, excludedRoots)) return false;
  if (Object.keys(mesh.geometry.morphAttributes).length) return false;
  if (mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) return false;
  return true;
}

/**
 * Approximate renderer submission statistics for opaque/transparent Mesh objects.
 * Triangles account for InstancedMesh.count; points and lines are intentionally
 * outside this level-geometry metric.
 */
export function measureMeshSubmissions(root) {
  const geometries = new Set();
  const materials = new Set();
  const stats = { meshes: 0, drawCalls: 0, triangles: 0, geometries: 0, materials: 0 };
  root.traverse((object) => {
    if (!object.isMesh || !object.visible || !object.geometry) return;
    stats.meshes++;
    geometries.add(object.geometry);
    const mats = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of mats) if (material) materials.add(material);
    const calls = Array.isArray(object.material)
      ? Math.max(1, object.geometry.groups.length)
      : 1;
    stats.drawCalls += calls;
    const elements = object.geometry.index
      ? object.geometry.index.count
      : object.geometry.attributes.position?.count || 0;
    const instances = object.isInstancedMesh ? object.count : 1;
    stats.triangles += Math.floor(elements / 3) * instances;
  });
  stats.geometries = geometries.size;
  stats.materials = materials.size;
  return stats;
}

/**
 * Replace repeated, immutable scene meshes with InstancedMeshes.
 *
 * Only byte-identical opaque geometry/material pairs are eligible. Callers pass
 * every movable/interactable root in `excludeRoots`, so batching never changes
 * gameplay ownership or collision logic.
 */
export function instanceStaticMeshes(root, { excludeRoots = [], minInstances = 2 } = {}) {
  const excluded = new Set(excludeRoots.filter(Boolean));
  const before = measureMeshSubmissions(root);
  const buckets = new Map();

  root.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  root.traverse((mesh) => {
    if (!isBatchable(mesh, excluded)) return;
    const key = [
      geometrySignature(mesh.geometry),
      mesh.material.uuid,
      mesh.castShadow ? 1 : 0,
      mesh.receiveShadow ? 1 : 0,
      mesh.renderOrder,
      mesh.layers.mask,
    ].join(";");
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { meshes: [], geometry: mesh.geometry, material: mesh.material, exemplar: mesh };
      buckets.set(key, bucket);
    }
    bucket.meshes.push(mesh);
  });

  let batches = 0;
  let instances = 0;
  const localMatrix = new THREE.Matrix4();
  for (const bucket of buckets.values()) {
    if (bucket.meshes.length < minInstances) continue;
    const exemplar = bucket.exemplar;
    const batch = new THREE.InstancedMesh(bucket.geometry, bucket.material, bucket.meshes.length);
    batch.name = `static-batch:${bucket.geometry.type}:${bucket.meshes.length}`;
    batch.castShadow = exemplar.castShadow;
    batch.receiveShadow = exemplar.receiveShadow;
    batch.renderOrder = exemplar.renderOrder;
    batch.layers.mask = exemplar.layers.mask;
    batch.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    batch.userData.staticBatch = true;

    bucket.meshes.forEach((mesh, index) => {
      localMatrix.multiplyMatrices(rootInverse, mesh.matrixWorld);
      batch.setMatrixAt(index, localMatrix);
    });
    batch.instanceMatrix.needsUpdate = true;
    batch.computeBoundingBox();
    batch.computeBoundingSphere();

    for (const mesh of bucket.meshes) mesh.removeFromParent();
    root.add(batch);
    batches++;
    instances += bucket.meshes.length;
  }

  const after = measureMeshSubmissions(root);
  return {
    before,
    after,
    batches,
    instances,
    drawCallsSaved: before.drawCalls - after.drawCalls,
  };
}
