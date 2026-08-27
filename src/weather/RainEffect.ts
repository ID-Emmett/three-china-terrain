import * as THREE from 'three/webgpu';
import type { StationWeather, WeatherStyle } from '../types/weather';
import { worldUnitsPerPixel, type WeatherEffect } from './WeatherEffect';
import { createSeededRandom, projectWorldDirectionToScreen } from './WeatherMath';
import { createWeatherTexture } from './WeatherTextures';

interface RainProfile {
  across: number;
  phase: number;
  speed: number;
  length: number;
  wobble: number;
}

interface RainLayer {
  mesh: THREE.InstancedMesh;
  profiles: RainProfile[];
  maximumCount: number;
  lengthPixels: number;
  thicknessPixels: number;
  speedScale: number;
  depthPixels: number;
}

export class RainEffect implements WeatherEffect {
  public readonly object3d = new THREE.Group();
  private readonly streakTexture = createWeatherTexture('rain', 64);
  private readonly mistTexture = createWeatherTexture('mist', 128);
  private readonly layers: RainLayer[];
  private readonly mist: THREE.Sprite;
  private readonly groundMist: THREE.Sprite;
  private readonly dummy = new THREE.Object3D();
  private precipitation = 0;
  private windSpeed = 0;
  private windDirection = 0;
  private style: WeatherStyle = defaultStyle();

  public constructor(seed: number) {
    this.object3d.name = 'RainEffect';
    const random = createSeededRandom(seed);
    this.layers = [
      this.createLayer('RainCurtainFar', 112, '#94c7d2', 15, 11, 0.72, 0.82, -1.2, random),
      this.createLayer('RainCurtainNear', 38, '#d2f0f2', 17, 18, 1.08, 1.12, 1.4, random),
    ];
    const mistMaterial = new THREE.SpriteMaterial({
      map: this.mistTexture,
      color: '#7d999c',
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      opacity: 0,
    });
    this.mist = new THREE.Sprite(mistMaterial);
    this.mist.name = 'RainMist';
    this.mist.renderOrder = 14;
    this.object3d.add(this.mist);
    const groundMistMaterial = new THREE.SpriteMaterial({
      map: this.mistTexture,
      color: '#8eb3b6',
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      opacity: 0,
    });
    this.groundMist = new THREE.Sprite(groundMistMaterial);
    this.groundMist.name = 'RainGroundSpray';
    this.groundMist.renderOrder = 16;
    this.object3d.add(this.groundMist);
  }

  public update(weather: StationWeather): void {
    this.precipitation = THREE.MathUtils.clamp(weather.precipitation ?? 0, 0, 1);
    this.windSpeed = Math.max(0, weather.wind?.speed ?? 0);
    this.windDirection = THREE.MathUtils.degToRad(weather.wind?.direction ?? 0);
    this.object3d.visible = this.precipitation > 0.01;
  }

  public setStyle(style: WeatherStyle): void {
    this.style = style;
    const density = THREE.MathUtils.clamp(this.precipitation * style.rainDensity, 0, 1);
    for (const layer of this.layers) layer.mesh.count = Math.ceil(layer.maximumCount * density);
    const farOpacity = (0.35 + this.precipitation * 0.3) * style.intensity * style.opacity;
    const nearOpacity = (0.55 + this.precipitation * 0.4) * style.intensity * style.opacity;
    (this.layers[0].mesh.material as THREE.MeshBasicMaterial).opacity = farOpacity;
    (this.layers[1].mesh.material as THREE.MeshBasicMaterial).opacity = nearOpacity;
    (this.mist.material as THREE.SpriteMaterial).opacity = (0.08 + this.precipitation * 0.12)
      * style.intensity * style.opacity;
    (this.groundMist.material as THREE.SpriteMaterial).opacity = (0.055 + this.precipitation * 0.11)
      * style.intensity * style.opacity;
  }

