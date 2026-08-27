import * as THREE from 'three/webgpu';
import type { StationWeather, WeatherStyle } from '../types/weather';

export interface WeatherEffect {
  readonly object3d: THREE.Object3D;
  update(weather: StationWeather): void;
  setStyle(style: WeatherStyle): void;
  tick(deltaSeconds: number, elapsedSeconds: number, camera: THREE.Camera, viewportHeight: number): void;
  dispose(): void;
}

export function worldUnitsPerPixel(
  object: THREE.Object3D,
  camera: THREE.Camera,
  viewportHeight: number,
): number {
  if (!(camera instanceof THREE.PerspectiveCamera)) return 0.01;
  const distance = object.getWorldPosition(_worldPosition).distanceTo(camera.position);
  const perspective = camera;
  return distance * 2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov) * 0.5)
    / Math.max(1, viewportHeight);
}

const _worldPosition = new THREE.Vector3();
