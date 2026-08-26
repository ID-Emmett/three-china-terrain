import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import sharp from 'sharp';
import { OUTPUT_ROOT } from './config.mjs';
import { readJson, writeJson } from './io.mjs';
import { buildSurfaceFieldBundle, writeSurfaceFieldBundle } from './surface-field.mjs';

function normalizedFileSize(filePath, data) {
  if (!filePath.endsWith('.json') && !filePath.endsWith('.md')) return data.byteLength;
  return Buffer.byteLength(data.toString('utf8').replace(/\r\n/g, '\n'));
}

const manifestPath = path.join(OUTPUT_ROOT, 'scene-manifest.json');
const manifest = await readJson(manifestPath);
const heightCompressed = await fs.readFile(path.join(OUTPUT_ROOT, 'terrain-height.bin.gz'));
const heightBuffer = gunzipSync(heightCompressed);
const heights = new Int16Array(
  heightBuffer.buffer,
  heightBuffer.byteOffset,
  heightBuffer.byteLength / Int16Array.BYTES_PER_ELEMENT,
);
const { data: reliefPixels, info: reliefInfo } = await sharp(path.join(OUTPUT_ROOT, 'terrain-relief.webp'))
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const surfaceMeta = {
  ...manifest.terrain,
  reliefResidualRangeMeters: manifest.terrain.reliefResidualRangeMeters,
};
const bundle = buildSurfaceFieldBundle(
  surfaceMeta,
  heights,
  reliefPixels,
  reliefInfo.width,
  reliefInfo.height,
);
await writeSurfaceFieldBundle(path.join(OUTPUT_ROOT, 'terrain-surface.bin.gz'), bundle);

manifest.version = 13;
manifest.generatedAt = new Date().toISOString();
manifest.terrain.surfaceUrl = '/data/terrain-surface.bin.gz';
manifest.terrain.surfaceWidth = bundle.levels[0].width;
manifest.terrain.surfaceHeight = bundle.levels[0].height;
manifest.terrain.surfaceMipLevels = bundle.levels.length;
const assetFiles = [...Object.keys(manifest.assetBytes), 'terrain-surface.bin.gz'];
manifest.assetBytes = Object.fromEntries(await Promise.all(
  [...new Set(assetFiles)].map(async (file) => {
    const data = await fs.readFile(path.join(OUTPUT_ROOT, file));
    return [file, normalizedFileSize(file, data)];
  }),
));
await writeJson(manifestPath, manifest);
console.log(`Built ${bundle.levels.length} terrain surface mip levels (${bundle.levels[0].width}x${bundle.levels[0].height}).`);
