import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import pngjs from 'pngjs';
import sharp from 'sharp';
import simplify from 'simplify-js';
import {
  CACHE_ROOT,
  OUTPUT_ROOT,
  PROJECT_ROOT,
  REGION,
  REGION_METRICS,
  lonLatToUv,
  mercatorY,
  uvToLonLat,
} from './config.mjs';
import { ensureDirectory, exists, readJson, writeJson } from './io.mjs';

const { PNG } = pngjs;
const NASA_IMAGERY_FILE = path.join(CACHE_ROOT, 'nasa-blue-marble-2004-08-21600.jpg');
const ATTRIBUTION_FILE = path.join(PROJECT_ROOT, 'tools', 'data-pipeline', 'ATTRIBUTION.md');
const RELIEF_WIDTH = 1024;
const RELIEF_HEIGHT = 768;
const RELIEF_TILE_WIDTH = 8192;
const RELIEF_TILE_HEIGHT = 6144;
const RELIEF_TILE_SIZE = 512;
const RELIEF_TILE_GUTTER = 2;
const RELIEF_TILE_DIRECTORY = 'terrain-relief-tiles';
const RELIEF_TILE_RESIDENT_COUNT = 36;
const IMAGERY_WIDTH = 2048;
const IMAGERY_HEIGHT = 1536;
const RELIEF_RESIDUAL_RANGE_METERS = 720;
const TERRARIUM_TILE_SIZE = 256;
const COAST_FLATTEN_DISTANCE_PIXELS = 3;
const ADMIN_LEVELS = ['province', 'city'];
const SIMPLIFY_TOLERANCE = {
  province: 0.00022,
  city: 0.00016,
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function boxBlur(source, width, height, radius) {
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);
  const diameter = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      sum += source[row + clamp(offset, 0, width - 1)];
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum / diameter;
      sum -= source[row + clamp(x - radius, 0, width - 1)];
      sum += source[row + clamp(x + radius + 1, 0, width - 1)];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      sum += horizontal[clamp(offset, 0, height - 1) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / diameter;
      sum -= horizontal[clamp(y - radius, 0, height - 1) * width + x];
      sum += horizontal[clamp(y + radius + 1, 0, height - 1) * width + x];
    }
  }
  return output;
}

function directionalRelief(heights, width, height, x, y) {
  const left = heights[y * width + Math.max(0, x - 1)];
  const right = heights[y * width + Math.min(width - 1, x + 1)];
  const up = heights[Math.max(0, y - 1) * width + x];
  const down = heights[Math.min(height - 1, y + 1) * width + x];
  const slopeX = (right - left) * REGION_METRICS.sceneUnitsPerMeter * 38
    / (2 * REGION.sceneWidth / (width - 1));
  const slopeZ = (down - up) * REGION_METRICS.sceneUnitsPerMeter * 38
    / (2 * REGION_METRICS.sceneDepth / (height - 1));
  const inverseLength = 1 / Math.hypot(slopeX, 1, slopeZ);
  const light = (-slopeX * inverseLength) * -0.557
    + inverseLength * 0.743
    + (-slopeZ * inverseLength) * -0.371;
  return clamp((light - 0.743) * 1.65, -1, 1);
}

async function buildReliefTexture(sourceHeights, width, height) {
  const fineHeights = boxBlur(Float32Array.from(sourceHeights), width, height, 1);
  const mediumHeights = boxBlur(fineHeights, width, height, 3);
  const broadHeights = boxBlur(boxBlur(mediumHeights, width, height, 9), width, height, 9);
  const output = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * 4;
      const broadLight = directionalRelief(broadHeights, width, height, x, y);
      const mediumLight = directionalRelief(mediumHeights, width, height, x, y);
      const fineLight = directionalRelief(fineHeights, width, height, x, y);
      const heightResidual = clamp(
        (fineHeights[index] - broadHeights[index]) / RELIEF_RESIDUAL_RANGE_METERS,
        -1,
        1,
      );
      // R is a signed high-resolution elevation residual. The runtime adds its
      // gradient to the base DEM normal, so these texels create actual ridge
      // faces instead of differentiating an already-lit hillshade image.
      output[offset] = Math.round((heightResidual * 0.5 + 0.5) * 255);
      output[offset + 1] = Math.round((broadLight * 0.5 + 0.5) * 255);
      output[offset + 2] = Math.round((mediumLight * 0.5 + 0.5) * 255);
      output[offset + 3] = Math.round((fineLight * 0.5 + 0.5) * 255);
    }
  }
  await sharp(output, { raw: { width, height, channels: 4 } })
    .webp({ quality: 90, alphaQuality: 90, smartSubsample: true, effort: 6 })
    .toFile(path.join(OUTPUT_ROOT, 'terrain-relief.webp'));
}

async function buildTerrainImagery() {
  const sourceMetadata = await sharp(NASA_IMAGERY_FILE).metadata();
  const sourceWidth = sourceMetadata.width;
  const sourceHeight = sourceMetadata.height;
  if (!sourceWidth || !sourceHeight) throw new Error('NASA imagery has no dimensions.');
  const sourceX = (longitude) => ((longitude + 180) / 360) * sourceWidth;
  const sourceY = (latitude) => ((90 - latitude) / 180) * sourceHeight;
  const cropLeft = Math.floor(sourceX(REGION.west));
  const cropTop = Math.floor(sourceY(REGION.north));
  const cropWidth = Math.ceil(sourceX(REGION.east)) - cropLeft + 1;
  const cropHeight = Math.ceil(sourceY(REGION.south)) - cropTop + 1;
  const width = IMAGERY_WIDTH;
  const height = IMAGERY_HEIGHT;
  // Decode only the Asia crop, then resize horizontally before the custom
  // latitude-to-Mercator vertical reprojection. This avoids a ~1 GB RGBA
  // allocation for the 21600x10800 global source.
  const stripHeight = Math.min(4096, cropHeight);
  const { data: strip, info } = await sharp(NASA_IMAGERY_FILE)
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .resize(width, stripHeight, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const output = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1);
    const { latitude } = uvToLonLat(0.5, v);
    const stripY = clamp(
      ((sourceY(latitude) - cropTop) / cropHeight) * (stripHeight - 1),
      0,
      stripHeight - 1,
    );
    const y0 = Math.floor(stripY);
    const y1 = Math.min(stripHeight - 1, y0 + 1);
    const blend = stripY - y0;
    for (let x = 0; x < width; x += 1) {
      const outputOffset = (y * width + x) * 3;
      const topOffset = (y0 * width + x) * info.channels;
      const bottomOffset = (y1 * width + x) * info.channels;
      for (let channel = 0; channel < 3; channel += 1) {
        output[outputOffset + channel] = Math.round(
          strip[topOffset + channel] * (1 - blend) + strip[bottomOffset + channel] * blend,
        );
      }
    }
  }

  await sharp(output, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 82, chromaSubsampling: '4:2:0', mozjpeg: true })
    .toFile(path.join(OUTPUT_ROOT, 'terrain-imagery.jpg'));
  return { width, height };
}

