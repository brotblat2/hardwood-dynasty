import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function mergeStaticMeshes(group: THREE.Group, disposeSource: boolean) {
  const batches = new Map<THREE.Material, THREE.Mesh[][]>();
  for (const child of group.children) {
    if (!(child instanceof THREE.Mesh) || child instanceof THREE.InstancedMesh || Array.isArray(child.material) || child.material.transparent) continue;
    const partitions = batches.get(child.material) ?? [[], [], [], []];
    const flags = Number(child.castShadow) + 2 * Number(child.receiveShadow);
    partitions[flags].push(child);
    batches.set(child.material, partitions);
  }

  for (const [material, partitions] of batches) {
    for (const meshes of partitions) {
      if (meshes.length < 2) continue;
      const transformed = meshes.map((mesh) => {
        mesh.updateMatrix();
        return mesh.geometry.clone().applyMatrix4(mesh.matrix);
      });
      const geometry = mergeGeometries(transformed);
      for (const copy of transformed) copy.dispose();
      if (!geometry) continue;
      const merged = new THREE.Mesh(geometry, material);
      merged.castShadow = meshes[0].castShadow;
      merged.receiveShadow = meshes[0].receiveShadow;
      group.add(merged);
      for (const original of meshes) {
        group.remove(original);
        if (disposeSource) original.geometry.dispose();
      }
    }
  }
}
