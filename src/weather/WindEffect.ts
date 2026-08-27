import * as THREE from 'three/webgpu';
import type { StationWeather, WeatherStyle } from '../types/weather';
import { worldUnitsPerPixel, type WeatherEffect } from './WeatherEffect';
import { createSeededRandom, projectWorldDirectionToScreen } from './WeatherMath';
import { createWeatherTexture } from './WeatherTextures';

const RIBBON_COUNT = 5;
const RIBBON_SEGMENTS = 36;
const MOTE_COUNT = 30;

interface WindMote {
  phase: number;
  band: number;
  speed: number;
  length: number;
  wave: number;
}

export class WindEffect implements WeatherEffect {
  public readonly object3d = new THREE.Group();
  private readonly field = new THREE.Group();
  private readonly geometry: THREE.BufferGeometry;
  private readonly flowTexture = createWeatherTexture('wind', 128);
  private readonly moteTexture = createWeatherTexture('wind', 64);
  private readonly baseMaterial: THREE.MeshBasicMaterial;
  private readonly flowMaterial: THREE.MeshBasicMaterial;
  private readonly baseMesh: THREE.Mesh;
  private readonly flowMesh: THREE.Mesh;
  private readonly moteGeometry: THREE.PlaneGeometry;
  private readonly moteMaterial: THREE.MeshBasicMaterial;
  private readonly moteMesh: THREE.InstancedMesh;
  private readonly moteProfiles: WindMote[] = [];
  private readonly dummy = new THREE.Object3D();
  private speed = 0;
  private direction = 0;
  private style: WeatherStyle = defaultStyle();

