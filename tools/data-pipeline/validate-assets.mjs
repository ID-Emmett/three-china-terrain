import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import sharp from 'sharp';
import { OUTPUT_ROOT } from './config.mjs';
import { readJson } from './io.mjs';

const ADMIN_LEVELS = ['province', 'city'];
const ASSET_FILES = [
  'terrain-meta.json',
  'terrain-height.bin.gz',
  'terrain-relief.webp',
  'terrain-imagery.jpg',
  'ocean-mask.bin.gz',
  'china-mask.bin.gz',
  ...ADMIN_LEVELS.flatMap((level) => [`${level}-boundary.bin.gz`, `${level}-labels.json`]),
];
const REQUIRED_FILES = ['scene-manifest.json', 'ATTRIBUTION.md', ...ASSET_FILES];
const MAX_RUNTIME_BYTES = 2 * 1024 * 1024;
const MAX_TERRAIN_TEXTURE_BYTES = 1024 * 1024;
const EXPECTED_LAND_SOURCE = 'China administrative coastline with Natural Earth surrounding context';

function sameEntries(actual, expected) {
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function sampleMask(mask, width, height, u, v) {
  const x = clamp(u * width - 0.5, 0, width - 1);
  const y = clamp(v * height - 0.5, 0, height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = mask[y0 * width + x0];
  const b = mask[y0 * width + x1];
  const c = mask[y1 * width + x0];
  const d = mask[y1 * width + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

async function readAsset(relativePath) {
  const data = await fs.readFile(path.join(OUTPUT_ROOT, relativePath));
  return relativePath.endsWith('.gz') ? gunzipSync(data) : data;
}

function normalizedFileSize(relativePath, data) {
  if (!relativePath.endsWith('.json') && !relativePath.endsWith('.md')) return data.byteLength;
  return Buffer.byteLength(data.toString('utf8').replace(/\r\n/g, '\n'));
}

async function validateBoundary(relativePath) {
  const boundary = await readAsset(relativePath);
  if (boundary.length < 8) throw new Error(`Boundary file is too small: ${relativePath}`);
  if (boundary.subarray(0, 4).toString('ascii') !== 'LGB4') {
    throw new Error(`Invalid boundary header: ${relativePath}`);
  }

  const view = new DataView(boundary.buffer, boundary.byteOffset, boundary.byteLength);
  const lineCount = view.getUint32(4, true);
  const segments = new Set();
  let pointCount = 0;
  let offset = 8;

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    if (offset + 8 > boundary.length) throw new Error(`Truncated line header: ${relativePath}`);
    const provinceAdcode = view.getInt32(offset, true);
    const linePointCount = view.getUint32(offset + 4, true);
    offset += 8;
    if (relativePath.startsWith('city-')
      && (!Number.isInteger(provinceAdcode) || provinceAdcode < 100000 || provinceAdcode % 10000 !== 0)) {
      throw new Error(`Invalid city boundary province adcode in ${relativePath}: ${provinceAdcode}`);
    }
    if (relativePath.startsWith('province-') && provinceAdcode !== 0) {
      throw new Error(`Province boundary ownership must be zero in ${relativePath}.`);
    }
    if (linePointCount < 2) throw new Error(`Boundary line has fewer than two points: ${relativePath}`);
    if (offset + linePointCount * 8 > boundary.length) throw new Error(`Truncated line data: ${relativePath}`);

    let previousPoint = null;
    for (let pointIndex = 0; pointIndex < linePointCount; pointIndex += 1) {
      const u = view.getFloat32(offset, true);
      const v = view.getFloat32(offset + 4, true);
      const point = {
        key: `${u.toFixed(8)},${v.toFixed(8)}`,
        u,
        v,
      };
      if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) {
        throw new Error(`Boundary point is outside the map region in ${relativePath}.`);
      }

      if (previousPoint !== null && previousPoint.key !== point.key) {
        const segmentKey = previousPoint.key < point.key
          ? `${previousPoint.key}|${point.key}`
          : `${point.key}|${previousPoint.key}`;
        if (segments.has(segmentKey)) {
          throw new Error(`Duplicate boundary segment in ${relativePath}: ${segmentKey}`);
        }
        segments.add(segmentKey);

      }
      previousPoint = point;
      pointCount += 1;
      offset += 8;
    }
  }

  if (offset !== boundary.length) throw new Error(`Unexpected trailing boundary bytes: ${relativePath}`);
  return {
    bytes: boundary.length,
    lineCount,
    pointCount,
    segmentCount: segments.size,
    segments,
  };
}

async function validateLabels(level, relativePath) {
  const labels = await readJson(path.join(OUTPUT_ROOT, relativePath));
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error(`No ${level} labels generated.`);
  }

  const seenAdcodes = new Set();
  for (const label of labels) {
    if (label.level !== level) throw new Error(`Unexpected label level in ${relativePath}: ${label.level}`);
    if (!Number.isInteger(label.adcode) || !label.name || !Number.isFinite(label.u)
      || !Number.isFinite(label.v) || 'elevation' in label) {
      throw new Error(`Invalid label in ${relativePath}.`);
    }
    if (label.u < 0 || label.u > 1 || label.v < 0 || label.v > 1) {
      throw new Error(`Label outside the map region in ${relativePath}: ${label.adcode}`);
    }
    if (seenAdcodes.has(label.adcode)) throw new Error(`Duplicate ${level} label: ${label.adcode}`);
    seenAdcodes.add(label.adcode);
  }
  return labels.length;
}

async function validateCoastMask(relativePath, width, height) {
  const mask = await readAsset(relativePath);
  if (mask.length !== width * height) {
    throw new Error(`Invalid ocean mask size: ${mask.length} !== ${width * height}`);
  }

  let landPixels = 0;
  let waterPixels = 0;
  for (const signedDistance of mask) {
    if (signedDistance >= 128) landPixels += 1;
    else waterPixels += 1;
  }
  if (landPixels === 0 || waterPixels === 0) throw new Error('Ocean mask must contain land and water.');
}

async function main() {
  const sizes = {};
  const outputEntries = await fs.readdir(OUTPUT_ROOT, { withFileTypes: true });
  const directories = outputEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (directories.length > 0) {
    throw new Error(`Unexpected runtime asset directories: ${directories.join(', ')}`);
  }

  const actualFiles = outputEntries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const expectedFiles = [...REQUIRED_FILES].sort();
  if (!sameEntries(actualFiles, expectedFiles)) {
    const missing = expectedFiles.filter((file) => !actualFiles.includes(file));
    const unexpected = actualFiles.filter((file) => !expectedFiles.includes(file));
    throw new Error(`Runtime asset set mismatch. Missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`);
  }
  for (const file of REQUIRED_FILES) {
    const data = await fs.readFile(path.join(OUTPUT_ROOT, file));
    sizes[file] = normalizedFileSize(file, data);
  }

  const manifest = await readJson(path.join(OUTPUT_ROOT, 'scene-manifest.json'));
  if (manifest.version !== 14) throw new Error(`Unexpected manifest version: ${manifest.version}`);
  if (manifest.sources?.landMask !== EXPECTED_LAND_SOURCE
    || JSON.stringify(manifest).includes('replacement')) {
    throw new Error('Manifest does not describe the authoritative single land topology.');
  }
  if (manifest.topology?.landMask !== '/data/ocean-mask.bin.gz'
    || manifest.topology?.coastIsoValue !== 0.5
    || manifest.topology?.surface !== 'shared-clipped-triangle-mesh'
    || manifest.topology?.boundaryHeight !== 'runtime-final-terrain-triangle-sampling'
    || manifest.topology?.boundaryFormat !== 'LGB4-uv-province') {
    throw new Error('Manifest topology contract is missing or invalid.');
  }
  if ('adminGrid' in manifest || 'adminChunks' in manifest) {
    throw new Error('Chunked administrative metadata must not be present.');
  }
  if (JSON.stringify(manifest).includes('district') || JSON.stringify(manifest).includes('/data/admin/')) {
    throw new Error('Manifest still contains district or chunked administrative data.');
  }

  const summaryLevels = Object.keys(manifest.adminSummary ?? {}).sort();
  if (!sameEntries(summaryLevels, [...ADMIN_LEVELS].sort())) {
    throw new Error(`Unexpected administrative summary levels: ${summaryLevels.join(', ')}`);
  }
  const boundaryLevels = Object.keys(manifest.boundaries ?? {}).sort();
  const labelLevels = Object.keys(manifest.labels ?? {}).sort();
  if (!sameEntries(boundaryLevels, [...ADMIN_LEVELS].sort())
    || !sameEntries(labelLevels, [...ADMIN_LEVELS].sort())) {
    throw new Error('Manifest boundaries and labels must contain province and city only.');
  }

  const expectedHeightBytes = manifest.terrain.width * manifest.terrain.height * 2;
  if (manifest.ocean.maskChannels !== 1) throw new Error('Ocean mask must use one signed-distance channel.');
  const expectedMaskBytes = manifest.ocean.maskWidth * manifest.ocean.maskHeight;
  const heightBuffer = await readAsset('terrain-height.bin.gz');
  if (heightBuffer.length !== expectedHeightBytes) {
    throw new Error(`Invalid terrain height size: ${heightBuffer.length} !== ${expectedHeightBytes}`);
  }
  if ('surfaceUrl' in manifest.terrain || 'surfaceWidth' in manifest.terrain
    || 'surfaceHeight' in manifest.terrain || 'surfaceMipLevels' in manifest.terrain) {
    throw new Error('Manifest must not require a precomputed terrain surface asset.');
  }
  if (manifest.terrain.reliefTextureUrl !== '/data/terrain-relief.webp'
    || sizes['terrain-relief.webp'] < 100_000
    || sizes['terrain-relief.webp'] > MAX_TERRAIN_TEXTURE_BYTES) {
    throw new Error('Invalid terrain relief texture asset.');
  }
  if (manifest.terrainImagery?.url !== '/data/terrain-imagery.jpg'
    || sizes['terrain-imagery.jpg'] < 100_000
    || sizes['terrain-imagery.jpg'] > MAX_TERRAIN_TEXTURE_BYTES) {
    throw new Error('Invalid terrain imagery metadata or image asset.');
  }
  const [reliefMetadata, imageryMetadata] = await Promise.all([
    sharp(path.join(OUTPUT_ROOT, 'terrain-relief.webp')).metadata(),
    sharp(path.join(OUTPUT_ROOT, 'terrain-imagery.jpg')).metadata(),
  ]);
  if (reliefMetadata.width !== manifest.terrain.reliefWidth
    || reliefMetadata.height !== manifest.terrain.reliefHeight
    || imageryMetadata.width !== manifest.terrainImagery.width
    || imageryMetadata.height !== manifest.terrainImagery.height) {
    throw new Error('Terrain texture dimensions do not match the manifest.');
  }
  const oceanMask = await readAsset('ocean-mask.bin.gz');
  if (oceanMask.length !== expectedMaskBytes) {
    throw new Error(`Invalid ocean mask size: ${oceanMask.length} !== ${expectedMaskBytes}`);
  }
  const chinaMask = await readAsset('china-mask.bin.gz');
  if (manifest.china?.maskChannels !== 1 || chinaMask.length !== manifest.china.maskWidth * manifest.china.maskHeight) {
    throw new Error('Invalid China focus mask.');
  }
  await validateCoastMask('ocean-mask.bin.gz', manifest.ocean.maskWidth, manifest.ocean.maskHeight);

  const heights = new Int16Array(
    heightBuffer.buffer,
    heightBuffer.byteOffset,
    heightBuffer.byteLength / Int16Array.BYTES_PER_ELEMENT,
  );
  const mask = oceanMask;
  for (let y = 0; y < manifest.terrain.height; y += 1) {
    for (let x = 0; x < manifest.terrain.width; x += 1) {
      const index = y * manifest.terrain.width + x;
      const signedDistance = sampleMask(
        mask,
        manifest.ocean.maskWidth,
        manifest.ocean.maskHeight,
        x / (manifest.terrain.width - 1),
        y / (manifest.terrain.height - 1),
      );
      if (heights[index] < 0) throw new Error('Terrain must not contain seabed elevations.');
      if (signedDistance < 127.5 && heights[index] !== 0) {
        throw new Error('Water terrain vertex must remain on the zero-height support plane.');
      }
    }
  }
  const boundaries = {};
  for (const level of ADMIN_LEVELS) {
    const boundaryPath = `${level}-boundary.bin.gz`;
    const labelsPath = `${level}-labels.json`;
    if (manifest.boundaries?.[level] !== `/data/${boundaryPath}`
      || manifest.labels?.[level] !== `/data/${labelsPath}`) {
      throw new Error(`Invalid ${level} asset URLs in manifest.`);
    }

    const boundary = await validateBoundary(boundaryPath);
    boundaries[level] = boundary;
    const labelCount = await validateLabels(level, labelsPath);
    const summary = manifest.adminSummary?.[level];
    if (!summary || summary.lines !== boundary.lineCount
      || summary.points !== boundary.pointCount
      || summary.segments !== boundary.segmentCount
      || summary.labels !== labelCount
      || summary.features !== labelCount) {
      throw new Error(`Manifest summary mismatch for ${level}.`);
    }
  }

  for (const segment of boundaries.city.segments) {
    if (boundaries.province.segments.has(segment)) {
      throw new Error(`City and province layers contain the same boundary segment: ${segment}`);
    }
  }

  const manifestAssetFiles = Object.keys(manifest.assetBytes ?? {}).sort();
  if (!sameEntries(manifestAssetFiles, [...ASSET_FILES].sort())) {
    throw new Error('Manifest asset byte list does not match the runtime assets.');
  }
  for (const file of ASSET_FILES) {
    if (manifest.assetBytes?.[file] !== sizes[file]) {
      throw new Error(`Manifest byte size mismatch for ${file}.`);
    }
  }
  if (Object.keys(manifest.assetBytes ?? {}).some((file) => file.includes('district') || file.startsWith('admin/'))) {
    throw new Error('Manifest still references obsolete administrative assets.');
  }

  const totalBytes = REQUIRED_FILES.reduce((sum, file) => sum + sizes[file], 0);
  if (totalBytes > MAX_RUNTIME_BYTES) {
    throw new Error(`Runtime assets exceed 2 MB: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  }

  console.log(`Validated ${REQUIRED_FILES.length} files (${(totalBytes / 1024 / 1024).toFixed(2)} MB runtime assets).`);
  console.table(manifest.adminSummary);
}

await main();
