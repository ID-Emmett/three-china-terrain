import * as THREE from 'three/webgpu';
import { Line2NodeMaterial } from 'three/webgpu';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { SceneLayer } from '../app/SceneLayer';
import type { AdminLevel } from '../types/scene';
import type { TerrainData } from '../terrain/TerrainData';
import { decodeBoundaryBuffers } from './BoundaryData';

interface BoundaryStyle {
  color: string;
  opacity: number;
  lineWidth: number;
}

const DEFAULT_STYLES: Record<AdminLevel, BoundaryStyle> = {
  province: { color: '#dce9e4', opacity: 0.82, lineWidth: 1.25 },
  city: { color: '#b7ccc6', opacity: 0.62, lineWidth: 0.82 },
};

const LEVELS: AdminLevel[] = ['province', 'city'];

export class BoundaryLayer implements SceneLayer {
  public readonly object3d = new THREE.Group();
  private readonly lines = new Map<AdminLevel, LineSegments2>();
  private readonly materials = new Map<AdminLevel, Line2NodeMaterial>();
  private readonly enabled = new Map<AdminLevel, boolean>();
  private readonly baseOpacity = new Map<AdminLevel, number>();
  private readonly lodOpacity = new Map<AdminLevel, number>();
  private readonly terrain: TerrainData;
  private readonly diagnostics = new Map<AdminLevel, { segmentCount: number; sourceSegmentCount: number; maximumSurfaceErrorMeters: number; worstSample?: { u: number; v: number; renderedHeight: number; sampledHeight: number } }>();
  private readonly cityPositionsByProvince = new Map<number, Float32Array>();
  private readonly cityLineCache = new Map<string, LineSegments2>();
  private activeCityProvinceAdcodes = new Set<number>();

  public constructor(
    provinceBuffer: ArrayBuffer,
    cityBuffer: ArrayBuffer | undefined,
    terrain: TerrainData,
  ) {
    this.terrain = terrain;
    this.object3d.name = 'AdministrativeBoundaryLayer';

    for (const level of LEVELS) {
      const style = DEFAULT_STYLES[level];
      const material = new Line2NodeMaterial({
        color: style.color,
        linewidth: style.lineWidth,
        transparent: true,
        opacity: style.opacity,
        depthTest: true,
        depthWrite: false,
        alphaToCoverage: true,
      });
      material.polygonOffset = true;
      material.polygonOffsetFactor = -1;
      material.polygonOffsetUnits = -1;
      this.materials.set(level, material);
      this.enabled.set(level, true);
      this.baseOpacity.set(level, style.opacity);
      this.lodOpacity.set(level, level === 'province' ? 1 : 0);
    }
    this.setLevelData('province', [provinceBuffer]);
    if (cityBuffer) this.setLevelData('city', [cityBuffer]);
  }

  public setExaggeration(value: number): void {
    this.object3d.scale.y = value;
  }

  public setLevelVisible(level: AdminLevel, visible: boolean): void {
    this.enabled.set(level, visible);
    this.applyOpacity(level);
  }

  public setLodOpacity(level: AdminLevel, opacity: number): void {
    this.lodOpacity.set(level, THREE.MathUtils.clamp(opacity, 0, 1));
    this.applyOpacity(level);
  }

  public setCityProvinceFilter(provinceAdcodes: Iterable<number>): void {
    this.activeCityProvinceAdcodes = new Set(provinceAdcodes);
    this.activateCityLine();
  }

  public setLevelData(level: AdminLevel, buffers: ArrayBuffer[]): void {
    const previous = this.lines.get(level);
    if (previous) {
      this.object3d.remove(previous);
      if (level !== 'city') previous.geometry.dispose();
      this.lines.delete(level);
    }
    if (level === 'city') {
      for (const line of this.cityLineCache.values()) line.geometry.dispose();
      this.cityLineCache.clear();
      this.cityPositionsByProvince.clear();
    }
    if (buffers.length === 0) return;

    const decoded = decodeBoundaryBuffers(buffers, this.terrain);
    this.setDecodedLevelData(level, decoded);
  }

  private setDecodedLevelData(level: AdminLevel, decoded: ReturnType<typeof decodeBoundaryBuffers>): void {
    this.diagnostics.set(level, {
      segmentCount: decoded.segmentCount,
      sourceSegmentCount: decoded.sourceSegmentCount,
      maximumSurfaceErrorMeters: decoded.maximumSurfaceErrorMeters,
      worstSample: decoded.worstSample,
    });
    if (level === 'city') {
      this.groupCityPositions(decoded.positions, decoded.provinceAdcodes);
      this.activateCityLine();
      return;
    }
    if (decoded.positions.length === 0) return;
    const line = this.createLine(level, decoded.positions);
    this.lines.set(level, line);
    this.object3d.add(line);
    this.applyOpacity(level);
  }