  public tick(_deltaSeconds: number, elapsedSeconds: number, camera: THREE.Camera, viewportHeight: number): void {
    if (!this.object3d.visible) return;
    const unitsPerPixel = worldUnitsPerPixel(this.object3d, camera, viewportHeight);
    const fieldWidth = THREE.MathUtils.clamp(unitsPerPixel * 72, 0.22, 6.5);
    const fieldHeight = THREE.MathUtils.clamp(unitsPerPixel * 88, 0.28, 8.2);
    const windTilt = THREE.MathUtils.clamp(this.windSpeed * this.style.windSpeed / 18, 0, 0.42);
    _fallDirection.set(
      Math.sin(this.windDirection) * windTilt,
      -1,
      -Math.cos(this.windDirection) * windTilt,
    ).normalize();
    projectWorldDirectionToScreen(_fallDirection, camera, _screenDirection);
    const angle = Math.atan2(_screenDirection.y, _screenDirection.x);
    const perpendicularX = -_screenDirection.y;
    const perpendicularY = _screenDirection.x;

    for (const layer of this.layers) {
      layer.mesh.quaternion.copy(camera.quaternion);
      for (let index = 0; index < layer.mesh.count; index += 1) {
        const profile = layer.profiles[index];
        const phase = fract(
          elapsedSeconds * (0.72 + this.precipitation * 0.34)
            * layer.speedScale * profile.speed * (0.82 + this.style.windSpeed * 0.18)
            + profile.phase,
        );
        const across = (profile.across - 0.5) * fieldWidth;
        const travel = phase * fieldHeight;
        const wobble = Math.sin(elapsedSeconds * 1.7 + profile.wobble) * unitsPerPixel * 0.55;
        this.dummy.position.set(
          across * perpendicularX + travel * _screenDirection.x + wobble * perpendicularX,
          fieldHeight * 0.68 + across * perpendicularY * 0.12 + travel * _screenDirection.y,
          unitsPerPixel * layer.depthPixels,
        );
        this.dummy.rotation.set(0, 0, angle);
        this.dummy.scale.set(
          unitsPerPixel * layer.lengthPixels * profile.length,
          unitsPerPixel * layer.thicknessPixels,
          1,
        );
        this.dummy.updateMatrix();
        layer.mesh.setMatrixAt(index, this.dummy.matrix);
      }
      layer.mesh.instanceMatrix.needsUpdate = true;
    }

    this.mist.position.set(0, unitsPerPixel * 37, -unitsPerPixel * 1.5);
    this.mist.scale.set(unitsPerPixel * 76, unitsPerPixel * 82, 1);
    this.groundMist.position.set(0, unitsPerPixel * 6, unitsPerPixel * 0.5);
    this.groundMist.scale.set(unitsPerPixel * 66, unitsPerPixel * 18, 1);
  }

  public dispose(): void {
    for (const layer of this.layers) {
      layer.mesh.geometry.dispose();
      (layer.mesh.material as THREE.MeshBasicMaterial).dispose();
    }
    (this.mist.material as THREE.SpriteMaterial).dispose();
    (this.groundMist.material as THREE.SpriteMaterial).dispose();
    this.streakTexture.dispose();
    this.mistTexture.dispose();
    this.object3d.clear();
  }

  private createLayer(
    name: string,
    count: number,
    color: string,
    renderOrder: number,
    lengthPixels: number,
    thicknessPixels: number,
    speedScale: number,
    depthPixels: number,
    random: () => number,
  ): RainLayer {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      map: this.streakTexture,
      color,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      opacity: 0,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = name;
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const profiles: RainProfile[] = [];
    for (let index = 0; index < count; index += 1) {
      profiles.push({
        across: random(),
        phase: random(),
        speed: 0.72 + random() * 0.62,
        length: 0.58 + random() * 0.78,
        wobble: random() * Math.PI * 2,
      });
    }
    this.object3d.add(mesh);
    return { mesh, profiles, maximumCount: count, lengthPixels, thicknessPixels, speedScale, depthPixels };
  }
}

function defaultStyle(): WeatherStyle {
  return { enabled: true, intensity: 1, rainDensity: 1, windSpeed: 1, cloudScale: 1, opacity: 1 };
}

function fract(value: number): number {
  return value - Math.floor(value);
}

const _fallDirection = new THREE.Vector3();
const _screenDirection = new THREE.Vector2();
