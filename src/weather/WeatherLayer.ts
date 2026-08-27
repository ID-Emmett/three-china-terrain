import * as THREE from 'three/webgpu';
import type { SceneLayer } from '../app/SceneLayer';
import type { StationWeather, WeatherStyle } from '../types/weather';
import { hasWeather, normalizeStationWeather } from '../types/weather';
import { StationWeatherEmitter } from './StationWeatherEmitter';

export interface WeatherStationInput {
  id: string;
  weather?: StationWeather | 'rain' | 'wind' | 'cloud';
}

export type StationPositionProvider = (stationId: string) => THREE.Vector3 | undefined;

/** Owns station weather lifecycles while remaining independent of terrain and route layers. */
export class WeatherLayer implements SceneLayer {
  public readonly object3d = new THREE.Group();
  private readonly emitters = new Map<string, StationWeatherEmitter>();
  private readonly stations = new Map<string, WeatherStationInput>();
  private activeStationIds = new Set<string>();
  private style: WeatherStyle = {
    enabled: true, intensity: 0.72, rainDensity: 0.72, windSpeed: 0.75, cloudScale: 0.75, opacity: 0.65,
  };

  public constructor(
    stations: readonly WeatherStationInput[],
    private readonly getStationPosition: StationPositionProvider,
  ) {
    this.object3d.name = 'WeatherLayer';
    this.reconcile(stations);
  }

  /** Refreshes anchors after the station layer changes height or coordinates. */
  public refreshAnchors(): void {
    for (const [stationId, emitter] of this.emitters) {
      const position = this.getStationPosition(stationId);
      if (position) emitter.object3d.position.copy(position);
    }
  }

  /** Compatibility entry used when terrain exaggeration changes station anchors. */
  public setExaggeration(_value: number): void {
    this.refreshAnchors();
  }

  public setActiveStations(stationIds: Iterable<string>): void {
    this.activeStationIds = new Set(stationIds);
    this.applyVisibility();
  }

  public setStyle(style: WeatherStyle): void {
    this.style = style;
    for (const emitter of this.emitters.values()) emitter.setStyle(style);
    this.applyVisibility();
  }

  public tick(deltaSeconds: number, elapsedSeconds: number, camera: THREE.Camera, viewportHeight: number): void {
    if (!this.style.enabled) return;
    for (const emitter of this.emitters.values()) {
      if (emitter.object3d.visible) emitter.tick(deltaSeconds, elapsedSeconds, camera, viewportHeight);
    }
  }

  /** Incrementally adds, updates and removes station-scoped emitters. */
  public reconcile(stations: readonly WeatherStationInput[]): void {
    const nextIds = new Set(stations.map((station) => station.id));
    for (const stationId of this.stations.keys()) {
      if (!nextIds.has(stationId)) this.removeStation(stationId);
    }
    for (const station of stations) {
      this.stations.set(station.id, station);
      this.updateStation(station.id, normalizeStationWeather(station.weather));
    }
    this.refreshAnchors();
    this.applyVisibility();
  }

  public updateStation(stationId: string, weather: StationWeather): void {
    const station = this.stations.get(stationId);
    if (!station) return;
    station.weather = weather;
    let emitter = this.emitters.get(stationId);
    if (!hasWeather(weather)) {
      if (emitter) this.removeEmitter(stationId, emitter);
      return;
    }
    if (!emitter) {
      emitter = new StationWeatherEmitter(stationId, this.style);
      this.emitters.set(stationId, emitter);
      this.object3d.add(emitter.object3d);
    }
    emitter.update(weather);
    const position = this.getStationPosition(stationId);
    if (position) emitter.object3d.position.copy(position);
    emitter.object3d.visible = this.style.enabled && this.activeStationIds.has(stationId);
  }

  public removeStation(stationId: string): void {
    this.stations.delete(stationId);
    const emitter = this.emitters.get(stationId);
    if (emitter) this.removeEmitter(stationId, emitter);
  }

  public dispose(): void {
    for (const emitter of this.emitters.values()) emitter.dispose();
    this.emitters.clear();
    this.stations.clear();
    this.activeStationIds.clear();
    this.object3d.clear();
  }

  private applyVisibility(): void {
    this.object3d.visible = this.style.enabled;
    for (const [stationId, emitter] of this.emitters) {
      emitter.object3d.visible = this.style.enabled && this.activeStationIds.has(stationId);
    }
  }

  private removeEmitter(stationId: string, emitter: StationWeatherEmitter): void {
    emitter.object3d.removeFromParent();
    emitter.dispose();
    this.emitters.delete(stationId);
  }
}