  private createLine(level: AdminLevel, positions: Float32Array): LineSegments2 {
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const line = new LineSegments2(geometry, this.materials.get(level)!);
    line.name = `${level}BoundaryLines`;
    line.renderOrder = level === 'province' ? 5 : 4;
    line.frustumCulled = true;
    return line;
  }

  private groupCityPositions(positions: Float32Array, provinceAdcodes: Int32Array): void {
    if (provinceAdcodes.length * 6 !== positions.length) {
      throw new Error('City boundary province metadata does not match its segment count.');
    }
    const counts = new Map<number, number>();
    for (const provinceAdcode of provinceAdcodes) {
      counts.set(provinceAdcode, (counts.get(provinceAdcode) ?? 0) + 1);
    }
    for (const [provinceAdcode, count] of counts) {
      this.cityPositionsByProvince.set(provinceAdcode, new Float32Array(count * 6));
    }
    const offsets = new Map<number, number>();
    for (let segment = 0; segment < provinceAdcodes.length; segment += 1) {
      const provinceAdcode = provinceAdcodes[segment];
      const target = this.cityPositionsByProvince.get(provinceAdcode)!;
      const targetOffset = offsets.get(provinceAdcode) ?? 0;
      target.set(positions.subarray(segment * 6, segment * 6 + 6), targetOffset);
      offsets.set(provinceAdcode, targetOffset + 6);
    }
  }

  private activateCityLine(): void {
    const previous = this.lines.get('city');
    if (previous) {
      this.object3d.remove(previous);
      this.lines.delete('city');
    }
    if (this.cityPositionsByProvince.size === 0 || this.activeCityProvinceAdcodes.size === 0) return;

    const key = [...this.activeCityProvinceAdcodes].sort((a, b) => a - b).join(',');
    let line = this.cityLineCache.get(key);
    if (!line) {
      const groups = [...this.activeCityProvinceAdcodes]
        .map((provinceAdcode) => this.cityPositionsByProvince.get(provinceAdcode))
        .filter((positions): positions is Float32Array => positions !== undefined);
      const floatCount = groups.reduce((sum, positions) => sum + positions.length, 0);
      if (floatCount === 0) return;
      const positions = groups.length === 1 ? groups[0] : new Float32Array(floatCount);
      if (groups.length > 1) {
        let offset = 0;
        for (const group of groups) {
          positions.set(group, offset);
          offset += group.length;
        }
      }
      line = this.createLine('city', positions);
      line.name = `cityBoundaryLines:${key}`;
      this.cityLineCache.set(key, line);
    }
    this.lines.set('city', line);
    this.object3d.add(line);
    this.applyOpacity('city');
  }

  public setColor(level: AdminLevel, color: string): void {
    this.materials.get(level)?.color.set(color);
  }

  public setOpacity(level: AdminLevel, opacity: number): void {
    this.baseOpacity.set(level, THREE.MathUtils.clamp(opacity, 0, 1));
    this.applyOpacity(level);
  }

  public setLineWidth(level: AdminLevel, width: number): void {
    const material = this.materials.get(level);
    if (material) material.linewidth = width;
  }

  public resize(width: number, height: number): void {
    void width;
    void height;
  }

  public dispose(): void {
    const lines = new Set([...this.lines.values(), ...this.cityLineCache.values()]);
    for (const line of lines) line.geometry.dispose();
    this.cityLineCache.clear();
    this.cityPositionsByProvince.clear();
    for (const material of this.materials.values()) material.dispose();
  }

  public getDiagnostics(): Record<AdminLevel, { segmentCount: number; sourceSegmentCount: number; maximumSurfaceErrorMeters: number; worstSample?: { u: number; v: number; renderedHeight: number; sampledHeight: number } }> {
    return {
      province: this.diagnostics.get('province') ?? { segmentCount: 0, sourceSegmentCount: 0, maximumSurfaceErrorMeters: Number.POSITIVE_INFINITY },
      city: this.diagnostics.get('city') ?? { segmentCount: 0, sourceSegmentCount: 0, maximumSurfaceErrorMeters: Number.POSITIVE_INFINITY },
    };
  }

  private applyOpacity(level: AdminLevel): void {
    const opacity = (this.enabled.get(level) ? 1 : 0)
      * (this.baseOpacity.get(level) ?? 1)
      * (this.lodOpacity.get(level) ?? 1);
    const material = this.materials.get(level);
    if (material) material.opacity = opacity;
    const line = this.lines.get(level);
    if (line) line.visible = opacity > 0.001;
  }
}
