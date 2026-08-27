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
  flowLine: Line2;
  material: RouteMaterial;
  glowMaterial: RouteMaterial;
  flowMaterial: RouteMaterial;
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
      entry.flowLine.visible = visible;
    }
    this.setHovered(null);
  }

  public setStyle(params: DebugParams['route'], rebuild = true): void {
    const hovered = this.hovered;
    for (const entry of this.entries) {
      const selected = hovered ? this.routesAreRelated(entry.datum, hovered) : false;
      const dimmed = hovered !== null && !selected;
      const baseColor = this.getRouteColor(entry.datum, params);
      const shared = entry.datum.comparisonShared === true;
      const different = entry.datum.mode === 'comparison' && !shared;
      const highlightColor = entry.datum.id === this.hoveredId
        ? params.hoverColor
        : `#${new THREE.Color(baseColor).lerp(new THREE.Color('#ffffff'), 0.62).getHexString()}`;
      const style = {
        color: baseColor,
        highlightColor,
        opacity: params.opacity * (shared ? 0.9 : 1),
        width: params.pixelWidth * (shared ? 0.9 : different ? 1.16 : 1),
        glowRange: params.glowRange * (shared ? 0.82 : different ? 1.08 : 1),
        glowStrength: params.glowIntensity * (shared ? 0.82 : different ? 1.12 : 1),
        roundness: params.dashRoundness,
      };
      entry.material.setStyle(style);
      entry.glowMaterial.setStyle(style);
      entry.flowMaterial.setStyle(style);
      entry.material.setInteraction(selected, dimmed);
      entry.glowMaterial.setInteraction(selected, dimmed);
      entry.flowMaterial.setInteraction(selected, dimmed);
    }
    if (rebuild) this.rebuildGeometry(params.liftHeight, params.arcHeight);
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    params: DebugParams['route'],
  ): void {
    for (const entry of this.entries) {
      const dashLength = params.dashLength * Math.max(0.2, params.flowLength);
      const args = [
        deltaSeconds,
        elapsedSeconds,
        params.flowSpeed,
        params.flowDirection,
        dashLength,
        params.dashGap,
      ] as const;
      entry.material.update(...args);
      entry.glowMaterial.update(...args);
      entry.flowMaterial.update(...args);
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
      entry.flowMaterial.dispose();
    }
    this.entries.length = 0;
    this.object3d.clear();
  }

  private buildRoutes(): void {
    for (const datum of ROUTES) {
      const geometry = new LineGeometry();
      const material = new RouteMaterial('dash');
      const glowMaterial = new RouteMaterial('halo');
      const flowMaterial = new RouteMaterial('pulse');
      const line = new Line2(geometry, material);
      const glowLine = new Line2(geometry, glowMaterial);
      const flowLine = new Line2(geometry, flowMaterial);
      line.name = datum.id;
      glowLine.name = `${datum.id}-glow`;
      flowLine.name = `${datum.id}-flow`;
      glowLine.renderOrder = 18;
      line.renderOrder = 20;
      flowLine.renderOrder = 21;
      for (const routeLine of [glowLine, line, flowLine]) {
        routeLine.frustumCulled = true;
        routeLine.userData.route = datum;
      }
      this.object3d.add(glowLine, line, flowLine);
      this.entries.push({
        datum,
        line,
        glowLine,
        flowLine,
        material,
        glowMaterial,
        flowMaterial,
        points: [],
      });
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
      const fromHeight = this.stationHeight(from.u, from.v);
      const toHeight = this.stationHeight(to.u, to.v);
      const routeLift = 0.08 + liftHeight * 0.62;
      const radialArcHeight = arcHeight * THREE.MathUtils.clamp(distanceUv * 10, 0.34, 1.2);
      const deltaX = (to.u - from.u) * this.terrain.meta.sceneWidth;
      const deltaZ = (to.v - from.v) * this.terrain.meta.sceneDepth;
      const planarLength = Math.max(0.0001, Math.hypot(deltaX, deltaZ));
      const sharedSide = entry.datum.comparisonShared
        ? entry.datum.comparisonRouteIds?.[0] === 'route-a' ? -1 : 1
        : 0;
      entry.points = [];
      for (let index = 0; index <= sampleCount; index += 1) {
        const t = index / sampleCount;
        const u = THREE.MathUtils.lerp(from.u, to.u, t);
        const v = THREE.MathUtils.lerp(from.v, to.v, t);
        const isEndpoint = index === 0 || index === sampleCount;
        let y: number;
        if (isEndpoint) {
          y = index === 0 ? fromHeight : toHeight;
        } else if (entry.datum.mode === 'radial') {
          y = THREE.MathUtils.lerp(fromHeight, toHeight, t)
            + Math.sin(Math.PI * t) * (radialArcHeight + routeLift);
        } else {
          y = this.terrain.sampleUv(u, v)
            * this.terrain.meta.sceneUnitsPerMeter
            * this.exaggeration
            + routeLift;
        }
        const sharedOffset = Math.sin(Math.PI * t) * sharedSide * 0.13;
        entry.points.push(new THREE.Vector3(
          (u - 0.5) * this.terrain.meta.sceneWidth - deltaZ / planarLength * sharedOffset,
          y,
          (v - 0.5) * this.terrain.meta.sceneDepth + deltaX / planarLength * sharedOffset,
        ));
      }
      (entry.line.geometry as LineGeometry).setFromPoints(entry.points);
      entry.line.computeLineDistances();
    }
  }

  private stationHeight(u: number, v: number): number {
    return this.terrain.sampleUv(u, v)
      * this.terrain.meta.sceneUnitsPerMeter
      * this.exaggeration
      + STATION_ANCHOR_LIFT;
  }

  private getRouteColor(route: RouteDatum, params: DebugParams['route']): string {
    if (route.mode === 'radial') return params.mainColor;
    if (route.comparisonRouteIds?.[0] === 'route-a') return params.routeAColor;
    return params.routeBColor;
  }

  private routesAreRelated(a: RouteDatum, b: RouteDatum): boolean {
    if (a.mode !== 'comparison' || b.mode !== 'comparison') return a.id === b.id;
    const aIds = a.comparisonRouteIds ?? [];
    const bIds = b.comparisonRouteIds ?? [];
    return aIds.some((id) => bIds.includes(id));
  }
}
