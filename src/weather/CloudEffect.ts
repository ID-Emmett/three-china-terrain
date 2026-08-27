import * as THREE from 'three/webgpu';
import type { StationWeather, WeatherStyle } from '../types/weather';
import { worldUnitsPerPixel, type WeatherEffect } from './WeatherEffect';
import { createSeededRandom } from './WeatherMath';
import { createCloudVolumeTexture } from './WeatherTextures';

interface CloudPuff {
  body: THREE.Sprite;
  shadow: THREE.Sprite;
  offsetX: number;
  offsetY: number;
  scale: number;
  phase: number;
}

const PUFF_COUNT = 3;

export class CloudEffect implements WeatherEffect {
  public readonly object3d = new THREE.Group();
  private readonly field = new THREE.Group();
  private readonly textures: THREE.DataTexture[] = [];
  private readonly puffs: CloudPuff[] = [];
  private cover = 0;
  private style: WeatherStyle = defaultStyle();

  public constructor(seed: number) {
    this.object3d.name = 'CloudEffect';
    this.field.name = 'CloudField';
    this.object3d.add(this.field);
    const random = createSeededRandom(seed);
    for (let index = 0; index < PUFF_COUNT; index += 1) {
      const texture = createCloudVolumeTexture(seed + index * 149, index);
      const bodyMaterial = new THREE.SpriteMaterial({
        map: texture,
        color: '#ffffff',
        transparent: true,
        depthTest: true,
        depthWrite: false,
        toneMapped: true,
        alphaTest: 0.018,
      });
      const shadowMaterial = new THREE.SpriteMaterial({
        map: texture,
        color: '#526566',
        transparent: true,
        depthTest: true,
        depthWrite: false,
        toneMapped: true,
        alphaTest: 0.012,
      });
      const shadow = new THREE.Sprite(shadowMaterial);
      const body = new THREE.Sprite(bodyMaterial);
      shadow.renderOrder = 14;
      body.renderOrder = 15 + index;
      this.field.add(shadow, body);
      this.textures.push(texture);
      this.puffs.push({
        body,
        shadow,
        offsetX: (index - 1) * 0.37 + (random() - 0.5) * 0.1,
        offsetY: (index === 1 ? 0.16 : -0.02) + (random() - 0.5) * 0.12,
        scale: (index === 1 ? 1.04 : 0.84) + random() * 0.18,
        phase: random() * Math.PI * 2,
      });
    }
  }

  public update(weather: StationWeather): void {
    this.cover = THREE.MathUtils.clamp(weather.cloudCover ?? 0, 0, 1);
    const visibleCount = Math.ceil(this.cover * PUFF_COUNT);
    this.puffs.forEach((puff, index) => {
      puff.body.visible = index < visibleCount;
      puff.shadow.visible = index < visibleCount;
    });
  }

  public setStyle(style: WeatherStyle): void {
    this.style = style;
    const bodyOpacity = THREE.MathUtils.clamp(
      (0.78 + this.cover * 0.2) * style.opacity * (0.85 + style.intensity * 0.15),
      0,
      0.94,
    );
    for (const puff of this.puffs) {
      (puff.body.material as THREE.SpriteMaterial).opacity = bodyOpacity;
      (puff.shadow.material as THREE.SpriteMaterial).opacity = bodyOpacity * 0.16;
    }
  }

  public tick(_deltaSeconds: number, elapsedSeconds: number, camera: THREE.Camera, viewportHeight: number): void {
    if (this.cover <= 0 || !this.object3d.visible) return;
    const unitsPerPixel = worldUnitsPerPixel(this.object3d, camera, viewportHeight);
    const puffWidth = THREE.MathUtils.clamp(unitsPerPixel * 60 * this.style.cloudScale, 0.18, 6.2);
    const baseHeight = unitsPerPixel * 48;
    this.field.quaternion.copy(camera.quaternion);
    for (const puff of this.puffs) {
      const drift = Math.sin(elapsedSeconds * 0.11 + puff.phase) * unitsPerPixel * 3.5;
      const x = puff.offsetX * puffWidth + drift;
      const y = baseHeight + puff.offsetY * puffWidth
        + Math.sin(elapsedSeconds * 0.16 + puff.phase) * unitsPerPixel * 1.4;
      const width = puffWidth * puff.scale;
      const height = width * 0.58;
      puff.body.position.set(x, y, 0);
      puff.body.scale.set(width, height, 1);
      puff.shadow.position.set(x + unitsPerPixel * 2.2, y - unitsPerPixel * 3.2, -unitsPerPixel * 0.4);
      puff.shadow.scale.set(width * 1.04, height * 1.03, 1);
      (puff.body.material as THREE.SpriteMaterial).rotation = Math.sin(puff.phase) * 0.025;
      (puff.shadow.material as THREE.SpriteMaterial).rotation = Math.sin(puff.phase) * 0.025;
    }
  }

  public dispose(): void {
    for (const puff of this.puffs) {
      (puff.body.material as THREE.SpriteMaterial).dispose();
      (puff.shadow.material as THREE.SpriteMaterial).dispose();
    }
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;
    this.puffs.length = 0;
    this.object3d.clear();
  }
}

function defaultStyle(): WeatherStyle {
  return { enabled: true, intensity: 1, rainDensity: 1, windSpeed: 1, cloudScale: 1, opacity: 1 };
}