function decodeTerrariumPixel(png, x, y) {
  const pixelIndex = (y * png.width + x) * 4;
  return png.data[pixelIndex] * 256
    + png.data[pixelIndex + 1]
    + png.data[pixelIndex + 2] / 256
    - 32768;
}

function decodeTerrariumGlobalPixel(terrainTiles, globalPixelX, globalPixelY) {
  const { tiles, zoom } = terrainTiles;
  const tileX = Math.floor(globalPixelX / TERRARIUM_TILE_SIZE);
  const tileY = Math.floor(globalPixelY / TERRARIUM_TILE_SIZE);
  const pixelX = ((globalPixelX % TERRARIUM_TILE_SIZE) + TERRARIUM_TILE_SIZE)
    % TERRARIUM_TILE_SIZE;
  const pixelY = ((globalPixelY % TERRARIUM_TILE_SIZE) + TERRARIUM_TILE_SIZE)
    % TERRARIUM_TILE_SIZE;
  const tile = tiles.get(`${tileX}/${tileY}`);
  if (!tile) throw new Error(`Missing terrain tile ${zoom}/${tileX}/${tileY}`);
  return decodeTerrariumPixel(tile, pixelX, pixelY);
}

async function loadTerrainTiles(manifestKey = 'terrain') {
  const downloadManifest = await readJson(path.join(CACHE_ROOT, 'download-manifest.json'));
  const { zoom, minX, maxX, minY, maxY } = downloadManifest[manifestKey];
  const tiles = new Map();

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const filePath = path.join(CACHE_ROOT, 'terrain', String(zoom), String(x), `${y}.png`);
      const buffer = await fs.readFile(filePath);
      tiles.set(`${x}/${y}`, PNG.sync.read(buffer));
    }
  }

  return { tiles, zoom };
}

function sampleTerrainTile(terrainTiles, longitude, latitude) {
  const { zoom } = terrainTiles;
  const scale = 2 ** zoom;
  const globalX = ((longitude + 180) / 360) * scale * TERRARIUM_TILE_SIZE - 0.5;
  const globalY = ((1 - mercatorY(latitude) / Math.PI) / 2) * scale * TERRARIUM_TILE_SIZE - 0.5;
  const x0 = Math.floor(globalX);
  const y0 = Math.floor(globalY);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const tx = globalX - x0;
  const ty = globalY - y0;
  const a = decodeTerrariumGlobalPixel(terrainTiles, x0, y0);
  const b = decodeTerrariumGlobalPixel(terrainTiles, x1, y0);
  const c = decodeTerrariumGlobalPixel(terrainTiles, x0, y1);
  const d = decodeTerrariumGlobalPixel(terrainTiles, x1, y1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

function smootherstep(value, edge0, edge1) {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, Number.EPSILON), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function smoothHeightGrid(source, landVertices, width, height) {
  const output = new Int16Array(source.length);
  const kernel = [1, 2, 1];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const centerIndex = y * width + x;
      if (!landVertices[centerIndex]) {
        output[centerIndex] = 0;
        continue;
      }
      const center = source[y * width + x];
      let weightedHeight = 0;
      let weightSum = 0;

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const sampleY = clamp(y + offsetY, 0, height - 1);
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const sampleX = clamp(x + offsetX, 0, width - 1);
          const sampleIndex = sampleY * width + sampleX;
          if (!landVertices[sampleIndex]) continue;
          const sample = source[sampleIndex];
          const spatialWeight = kernel[offsetX + 1] * kernel[offsetY + 1];
          const rangeScale = 900;
          const rangeWeight = 1 / (1 + Math.abs(sample - center) / rangeScale);
          const weight = spatialWeight * rangeWeight;
          weightedHeight += sample * weight;
          weightSum += weight;
        }
      }

      const smoothed = weightSum > 0 ? weightedHeight / weightSum : center;
      output[centerIndex] = Math.round(center * 0.28 + smoothed * 0.72);
    }
  }
  return output;
}

