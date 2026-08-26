import type * as THREE from 'three/webgpu';

export interface SceneLayer {
  readonly object3d: THREE.Object3D;
  dispose(): void;
}
