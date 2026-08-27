import * as THREE from 'three/webgpu';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { TerrainData } from '../terrain/TerrainData';
import type { DebugParams } from '../debug/DebugParams';
import {
  ROUTES,
  STATIONS,
  STATION_ANCHOR_LIFT,
  formatRouteMetric,
  type RouteDatum,
  type RouteMode,
  type StationDatum,
} from './BusinessData';

interface LabelEntry {
  id: string;
  kind: 'station' | 'route';
  priority: number;
  element: HTMLDivElement;
  object: CSS2DObject;
  station?: StationDatum;
  route?: RouteDatum;
}

export class BusinessLabelLayer {
  public readonly object3d = new THREE.Group();
  private readonly entries: LabelEntry[] = [];
  private mode: RouteMode = 'comparison';
  private hoveredRoute: RouteDatum | null = null;
  private exaggeration = 1;
  private arcHeight = 0.86;

  public constructor(private readonly terrain: TerrainData) {
    this.object3d.name = 'BusinessLabelLayer';
    this.createStationLabels();
    this.createRouteLabels();
    this.setMode('comparison');
  }

  public setExaggeration(value: number): void {
    this.exaggeration = value;
    this.updateAnchors();
  }

  public setMode(mode: RouteMode): void {
    this.mode = mode;
    this.applyVisibility();
  }

  public setHovered(route: RouteDatum | null): void {
    this.hoveredRoute = route;
    this.applyVisibility();
  }

  public applyStyle(
    params: DebugParams['station'],
    routeParams: DebugParams['route'],
  ): void {
    this.arcHeight = routeParams.arcHeight;
    for (const entry of this.entries) {
      entry.element.style.fontSize = `${entry.kind === 'route'
        ? Math.max(10, params.labelFontSize - 1)
        : params.labelFontSize}px`;
      entry.element.style.setProperty('--label-opacity', params.labelOpacity.toString());
      entry.element.style.setProperty('--label-bg-opacity', params.labelBackgroundOpacity.toString());
      if (entry.route?.comparisonRouteIds?.[0] === 'route-a') {
        entry.element.style.setProperty('--route-color', routeParams.routeAColor);
      } else if (entry.route?.comparisonRouteIds?.[0] === 'route-b') {
        entry.element.style.setProperty('--route-color', routeParams.routeBColor);
      } else {
        entry.element.style.setProperty('--route-color', routeParams.mainColor);
      }
    }
    this.updateAnchors();
  }

  public update(camera: THREE.Camera, width: number, height: number, params: DebugParams['station']): void {
    const candidates: Array<{ entry: LabelEntry; box: DOMRect; distance: number }> = [];
    const world = new THREE.Vector3();
    const projected = new THREE.Vector3();
    for (const entry of this.entries) {
      if (!entry.object.visible) continue;
      entry.object.getWorldPosition(world);
      const distance = camera.position.distanceTo(world);
      if (distance > params.labelDistance) {
        entry.element.classList.add('is-suppressed');
        continue;
      }
      projected.copy(world).project(camera);
      const screenX = (projected.x * 0.5 + 0.5) * width;
      const screenY = (-projected.y * 0.5 + 0.5) * height;
      if (projected.z < -1 || projected.z > 1 || screenX < 0 || screenX > width || screenY < 0 || screenY > height) {
        entry.element.classList.add('is-suppressed');
        continue;
      }
      entry.element.classList.remove('is-suppressed');
      const box = entry.element.getBoundingClientRect();
      candidates.push({ entry, box, distance });
    }
    candidates.sort((a, b) => b.entry.priority - a.entry.priority || a.distance - b.distance);
    const accepted: DOMRect[] = [];
    for (const candidate of candidates) {
      const expanded = new DOMRect(
        candidate.box.x - params.labelClusterDistance,
        candidate.box.y - params.labelClusterDistance,
        candidate.box.width + params.labelClusterDistance * 2,
        candidate.box.height + params.labelClusterDistance * 2,
      );
      const overlaps = accepted.some((box) => !(
        expanded.right < box.left || expanded.left > box.right
        || expanded.bottom < box.top || expanded.top > box.bottom
      ));
      const forced = candidate.entry.route !== undefined
        && (candidate.entry.route.label !== undefined
          || candidate.entry.route.id === this.hoveredRoute?.id);
      candidate.entry.element.classList.toggle('is-suppressed', overlaps && !forced);
      if (!overlaps || forced) accepted.push(expanded);
    }
  }