  public constructor(seed: number) {
    this.object3d.name = 'WindEffect';
    this.field.name = 'WindFlowField';
    const random = createSeededRandom(seed);
    this.geometry = createWindFieldGeometry(random);
    this.flowTexture.wrapS = THREE.RepeatWrapping;
    this.flowTexture.repeat.set(1.8, 1);
    this.flowTexture.needsUpdate = true;
    this.baseMaterial = new THREE.MeshBasicMaterial({
      color: '#a9c9ca',
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    this.flowMaterial = new THREE.MeshBasicMaterial({
      map: this.flowTexture,
      color: '#f1faf7',
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    this.baseMesh = new THREE.Mesh(this.geometry, this.baseMaterial);
    this.flowMesh = new THREE.Mesh(this.geometry, this.flowMaterial);
    this.baseMesh.name = 'WindRibbonBase';
    this.flowMesh.name = 'WindRibbonFlow';
    this.baseMesh.renderOrder = 16;
    this.flowMesh.renderOrder = 17;
    this.baseMesh.frustumCulled = false;
    this.flowMesh.frustumCulled = false;
    this.flowMesh.position.z = 0.002;
    this.moteGeometry = new THREE.PlaneGeometry(1, 1);
    this.moteMaterial = new THREE.MeshBasicMaterial({
      map: this.moteTexture,
      color: '#d8ece8',
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      opacity: 0,
    });
    this.moteMesh = new THREE.InstancedMesh(this.moteGeometry, this.moteMaterial, MOTE_COUNT);
    this.moteMesh.name = 'WindMotes';
    this.moteMesh.renderOrder = 18;
    this.moteMesh.frustumCulled = false;
    this.moteMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let index = 0; index < MOTE_COUNT; index += 1) {
      this.moteProfiles.push({
        phase: random(),
        band: (random() - 0.5) * 0.52,
        speed: 0.72 + random() * 0.58,
        length: 0.034 + random() * 0.05,
        wave: random() * Math.PI * 2,
      });
    }
    this.field.add(this.baseMesh, this.flowMesh, this.moteMesh);
    this.object3d.add(this.field);
  }

  public update(weather: StationWeather): void {
    this.speed = Math.max(0, weather.wind?.speed ?? 0);
    this.direction = THREE.MathUtils.degToRad(weather.wind?.direction ?? 0);
    this.object3d.visible = this.speed > 0.01;
  }

  public setStyle(style: WeatherStyle): void {
    this.style = style;
    const speedWeight = THREE.MathUtils.clamp(this.speed / 8, 0.12, 1);
    this.baseMaterial.opacity = (0.18 + speedWeight * 0.16)
      * style.intensity * style.opacity * THREE.MathUtils.clamp(style.windSpeed, 0, 1.4);
    this.flowMaterial.opacity = (0.38 + speedWeight * 0.32)
      * style.intensity * style.opacity * THREE.MathUtils.clamp(style.windSpeed, 0, 1.4);
    this.moteMaterial.opacity = (0.16 + speedWeight * 0.13)
      * style.intensity * style.opacity * THREE.MathUtils.clamp(style.windSpeed, 0, 1.4);
  }

  public tick(_deltaSeconds: number, elapsedSeconds: number, camera: THREE.Camera, viewportHeight: number): void {
    if (!this.object3d.visible) return;
    const unitsPerPixel = worldUnitsPerPixel(this.object3d, camera, viewportHeight);
    const width = THREE.MathUtils.clamp(unitsPerPixel * 94, 0.26, 8.2);
    _worldDirection.set(Math.sin(this.direction), 0, -Math.cos(this.direction));
    projectWorldDirectionToScreen(_worldDirection, camera, _screenDirection);
    const angle = Math.atan2(_screenDirection.y, _screenDirection.x);
    _screenRotation.setFromAxisAngle(_screenNormal, angle);
    this.field.quaternion.copy(camera.quaternion).multiply(_screenRotation);
    this.field.position.set(0, unitsPerPixel * 31, 0);
    this.field.scale.set(width, width, 1);
    this.flowTexture.offset.x = fract(
      -elapsedSeconds * (0.055 + this.speed * 0.012) * Math.max(0.1, this.style.windSpeed),
    );
    for (let index = 0; index < MOTE_COUNT; index += 1) {
      const profile = this.moteProfiles[index];
      const phase = fract(
        elapsedSeconds * (0.075 + this.speed * 0.016)
          * Math.max(0.1, this.style.windSpeed) * profile.speed + profile.phase,
      );
      this.dummy.position.set(
        (phase - 0.5) * 1.04,
        profile.band + Math.sin(phase * Math.PI * 2 + profile.wave) * 0.035,
        0.004,
      );
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(profile.length, 0.006, 1);
      this.dummy.updateMatrix();
      this.moteMesh.setMatrixAt(index, this.dummy.matrix);
    }
    this.moteMesh.instanceMatrix.needsUpdate = true;
  }

  public dispose(): void {
    this.geometry.dispose();
    this.baseMaterial.dispose();
    this.flowMaterial.dispose();
    this.moteGeometry.dispose();
    this.moteMaterial.dispose();
    this.flowTexture.dispose();
    this.moteTexture.dispose();
    this.object3d.clear();
  }
}

function createWindFieldGeometry(random: () => number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let ribbon = 0; ribbon < RIBBON_COUNT; ribbon += 1) {
    const centerY = (ribbon - (RIBBON_COUNT - 1) * 0.5) * 0.105 + (random() - 0.5) * 0.035;
    const span = 0.72 + random() * 0.24;
    const xOffset = (random() - 0.5) * 0.11;
    const amplitude = 0.055 + random() * 0.065;
    const phase = random() * Math.PI * 1.3;
    const bend = (random() - 0.5) * 0.18;
    const width = 0.011 + random() * 0.007;
    const uvOffset = random();
    const sampleY = (t: number): number => (
      centerY
      + Math.sin(t * Math.PI * 1.35 + phase) * amplitude
      + ((t - 0.5) * (t - 0.5) - 0.25) * bend
    );
    for (let segment = 0; segment <= RIBBON_SEGMENTS; segment += 1) {
      const t = segment / RIBBON_SEGMENTS;
      const x = (t - 0.5) * span + xOffset;
      const y = sampleY(t);
      const nextT = Math.min(1, t + 0.01);
      const previousT = Math.max(0, t - 0.01);
      const tangentX = Math.max(0.001, (nextT - previousT) * span);
      const tangentY = sampleY(nextT) - sampleY(previousT);
      const inverseLength = 1 / Math.hypot(tangentX, tangentY);
      const normalX = -tangentY * inverseLength;
      const normalY = tangentX * inverseLength;
      const taper = Math.pow(Math.sin(Math.PI * t), 0.58);
      const halfWidth = width * taper;
      positions.push(
        x + normalX * halfWidth, y + normalY * halfWidth, 0,
        x - normalX * halfWidth, y - normalY * halfWidth, 0,
      );
      uvs.push(t * 1.35 + uvOffset, 0, t * 1.35 + uvOffset, 1);
      if (segment < RIBBON_SEGMENTS) {
        const base = ribbon * (RIBBON_SEGMENTS + 1) * 2 + segment * 2;
        indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function defaultStyle(): WeatherStyle {
  return { enabled: true, intensity: 1, rainDensity: 1, windSpeed: 1, cloudScale: 1, opacity: 1 };
}

function fract(value: number): number {
  return value - Math.floor(value);
}

const _worldDirection = new THREE.Vector3();
const _screenDirection = new THREE.Vector2();
const _screenRotation = new THREE.Quaternion();
const _screenNormal = new THREE.Vector3(0, 0, 1);
