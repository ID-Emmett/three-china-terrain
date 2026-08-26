import * as THREE from 'three/webgpu';
import {
  float,
  fract,
  instancedBufferAttribute,
  sin,
  uniform,
  vec3,
} from 'three/tsl';
import type { TerrainData } from '../terrain/TerrainData';
import type { DebugParams } from '../debug/DebugParams';
import { STATIONS, type RouteMode } from '../business/BusinessData';

type WeatherKind = 'rain' | 'wind' | 'cloud';

interface WeatherAnchor {
  u: number;
  v: number;
  seed: number;
  drift: number;
}

interface WeatherBatch {
  mode: RouteMode;
  kind: WeatherKind;
  sprite: THREE.Sprite;
  material: THREE.PointsNodeMaterial;
  anchors: WeatherAnchor[];
  positionAttribute: THREE.BufferAttribute;
  seedAttribute: THREE.BufferAttribute;
  driftAttribute: THREE.BufferAttribute;
  timeNode: { value: number };
  intensityNode: { value: number };
  densityNode: { value: number };
  speedNode: { value: number };
  opacityNode: { value: number };
  sizeNode: { value: THREE.Vector2 };
}

/** Localized weather particles, grouped into one draw per mode and weather type. */
export class WeatherLayer {
  public readonly object3d = new THREE.Group();
  private readonly batches: WeatherBatch[] = [];
  private exaggeration = 1;
  private mode: RouteMode = 'comparison';
  private readonly particleTextures: Record<WeatherKind, THREE.DataTexture> = {
    rain: createParticleTexture('rain'),
    wind: createParticleTexture('wind'),
    cloud: createParticleTexture('cloud'),
  };

  public constructor(private readonly terrain: TerrainData) {
    this.object3d.name = 'WeatherLayer';
    this.buildBatches();
  }

  public setExaggeration(value: number): void {
    this.exaggeration = value;
    this.updateAnchors();
  }

  public setMode(mode: RouteMode): void {
    this.mode = mode;
    this.applyVisibility();
  }

  public setStyle(params: DebugParams['weather']): void {
    this.object3d.visible = params.enabled;
    for (const batch of this.batches) {
      batch.intensityNode.value = params.intensity;
      batch.densityNode.value = params.rainDensity;
      batch.speedNode.value = params.windSpeed;
      batch.opacityNode.value = params.opacity;
      const scale = batch.kind === 'cloud' ? params.cloudScale : 1;
      const baseSize = batch.kind === 'cloud'
        ? new THREE.Vector2(24, 15)
        : batch.kind === 'rain'
          ? new THREE.Vector2(5, 14)
          : new THREE.Vector2(16, 5);
      batch.sizeNode.value.set(baseSize.x * scale, baseSize.y * scale);
    }
    this.applyVisibility();
  }

  public update(elapsedSeconds: number, params: DebugParams['weather']): void {
    if (!params.enabled) return;
    for (const batch of this.batches) batch.timeNode.value = elapsedSeconds;
  }

  public dispose(): void {
    for (const batch of this.batches) {
      batch.material.dispose();
    }
    for (const texture of Object.values(this.particleTextures)) texture.dispose();
    this.batches.length = 0;
    this.object3d.clear();
  }

  private buildBatches(): void {
    const grouped = new Map<string, { mode: RouteMode; kind: WeatherKind; anchors: WeatherAnchor[] }>();
    for (const [stationIndex, station] of STATIONS.entries()) {
      if (!station.weather) continue;
      const mode: RouteMode = stationIndex < 6 ? 'comparison' : 'radial';
      const kind = station.weather;
      const key = `${mode}:${kind}`;
      const group = grouped.get(key) ?? { mode, kind, anchors: [] };
      const count = kind === 'rain' ? 24 : kind === 'wind' ? 16 : 9;
      for (let index = 0; index < count; index += 1) {
        const seed = ((index * 37 + stationIndex * 17) % 101) / 101;
        group.anchors.push({
          u: station.u + (seed - 0.5) * (kind === 'cloud' ? 0.009 : 0.005),
          v: station.v + ((((index * 53) % 97) / 97) - 0.5) * 0.006,
          seed,
          drift: (((index * 29 + stationIndex * 11) % 97) / 97) - 0.5,
        });
      }
      grouped.set(key, group);
    }

    for (const group of grouped.values()) this.createBatch(group);
    this.updateAnchors();
    this.applyVisibility();
  }

