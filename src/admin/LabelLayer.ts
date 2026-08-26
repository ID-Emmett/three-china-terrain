import * as THREE from 'three/webgpu';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { SceneLayer } from '../app/SceneLayer';
import type { AdminLabelDatum, AdminLevel } from '../types/scene';
import type { TerrainData } from '../terrain/TerrainData';

interface LabelEntry {
  datum: AdminLabelDatum;
  object: CSS2DObject;
  element: HTMLDivElement;
  anchor: THREE.Vector3;
  distance: number;
  distanceOpacity: number;
  collisionTarget: number;
  opacity: number;
  appliedOpacity: number;
  accepted: boolean;
}

interface ScreenCandidate {
  entry: LabelEntry;
  box: ScreenBox;
  effectiveDistance: number;
}

interface ScreenBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const LEVEL_PRIORITY: Record<AdminLevel, number> = {
  province: 2,
  city: 1,
};
const LABEL_FONT_SIZE = 12;
const OPACITY_EPSILON = 0.003;
const DEFAULT_CITY_NEAR_DISTANCE = 30;
const DEFAULT_CITY_FAR_DISTANCE = 82;
const DEFAULT_FADE_SECONDS = 0.24;

function intersects(a: ScreenBox, b: ScreenBox): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function damp(current: number, target: number, deltaSeconds: number, duration: number): number {
  if (duration <= 0 || deltaSeconds <= 0) return target;
  const response = 1 - Math.exp(-deltaSeconds / duration);
  return THREE.MathUtils.lerp(current, target, response);
}

export class LabelLayer implements SceneLayer {
  public readonly object3d = new THREE.Group();
  private readonly entries: LabelEntry[] = [];
  private readonly enabled: Record<AdminLevel, boolean> = { province: true, city: true };
  private readonly baseOpacity: Record<AdminLevel, number> = { province: 1, city: 1 };
  private cityNearDistance = DEFAULT_CITY_NEAR_DISTANCE;
  private cityFarDistance = DEFAULT_CITY_FAR_DISTANCE;
  private fadeSeconds = DEFAULT_FADE_SECONDS;
  private exaggeration = 1;
  private activeCityProvinceAdcodes = new Set<number>();

  public constructor(
    provinceLabels: AdminLabelDatum[],
    cityLabels: AdminLabelDatum[] | undefined,
    private readonly terrain: TerrainData,
  ) {
    this.object3d.name = 'AdministrativeLabelLayer';
    this.addLabels([...provinceLabels, ...(cityLabels ?? [])]);
  }

