import * as THREE from 'three/webgpu';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { Line2 } from 'three/addons/lines/webgpu/Line2.js';
import type { SceneLayer } from '../app/SceneLayer';
import type { TerrainData } from '../terrain/TerrainData';
import type { DebugParams } from '../debug/DebugParams';
import {
  ROUTES,
  STATIONS,
  STATION_ANCHOR_LIFT,
  type RouteDatum,
  type RouteMode,
} from './BusinessData';
import { RouteMaterial } from './RouteMaterial';

interface RouteEntry {
  datum: RouteDatum;
  line: Line2;
  glowLine: Line2;
  material: RouteMaterial;
  glowMaterial: RouteMaterial;
  points: THREE.Vector3[];
}

export class RouteLayer implements SceneLayer {
  public readonly object3d = new THREE.Group();
  private readonly entries: RouteEntry[] = [];
  private mode: RouteMode = 'comparison';
  private hoveredId: string | null = null;
  private exaggeration = 1;

  public constructor(private readonly terrain: TerrainData) {
    this.object3d.name = 'RouteLayer';
    this.buildRoutes();
    this.setMode('comparison');
  }

  public setExaggeration(value: number): void {
    this.exaggeration = value;
    this.rebuildGeometry();
  }

  public setMode(mode: RouteMode): void {
    this.mode = mode;
    for (const entry of this.entries) {
      const visible = entry.datum.mode === mode;
      entry.line.visible = visible;
      entry.glowLine.visible = visible;
    }
    this.setHovered(null);
  }

  public setStyle(params: DebugParams['route'], rebuild = true): void {
    for (const entry of this.entries) {
      const isHovered = entry.datum.id === this.hoveredId;
      entry.material.setStyle({
        color: isHovered ? params.hoverColor : params.mainColor,
        highlightColor: isHovered ? '#fff0c4' : '#b8ffff',
        opacity: params.opacity,
        width: params.pixelWidth,
        glowRange: params.glowRange,
        glowStrength: params.glowIntensity * Math.min(1, params.glowRange / 12),
        roundness: params.dashRoundness,
      });
      entry.glowMaterial.setStyle({
        color: isHovered ? params.hoverColor : params.mainColor,
        highlightColor: isHovered ? '#fff0c4' : '#b8ffff',
        opacity: params.opacity,
        width: params.pixelWidth,
        glowRange: params.glowRange,
        glowStrength: params.glowIntensity * Math.min(1, params.glowRange / 12),
        roundness: params.dashRoundness,
      });
      entry.material.setInteraction(isHovered, this.hoveredId !== null && !isHovered);
      entry.glowMaterial.setInteraction(isHovered, this.hoveredId !== null && !isHovered);
    }
    if (rebuild) this.rebuildGeometry(params.liftHeight, params.arcHeight);
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    params: DebugParams['route'],
  ): void {
    for (const entry of this.entries) {
      const flowSpeed = params.flowSpeed * Math.max(0.25, params.flowLength);
      entry.material.update(
        deltaSeconds,
        elapsedSeconds,
        flowSpeed,
        params.flowDirection,
        params.dashLength,
        params.dashGap,
      );
      entry.glowMaterial.update(
        deltaSeconds,
        elapsedSeconds,
        flowSpeed,
        params.flowDirection,
        params.dashLength,
        params.dashGap,
      );
    }
  }