  public dispose(): void {
    for (const entry of this.entries) entry.element.remove();
    this.entries.length = 0;
    this.object3d.clear();
  }

  private createStationLabels(): void {
    for (const station of STATIONS) {
      const element = document.createElement('div');
      element.className = 'business-label business-label--station';
      if (station.priority === 3) element.classList.add('is-priority');
      if (station.center) element.classList.add('is-center');
      element.textContent = station.name;
      const object = new CSS2DObject(element);
      object.center.set(...(station.labelOffset ?? [0.5, 1.8]));
      this.object3d.add(object);
      this.entries.push({
        id: station.id,
        kind: 'station',
        priority: station.priority,
        element,
        object,
        station,
      });
    }
  }

  private createRouteLabels(): void {
    for (const route of ROUTES) {
      if (route.mode === 'comparison') continue;
      const element = document.createElement('div');
      element.className = 'business-label business-label--metric';
      if (route.comparisonRouteIds?.[0]) {
        element.classList.add(`is-${route.comparisonRouteIds[0]}`);
      }
      element.textContent = route.label ?? formatRouteMetric(route);
      const object = new CSS2DObject(element);
      if (route.comparisonRouteIds?.[0] === 'route-a') object.center.set(1.08, -0.5);
      else if (route.comparisonRouteIds?.[0] === 'route-b') object.center.set(-0.08, -0.5);
      else object.center.set(0.5, -0.5);
      this.object3d.add(object);
      this.entries.push({
        id: route.id,
        kind: 'route',
        priority: 1,
        element,
        object,
        route,
      });
    }
    this.updateAnchors();
  }

  private updateAnchors(): void {
    const stations = new Map(STATIONS.map((station) => [station.id, station]));
    for (const entry of this.entries) {
      let u: number;
      let v: number;
      if (entry.station) {
        u = entry.station.u;
        v = entry.station.v;
      } else if (entry.route) {
        const from = stations.get(entry.route.from);
        const to = stations.get(entry.route.to);
        if (!from || !to) continue;
        u = (from.u + to.u) * 0.5;
        v = (from.v + to.v) * 0.5;
      } else continue;
      let height = this.terrain.sampleUv(u, v)
        * this.terrain.meta.sceneUnitsPerMeter
        * this.exaggeration
        + STATION_ANCHOR_LIFT;
      if (entry.route?.mode === 'radial') {
        const from = stations.get(entry.route.from);
        const to = stations.get(entry.route.to);
        if (!from || !to) continue;
        const fromHeight = this.terrain.sampleUv(from.u, from.v)
          * this.terrain.meta.sceneUnitsPerMeter
          * this.exaggeration
          + STATION_ANCHOR_LIFT;
        const toHeight = this.terrain.sampleUv(to.u, to.v)
          * this.terrain.meta.sceneUnitsPerMeter
          * this.exaggeration
          + STATION_ANCHOR_LIFT;
        const distanceUv = Math.hypot(to.u - from.u, to.v - from.v);
        height = (fromHeight + toHeight) * 0.5
          + this.arcHeight * THREE.MathUtils.clamp(distanceUv * 10, 0.34, 1.2)
          + 0.13;
      }
      entry.object.position.set(
        (u - 0.5) * this.terrain.meta.sceneWidth,
        height,
        (v - 0.5) * this.terrain.meta.sceneDepth,
      );
    }
  }

  private applyVisibility(): void {
    const activeStationIds = new Set(
      ROUTES.filter((route) => route.mode === this.mode).flatMap((route) => [route.from, route.to]),
    );
    for (const entry of this.entries) {
      if (entry.station) {
        const visible = activeStationIds.has(entry.station.id);
        entry.object.visible = visible;
        entry.element.style.display = visible ? '' : 'none';
        entry.element.classList.toggle('is-suppressed', !visible);
      }
      if (entry.route) {
        const visible = entry.route.mode === this.mode
          && (entry.route.mode === 'radial' || entry.route.label !== undefined);
        entry.object.visible = visible;
        entry.element.style.display = visible ? '' : 'none';
        entry.element.classList.toggle('is-suppressed', !visible);
        entry.element.classList.toggle('is-hovered', entry.route.id === this.hoveredRoute?.id);
        const related = this.hoveredRoute === null
          || entry.route.mode !== 'comparison'
          || entry.route.comparisonRouteIds?.some((id) => this.hoveredRoute?.comparisonRouteIds?.includes(id));
        entry.element.classList.toggle('is-dimmed', !related);
      }
    }
  }
}
