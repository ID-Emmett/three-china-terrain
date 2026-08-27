import * as THREE from 'three/webgpu';
import type { CameraController } from '../app/CameraController';
import type { BoundaryLayer } from './BoundaryLayer';
import type { LabelLayer } from './LabelLayer';

/** The metric intentionally exposes only the two visual states used by this map. */
export type AdminLod = 'country' | 'city';

export interface AdminLodSettings {
  cityDistance: number;
  showProvince: boolean;
  showCity: boolean;
  showProvinceLabels: boolean;
  showCityLabels: boolean;
  cityTransitionWidth?: number;
  cityLabelNearDistance?: number;
  cityLabelFarDistance?: number;
  lodFadeSeconds?: number;
}

function damp(current: number, target: number, deltaSeconds: number, duration: number): number {
  if (duration <= 0 || deltaSeconds <= 0) return target;
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-deltaSeconds / duration));
}

export class AdminLodController {
  public currentLod: AdminLod = 'country';
  private cityFade = 0;
  private activeProvinceAdcodes = new Set<number>();
  private disposed = false;

  public constructor(
    private readonly camera: CameraController,
    private readonly boundaries: BoundaryLayer,
    private readonly labels: LabelLayer,
    private readonly settings: AdminLodSettings,
  ) {}

  public update(deltaSeconds = 0): void {
    if (this.disposed) return;

    const delta = THREE.MathUtils.clamp(deltaSeconds, 0, 0.1);

    const zoomDistance = this.camera.getDistance();
    const transitionWidth = Math.max(
      8,
      this.settings.cityTransitionWidth ?? Math.max(20, this.settings.cityDistance * 0.34),
    );
    const transitionNear = Math.max(0, this.settings.cityDistance - transitionWidth * 0.5);
    const transitionFar = this.settings.cityDistance + transitionWidth * 0.5;
    const zoomTarget = 1 - THREE.MathUtils.smootherstep(
      zoomDistance,
      transitionNear,
      transitionFar,
    );
    const fadeDuration = Math.max(0, this.settings.lodFadeSeconds ?? 0.28);
    this.cityFade = damp(this.cityFade, zoomTarget, delta, fadeDuration);
    this.currentLod = this.cityFade > 0.52 ? 'city' : 'country';

    const showActiveCityBoundaries = this.settings.showCity && this.activeProvinceAdcodes.size > 0;
    this.boundaries.setLevelVisible('province', this.settings.showProvince);
    this.boundaries.setLevelVisible('city', showActiveCityBoundaries);
    this.boundaries.setLodOpacity('province', this.settings.showProvince ? 1 : 0);
    this.boundaries.setLodOpacity('city', showActiveCityBoundaries ? 1 : 0);

    this.labels.setLevelVisible('province', this.settings.showProvinceLabels);
    this.labels.setLevelVisible('city', this.settings.showCityLabels);
    const nearDistance = this.settings.cityLabelNearDistance
      ?? Math.max(16, this.settings.cityDistance * 0.42);
    const farDistance = this.settings.cityLabelFarDistance
      ?? Math.max(nearDistance + 12, this.settings.cityDistance + 10);
    this.labels.setCityDistanceRange(nearDistance, farDistance);
    this.labels.setFadeDuration(fadeDuration);
    // The camera position, rather than OrbitControls.target, is the label reference.
    this.labels.updateDistanceFade(this.camera.camera.position, delta);
  }

  public setActiveProvinceAdcodes(provinceAdcodes: Iterable<number>): void {
    this.activeProvinceAdcodes = new Set(provinceAdcodes);
    this.boundaries.setCityProvinceFilter(this.activeProvinceAdcodes);
    this.labels.setCityProvinceFilter(this.activeProvinceAdcodes);
    this.update(0);
  }

  public dispose(): void {
    this.disposed = true;
  }
}
