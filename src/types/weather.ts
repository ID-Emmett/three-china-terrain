/** Weather data is intentionally independent from the scene and renderer. */
export interface StationWind {
  /** Wind speed in metres per second. */
  speed: number;
  /** Direction in degrees, clockwise from north. */
  direction: number;
}

export interface StationWeather {
  /** Cloud coverage from 0 to 1. */
  cloudCover?: number;
  /** Precipitation intensity from 0 to 1 for the mock data. */
  precipitation?: number;
  wind?: StationWind;
}

export type LegacyWeatherKind = 'rain' | 'wind' | 'cloud';

export interface WeatherStyle {
  enabled: boolean;
  intensity: number;
  rainDensity: number;
  windSpeed: number;
  cloudScale: number;
  opacity: number;
}

/** Keeps old mock payloads valid while the business model migrates to composable data. */
export function normalizeStationWeather(
  weather: StationWeather | LegacyWeatherKind | undefined,
): StationWeather {
  if (!weather) return {};
  if (typeof weather !== 'string') return weather;
  if (weather === 'rain') return { cloudCover: 0.7, precipitation: 0.8 };
  if (weather === 'wind') return { wind: { speed: 5, direction: 90 } };
  return { cloudCover: 0.82 };
}

export function hasWeather(weather: StationWeather): boolean {
  return (weather.cloudCover ?? 0) > 0.01
    || (weather.precipitation ?? 0) > 0.01
    || (weather.wind?.speed ?? 0) > 0.01;
}