function sampleMaskValue(mask, u, v) {
  const x = clamp(clamp(u, 0, 1) * mask.width - 0.5, 0, mask.width - 1);
  const y = clamp(clamp(v, 0, 1) * mask.height - 0.5, 0, mask.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(mask.width - 1, x0 + 1);
  const y1 = Math.min(mask.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = mask.data[y0 * mask.width + x0];
  const b = mask.data[y0 * mask.width + x1];
  const c = mask.data[y1 * mask.width + x0];
  const d = mask.data[y1 * mask.width + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

function buildHeightGrid(
  terrainTiles,
  coastMask,
  width = REGION.terrainWidth,
  height = REGION.terrainHeight,
) {
  const sampledHeights = new Int16Array(width * height);
  const landVertices = new Uint8Array(width * height);
  const coastDistances = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const { longitude, latitude } = uvToLonLat(u, v);
      const index = y * width + x;
      const signedDistance = sampleMaskValue(coastMask, u, v) / 255;
      const isLand = signedDistance >= 0.5;
      landVertices[index] = isLand ? 1 : 0;
      coastDistances[index] = Math.max(0, (signedDistance - 0.5) * 2 * coastMask.maximumDistance);
      const elevation = sampleTerrainTile(terrainTiles, longitude, latitude);
      sampledHeights[index] = isLand
        ? Math.round(clamp(Math.max(0, elevation), 0, 10000))
        : 0;
    }
  }

  const heights = smoothHeightGrid(sampledHeights, landVertices, width, height);
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < heights.length; index += 1) {
    if (landVertices[index]) {
      const coastRamp = smootherstep(
        coastDistances[index],
        0,
        COAST_FLATTEN_DISTANCE_PIXELS,
      );
      heights[index] = Math.round(heights[index] * coastRamp);
    } else {
      heights[index] = 0;
    }
    const elevation = heights[index];
    minimum = Math.min(minimum, elevation);
    maximum = Math.max(maximum, elevation);
  }

  return { heights, minimum, maximum };
}

function geometryToPolygons(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function projectRing(ring) {
  return ring.map(([longitude, latitude]) => lonLatToUv(longitude, latitude));
}

function ringBounds(ring) {
  const bounds = { minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity };
  for (const point of ring) {
    bounds.minU = Math.min(bounds.minU, point.u);
    bounds.minV = Math.min(bounds.minV, point.v);
    bounds.maxU = Math.max(bounds.maxU, point.u);
    bounds.maxV = Math.max(bounds.maxV, point.v);
  }
  return bounds;
}

function boundsIntersectRegion(bounds) {
  return bounds.maxU >= 0 && bounds.minU <= 1 && bounds.maxV >= 0 && bounds.minV <= 1;
}

function pointInRing(u, v, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    const intersects = ((a.v > v) !== (b.v > v))
      && (u < ((b.u - a.u) * (v - a.v)) / ((b.v - a.v) || Number.EPSILON) + a.u);
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceTransform(seedMask, width, height) {
  const distance = new Float32Array(width * height);
  distance.fill(1e6);
  for (let index = 0; index < seedMask.length; index += 1) {
    if (seedMask[index]) distance[index] = 0;
  }

  const diagonal = Math.SQRT2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (x > 0) distance[index] = Math.min(distance[index], distance[index - 1] + 1);
      if (y > 0) distance[index] = Math.min(distance[index], distance[index - width] + 1);
      if (x > 0 && y > 0) distance[index] = Math.min(distance[index], distance[index - width - 1] + diagonal);
      if (x + 1 < width && y > 0) distance[index] = Math.min(distance[index], distance[index - width + 1] + diagonal);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (x + 1 < width) distance[index] = Math.min(distance[index], distance[index + 1] + 1);
      if (y + 1 < height) distance[index] = Math.min(distance[index], distance[index + width] + 1);
      if (x + 1 < width && y + 1 < height) distance[index] = Math.min(distance[index], distance[index + width + 1] + diagonal);
      if (x > 0 && y + 1 < height) distance[index] = Math.min(distance[index], distance[index + width - 1] + diagonal);
    }
  }
  return distance;
}

function collectProjectedPolygons(featureCollection, predicate = () => true) {
  const polygons = [];
  for (const feature of featureCollection.features ?? []) {
    if (!predicate(feature)) continue;
    for (const polygon of geometryToPolygons(feature.geometry)) {
      const rings = polygon.map(projectRing).filter((ring) => ring.length >= 3);
      if (rings.length === 0) continue;
      const bounds = ringBounds(rings[0]);
      if (boundsIntersectRegion(bounds)) polygons.push({ rings, bounds });
    }
  }
  return polygons;
}

function rasterizePolygons(polygons, width, height) {
  const gridColumns = 128;
  const gridRows = 96;
  const buckets = Array.from({ length: gridColumns * gridRows }, () => []);

  polygons.forEach((polygon, polygonIndex) => {
    const x0 = clamp(Math.floor(polygon.bounds.minU * gridColumns), 0, gridColumns - 1);
    const x1 = clamp(Math.floor(polygon.bounds.maxU * gridColumns), 0, gridColumns - 1);
    const y0 = clamp(Math.floor(polygon.bounds.minV * gridRows), 0, gridRows - 1);
    const y1 = clamp(Math.floor(polygon.bounds.maxV * gridRows), 0, gridRows - 1);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        buckets[y * gridColumns + x].push(polygonIndex);
      }
    }
  });

  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const bucketY = clamp(Math.floor(v * gridRows), 0, gridRows - 1);
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const bucketX = clamp(Math.floor(u * gridColumns), 0, gridColumns - 1);
      const candidates = buckets[bucketY * gridColumns + bucketX];

      for (const polygonIndex of candidates) {
        const polygon = polygons[polygonIndex];
        if (u < polygon.bounds.minU || u > polygon.bounds.maxU
          || v < polygon.bounds.minV || v > polygon.bounds.maxV
          || !pointInRing(u, v, polygon.rings[0])) continue;

        let insideHole = false;
        for (let ringIndex = 1; ringIndex < polygon.rings.length; ringIndex += 1) {
          if (pointInRing(u, v, polygon.rings[ringIndex])) {
            insideHole = true;
            break;
          }
        }
        if (!insideHole) {
          output[y * width + x] = 1;
          break;
        }
      }
    }
  }
  return output;
}

