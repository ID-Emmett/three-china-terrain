import * as THREE from 'three/webgpu';
import type { SceneLayer } from '../app/SceneLayer';
import type { TerrainData } from '../terrain/TerrainData';
import type { DebugParams } from '../debug/DebugParams';
import {
  ROUTES,
  STATIONS,
  STATION_ANCHOR_LIFT,
  type RouteDatum,
  type RouteMode,
  type StationDatum,
} from './BusinessData';

interface StationEntry {
  datum: StationDatum;
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  baseOpacity: number;
  opacityTarget: number;
}

export class StationLayer implements SceneLayer {
  public readonly object3d = new THREE.Group();
  private readonly entries: StationEntry[] = [];
  private exaggeration = 1;
  private mode: RouteMode = 'comparison';
  private hoveredRoute: RouteDatum | null = null;
  private readonly dotTexture = createDotTexture();
  private pixelSize = 16;

  public constructor(private readonly terrain: TerrainData) {
    this.object3d.name = 'StationLayer';
    this.buildStations();
    this.setMode('comparison');
  }

  public setExaggeration(value: number): void {
    this.exaggeration = value;
    this.updatePositions();
  }

  public setMode(mode: RouteMode): void {
    this.mode = mode;
    this.applyVisibility();
  }

  public setHovered(route: RouteDatum | null): void {
    this.hoveredRoute = route;
    this.applyVisualState();
  }

  public update(deltaSeconds: number, camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    const response = 1 - Math.exp(-Math.min(deltaSeconds, 0.1) * 9);
    for (const entry of this.entries) {
      entry.material.opacity = THREE.MathUtils.lerp(
        entry.material.opacity,
        entry.opacityTarget,
        response,
      );
      const distance = camera.position.distanceTo(entry.sprite.position);
      const unitsPerPixel = distance * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5)
        / Math.max(1, viewportHeight);
      const size = this.pixelSize * unitsPerPixel;
      entry.sprite.scale.set(size, size, 1);
    }
  }

  public setStyle(params: DebugParams['station']): void {
    for (const entry of this.entries) {
      this.pixelSize = params.pixelSize * params.haloSize;
      entry.baseOpacity = params.haloOpacity;
      const materialColor = entry.datum.center ? '#ffad3f' : '#55ffff';
      entry.material.color.set(materialColor);
      entry.material.color.multiplyScalar(0.72 + params.centerBrightness * 0.34);
    }
    this.applyVisualState();
  }

  public dispose(): void {
    for (const entry of this.entries) entry.material.dispose();
    this.dotTexture.dispose();
    this.entries.length = 0;
    this.object3d.clear();
  }

  private buildStations(): void {
    for (const datum of STATIONS) {
      const material = new THREE.SpriteMaterial({
        map: this.dotTexture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        opacity: 0.48,
        blending: THREE.AdditiveBlending,
      });
      material.color.set('#55ffff');
      const sprite = new THREE.Sprite(material);
      sprite.name = datum.name;
      sprite.renderOrder = 25;
      sprite.center.set(0.5, 0.5);
      this.object3d.add(sprite);
      this.entries.push({
        datum,
        sprite,
        material,
        baseOpacity: 0.48,
        opacityTarget: 0.48,
      });
    }
    this.updatePositions();
  }

  private updatePositions(): void {
    for (const entry of this.entries) {
      const height = this.terrain.sampleUv(entry.datum.u, entry.datum.v)
        * this.terrain.meta.sceneUnitsPerMeter
        * this.exaggeration;
      entry.sprite.position.set(
        (entry.datum.u - 0.5) * this.terrain.meta.sceneWidth,
        height + STATION_ANCHOR_LIFT,
        (entry.datum.v - 0.5) * this.terrain.meta.sceneDepth,
      );
    }
  }

  private applyVisibility(): void {
    const activeIds = new Set(
      ROUTES.filter((route) => route.mode === this.mode).flatMap((route) => [route.from, route.to]),
    );
    for (const entry of this.entries) entry.sprite.visible = activeIds.has(entry.datum.id);
    this.applyVisualState();
  }

  private applyVisualState(): void {
    for (const entry of this.entries) {
      const connected = this.hoveredRoute
        ? entry.datum.id === this.hoveredRoute.from || entry.datum.id === this.hoveredRoute.to
        : false;
      const dimmed = this.hoveredRoute !== null && !connected;
      entry.opacityTarget = dimmed
        ? entry.baseOpacity * 0.3
        : connected
          ? Math.min(1, entry.baseOpacity * 1.55)
          : entry.baseOpacity;
    }
  }
}

function createDotTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) * 0.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const radius = Math.hypot(x - center, y - center) / center;
      const core = Math.max(0, 1 - Math.min(1, radius / 0.2));
      const halo = Math.pow(Math.max(0, 1 - radius), 2.1) * 0.72;
      const alpha = Math.min(1, core * 0.98 + halo);
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