  public pick(
    clientX: number,
    clientY: number,
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
  ): RouteDatum | null {
    const rect = canvas.getBoundingClientRect();
    const cursorX = clientX - rect.left;
    const cursorY = clientY - rect.top;
    const projected = new THREE.Vector3();
    let closest: { entry: RouteEntry; distance: number } | null = null;
    for (const entry of this.entries) {
      if (entry.datum.mode !== this.mode || !entry.line.visible) continue;
      let previous: { x: number; y: number; z: number } | null = null;
      for (const point of entry.points) {
        projected.copy(point).project(camera);
        const current = {
          x: (projected.x * 0.5 + 0.5) * rect.width,
          y: (-projected.y * 0.5 + 0.5) * rect.height,
          z: projected.z,
        };
        if (previous && current.z > -1 && current.z < 1) {
          const dx = current.x - previous.x;
          const dy = current.y - previous.y;
          const lengthSq = dx * dx + dy * dy;
          const t = lengthSq > 0
            ? THREE.MathUtils.clamp(((cursorX - previous.x) * dx + (cursorY - previous.y) * dy) / lengthSq, 0, 1)
            : 0;
          const distance = Math.hypot(cursorX - (previous.x + dx * t), cursorY - (previous.y + dy * t));
          if (distance < 18 && (!closest || distance < closest.distance)) closest = { entry, distance };
        }
        previous = current;
      }
    }
    return closest?.entry.datum ?? null;
  }

  public setHovered(id: string | null): void {
    this.hoveredId = id;
  }

  public get hovered(): RouteDatum | null {
    return this.entries.find((entry) => entry.datum.id === this.hoveredId)?.datum ?? null;
  }

  public dispose(): void {
    for (const entry of this.entries) {
      entry.line.geometry.dispose();
      entry.material.dispose();
      entry.glowMaterial.dispose();
    }
    this.entries.length = 0;
    this.object3d.clear();
  }

  private buildRoutes(): void {
    for (const datum of ROUTES) {
      const material = new RouteMaterial();
      const glowMaterial = new RouteMaterial(true);
      const geometry = new LineGeometry();
      const line = new Line2(geometry, material);
      const glowLine = new Line2(geometry, glowMaterial);
      line.name = datum.id;
      glowLine.name = datum.id + '-glow';
      line.renderOrder = 20;
      glowLine.renderOrder = 19;
      line.frustumCulled = true;
      glowLine.frustumCulled = true;
      line.userData.route = datum;
      glowLine.userData.route = datum;
      this.object3d.add(glowLine, line);
      this.entries.push({ datum, line, glowLine, material, glowMaterial, points: [] });
    }
    this.rebuildGeometry();
  }

  private rebuildGeometry(liftHeight = 0.08, arcHeight = 0.86): void {
    const stations = new Map(STATIONS.map((station) => [station.id, station]));
    for (const entry of this.entries) {
      const from = stations.get(entry.datum.from);
      const to = stations.get(entry.datum.to);
      if (!from || !to) continue;
      const distanceUv = Math.hypot(to.u - from.u, to.v - from.v);
      const sampleCount = THREE.MathUtils.clamp(Math.ceil(distanceUv * 950), 24, 128);
      entry.points = [];
      for (let index = 0; index <= sampleCount; index += 1) {
        const t = index / sampleCount;
        const u = THREE.MathUtils.lerp(from.u, to.u, t);
        const v = THREE.MathUtils.lerp(from.v, to.v, t);
        const terrainHeight = this.terrain.sampleUv(u, v)
          * this.terrain.meta.sceneUnitsPerMeter
          * this.exaggeration;
        const routeLift = 0.08 + liftHeight * 0.62;
        const arc = entry.datum.mode === 'radial'
          ? Math.sin(Math.PI * t) * arcHeight * Math.min(1, distanceUv * 10)
          : 0;
        const isEndpoint = index === 0 || index === sampleCount;
        const endpointStation = index === 0 ? from : to;
        entry.points.push(new THREE.Vector3(
          (u - 0.5) * this.terrain.meta.sceneWidth,
          isEndpoint
            ? this.terrain.sampleUv(endpointStation.u, endpointStation.v)
              * this.terrain.meta.sceneUnitsPerMeter
              * this.exaggeration
              + STATION_ANCHOR_LIFT
            : terrainHeight + routeLift + arc,
          (v - 0.5) * this.terrain.meta.sceneDepth,
        ));
      }
      (entry.line.geometry as LineGeometry).setFromPoints(entry.points);
      entry.line.computeLineDistances();
    }
  }

}