async function buildOceanMask() {
  console.log('Building the single authoritative land topology and coast-distance mask...');
  const [landGeoJson, nationalAdmin] = await Promise.all([
    readJson(path.join(CACHE_ROOT, 'natural-earth', 'ne_50m_land.geojson')),
    readJson(path.join(CACHE_ROOT, 'admin', '100000_full.json')),
  ]);
  const width = REGION.maskWidth;
  const height = REGION.maskHeight;
  const naturalLand = rasterizePolygons(
    collectProjectedPolygons(landGeoJson),
    width,
    height,
  );
  const chinaLand = rasterizePolygons(
    collectProjectedPolygons(nationalAdmin, (feature) => (
      feature.properties?.level === 'province'
      && Number.isInteger(Number(feature.properties?.adcode))
    )),
    width,
    height,
  );

  // Resolve the China administrative coastline first. Natural Earth remains useful
  // for surrounding context, but it must not overwrite the Chinese coastline when
  // the two public sources disagree by a few raster pixels.
  const chinaCoastSeeds = new Uint8Array(width * height);
  const coastSearchRadius = Math.max(3, Math.round(8 * (width / 1536)));
  const hasChinaBoundaryNeighbour = (x, y) => {
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) continue;
        const neighbourX = x + offsetX;
        const neighbourY = y + offsetY;
        if (neighbourX < 0 || neighbourX >= width || neighbourY < 0 || neighbourY >= height) return true;
        if (!chinaLand[neighbourY * width + neighbourX]) return true;
      }
    }
    return false;
  };
  const hasNaturalWaterNearby = (x, y) => {
    for (let offsetY = -coastSearchRadius; offsetY <= coastSearchRadius; offsetY += 1) {
      for (let offsetX = -coastSearchRadius; offsetX <= coastSearchRadius; offsetX += 1) {
        if (offsetX * offsetX + offsetY * offsetY > coastSearchRadius * coastSearchRadius) continue;
        const neighbourX = x + offsetX;
        const neighbourY = y + offsetY;
        if (neighbourX < 0 || neighbourX >= width || neighbourY < 0 || neighbourY >= height) continue;
        const neighbourIndex = neighbourY * width + neighbourX;
        if (!chinaLand[neighbourIndex] && !naturalLand[neighbourIndex]) return true;
      }
    }
    return false;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (chinaLand[index] && hasChinaBoundaryNeighbour(x, y) && hasNaturalWaterNearby(x, y)) {
        chinaCoastSeeds[index] = 1;
      }
    }
  }
  const distanceToChinaCoast = distanceTransform(chinaCoastSeeds, width, height);
  const chinaCoastBand = Math.max(2, Math.round(8 * (width / 1536)));

  // The raster topology is authoritative for both terrain clipping and ocean
  // shading. Inside the coastal authority band, use the administrative polygon;
  // elsewhere retain Natural Earth as contextual surrounding land.
  const land = new Uint8Array(width * height);
  for (let index = 0; index < land.length; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    const forceChinaCoast = distanceToChinaCoast[index] <= chinaCoastBand
      && (chinaLand[index] || hasNaturalWaterNearby(x, y));
    land[index] = forceChinaCoast ? chinaLand[index] : (chinaLand[index] || naturalLand[index] ? 1 : 0);
  }

  const landSeeds = new Uint8Array(land.length);
  const waterSeeds = new Uint8Array(land.length);
  for (let index = 0; index < land.length; index += 1) {
    const isLand = land[index] !== 0;
    landSeeds[index] = isLand ? 1 : 0;
    waterSeeds[index] = isLand ? 0 : 1;
  }
  const distanceToLand = distanceTransform(landSeeds, width, height);
  const distanceToWater = distanceTransform(waterSeeds, width, height);

  const output = new Uint8Array(width * height);
  const chinaOutput = new Uint8Array(width * height);
  const maximumDistance = Math.round(52 * (width / 768));
  const chinaLandSeeds = new Uint8Array(land.length);
  const chinaWaterSeeds = new Uint8Array(land.length);
  for (let index = 0; index < chinaLand.length; index += 1) {
    chinaLandSeeds[index] = chinaLand[index] ? 1 : 0;
    chinaWaterSeeds[index] = chinaLand[index] ? 0 : 1;
  }
  const distanceToChinaLand = distanceTransform(chinaLandSeeds, width, height);
  const distanceToChinaWater = distanceTransform(chinaWaterSeeds, width, height);
  for (let index = 0; index < land.length; index += 1) {
    const isLand = land[index] !== 0;
    const signedDistance = isLand
      ? 0.5 + clamp(distanceToWater[index] / maximumDistance, 0, 1) * 0.5
      : 0.5 - clamp(distanceToLand[index] / maximumDistance, 0, 1) * 0.5;
    output[index] = Math.round(signedDistance * 255);

    const isChina = chinaLand[index] !== 0;
    const chinaSignedDistance = isChina
      ? 0.5 + clamp(distanceToChinaWater[index] / maximumDistance, 0, 1) * 0.5
      : 0.5 - clamp(distanceToChinaLand[index] / maximumDistance, 0, 1) * 0.5;
    chinaOutput[index] = Math.round(chinaSignedDistance * 255);
  }
  return {
    data: output,
    chinaData: chinaOutput,
    width,
    height,
    maximumDistance,
  };
}

function featureRings(feature) {
  const rings = [];
  for (const polygon of geometryToPolygons(feature.geometry)) {
    for (const coordinateRing of polygon) {
      if (coordinateRing.length < 3) continue;
      const projected = coordinateRing.map(([longitude, latitude]) => {
        const { u, v } = lonLatToUv(longitude, latitude);
        return { x: u, y: v };
      });
      if (!boundsIntersectRegion(ringBounds(projected.map(({ x, y }) => ({ u: x, v: y }))))) continue;

      if (projected.length > 1) {
        const first = projected[0];
        const last = projected[projected.length - 1];
        if (Math.abs(first.x - last.x) >= 1e-9 || Math.abs(first.y - last.y) >= 1e-9) {
          projected.push({ ...first });
        }
      }
      if (projected.length >= 4) rings.push(projected);
    }
  }
  return rings;
}

function labelForFeature(feature, level) {
  const properties = feature.properties ?? {};
  const coordinate = properties.centroid ?? properties.center;
  if (!Array.isArray(coordinate) || coordinate.length < 2) return null;
  const { u, v } = lonLatToUv(Number(coordinate[0]), Number(coordinate[1]));
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return {
    adcode: Number(properties.adcode),
    name: String(properties.name ?? ''),
    level,
    u: Number(u.toFixed(6)),
    v: Number(v.toFixed(6)),
  };
}

