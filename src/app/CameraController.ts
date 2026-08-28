import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { TerrainData } from '../terrain/TerrainData';

interface UvPoint {
  u: number;
  v: number;
}

interface FocusAnimation {
  fromPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toPosition: THREE.Vector3;
  toTarget: THREE.Vector3;
  elapsed: number;
  duration: number;
}

export class CameraController {
  public readonly controls: OrbitControls;
  private readonly homePosition = new THREE.Vector3();
  private readonly baseHomePosition = new THREE.Vector3();
  private readonly homeTarget = new THREE.Vector3();
  private readonly baseHomeTarget = new THREE.Vector3();
  private readonly mapBounds = new THREE.Vector2();
  private readonly clampedTarget = new THREE.Vector3();
  private readonly panDelta = new THREE.Vector3();
  private readonly focusOffset = new THREE.Vector3(0, 0.72, 0.69).normalize();
  private focusAnimation?: FocusAnimation;
  private exaggeration = 1;
  private readonly onControlStart = (): void => {
    this.focusAnimation = undefined;
  };

  public constructor(
    public readonly camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    private readonly terrain: TerrainData,
  ) {
    const meta = terrain.meta;
    this.controls = new OrbitControls(camera, domElement);
    this.controls.addEventListener('start', this.onControlStart);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 4;
    this.controls.maxDistance = Math.max(160, Math.hypot(meta.sceneWidth, meta.sceneDepth) * 1.35);
    this.controls.minPolarAngle = 0.16;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.12;
    this.mapBounds.set(
      Math.max(0, meta.sceneWidth * 0.5 - Math.min(6, meta.sceneWidth * 0.06)),
      Math.max(0, meta.sceneDepth * 0.5 - Math.min(6, meta.sceneDepth * 0.06)),
    );
    this.controls.minTargetRadius = 0;
    this.controls.maxTargetRadius = Math.hypot(this.mapBounds.x, this.mapBounds.y);
    this.controls.target.set(0, 0, 0);

    this.baseHomePosition.set(0, meta.sceneDepth * 1.02, meta.sceneDepth * 0.72);
    this.homePosition.copy(this.baseHomePosition);
    this.baseHomeTarget.set(0, 0, 0);
    this.homeTarget.copy(this.baseHomeTarget);
    this.reset();
  }

  public reset(): void {
    this.focusAnimation = undefined;
    this.camera.position.copy(this.homePosition);
    this.controls.target.copy(this.homeTarget);
    this.controls.update();
  }

  public setViewportAspect(aspect: number, frameOverview = false): void {
    const portrait = THREE.MathUtils.clamp((0.95 - aspect) / 0.5, 0, 1);
    const distanceScale = THREE.MathUtils.lerp(1, 1.1, portrait);
    this.homePosition.copy(this.baseHomePosition).multiplyScalar(distanceScale);
    this.homeTarget.copy(this.baseHomeTarget);
    this.homeTarget.y = -this.baseHomePosition.y * 0.08 * portrait;
    this.camera.fov = THREE.MathUtils.lerp(36, 46, portrait);
    this.camera.updateProjectionMatrix();
    if (frameOverview) this.reset();
  }

  public getDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  public setExaggeration(value: number): void {
    this.exaggeration = value;
  }

  public focusUvPoints(points: readonly UvPoint[]): void {
    this.focusAnimation = undefined;
    if (points.length === 0) return;
    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    let height = 0;
    for (const point of points) {
      minU = Math.min(minU, point.u);
      maxU = Math.max(maxU, point.u);
      minV = Math.min(minV, point.v);
      maxV = Math.max(maxV, point.v);
      height += this.sampleSceneHeight(point.u, point.v);
    }

    const meta = this.terrain.meta;
    const spanX = Math.max(2.8, (maxU - minU) * meta.sceneWidth);
    const spanZ = Math.max(2.8, (maxV - minV) * meta.sceneDepth);
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * this.camera.aspect);
    const widthDistance = (spanX * 0.68) / Math.max(0.1, Math.tan(horizontalFov * 0.5));
    const depthDistance = (spanZ * 0.82) / Math.max(0.1, Math.tan(verticalFov * 0.5));
    // Keep the route bounds in frame with enough regional context while
    // leaving short alternative segments large enough to compare.
    const distance = THREE.MathUtils.clamp(
      Math.max(widthDistance, depthDistance) * 1.08 + 4,
      22,
      66,
    );

