import type { TerrainMeta } from '../types/scene';

export const TERRAIN_RENDER_GRID_SCALE = 1.5;
export const TERRAIN_SURFACE_MIP_LEVELS = 4;
export const TERRAIN_SURFACE_FORMAT_VERSION = 1;

const MAGIC = 'TDF1';
const SHAPE_FACTOR_MINIMUM = 0.9;
const SHAPE_FACTOR_RANGE = 0.14;

export interface TerrainSurfaceMeta extends TerrainMeta {
  reliefResidualRangeMeters: number;
}

export interface TerrainSurfaceLevel {
  data: Uint8Array;
  width: number;
  height: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return p1 + 0.5 * t * (
    p2 - p0
    + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0))
  );
}

function sampleSourceSmooth(
  meta: TerrainMeta,
  heights: Int16Array,
  u: number,
  v: number,
): number {
  const { width, height } = meta;
  const x = clamp(u, 0, 1) * (width - 1);
  const y = clamp(v, 0, 1) * (height - 1);
  const x1 = Math.floor(x);
  const y1 = Math.floor(y);
  const tx = x - x1;
  const ty = y - y1;
  const sample = (sx: number, sy: number): number => heights[
    clamp(sy, 0, height - 1) * width + clamp(sx, 0, width - 1)
  ];

  let containsSea = false;
  let localMinimum = Number.POSITIVE_INFINITY;
  let localMaximum = Number.NEGATIVE_INFINITY;
  const rows = [0, 0, 0, 0];
  for (let row = -1; row <= 2; row += 1) {
    const p0 = sample(x1 - 1, y1 + row);
    const p1 = sample(x1, y1 + row);
    const p2 = sample(x1 + 1, y1 + row);
    const p3 = sample(x1 + 2, y1 + row);
    containsSea ||= p0 === 0 || p1 === 0 || p2 === 0 || p3 === 0;
    localMinimum = Math.min(localMinimum, p0, p1, p2, p3);
    localMaximum = Math.max(localMaximum, p0, p1, p2, p3);
    rows[row + 1] = cubic(p0, p1, p2, p3, tx);
  }
  if (!containsSea) {
    return clamp(cubic(rows[0], rows[1], rows[2], rows[3], ty), localMinimum, localMaximum);
  }

  const a = sample(x1, y1);
  const b = sample(x1 + 1, y1);
  const c = sample(x1, y1 + 1);
  const d = sample(x1 + 1, y1 + 1);
  return ((a * (1 - tx) + b * tx) * (1 - ty)) + ((c * (1 - tx) + d * tx) * ty);
}

export function buildTerrainRenderHeightGrid(
  meta: TerrainMeta,
  heights: Int16Array,
): { data: Float32Array; width: number; height: number } {
  const width = Math.round(meta.width * TERRAIN_RENDER_GRID_SCALE);
  const height = Math.round(meta.height * TERRAIN_RENDER_GRID_SCALE);
  const output = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      output[y * width + x] = sampleSourceSmooth(meta, heights, x / (width - 1), v);
    }
  }

  const smoothed = new Float32Array(output);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const center = output[index];
      if (center <= 0) continue;
      const neighbours = [
        output[index - width], output[index + width], output[index - 1], output[index + 1],
        output[index - width - 1], output[index - width + 1],
        output[index + width - 1], output[index + width + 1],
      ];
      if (neighbours.some((value) => value <= 0)) continue;
      const blur = (
        center * 4
        + (neighbours[0] + neighbours[1] + neighbours[2] + neighbours[3]) * 2
        + neighbours[4] + neighbours[5] + neighbours[6] + neighbours[7]
      ) / 16;
      smoothed[index] = center * 0.82 + blur * 0.18;
    }
  }
  return { data: smoothed, width, height };
}

function downsampleScalar(
  source: Float32Array,
  width: number,
  height: number,
): { data: Float32Array; width: number; height: number } {
  const targetWidth = Math.max(1, Math.floor(width / 2));
  const targetHeight = Math.max(1, Math.floor(height / 2));
  const output = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = x * 2;
      const y0 = y * 2;
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      output[y * targetWidth + x] = (
        source[y0 * width + x0]
        + source[y0 * width + x1]
        + source[y1 * width + x0]
        + source[y1 * width + x1]
      ) * 0.25;
    }
  }
  return { data: output, width: targetWidth, height: targetHeight };
}