function quantizeBoundaryPoint(point) {
  const u16 = Math.round(clamp(point.u ?? point.x, 0, 1) * 65535);
  const v16 = Math.round(clamp(point.v ?? point.y, 0, 1) * 65535);
  return {
    key: `${u16},${v16}`,
    u: u16 / 65535,
    v: v16 / 65535,
  };
}

function connectBoundarySegments(nodes, segments) {
  const adjacency = new Map();
  segments.forEach((segment, segmentIndex) => {
    if (!adjacency.has(segment.a)) adjacency.set(segment.a, []);
    if (!adjacency.has(segment.b)) adjacency.set(segment.b, []);
    adjacency.get(segment.a).push(segmentIndex);
    adjacency.get(segment.b).push(segmentIndex);
  });

  const visited = new Uint8Array(segments.length);
  const lines = [];
  const walk = (startNode, startSegment) => {
    const line = [nodes.get(startNode)];
    let currentNode = startNode;
    let segmentIndex = startSegment;

    while (segmentIndex !== undefined && !visited[segmentIndex]) {
      visited[segmentIndex] = 1;
      const segment = segments[segmentIndex];
      const nextNode = segment.a === currentNode ? segment.b : segment.a;
      line.push(nodes.get(nextNode));
      const candidates = adjacency.get(nextNode).filter((candidate) => !visited[candidate]);
      if (candidates.length !== 1) break;
      currentNode = nextNode;
      [segmentIndex] = candidates;
    }
    if (line.length >= 2) lines.push(line);
  };

  for (const [nodeKey, connectedSegments] of adjacency) {
    if (connectedSegments.length === 2) continue;
    for (const segmentIndex of connectedSegments) {
      if (!visited[segmentIndex]) walk(nodeKey, segmentIndex);
    }
  }
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    if (!visited[segmentIndex]) walk(segments[segmentIndex].a, segmentIndex);
  }

  return lines;
}

function uniqueBoundaryLines(rings, minimumOccurrences) {
  const nodes = new Map();
  const segments = new Map();

  for (const ring of rings) {
    for (let index = 1; index < ring.length; index += 1) {
      const a = quantizeBoundaryPoint(ring[index - 1]);
      const b = quantizeBoundaryPoint(ring[index]);
      if (a.key === b.key) continue;
      const segmentKey = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
      if (!nodes.has(a.key)) nodes.set(a.key, a);
      if (!nodes.has(b.key)) nodes.set(b.key, b);
      const existing = segments.get(segmentKey);
      if (existing) {
        existing.occurrences += 1;
      } else {
        segments.set(segmentKey, { a: a.key, b: b.key, occurrences: 1 });
      }
    }
  }

  const selectedSegments = [...segments.values()]
    .filter((segment) => segment.occurrences >= minimumOccurrences);
  return connectBoundarySegments(nodes, selectedSegments);
}

function simplifyBoundaryLine(line, level) {
  const points = simplify(
    line.map(({ u, v }) => ({ x: u, y: v })),
    SIMPLIFY_TOLERANCE[level],
    true,
  ).map(({ x, y }) => quantizeBoundaryPoint({ x, y }));
  const uniquePoints = points.filter((point, index) => index === 0 || point.key !== points[index - 1].key);
  if (uniquePoints.length < 2) return null;
  uniquePoints.provinceAdcode = line.provinceAdcode ?? 0;
  return uniquePoints;
}

function deduplicateBoundaryLines(lines, excludedSegments = new Set()) {
  const linesByProvince = new Map();
  for (const line of lines) {
    const provinceAdcode = line.provinceAdcode ?? 0;
    const provinceLines = linesByProvince.get(provinceAdcode);
    if (provinceLines) provinceLines.push(line);
    else linesByProvince.set(provinceAdcode, [line]);
  }

  const output = [];
  for (const [provinceAdcode, provinceLines] of linesByProvince) {
    const nodes = new Map();
    const segments = new Map();
    for (const line of provinceLines) {
      for (let index = 1; index < line.length; index += 1) {
        const start = line[index - 1];
        const end = line[index];
        if (start.key === end.key) continue;
        if (!nodes.has(start.key)) nodes.set(start.key, start);
        if (!nodes.has(end.key)) nodes.set(end.key, end);
        const segmentKey = start.key < end.key
          ? `${start.key}|${end.key}`
          : `${end.key}|${start.key}`;
        if (!excludedSegments.has(segmentKey) && !segments.has(segmentKey)) {
          segments.set(segmentKey, { a: start.key, b: end.key });
        }
      }
    }
    const connected = connectBoundarySegments(nodes, [...segments.values()]);
    for (const line of connected) line.provinceAdcode = provinceAdcode;
    output.push(...connected);
  }
  return output;
}

function boundaryBounds(lines, labels) {
  const bounds = { minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity };
  for (const line of lines) {
    for (const point of line) {
      bounds.minU = Math.min(bounds.minU, point.u);
      bounds.minV = Math.min(bounds.minV, point.v);
      bounds.maxU = Math.max(bounds.maxU, point.u);
      bounds.maxV = Math.max(bounds.maxV, point.v);
    }
  }
  for (const label of labels) {
    bounds.minU = Math.min(bounds.minU, label.u);
    bounds.minV = Math.min(bounds.minV, label.v);
    bounds.maxU = Math.max(bounds.maxU, label.u);
    bounds.maxV = Math.max(bounds.maxV, label.v);
  }
  if (!Number.isFinite(bounds.minU)) return { minU: 0, minV: 0, maxU: 0, maxV: 0 };
  return Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, Number(value.toFixed(6))]));
}

