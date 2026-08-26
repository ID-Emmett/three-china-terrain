import * as THREE from 'three/webgpu';
import type { SceneLayer } from '../app/SceneLayer';
import type { TerrainData } from '../terrain/TerrainData';
import { OceanMaterial } from './OceanMaterial';

export class OceanLayer implements SceneLayer {
  public readonly object3d = new THREE.Group();
  public readonly material: OceanMaterial;
  public readonly mesh: THREE.Mesh;

  public constructor(terrain: TerrainData, coastMask: THREE.Texture) {
    this.object3d.name = 'OceanLayer';
    this.material = new OceanMaterial(coastMask);
    const geometry = terrain.createOceanGeometry();
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'StaticOceanSurface';
    this.mesh.position.y = 0;
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = true;
    this.object3d.add(this.mesh);
  }

  public update(elapsedSeconds: number): void {
    this.material.update(elapsedSeconds);
  }

  public dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
