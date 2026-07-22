import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { instanceStaticMeshes, measureMeshSubmissions } from "../src/game/StaticInstancing.js";

function box(material, x) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), material);
  mesh.position.x = x;
  return mesh;
}

describe("instanceStaticMeshes", () => {
  it("instances separately-created byte-identical static meshes", () => {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: 0x445566 });
    root.add(box(material, -4), box(material, 0), box(material, 4));

    const result = instanceStaticMeshes(root);
    const batches = root.children.filter((child) => child.isInstancedMesh);

    expect(result.before.drawCalls).toBe(3);
    expect(result.after.drawCalls).toBe(1);
    expect(result.drawCallsSaved).toBe(2);
    expect(result.instances).toBe(3);
    expect(batches).toHaveLength(1);
    expect(batches[0].count).toBe(3);
    expect(result.after.triangles).toBe(result.before.triangles);
  });

  it("never batches descendants of gameplay-owned roots", () => {
    const root = new THREE.Group();
    const dynamic = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const movingA = box(material, 0);
    const movingB = box(material, 2);
    dynamic.add(movingA, movingB);
    root.add(dynamic, box(material, 4), box(material, 6));

    instanceStaticMeshes(root, { excludeRoots: [dynamic] });

    expect(dynamic.children).toEqual([movingA, movingB]);
    expect(root.children.some((child) => child.isInstancedMesh)).toBe(true);
    expect(measureMeshSubmissions(root).triangles).toBe(48);
  });

  it("does not combine transparent meshes because order affects blending", () => {
    const root = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 });
    root.add(box(material, 0), box(material, 2));

    const result = instanceStaticMeshes(root);

    expect(result.batches).toBe(0);
    expect(result.after.drawCalls).toBe(2);
  });
});