function buildAdministrativeChunk(
  featureGroups,
  level,
  minimumOccurrences,
  excludedSegments = new Set(),
) {
  const featureList = featureGroups.flat();
  const labels = [];
  for (const feature of featureList) {
    const label = labelForFeature(feature, level);
    if (label?.name) labels.push(label);
  }

  let rawRingCount = 0;
  const topologicalLines = [];
  for (const featureGroup of featureGroups) {
    const rawRings = featureGroup.flatMap(featureRings);
    rawRingCount += rawRings.length;
    const provinceAdcode = level === 'city'
      ? Math.floor(Number(featureGroup[0]?.properties?.adcode) / 10000) * 10000
      : 0;
    const groupLines = uniqueBoundaryLines(rawRings, minimumOccurrences);
    for (const line of groupLines) line.provinceAdcode = provinceAdcode;
    topologicalLines.push(...groupLines);
  }
  const lines = deduplicateBoundaryLines(
    topologicalLines
      .map((line) => simplifyBoundaryLine(line, level))
      .filter(Boolean),
    excludedSegments,
  );

  return {
    featureCount: featureList.length,
    rawRingCount,
    lines,
    labels,
    bounds: boundaryBounds(lines, labels),
    pointCount: lines.reduce((sum, line) => sum + line.length, 0),
    segmentCount: lines.reduce((sum, line) => sum + Math.max(0, line.length - 1), 0),
  };
}

function boundarySegmentKeys(lines) {
  const segments = new Set();
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      const start = line[index - 1].key;
      const end = line[index].key;
      if (start === end) continue;
      segments.add(start < end ? `${start}|${end}` : `${end}|${start}`);
    }
  }
  return segments;
}

async function collectAdministrativeFeatures() {
  const adminDirectory = path.join(CACHE_ROOT, 'admin');
  const national = await readJson(path.join(adminDirectory, '100000_full.json'));
  const provinces = (national.features ?? []).filter((feature) => (
    feature.properties?.level === 'province'
    && Number.isInteger(Number(feature.properties?.adcode))
  ));
  const cityGroups = [];

  for (const province of provinces) {
    const provinceCode = Number(province.properties?.adcode);
    const provinceFile = path.join(adminDirectory, `${provinceCode}_full.json`);
    if (!(await exists(provinceFile))) {
      if (Number(province.properties?.childrenNum) > 0) {
        throw new Error(`Missing province administrative source: ${province.properties?.name} (${provinceCode})`);
      }
      continue;
    }
    const provinceDetails = await readJson(provinceFile);
    const cities = (provinceDetails.features ?? [])
      .filter((feature) => feature.properties?.level === 'city');
    if (cities.length > 0) cityGroups.push(cities);
  }

  const seenCityCodes = new Set();
  const uniqueCityGroups = cityGroups.map((group) => group.filter((feature) => {
    const adcode = Number(feature.properties?.adcode);
    if (!Number.isInteger(adcode) || seenCityCodes.has(adcode)) return false;
    seenCityCodes.add(adcode);
    return true;
  })).filter((group) => group.length > 0);

  return {
    province: [provinces],
    city: uniqueCityGroups,
  };
}

function assertUniqueLabels(labels, level) {
  const seen = new Set();
  for (const label of labels) {
    if (seen.has(label.adcode)) {
      throw new Error(`Duplicate ${level} label adcode: ${label.adcode}`);
    }
    seen.add(label.adcode);
  }
}

function encodeBoundaryRings(rings) {
  const byteLength = 8 + rings.reduce((sum, ring) => sum + 8 + ring.length * 8, 0);
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  view.setUint8(0, 'L'.charCodeAt(0));
  view.setUint8(1, 'G'.charCodeAt(0));
  view.setUint8(2, 'B'.charCodeAt(0));
  view.setUint8(3, '4'.charCodeAt(0));
  view.setUint32(4, rings.length, true);
  let offset = 8;

  for (const ring of rings) {
    view.setInt32(offset, ring.provinceAdcode ?? 0, true);
    view.setUint32(offset + 4, ring.length, true);
    offset += 8;
    for (const point of ring) {
      view.setFloat32(offset, clamp(point.u, 0, 1), true);
      view.setFloat32(offset + 4, clamp(point.v, 0, 1), true);
      offset += 8;
    }
  }
  return Buffer.from(buffer);
}

async function writeGzip(fileName, data) {
  const compressedFileName = `${fileName}.gz`;
  await fs.writeFile(
    path.join(OUTPUT_ROOT, compressedFileName),
    gzipSync(data, { level: 9 }),
  );
  return compressedFileName;
}