  public setLevelData(level: AdminLevel, labels: AdminLabelDatum[]): void {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.datum.level !== level) continue;
      this.object3d.remove(entry.object);
      entry.element.remove();
      this.entries.splice(index, 1);
    }
    this.addLabels(labels.filter((label) => label.level === level));
  }

  public setExaggeration(value: number): void {
    this.exaggeration = value;
    this.object3d.scale.y = value;
  }

  public setLevelVisible(level: AdminLevel, visible: boolean): void {
    this.enabled[level] = visible;
  }

  public setCityProvinceFilter(provinceAdcodes: Iterable<number>): void {
    this.activeCityProvinceAdcodes = new Set(provinceAdcodes);
  }

  public setCityDistanceRange(nearDistance: number, farDistance: number): void {
    this.cityNearDistance = Math.max(0, Math.min(nearDistance, farDistance - 0.01));
    this.cityFarDistance = Math.max(this.cityNearDistance + 0.01, farDistance);
  }

  public setFadeDuration(seconds: number): void {
    this.fadeSeconds = Math.max(0, seconds);
  }

  public updateDistanceFade(cameraPosition: THREE.Vector3, deltaSeconds = 1 / 60): void {
    const delta = THREE.MathUtils.clamp(deltaSeconds, 0, 0.1);

    for (const entry of this.entries) {
      let distanceTarget = this.enabled[entry.datum.level] ? 1 : 0;
      if (entry.datum.level === 'city') {
        const provinceAdcode = Math.floor(entry.datum.adcode / 10000) * 10000;
        if (!this.activeCityProvinceAdcodes.has(provinceAdcode)) {
          distanceTarget = 0;
        }
        const dx = entry.anchor.x - cameraPosition.x;
        const dy = entry.anchor.y * this.exaggeration - cameraPosition.y;
        const dz = entry.anchor.z - cameraPosition.z;
        entry.distance = Math.hypot(dx, dy, dz);
        const distanceFade = 1 - THREE.MathUtils.smootherstep(
          entry.distance,
          this.cityNearDistance,
          this.cityFarDistance,
        );
        distanceTarget *= distanceFade;
      } else {
        entry.distance = 0;
      }

      entry.distanceOpacity = damp(
        entry.distanceOpacity,
        distanceTarget,
        delta,
        this.fadeSeconds,
      );
      const opacityTarget = entry.distanceOpacity
        * entry.collisionTarget
        * this.baseOpacity[entry.datum.level];
      entry.opacity = damp(entry.opacity, opacityTarget, delta, this.fadeSeconds);
      this.applyOpacity(entry, opacityTarget);
    }
  }

  public updateCollision(camera: THREE.Camera, viewportWidth: number, viewportHeight: number): void {
    const worldPosition = new THREE.Vector3();
    const projected = new THREE.Vector3();
    const candidates: ScreenCandidate[] = [];

    for (const entry of this.entries) {
      entry.collisionTarget = 0;
      if (entry.distanceOpacity <= OPACITY_EPSILON && entry.opacity <= OPACITY_EPSILON) {
        entry.accepted = false;
        continue;
      }

      entry.object.getWorldPosition(worldPosition);
      projected.copy(worldPosition).project(camera);
      if (projected.z < -1 || projected.z > 1
        || Math.abs(projected.x) > 1.06 || Math.abs(projected.y) > 1.06) {
        entry.accepted = false;
        continue;
      }

      const x = (projected.x * 0.5 + 0.5) * viewportWidth;
      const y = (-projected.y * 0.5 + 0.5) * viewportHeight;
      const fontSize = Number.parseFloat(entry.element.style.fontSize) || LABEL_FONT_SIZE;
      const width = Math.max(27, entry.datum.name.length * fontSize * 0.96 + 5);
      const height = fontSize * 1.25;
      const spacing = entry.datum.level === 'province' ? 3 : 2;
      candidates.push({
        entry,
        box: {
          left: x - width / 2 - spacing,
          right: x + width / 2 + spacing,
          top: y - height / 2 - spacing,
          bottom: y + height / 2 + spacing,
        },
        effectiveDistance: entry.distance - (entry.accepted ? 3.5 : 0),
      });
    }

    candidates.sort((a, b) => {
      const priority = LEVEL_PRIORITY[b.entry.datum.level] - LEVEL_PRIORITY[a.entry.datum.level];
      if (priority !== 0) return priority;
      if (a.entry.datum.level === 'city') {
        const distance = a.effectiveDistance - b.effectiveDistance;
        if (Math.abs(distance) > 0.5) return distance;
      }
      if (a.entry.accepted !== b.entry.accepted) return a.entry.accepted ? -1 : 1;
      return a.entry.datum.adcode - b.entry.datum.adcode;
    });

    const acceptedBoxes: ScreenBox[] = [];
    const cityLimit = THREE.MathUtils.clamp(
      Math.floor((viewportWidth * viewportHeight) / 52000),
      8,
      24,
    );
    let cityCount = 0;

    for (const candidate of candidates) {
      const isCity = candidate.entry.datum.level === 'city';
      const overlaps = acceptedBoxes.some((box) => intersects(candidate.box, box));
      const overDensityLimit = isCity && cityCount >= cityLimit;
      // Province names are part of the always-on national context. Only city
      // labels participate in collision and density suppression.
      const accepted = !isCity || (!overlaps && !overDensityLimit);
      candidate.entry.accepted = accepted;
      candidate.entry.collisionTarget = accepted ? 1 : 0;
      if (!accepted) continue;
      acceptedBoxes.push(candidate.box);
      if (isCity) cityCount += 1;
    }
  }

  public setFontSize(level: AdminLevel, size: number): void {
    const safeSize = Math.max(8, size);
    for (const entry of this.entries) {
      if (entry.datum.level === level) entry.element.style.fontSize = `${safeSize}px`;
    }
  }

  public setOpacity(level: AdminLevel, opacity: number): void {
    this.baseOpacity[level] = THREE.MathUtils.clamp(opacity, 0, 1);
  }

  public setColor(level: AdminLevel, color: string): void {
    for (const entry of this.entries) {
      if (entry.datum.level === level) entry.element.style.color = color;
    }
  }

  public dispose(): void {
    for (const entry of this.entries) entry.element.remove();
    this.entries.length = 0;
  }

  private addLabels(labels: AdminLabelDatum[]): void {
    for (const datum of labels.sort((a, b) => a.adcode - b.adcode)) {
      const element = document.createElement('div');
      element.className = `map-label map-label--${datum.level}`;
      element.textContent = datum.name;
      element.style.fontSize = `${LABEL_FONT_SIZE}px`;
      element.style.opacity = datum.level === 'province' ? '1' : '0';
      element.style.visibility = datum.level === 'province' ? 'visible' : 'hidden';

      const object = new CSS2DObject(element);
      const anchor = new THREE.Vector3(
        (datum.u - 0.5) * this.terrain.meta.sceneWidth,
        this.terrain.sampleUv(datum.u, datum.v) * this.terrain.meta.sceneUnitsPerMeter + 0.012,
        (datum.v - 0.5) * this.terrain.meta.sceneDepth,
      );
      object.position.copy(anchor);
      object.center.set(0.5, 0.5);
      object.visible = datum.level === 'province';
      this.object3d.add(object);
      this.entries.push({
        datum,
        object,
        element,
        anchor,
        distance: datum.level === 'province' ? 0 : Number.POSITIVE_INFINITY,
        distanceOpacity: datum.level === 'province' ? 1 : 0,
        collisionTarget: datum.level === 'province' ? 1 : 0,
        opacity: datum.level === 'province' ? 1 : 0,
        appliedOpacity: datum.level === 'province' ? 1 : 0,
        accepted: false,
      });
    }
  }

  private applyOpacity(entry: LabelEntry, target: number): void {
    const visible = entry.opacity > OPACITY_EPSILON || target > OPACITY_EPSILON;
    entry.object.visible = visible;
    entry.element.style.visibility = visible ? 'visible' : 'hidden';
    if (Math.abs(entry.opacity - entry.appliedOpacity) < 0.002 && visible) return;
    const applied = entry.opacity <= OPACITY_EPSILON && target <= OPACITY_EPSILON
      ? 0
      : entry.opacity;
    entry.element.style.opacity = applied.toFixed(3);
    entry.appliedOpacity = applied;
  }
}
