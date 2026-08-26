import * as THREE from 'three/webgpu';
import {
  color,
  dot,
  float,
  mix,
  mx_fractal_noise_float,
  positionLocal,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import type { SceneLayer } from '../app/SceneLayer';

export class AtmosphereLayer implements SceneLayer {
  public readonly object3d = new THREE.Group();
  public readonly sunDirection = new THREE.Vector3();
  private readonly skyMaterial = new THREE.MeshBasicNodeMaterial({
    side: THREE.BackSide,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  private readonly sky = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), this.skyMaterial);
  private readonly sunLight = new THREE.DirectionalLight('#fff1d1', 2.1);
  private readonly hemisphereLight = new THREE.HemisphereLight('#bcd6dc', '#18231f', 1.15);
  private readonly sunNode = uniform(new THREE.Vector3());
  private readonly hazeNode = uniform(new THREE.Color('#819399'));

  public constructor() {
    this.object3d.name = 'AtmosphereLayer';
    this.sky.name = 'TSLSkyDome';
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    const direction = positionLocal.normalize();
    const lowerAtmosphere = mix(
      this.hazeNode,
      color('#132832'),
      smoothstep(-0.42, 0.13, direction.y),
    );
    const sky = mix(
      lowerAtmosphere,
      color('#03090e'),
      smoothstep(-0.02, 0.88, direction.y),
    );
    // A static, low-contrast veil breaks the perfectly smooth horizon without
    // introducing texture downloads or noticeable moving cloud patterns.
    const cloudNoise = mx_fractal_noise_float(direction.mul(3.2)).mul(0.5).add(0.5);
    const cloudBand = smoothstep(-0.04, 0.16, direction.y)
      .mul(float(1).sub(smoothstep(0.31, 0.52, direction.y)));
    const cloudVeil = smoothstep(0.57, 0.74, cloudNoise).mul(cloudBand).mul(0.075);
    const sunDot = dot(direction, this.sunNode.normalize()).clamp(0, 1);
    const sunGlow = sunDot.pow(8).mul(0.068).add(sunDot.pow(64).mul(0.16));
    this.skyMaterial.colorNode = mix(sky, color('#52656a'), cloudVeil)
      .add(vec3(0.88, 0.42, 0.15).mul(sunGlow));
    this.object3d.add(this.sky, this.sunLight, this.hemisphereLight);
    this.setSun(126, 34);
  }

  public setSun(azimuthDegrees: number, elevationDegrees: number): void {
    const azimuth = THREE.MathUtils.degToRad(azimuthDegrees);
    const elevation = THREE.MathUtils.degToRad(elevationDegrees);
    this.sunDirection.setFromSphericalCoords(1, Math.PI / 2 - elevation, azimuth).normalize();
    this.sunNode.value.copy(this.sunDirection);
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(120);
  }

  public setSunIntensity(value: number): void {
    this.sunLight.intensity = value;
  }

  public setAmbientIntensity(value: number): void {
    this.hemisphereLight.intensity = value;
  }

  public setHazeColor(value: string): void {
    this.hazeNode.value.set(value);
  }

  public dispose(): void {
    this.sky.geometry.dispose();
    this.skyMaterial.dispose();
  }
}