  private createBatch(group: { mode: RouteMode; kind: WeatherKind; anchors: WeatherAnchor[] }): void {
    const positions = new Float32Array(group.anchors.length * 3);
    const seeds = new Float32Array(group.anchors.length);
    const drifts = new Float32Array(group.anchors.length);
    const positionAttribute = new THREE.Float32BufferAttribute(positions, 3);
    const seedAttribute = new THREE.Float32BufferAttribute(seeds, 1);
    const driftAttribute = new THREE.Float32BufferAttribute(drifts, 1);

    const timeNode = uniform(0);
    const intensityNode = uniform(0.3);
    const densityNode = uniform(0.5);
    const speedNode = uniform(0.75);
    const opacityNode = uniform(0.26);
    const sizeNode = uniform(new THREE.Vector2(10, 10));
    const positionNode = instancedBufferAttribute<'vec3'>(positionAttribute, 'vec3');
    const seedNode = instancedBufferAttribute<'float'>(seedAttribute, 'float');
    const driftNode = instancedBufferAttribute<'float'>(driftAttribute, 'float');
    const phase = fract(timeNode.mul(group.kind === 'rain' ? 0.52 : 0.28).add(seedNode));
    const offset = group.kind === 'rain'
      ? vec3(driftNode.mul(0.18), float(0.78).sub(phase.mul(0.7)), 0)
      : group.kind === 'wind'
        ? vec3(
        phase.sub(0.5).mul(0.86).mul(speedNode),
        sin(phase.mul(Math.PI * 2)).mul(0.05),
        0,
        )
        : vec3(sin(timeNode.mul(0.2).add(seedNode.mul(6))).mul(0.07), 0, 0);

    const densityFade = group.kind === 'rain'
      ? densityNode
      : float(1);
    const material = new THREE.PointsNodeMaterial({
      map: this.particleTextures[group.kind],
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      sizeAttenuation: false,
    });
    material.sizeNode = sizeNode;
    material.positionNode = positionNode.add(offset);
    material.color.set(group.kind === 'cloud' ? '#a9c1c4' : '#70dce4');
    material.opacityNode = densityFade.mul(intensityNode).mul(opacityNode).clamp(0, 1);
    const sprite = new THREE.Sprite(material);
    sprite.name = `${group.mode}-${group.kind}-weather`;
    sprite.renderOrder = 18;
    this.object3d.add(sprite);
    this.batches.push({
      mode: group.mode,
      kind: group.kind,
      sprite,
      material,
      anchors: group.anchors,
      positionAttribute,
      seedAttribute,
      driftAttribute,
      timeNode,
      intensityNode,
      densityNode,
      speedNode,
      opacityNode,
      sizeNode,
    });
  }

  private updateAnchors(): void {
    for (const batch of this.batches) {
      for (let index = 0; index < batch.anchors.length; index += 1) {
        const anchor = batch.anchors[index];
        const height = this.terrain.sampleUv(anchor.u, anchor.v)
          * this.terrain.meta.sceneUnitsPerMeter
          * this.exaggeration;
        batch.positionAttribute.setXYZ(
          index,
          (anchor.u - 0.5) * this.terrain.meta.sceneWidth,
          height + 0.08,
          (anchor.v - 0.5) * this.terrain.meta.sceneDepth,
        );
        batch.seedAttribute.setX(index, anchor.seed);
        batch.driftAttribute.setX(index, anchor.drift);
      }
      batch.positionAttribute.needsUpdate = true;
      batch.seedAttribute.needsUpdate = true;
      batch.driftAttribute.needsUpdate = true;
    }
  }

  private applyVisibility(): void {
    for (const batch of this.batches) batch.sprite.visible = this.object3d.visible && batch.mode === this.mode;
  }
}

function createParticleTexture(kind: WeatherKind, size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) * 0.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = (x - center) / center;
      const py = (y - center) / center;
      let alpha: number;
      if (kind === 'rain') {
        const lineX = px + py * 0.18;
        alpha = Math.pow(Math.max(0, 1 - Math.abs(lineX) / 0.12), 1.8)
          * Math.pow(Math.max(0, 1 - Math.abs(py)), 0.7);
      } else if (kind === 'wind') {
        const capsule = Math.hypot(Math.max(0, Math.abs(px) - 0.68), py * 3.6);
        alpha = Math.pow(Math.max(0, 1 - capsule / 0.28), 1.7);
      } else {
        const lobeA = Math.max(0, 1 - Math.hypot(px + 0.34, py + 0.02) / 0.62);
        const lobeB = Math.max(0, 1 - Math.hypot(px, py - 0.16) / 0.72);
        const lobeC = Math.max(0, 1 - Math.hypot(px - 0.38, py + 0.04) / 0.56);
        alpha = Math.pow(Math.max(lobeA, lobeB, lobeC), 2.1) * 0.78;
      }
      const offset = (y * size + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
