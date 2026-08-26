import type {
  AdminLabelDatum,
  DeferredAdminAssets,
  SceneAssets,
  SceneManifest,
} from '../types/scene';

async function fetchChecked(url: string, cache: RequestCache = 'force-cache'): Promise<Response> {
  const response = await fetch(url, { cache });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
  }
  return response;
}

async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const response = await fetchChecked(url);
  const compressed = new URL(url, window.location.href).pathname.endsWith('.gz');
  if (!compressed || response.headers.get('content-encoding') === 'gzip') {
    return response.arrayBuffer();
  }
  if (!response.body || typeof DecompressionStream === 'undefined') {
    throw new Error(`This browser cannot decompress ${url}.`);
  }
  const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

function versionedAssetUrl(url: string, version: number, generatedAt: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}v=${encodeURIComponent(`${version}-${generatedAt}`)}`;
}

export class AssetManifestLoader {
  public async load(manifestUrl = '/data/scene-manifest.json'): Promise<SceneAssets> {
    const startedAt = performance.now();
    // The manifest is the cache-busting root. It must always be revalidated so a
    // regenerated local dataset cannot be paired with an older binary asset set.
    const manifestResponse = await fetch(manifestUrl, { cache: 'no-store' });
    if (!manifestResponse.ok) {
      throw new Error(`Failed to load ${manifestUrl}: ${manifestResponse.status} ${manifestResponse.statusText}`);
    }
    const manifest = await manifestResponse.json() as SceneManifest;
    if (manifest.version !== 15 || manifest.topology?.boundaryFormat !== 'LGB4-uv-province') {
      throw new Error('Scene asset manifest is stale or incompatible with the current renderer.');
    }
    const assetUrl = (url: string): string => versionedAssetUrl(
      url,
      manifest.version,
      manifest.generatedAt,
    );

    const terrainReliefBlobPromise = fetchChecked(assetUrl(manifest.terrain.reliefTextureUrl))
      .then((response) => response.blob());
    const terrainReliefPromise = terrainReliefBlobPromise.then((blob) => createImageBitmap(
      blob,
      { colorSpaceConversion: 'none', premultiplyAlpha: 'none' },
    ));

    const [
      heightBuffer,
      terrainReliefBlob,
      terrainRelief,
      terrainImagery,
      oceanMaskBuffer,
      chinaMaskBuffer,
      provinceBoundary,
      provinceLabels,
    ] = await Promise.all([
      fetchBinary(assetUrl(manifest.terrain.heightUrl)),
      terrainReliefBlobPromise,
      terrainReliefPromise,
      fetchChecked(assetUrl(manifest.terrainImagery.url))
        .then((response) => response.blob())
        .then((blob) => createImageBitmap(blob, { colorSpaceConversion: 'default' })),
      fetchBinary(assetUrl(manifest.ocean.maskUrl)),
      fetchBinary(assetUrl(manifest.china.maskUrl)),
      fetchBinary(assetUrl(manifest.boundaries.province)),
      fetchChecked(assetUrl(manifest.labels.province)).then((response) => response.json() as Promise<AdminLabelDatum[]>),
    ]);

    const heights = new Int16Array(heightBuffer);
    const expectedHeightCount = manifest.terrain.width * manifest.terrain.height;
    if (heights.length !== expectedHeightCount) {
      throw new Error(`Terrain height count mismatch: ${heights.length} !== ${expectedHeightCount}`);
    }
    if (terrainRelief.width !== manifest.terrain.reliefWidth
      || terrainRelief.height !== manifest.terrain.reliefHeight) {
      throw new Error('Terrain relief image dimensions do not match the manifest.');
    }

    return {
      manifest,
      heights,
      terrainReliefBlob,
      terrainRelief,
      terrainImagery,
      oceanMask: new Uint8Array(oceanMaskBuffer),
      chinaMask: new Uint8Array(chinaMaskBuffer),
      provinceBoundary,
      provinceLabels,
      loadDurationMs: performance.now() - startedAt,
    };
  }
  public async loadDeferredAdmin(manifest: SceneManifest): Promise<DeferredAdminAssets> {
    const assetUrl = (url: string): string => versionedAssetUrl(
      url,
      manifest.version,
      manifest.generatedAt,
    );
    const [cityBoundary, cityLabels] = await Promise.all([
      fetchBinary(assetUrl(manifest.boundaries.city)),
      fetchChecked(assetUrl(manifest.labels.city))
        .then((response) => response.json() as Promise<AdminLabelDatum[]>),
    ]);
    return { cityBoundary, cityLabels };
  }
}