    this.controls.target.set(
      ((minU + maxU) * 0.5 - 0.5) * meta.sceneWidth,
      height / points.length + 0.08,
      ((minV + maxV) * 0.5 - 0.5) * meta.sceneDepth,
    );
    this.camera.position.copy(this.controls.target).addScaledVector(this.focusOffset, distance);
    this.controls.update();
  }

  /** Smoothly flies to a world-space point set while keeping the whole subject in frame. */
  public flyToWorldPoints(points: readonly THREE.Vector3[], duration = 0.9): void {
    if (points.length === 0) return;
    const bounds = new THREE.Box3();
    for (const point of points) bounds.expandByPoint(point);
    const center = bounds.getCenter(new THREE.Vector3());
    const spanX = Math.max(1.8, bounds.max.x - bounds.min.x);
    const spanZ = Math.max(1.8, bounds.max.z - bounds.min.z);
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * this.camera.aspect);
    const widthDistance = (spanX * 0.7) / Math.max(0.1, Math.tan(horizontalFov * 0.5));
    const depthDistance = (spanZ * 0.82) / Math.max(0.1, Math.tan(verticalFov * 0.5));
    const distance = THREE.MathUtils.clamp(
      Math.max(widthDistance, depthDistance) * 1.08 + 2.2,
      7,
      54,
    );
    center.y = Math.max(bounds.min.y, Math.min(bounds.max.y, center.y)) + 0.12;
    this.flyTo(center, distance, duration);
  }

  /** Smoothly flies to a station anchor at a close inspection distance. */
  public flyToWorldPoint(point: THREE.Vector3, distance = 8.5, duration = 0.8): void {
    const target = point.clone();
    target.y += 0.16;
    this.flyTo(target, THREE.MathUtils.clamp(distance, this.controls.minDistance, 18), duration);
  }

  private flyTo(target: THREE.Vector3, distance: number, duration: number): void {
    const toTarget = target.clone();
    const toPosition = target.clone().addScaledVector(this.focusOffset, distance);
    this.focusAnimation = {
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition,
      toTarget,
      elapsed: 0,
      duration: Math.max(0.2, duration),
    };
  }

  public update(deltaSeconds = 1 / 60): boolean {
    const changed = this.controls.update();
    if (this.focusAnimation) {
      const animation = this.focusAnimation;
      animation.elapsed += Math.min(deltaSeconds, 0.1);
      const progress = THREE.MathUtils.clamp(animation.elapsed / animation.duration, 0, 1);
      const eased = THREE.MathUtils.smoothstep(progress, 0, 1);
      this.camera.position.lerpVectors(animation.fromPosition, animation.toPosition, eased);
      this.controls.target.lerpVectors(animation.fromTarget, animation.toTarget, eased);
      this.controls.update();
      if (progress >= 1) this.focusAnimation = undefined;
    }
    this.clampTargetToMap();
    this.keepCameraAboveTerrain();
    return changed || this.focusAnimation !== undefined;
  }

  public dispose(): void {
    this.controls.removeEventListener('start', this.onControlStart);
    this.controls.dispose();
  }

  private clampTargetToMap(): void {
    this.clampedTarget.copy(this.controls.target);
    this.clampedTarget.x = THREE.MathUtils.clamp(this.clampedTarget.x, -this.mapBounds.x, this.mapBounds.x);
    this.clampedTarget.z = THREE.MathUtils.clamp(this.clampedTarget.z, -this.mapBounds.y, this.mapBounds.y);
    this.panDelta.subVectors(this.clampedTarget, this.controls.target);
    if (this.panDelta.lengthSq() < 1e-10) return;
    // Move camera and target together so clamping a damped pan does not rotate
    // or zoom the camera unexpectedly at the edge of the map.
    this.controls.target.copy(this.clampedTarget);
    this.camera.position.add(this.panDelta);
  }

  private keepCameraAboveTerrain(): void {
    const meta = this.terrain.meta;
    const u = this.camera.position.x / meta.sceneWidth + 0.5;
    const v = this.camera.position.z / meta.sceneDepth + 0.5;
    const floor = this.sampleSceneHeight(u, v) + 0.28;
    if (this.camera.position.y >= floor) return;
    this.camera.position.y = floor;
    this.controls.update();
  }

  private sampleSceneHeight(u: number, v: number): number {
    return this.terrain.sampleUv(
      THREE.MathUtils.clamp(u, 0, 1),
      THREE.MathUtils.clamp(v, 0, 1),
    ) * this.terrain.meta.sceneUnitsPerMeter * this.exaggeration;
  }
}
