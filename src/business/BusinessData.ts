export type RouteMode = 'comparison' | 'radial';

import type { LegacyWeatherKind, StationWeather } from '../types/weather';

// Keep every visual that represents a station anchored at the same height.
// Routes use this value for their first/last points so the stroke terminates
// at the station sprite's centre instead of hovering a few pixels away.
export const STATION_ANCHOR_LIFT = 0.12;

export interface StationDatum {
  id: string;
  name: string;
  u: number;
  v: number;
  provinceAdcode: number;
  priority: 1 | 2 | 3;
  center?: boolean;
  weather?: StationWeather | LegacyWeatherKind;
}

export interface RouteDatum {
  id: string;
  mode: RouteMode;
  from: string;
  to: string;
  distanceKm: number;
  durationMinutes: number;
}

const COMPARISON_STATIONS: StationDatum[] = [
  { id: 'yuhua', name: '雨花桃阳点部', u: 0.5752, v: 0.6158, provinceAdcode: 430000, priority: 3, weather: { cloudCover: 0.72, precipitation: 0.82, wind: { speed: 3.2, direction: 112 } } },
  { id: 'muyun', name: '暮云桃阳二级中转场', u: 0.5787, v: 0.6111, provinceAdcode: 430000, priority: 2 },
  { id: 'huanghua', name: '黄花中转场陆运二区', u: 0.5846, v: 0.6071, provinceAdcode: 430000, priority: 2, weather: { wind: { speed: 7.5, direction: 72 } } },
  { id: 'xiaoshan', name: '萧山机场分拨二区', u: 0.6643, v: 0.5879, provinceAdcode: 330000, priority: 2, weather: { cloudCover: 0.88 } },
  { id: 'tonglu', name: '桐庐凤川二级中转场', u: 0.6498, v: 0.5906, provinceAdcode: 330000, priority: 2 },
  { id: 'jiande', name: '建德金溪点部', u: 0.6349, v: 0.5944, provinceAdcode: 330000, priority: 3 },
];

const RADIAL_STATIONS: StationDatum[] = [
  { id: 'dalingshan', name: '大岭山分拨站点', u: 0.5834, v: 0.7009, provinceAdcode: 440000, priority: 3, center: true },
  { id: 'guangzhou', name: '广州北部中转场', u: 0.5698, v: 0.6868, provinceAdcode: 440000, priority: 3, weather: { cloudCover: 0.78 } },
  { id: 'huizhou', name: '惠州惠城点部', u: 0.5972, v: 0.6941, provinceAdcode: 440000, priority: 3, weather: { cloudCover: 0.65, precipitation: 0.74, wind: { speed: 2.4, direction: 156 } } },
  { id: 'shenzhen', name: '深圳龙岗点部', u: 0.5912, v: 0.7082, provinceAdcode: 440000, priority: 3, weather: { wind: { speed: 6.2, direction: 38 } } },
  { id: 'foshan', name: '佛山顺德点部', u: 0.5684, v: 0.7044, provinceAdcode: 440000, priority: 3 },
  { id: 'heyuan', name: '河源中转场', u: 0.6034, v: 0.6787, provinceAdcode: 440000, priority: 2 },
];

export const STATIONS: StationDatum[] = [...COMPARISON_STATIONS, ...RADIAL_STATIONS];

export const ROUTES: RouteDatum[] = [
  { id: 'cmp-1', mode: 'comparison', from: 'yuhua', to: 'muyun', distanceKm: 28, durationMinutes: 42 },
  { id: 'cmp-2', mode: 'comparison', from: 'muyun', to: 'huanghua', distanceKm: 39, durationMinutes: 55 },
  { id: 'cmp-3', mode: 'comparison', from: 'huanghua', to: 'xiaoshan', distanceKm: 830, durationMinutes: 620 },
  { id: 'cmp-4', mode: 'comparison', from: 'xiaoshan', to: 'tonglu', distanceKm: 76, durationMinutes: 68 },
  { id: 'cmp-5', mode: 'comparison', from: 'tonglu', to: 'jiande', distanceKm: 62, durationMinutes: 57 },
  { id: 'rad-1', mode: 'radial', from: 'dalingshan', to: 'guangzhou', distanceKm: 74, durationMinutes: 72 },
  { id: 'rad-2', mode: 'radial', from: 'dalingshan', to: 'huizhou', distanceKm: 96, durationMinutes: 95 },
  { id: 'rad-3', mode: 'radial', from: 'dalingshan', to: 'shenzhen', distanceKm: 58, durationMinutes: 63 },
  { id: 'rad-4', mode: 'radial', from: 'dalingshan', to: 'foshan', distanceKm: 91, durationMinutes: 88 },
  { id: 'rad-5', mode: 'radial', from: 'dalingshan', to: 'heyuan', distanceKm: 154, durationMinutes: 132 },
];

export function formatRouteMetric(route: RouteDatum): string {
  const hours = Math.floor(route.durationMinutes / 60);
  const minutes = route.durationMinutes % 60;
  return `${route.distanceKm} km · ${hours > 0 ? `${hours}h ` : ''}${minutes}m`;
}

export function stationsForMode(mode: RouteMode): StationDatum[] {
  const ids = new Set(
    ROUTES.filter((route) => route.mode === mode).flatMap((route) => [route.from, route.to]),
  );
  return STATIONS.filter((station) => ids.has(station.id));
}
