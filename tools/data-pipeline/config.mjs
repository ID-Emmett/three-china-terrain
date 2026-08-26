import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(HERE, '../..');
export const CACHE_ROOT = path.join(PROJECT_ROOT, 'data/cache');
export const OUTPUT_ROOT = path.join(PROJECT_ROOT, 'public/data');

export const REGION = Object.freeze({
  west: 70,
  east: 145,
  south: 3,
  north: 58,
  terrainZoom: 6,
  terrainDetailZoom: 8,
  terrainWidth: 512,
  terrainHeight: 384,
  maskWidth: 1536,
  maskHeight: 1152,
  sceneWidth: 120,
});

export const EARTH_RADIUS_METERS = 6378137;

export function clampLatitude(latitude) {
  return Math.max(-85.05112878, Math.min(85.05112878, latitude));
}

export function mercatorY(latitude) {
  const radians = (clampLatitude(latitude) * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + radians / 2));
}

const NORTH_Y = mercatorY(REGION.north);
const SOUTH_Y = mercatorY(REGION.south);
const WEST_X = (REGION.west * Math.PI) / 180;
const EAST_X = (REGION.east * Math.PI) / 180;

export const REGION_METRICS = Object.freeze({
  northY: NORTH_Y,
  southY: SOUTH_Y,
  westX: WEST_X,
  eastX: EAST_X,
  projectedWidthMeters: (EAST_X - WEST_X) * EARTH_RADIUS_METERS,
  projectedDepthMeters: (NORTH_Y - SOUTH_Y) * EARTH_RADIUS_METERS,
  sceneDepth: REGION.sceneWidth * ((NORTH_Y - SOUTH_Y) / (EAST_X - WEST_X)),
  sceneUnitsPerMeter: REGION.sceneWidth / ((EAST_X - WEST_X) * EARTH_RADIUS_METERS),
});

export function lonLatToUv(longitude, latitude) {
  const x = (longitude * Math.PI) / 180;
  const y = mercatorY(latitude);
  return {
    u: (x - WEST_X) / (EAST_X - WEST_X),
    v: (NORTH_Y - y) / (NORTH_Y - SOUTH_Y),
  };
}

export function uvToLonLat(u, v) {
  const x = WEST_X + u * (EAST_X - WEST_X);
  const y = NORTH_Y - v * (NORTH_Y - SOUTH_Y);
  return {
    longitude: (x * 180) / Math.PI,
    latitude: (Math.atan(Math.sinh(y)) * 180) / Math.PI,
  };
}

export function uvToScene(u, v) {
  return {
    x: (u - 0.5) * REGION.sceneWidth,
    z: (v - 0.5) * REGION_METRICS.sceneDepth,
  };
}

export function lonToTileX(longitude, zoom) {
  return Math.floor(((longitude + 180) / 360) * 2 ** zoom);
}

export function latToTileY(latitude, zoom) {
  const y = mercatorY(latitude);
  return Math.floor(((1 - y / Math.PI) / 2) * 2 ** zoom);
}