function sampleHeight(source, width, height, x, y) {
  return source[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
}

function multiscaleHeightResidual(source, width, height, x, y) {
  const center = sampleHeight(source, width, height, x, y);
  const ring = (radius) => (
    sampleHeight(source, width, height, x - radius, y)
    + sampleHeight(source, width, height, x + radius, y)
    + sampleHeight(source, width, height, x, y - radius)
    + sampleHeight(source, width, height, x, y + radius)
  ) * 0.25;
  const diagonal = (radius) => (
    sampleHeight(source, width, height, x - radius, y - radius)
    + sampleHeight(source, width, height, x + radius, y - radius)
    + sampleHeight(source, width, height, x - radius, y + radius)
    + sampleHeight(source, width, height, x + radius, y + radius)
  ) * 0.25;
  const broad = center * 0.2 + ring(5) * 0.3 + diagonal(9) * 0.2 + ring(15) * 0.3;
  return clamp((center - broad) / RELIEF_RESIDUAL_RANGE_METERS, -1, 1);
}

function encodeTerrainNormal(output, offset, source, width, height, x, y) {
  const slopeX = (
    sampleHeight(source, width, height, x + 1, y)
    - sampleHeight(source, width, height, x - 1, y)
  ) * REGION_METRICS.sceneUnitsPerMeter / (2 * REGION.sceneWidth / (width - 1));
  const slopeZ = (
    sampleHeight(source, width, height, x, y + 1)
    - sampleHeight(source, width, height, x, y - 1)
  ) * REGION_METRICS.sceneUnitsPerMeter / (2 * REGION_METRICS.sceneDepth / (height - 1));
  const inverseLength = 1 / Math.hypot(slopeX, 1, slopeZ);
  output[offset] = Math.round((clamp(-slopeX * inverseLength, -1, 1) * 0.5 + 0.5) * 255);
  output[offset + 1] = Math.round((clamp(-slopeZ * inverseLength, -1, 1) * 0.5 + 0.5) * 255);
}

async function buildReliefTiles(sourceHeights, width, height) {
  const columns = Math.ceil(width / RELIEF_TILE_SIZE);
  const rows = Math.ceil(height / RELIEF_TILE_SIZE);
  const assetSize = RELIEF_TILE_SIZE + RELIEF_TILE_GUTTER * 2;
  const directory = path.join(OUTPUT_ROOT, RELIEF_TILE_DIRECTORY);
  await ensureDirectory(directory);
  let byteLength = 0;

  for (let tileY = 0; tileY < rows; tileY += 1) {
    for (let tileX = 0; tileX < columns; tileX += 1) {
      const output = Buffer.alloc(assetSize * assetSize * 4);
      for (let localY = 0; localY < assetSize; localY += 1) {
        const sourceY = clamp(
          tileY * RELIEF_TILE_SIZE + localY - RELIEF_TILE_GUTTER,
          0,
          height - 1,
        );
        for (let localX = 0; localX < assetSize; localX += 1) {
          const sourceX = clamp(
            tileX * RELIEF_TILE_SIZE + localX - RELIEF_TILE_GUTTER,
            0,
            width - 1,
          );
          const offset = (localY * assetSize + localX) * 4;
          encodeTerrainNormal(output, offset, sourceHeights, width, height, sourceX, sourceY);
          const relief = directionalRelief(sourceHeights, width, height, sourceX, sourceY);
          const residual = multiscaleHeightResidual(
            sourceHeights,
            width,
            height,
            sourceX,
            sourceY,
          );
          output[offset + 2] = Math.round((relief * 0.5 + 0.5) * 255);
          output[offset + 3] = Math.round((residual * 0.5 + 0.5) * 255);
        }
      }
      const filePath = path.join(directory, `${tileX}-${tileY}.webp`);
      await sharp(output, { raw: { width: assetSize, height: assetSize, channels: 4 } })
        .webp({ lossless: true, effort: 5 })
        .toFile(filePath);
      byteLength += (await fs.stat(filePath)).size;
    }
    console.log(`Baked relief tile row ${tileY + 1}/${rows}.`);
  }

  return {
    urlTemplate: `/data/${RELIEF_TILE_DIRECTORY}/{x}-{y}.webp`,
    width,
    height,
    tileSize: RELIEF_TILE_SIZE,
    gutter: RELIEF_TILE_GUTTER,
    columns,
    rows,
    maxResidentTiles: RELIEF_TILE_RESIDENT_COUNT,
    byteLength,
    format: 'rg-normal-b-light-a-residual',
  };
}

async function validateBuildInputs() {
  const downloadManifestPath = path.join(CACHE_ROOT, 'download-manifest.json');
  const requiredFiles = [
    downloadManifestPath,
    path.join(CACHE_ROOT, 'natural-earth', 'ne_50m_land.geojson'),
    NASA_IMAGERY_FILE,
    path.join(CACHE_ROOT, 'admin', '100000_full.json'),
  ];
  const missing = [];
  for (const filePath of requiredFiles) {
    if (!(await exists(filePath))) missing.push(path.relative(PROJECT_ROOT, filePath));
  }
  if (missing.length > 0) {
    throw new Error(`Data build inputs are incomplete. Run npm run data:download. Missing: ${missing.join(', ')}`);
  }

  const downloadManifest = await readJson(downloadManifestPath);
  for (const key of ['terrain', 'terrainDetail']) {
    const source = downloadManifest[key];
    if (!source) {
      missing.push(`data/cache/download-manifest.json:${key}`);
      continue;
    }
    for (let y = source.minY; y <= source.maxY; y += 1) {
      for (let x = source.minX; x <= source.maxX; x += 1) {
        const tile = path.join(CACHE_ROOT, 'terrain', String(source.zoom), String(x), `${y}.png`);
        if (!(await exists(tile))) missing.push(path.relative(PROJECT_ROOT, tile));
      }
    }
  }
  const national = await readJson(path.join(CACHE_ROOT, 'admin', '100000_full.json'));
  for (const feature of national.features ?? []) {
    const adcode = Number(feature.properties?.adcode);
    if (feature.properties?.level !== 'province' || !Number.isInteger(adcode)) continue;
    if (Number(feature.properties?.childrenNum) <= 0) continue;
    const province = path.join(CACHE_ROOT, 'admin', `${adcode}_full.json`);
    if (!(await exists(province))) missing.push(path.relative(PROJECT_ROOT, province));
  }
  if (missing.length > 0) {
    const preview = missing.slice(0, 12).join(', ');
    const suffix = missing.length > 12 ? `, and ${missing.length - 12} more` : '';
    throw new Error(`Data build inputs are incomplete. Run npm run data:download. Missing: ${preview}${suffix}`);
  }
}

async function buildAdministrativeAssets() {
  console.log('Building administrative boundaries and labels...');
  const features = await collectAdministrativeFeatures();
  const summary = {};
  const generatedFiles = [];
  let provinceSegments = new Set();

  for (const level of ADMIN_LEVELS) {
    // Province outlines remain visible at every zoom. City data therefore contains only
    // borders shared by two cities in the same province; together the two layers form
    // one complete outline without drawing province borders twice.
    const minimumOccurrences = level === 'city' ? 2 : 1;
    const administrativeLevel = buildAdministrativeChunk(
      features[level],
      level,
      minimumOccurrences,
      level === 'city' ? provinceSegments : undefined,
    );
    assertUniqueLabels(administrativeLevel.labels, level);
    if (level === 'province') {
      provinceSegments = boundarySegmentKeys(administrativeLevel.lines);
    }
    const boundaryFile = `${level}-boundary.bin.gz`;
    const labelsFile = `${level}-labels.json`;
    await writeGzip(`${level}-boundary.bin`, encodeBoundaryRings(administrativeLevel.lines));
    await writeJson(path.join(OUTPUT_ROOT, labelsFile), administrativeLevel.labels);
    generatedFiles.push(boundaryFile, labelsFile);
    summary[level] = {
      features: administrativeLevel.featureCount,
      rings: administrativeLevel.rawRingCount,
      lines: administrativeLevel.lines.length,
      segments: administrativeLevel.segmentCount,
      points: administrativeLevel.pointCount,
      labels: administrativeLevel.labels.length,
    };
  }

  return { summary, generatedFiles };
}

async function fileSize(fileName) {
  const data = await fs.readFile(path.join(OUTPUT_ROOT, fileName));
  if (!fileName.endsWith('.json') && !fileName.endsWith('.md')) return data.byteLength;
  return Buffer.byteLength(data.toString('utf8').replace(/\r\n/g, '\n'));
}

async function main() {
  await validateBuildInputs();
  await fs.rm(OUTPUT_ROOT, { recursive: true, force: true });
  await ensureDirectory(OUTPUT_ROOT);
  await fs.copyFile(ATTRIBUTION_FILE, path.join(OUTPUT_ROOT, 'ATTRIBUTION.md'));
  const coastMask = await buildOceanMask();
  const oceanMaskFile = await writeGzip('ocean-mask.bin', coastMask.data);
  const chinaMaskFile = await writeGzip('china-mask.bin', coastMask.chinaData);

  console.log('Decoding elevation tiles...');
  const terrainTiles = await loadTerrainTiles('terrain');
  const { heights, minimum, maximum } = buildHeightGrid(terrainTiles, coastMask);
  const reliefWidth = RELIEF_WIDTH;
  const reliefHeight = RELIEF_HEIGHT;
  const detailTerrainTiles = await loadTerrainTiles('terrainDetail');
  const { heights: reliefHeights } = buildHeightGrid(
    detailTerrainTiles,
    coastMask,
    reliefWidth,
    reliefHeight,
  );
  const terrainHeightFile = await writeGzip(
    'terrain-height.bin',
    Buffer.from(heights.buffer, heights.byteOffset, heights.byteLength),
  );
  console.log('Baking multiscale terrain relief texture...');
  await buildReliefTexture(reliefHeights, reliefWidth, reliefHeight);
  console.log('Sampling zoom-8 terrain for the progressive relief tile set...');
  const { heights: tiledReliefHeights } = buildHeightGrid(
    detailTerrainTiles,
    coastMask,
    RELIEF_TILE_WIDTH,
    RELIEF_TILE_HEIGHT,
  );
  console.log('Baking progressive high-resolution terrain relief tiles...');
  const reliefTiles = await buildReliefTiles(
    tiledReliefHeights,
    RELIEF_TILE_WIDTH,
    RELIEF_TILE_HEIGHT,
  );
  console.log('Reprojecting NASA Blue Marble terrain imagery...');
  const terrainImagery = await buildTerrainImagery();

  const administrative = await buildAdministrativeAssets();

  const terrainMeta = {
    width: REGION.terrainWidth,
    height: REGION.terrainHeight,
    minimumElevationMeters: minimum,
    maximumElevationMeters: maximum,
    sceneWidth: REGION.sceneWidth,
    sceneDepth: REGION_METRICS.sceneDepth,
    sceneUnitsPerMeter: REGION_METRICS.sceneUnitsPerMeter,
    bounds: {
      west: REGION.west,
      east: REGION.east,
      south: REGION.south,
      north: REGION.north,
    },
  };
  await writeJson(path.join(OUTPUT_ROOT, 'terrain-meta.json'), terrainMeta);
  const files = [
    terrainHeightFile,
    'terrain-relief.webp',
    'terrain-imagery.jpg',
    'terrain-meta.json',
    oceanMaskFile,
    chinaMaskFile,
    ...administrative.generatedFiles,
  ];
  const sizes = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await fileSize(file)])));

  await writeJson(path.join(OUTPUT_ROOT, 'scene-manifest.json'), {
    version: 15,
    generatedAt: new Date().toISOString(),
    region: REGION,
    terrain: {
      metaUrl: '/data/terrain-meta.json',
      heightUrl: `/data/${terrainHeightFile}`,
      reliefTextureUrl: '/data/terrain-relief.webp',
      reliefWidth,
      reliefHeight,
      reliefResidualRangeMeters: RELIEF_RESIDUAL_RANGE_METERS,
      reliefTiles,
      ...terrainMeta,
    },
    terrainImagery: {
      url: '/data/terrain-imagery.jpg',
      width: terrainImagery.width,
      height: terrainImagery.height,
      colorSpace: 'srgb',
    },
    ocean: {
      maskUrl: `/data/${oceanMaskFile}`,
      maskWidth: REGION.maskWidth,
      maskHeight: REGION.maskHeight,
      maskChannels: 1,
    },
    china: {
      maskUrl: `/data/${chinaMaskFile}`,
      maskWidth: REGION.maskWidth,
      maskHeight: REGION.maskHeight,
      maskChannels: 1,
    },
    boundaries: {
      province: '/data/province-boundary.bin.gz',
      city: '/data/city-boundary.bin.gz',
    },
    labels: {
      province: '/data/province-labels.json',
      city: '/data/city-labels.json',
    },
    adminSummary: administrative.summary,
    assetBytes: sizes,
    topology: {
      landMask: `/data/${oceanMaskFile}`,
      coastIsoValue: 0.5,
      surface: 'shared-clipped-triangle-mesh',
      boundaryHeight: 'runtime-final-terrain-triangle-sampling',
      boundaryFormat: 'LGB4-uv-province',
    },
    sources: {
      elevation: 'Mapzen/AWS Terrain Tiles (Terrarium)',
      terrainImagery: 'NASA Earth Observatory Blue Marble, August 2004',
      administrative: 'Alibaba Cloud DataV GeoAtlas public dataset',
      landMask: 'China administrative coastline with Natural Earth surrounding context',
    },
  });

  const totalBytes = Object.values(sizes).reduce((sum, size) => sum + size, 0);
  console.log(`Generated ${(totalBytes / 1024 / 1024).toFixed(2)} MB of runtime map assets.`);
  console.table(administrative.summary);
}

await main();
