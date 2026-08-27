import * as THREE from 'three/webgpu';

export function createSeededRandom(seed: number): () => number {
  let state = Math.max(1, seed | 0);
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return (state >>> 0) / 4294967296;
  };
}

/** Projects a world-space direction into the camera-facing weather plane. */
export function projectWorldDirectionToScreen(
  worldDirection: THREE.Vector3,
  camera: THREE.Camera,
  target: THREE.Vector2,
): THREE.Vector2 {
  _cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _cameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  target.set(worldDirection.dot(_cameraRight), worldDirection.dot(_cameraUp));
  if (target.lengthSq() < 1e-6) target.set(0, -1);
  return target.normalize();
}

const _cameraRight = new THREE.Vector3();
const _cameraUp = new THREE.Vector3();
