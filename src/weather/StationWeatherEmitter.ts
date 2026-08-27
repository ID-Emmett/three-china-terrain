import * as THREE from 'three/webgpu';
import { hasWeather, type StationWeather, type WeatherStyle } from '../types/weather';
import { CloudEffect } from './CloudEffect';
import { RainEffect } from './RainEffect';
import { WindEffect } from './WindEffect';
import type { WeatherEffect } from './WeatherEffect';

type EffectKind = 'cloud' | 'rain' | 'wind';

const EFFECT_FACTORIES: Record<EffectKind, (seed: number) => WeatherEffect> = {
  cloud: (seed) => new CloudEffect(seed),
  rain: (seed) => new RainEffect(seed),
  wind: (seed) => new WindEffect(seed),
};

export class StationWeatherEmitter {
  public readonly object3d = new THREE.Group();
  private readonly effects = new Map<EffectKind, WeatherEffect>();
  private weather: StationWeather = {};

  public constructor(
    public readonly stationId: string,
    private style: WeatherStyle,
  ) {
    this.object3d.name = `station-${stationId}-weather`;
  }

  public update(weather: StationWeather): void {
    this.weather = weather;
    this.reconcileEffect('cloud', (weather.cloudCover ?? 0) > 0.01);
    this.reconcileEffect('rain', (weather.precipitation ?? 0) > 0.01);
    this.reconcileEffect('wind', (weather.wind?.speed ?? 0) > 0.01);
    for (const effect of this.effects.values()) {
      effect.update(weather);
      effect.setStyle(this.style);
    }
  }

  public setStyle(style: WeatherStyle): void {
    this.style = style;
    for (const effect of this.effects.values()) effect.setStyle(style);
  }

  public tick(deltaSeconds: number, elapsedSeconds: number, camera: THREE.Camera, viewportHeight: number): void {
    for (const effect of this.effects.values()) {
      effect.tick(deltaSeconds, elapsedSeconds, camera, viewportHeight);
    }
  }

  public hasEffects(): boolean {
    return hasWeather(this.weather) && this.effects.size > 0;
  }

  public dispose(): void {
    for (const effect of this.effects.values()) effect.dispose();
    this.effects.clear();
    this.object3d.clear();
  }

  private reconcileEffect(kind: EffectKind, active: boolean): void {
    const existing = this.effects.get(kind);
    if (active && !existing) {
      const effect = EFFECT_FACTORIES[kind](hash(this.stationId, kind));
      effect.setStyle(this.style);
      this.effects.set(kind, effect);
      this.object3d.add(effect.object3d);
    } else if (!active && existing) {
      existing.object3d.removeFromParent();
      existing.dispose();
      this.effects.delete(kind);
    }
  }
}

function hash(stationId: string, kind: EffectKind): number {
  let result = kind === 'cloud' ? 11 : kind === 'rain' ? 23 : 37;
  for (let index = 0; index < stationId.length; index += 1) {
    result = ((result * 31) + stationId.charCodeAt(index)) | 0;
  }
  return result;
}
