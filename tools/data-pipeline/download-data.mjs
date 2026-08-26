import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CACHE_ROOT,
  REGION,
  latToTileY,
  lonToTileX,
} from './config.mjs';
import {
  downloadToFile,
  ensureDirectory,
  mapConcurrent,
  readJson,
  writeJson,
} from './io.mjs';

const ADMIN_BASE = 'https://geo.datav.aliyun.com/areas_v3/bound';
const TERRAIN_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TERRAIN_IMAGE_PROXY = 'https://images.weserv.nl/?output=png&url=';
const LAND_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson';
const NASA_IMAGERY_URL = 'https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/august/world.topo.bathy.200408.3x21600x10800.jpg';

const adminDirectory = path.join(CACHE_ROOT, 'admin');
const terrainDirectory = path.join(CACHE_ROOT, 'terrain');
const landFile = path.join(CACHE_ROOT, 'natural-earth', 'ne_50m_land.geojson');
const imageryFile = path.join(CACHE_ROOT, 'nasa-blue-marble-2004-08-21600.jpg');

async function downloadAdminFile(adcode, optional = false) {
  const filePath = path.join(adminDirectory, `${adcode}_full.json`);
  return downloadToFile(`${ADMIN_BASE}/${adcode}_full.json`, filePath, { optional });
}

async function downloadAdministrativeData() {
  console.log('Downloading administrative boundaries...');
  const nationalDownload = await downloadAdminFile(100000);
  const national = await readJson(nationalDownload.filePath);
  const provinces = national.features.filter((feature) => (
    feature.properties?.level === 'province'
    && Number.isInteger(Number(feature.properties?.adcode))
  ));

  const results = await mapConcurrent(provinces, 8, async (feature) => {
    const adcode = Number(feature.properties.adcode);
    const optional = Number(feature.properties.childrenNum) === 0;
    return downloadAdminFile(adcode, optional);
  });

  return {
    nationalFiles: 1,
    provinceEntries: provinces.length,
    provinceFiles: results.filter((result) => !result.skipped).length,
  };
}

async function downloadTerrainData(zoom, label) {
  console.log(`Downloading ${label} Terrarium elevation tiles at zoom ${zoom}...`);
  const minX = lonToTileX(REGION.west, zoom);
  const maxX = lonToTileX(REGION.east, zoom);
  const minY = latToTileY(REGION.north, zoom);
  const maxY = latToTileY(REGION.south, zoom);
  const tiles = [];

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      tiles.push({ x, y, zoom });
    }
  }

  await mapConcurrent(tiles, 12, async ({ x, y, zoom: tileZoom }) => {
    const target = path.join(terrainDirectory, String(tileZoom), String(x), `${y}.png`);
    const sourceUrl = `${TERRAIN_BASE}/${tileZoom}/${x}/${y}.png`;
    await downloadToFile(`${TERRAIN_IMAGE_PROXY}${encodeURIComponent(sourceUrl)}`, target);
  });

  return { zoom, minX, maxX, minY, maxY, tileCount: tiles.length };
}

async function main() {
  await ensureDirectory(CACHE_ROOT);
  const [admin, terrain, terrainDetail] = await Promise.all([
    downloadAdministrativeData(),
    downloadTerrainData(REGION.terrainZoom, 'base'),
    downloadTerrainData(REGION.terrainDetailZoom, 'detail'),
    downloadToFile(LAND_URL, landFile),
    downloadToFile(NASA_IMAGERY_URL, imageryFile),
  ]);

  const cacheStats = await fs.stat(CACHE_ROOT);
  await writeJson(path.join(CACHE_ROOT, 'download-manifest.json'), {
    generatedAt: new Date().toISOString(),
    region: REGION,
    admin,
    terrain,
    terrainDetail,
    cacheCreatedAt: cacheStats.birthtime.toISOString(),
    sources: {
      administrative: ADMIN_BASE,
      elevation: TERRAIN_BASE,
      landMask: LAND_URL,
      terrainImagery: NASA_IMAGERY_URL,
    },
  });

  console.log(
    `Downloaded ${terrain.tileCount} base tiles, ${terrainDetail.tileCount} detail tiles, and ${admin.provinceFiles} province files.`,
  );
}

await main();