function sampleRelief(pixels: Uint8ClampedArray, width: number, height: number, u: number, v: number): number {
  const x = clamp(u, 0, 1) * (width - 1);
  const y = clamp(v, 0, 1) * (height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const at = (px: number, py: number): number => pixels[(py * width + px) * 4] / 255;
  return (
    (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty)
    + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty
  );
}

function encodeNormal(output: Uint8Array, offset: number, x: number, y: number, z: number): void {
  const inverseLength = 1 / Math.hypot(x, y, z);
  output[offset + 2] = Math.round((clamp(x * inverseLength, -1, 1) * 0.5 + 0.5) * 255);
  output[offset + 3] = Math.round((clamp(z * inverseLength, -1, 1) * 0.5 + 0.5) * 255);
}

function buildNormalPixels(
  meta: TerrainSurfaceMeta,
  heights: Float32Array,
  width: number,
  height: number,
  reliefPixels: Uint8ClampedArray,
  reliefWidth: number,
  reliefHeight: number,
): Uint8Array {
  const output = new Uint8Array(width * height * 4);
  const sample = (x: number, y: number): number => heights[
    clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)
  ];
  const reliefTexelX = 1 / (reliefWidth - 1);
  const reliefTexelY = 1 / (reliefHeight - 1);
  const residualRangeLocal = meta.reliefResidualRangeMeters * meta.sceneUnitsPerMeter;
  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const targetY = height - y - 1;
      const offset = (targetY * width + x) * 4;
      const baseSlopeX = (sample(x + 1, y) - sample(x - 1, y)) * meta.sceneUnitsPerMeter
        / (2 * meta.sceneWidth / (width - 1));
      const baseSlopeZ = (sample(x, y + 1) - sample(x, y - 1)) * meta.sceneUnitsPerMeter
        / (2 * meta.sceneDepth / (height - 1));
      const residualSlopeX = (
        sampleRelief(reliefPixels, reliefWidth, reliefHeight, u + reliefTexelX, v)
        - sampleRelief(reliefPixels, reliefWidth, reliefHeight, u - reliefTexelX, v)
      ) * residualRangeLocal / (meta.sceneWidth / (reliefWidth - 1));
      const residualSlopeZ = (
        sampleRelief(reliefPixels, reliefWidth, reliefHeight, u, v + reliefTexelY)
        - sampleRelief(reliefPixels, reliefWidth, reliefHeight, u, v - reliefTexelY)
      ) * residualRangeLocal / (meta.sceneDepth / (reliefHeight - 1));
      encodeNormal(
        output,
        offset,
        -(baseSlopeX + residualSlopeX * 0.92),
        1,
        -(baseSlopeZ + residualSlopeZ * 0.92),
      );
    }
  }
  return output;
}

function decodeNormal(pixels: Uint8Array, offset: number): { x: number; y: number; z: number } {
  const x = pixels[offset + 2] / 255 * 2 - 1;
  const z = pixels[offset + 3] / 255 * 2 - 1;
  return { x, y: Math.sqrt(Math.max(0, 1 - x * x - z * z)), z };
}

function downsampleNormals(
  source: Uint8Array,
  width: number,
  height: number,
): { data: Uint8Array; width: number; height: number } {
  const targetWidth = Math.max(1, Math.floor(width / 2));
  const targetHeight = Math.max(1, Math.floor(height / 2));
  const output = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let oy = 0; oy < 2; oy += 1) {
        for (let ox = 0; ox < 2; ox += 1) {
          const sx = Math.min(width - 1, x * 2 + ox);
          const sy = Math.min(height - 1, y * 2 + oy);
          const normal = decodeNormal(source, (sy * width + sx) * 4);
          nx += normal.x;
          ny += normal.y;
          nz += normal.z;
        }
      }
      encodeNormal(output, (y * targetWidth + x) * 4, nx, ny, nz);
    }
  }
  return { data: output, width: targetWidth, height: targetHeight };
}

