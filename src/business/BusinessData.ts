export type RouteMode = 'comparison' | 'radial';
export type ComparisonRouteId = 'route-a' | 'route-b';

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
  labelOffset?: readonly [number, number];
  weather?: StationWeather | LegacyWeatherKind;
}

export interface RouteDatum {
  id: string;
  mode: RouteMode;
  from: string;
  to: string;
  distanceKm?: number;
  durationMinutes?: number;
  comparisonRouteIds?: readonly ComparisonRouteId[];
  comparisonShared?: boolean;
  label?: string;
}

const COMPARISON_STATIONS: StationDatum[] = [
  { id: 'shunqing-gaoping', name: '顺庆高坪点部', u: 0.481467, v: 0.571426, provinceAdcode: 510000, priority: 3, labelOffset: [0.5, 2.05] },
  { id: 'shunqing-gaoping-hub', name: '顺庆高坪二级中转场', u: 0.482, v: 0.571596, provinceAdcode: 510000, priority: 2, labelOffset: [0.12, -0.8] },
  { id: 'datang-hub', name: '大塘中转场一区', u: 0.577867, v: 0.697691, provinceAdcode: 440000, priority: 3, labelOffset: [0.5, 2.05] },
  { id: 'baoan-airport', name: '宝安机场分拨二区', u: 0.584133, v: 0.704813, provinceAdcode: 440000, priority: 3, labelOffset: [1.05, 0.5] },
  { id: 'yunshan-jiangbei', name: '云山江北二级中转场', u: 0.592, v: 0.697216, provinceAdcode: 440000, priority: 3, labelOffset: [-0.05, 0.5] },
  { id: 'huijiang-shuikou', name: '惠江水口二级中转场', u: 0.593067, v: 0.697533, provinceAdcode: 440000, priority: 3, labelOffset: [0.5, 2.2] },
  { id: 'dongxiang-dongxing', name: '东祥东星二级中转场', u: 0.591067, v: 0.698801, provinceAdcode: 440000, priority: 2, labelOffset: [1.08, 0.5] },
  { id: 'dongxiang-yinghe', name: '东祥赢合点部', u: 0.590533, v: 0.699276, provinceAdcode: 440000, priority: 3, labelOffset: [0.5, -0.9] },
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
  { id: 'cmp-a-shared-1', mode: 'comparison', from: 'shunqing-gaoping', to: 'shunqing-gaoping-hub', comparisonRouteIds: ['route-a'], comparisonShared: true },
  { id: 'cmp-a-shared-2', mode: 'comparison', from: 'shunqing-gaoping-hub', to: 'datang-hub', comparisonRouteIds: ['route-a'], comparisonShared: true },
  { id: 'cmp-b-shared-1', mode: 'comparison', from: 'shunqing-gaoping', to: 'shunqing-gaoping-hub', comparisonRouteIds: ['route-b'], comparisonShared: true },
  { id: 'cmp-b-shared-2', mode: 'comparison', from: 'shunqing-gaoping-hub', to: 'datang-hub', comparisonRouteIds: ['route-b'], comparisonShared: true },
  { id: 'cmp-a-1', mode: 'comparison', from: 'datang-hub', to: 'baoan-airport', comparisonRouteIds: ['route-a'], label: '路线 A · 宝安机场' },
  { id: 'cmp-a-2', mode: 'comparison', from: 'baoan-airport', to: 'huijiang-shuikou', comparisonRouteIds: ['route-a'] },
  { id: 'cmp-a-3', mode: 'comparison', from: 'huijiang-shuikou', to: 'dongxiang-yinghe', comparisonRouteIds: ['route-a'] },
  { id: 'cmp-b-1', mode: 'comparison', from: 'datang-hub', to: 'yunshan-jiangbei', comparisonRouteIds: ['route-b'], label: '路线 B · 云山江北 / 东祥东星' },
  { id: 'cmp-b-2', mode: 'comparison', from: 'yunshan-jiangbei', to: 'huijiang-shuikou', comparisonRouteIds: ['route-b'] },
  { id: 'cmp-b-3', mode: 'comparison', from: 'huijiang-shuikou', to: 'dongxiang-dongxing', comparisonRouteIds: ['route-b'] },
  { id: 'cmp-b-4', mode: 'comparison', from: 'dongxiang-dongxing', to: 'dongxiang-yinghe', comparisonRouteIds: ['route-b'] },
  { id: 'rad-1', mode: 'radial', from: 'dalingshan', to: 'guangzhou', distanceKm: 74, durationMinutes: 72 },
  { id: 'rad-2', mode: 'radial', from: 'dalingshan', to: 'huizhou', distanceKm: 96, durationMinutes: 95 },
  { id: 'rad-3', mode: 'radial', from: 'dalingshan', to: 'shenzhen', distanceKm: 58, durationMinutes: 63 },
  { id: 'rad-4', mode: 'radial', from: 'dalingshan', to: 'foshan', distanceKm: 91, durationMinutes: 88 },
  { id: 'rad-5', mode: 'radial', from: 'dalingshan', to: 'heyuan', distanceKm: 154, durationMinutes: 132 },
];

export function formatRouteMetric(route: RouteDatum): string {
  if (route.distanceKm === undefined || route.durationMinutes === undefined) {
    return route.label ?? '';
  }
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