function buildPackedSurfacePixels(
  meta: TerrainSurfaceMeta,
  heights: Float32Array,
  normals: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const output = new Uint8Array(normals);
  const elevationRange = Math.max(1, meta.maximumElevationMeters - meta.minimumElevationMeters);
  const sample = (x: number, y: number): number => heights[
    clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)
  ];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const targetY = height - y - 1;
      const offset = (targetY * width + x) * 4;
      const center = sample(x, y);
      const left2 = sample(x - 2, y);
      const right2 = sample(x + 2, y);
      const up2 = sample(x, y - 2);
      const down2 = sample(x, y + 2);
      const curvature = clamp((left2 + right2 + up2 + down2 - center * 4) * 0.25 / 180, -1, 1);
      const ringAverage = (left2 + right2 + up2 + down2) * 0.25;
      const localRelief = Math.max(24, Math.abs(right2 - left2) * 0.5 + Math.abs(down2 - up2) * 0.5);
      const cavity = clamp(0.5 + (ringAverage - center) / localRelief, 0, 1);
      const shapeFactor = (0.94 + (1 - cavity) * 0.06) * (0.98 + curvature * 0.035);
      output[offset] = Math.round(clamp(
        (center - meta.minimumElevationMeters) / elevationRange,
        0,
        1,
      ) * 255);
      output[offset + 1] = Math.round(clamp(
        (shapeFactor - SHAPE_FACTOR_MINIMUM) / SHAPE_FACTOR_RANGE,
        0,
        1,
      ) * 255);
    }
  }
  return output;
}

export function buildTerrainSurfaceBundle(
  meta: TerrainSurfaceMeta,
  renderHeights: Float32Array,
  width: number,
  height: number,
  reliefPixels: Uint8ClampedArray,
  reliefWidth: number,
  reliefHeight: number,
): ArrayBuffer {
  const levels: TerrainSurfaceLevel[] = [];
  let heightLevel = { data: renderHeights, width, height };
  let normalLevel = {
    data: buildNormalPixels(meta, renderHeights, width, height, reliefPixels, reliefWidth, reliefHeight),
    width,
    height,
  };
  for (let level = 0; level < TERRAIN_SURFACE_MIP_LEVELS; level += 1) {
    levels.push({
      data: buildPackedSurfacePixels(
        meta,
        heightLevel.data,
        normalLevel.data,
        heightLevel.width,
        heightLevel.height,
      ),
      width: heightLevel.width,
      height: heightLevel.height,
    });
    heightLevel = downsampleScalar(heightLevel.data, heightLevel.width, heightLevel.height);
    normalLevel = downsampleNormals(normalLevel.data, normalLevel.width, normalLevel.height);
  }

  const byteLength = 8 + levels.reduce((sum, level) => sum + 8 + level.data.byteLength, 0);
  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  for (let index = 0; index < MAGIC.length; index += 1) bytes[index] = MAGIC.charCodeAt(index);
  view.setUint32(4, levels.length, true);
  let offset = 8;
  for (const level of levels) {
    view.setUint32(offset, level.width, true);
    view.setUint32(offset + 4, level.height, true);
    offset += 8;
    bytes.set(level.data, offset);
    offset += level.data.byteLength;
  }
  return buffer;
}

export function decodeTerrainSurfaceBundle(buffer: ArrayBuffer): TerrainSurfaceLevel[] {
  if (buffer.byteLength < 8) throw new Error('Terrain derived surface is truncated.');
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC) throw new Error(`Unsupported terrain derived surface: ${magic}.`);
  const view = new DataView(buffer);
  const mipLevels = view.getUint32(4, true);
  if (mipLevels !== TERRAIN_SURFACE_MIP_LEVELS) {
    throw new Error(`Invalid terrain derived surface mip count: ${mipLevels}.`);
  }
  const levels: TerrainSurfaceLevel[] = [];
  let offset = 8;
  for (let level = 0; level < mipLevels; level += 1) {
    if (offset + 8 > buffer.byteLength) throw new Error('Terrain derived surface mip header is truncated.');
    const width = view.getUint32(offset, true);
    const height = view.getUint32(offset + 4, true);
    offset += 8;
    const byteLength = width * height * 4;
    if (width < 1 || height < 1 || offset + byteLength > buffer.byteLength) {
      throw new Error(`Invalid terrain derived surface mip ${level}.`);
    }
    levels.push({ data: new Uint8Array(buffer, offset, byteLength), width, height });
    offset += byteLength;
  }
  if (offset !== buffer.byteLength) throw new Error('Terrain derived surface contains trailing bytes.');
  return levels;
}
