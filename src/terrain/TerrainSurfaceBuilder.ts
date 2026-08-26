import type { SceneManifest } from '../types/scene';
import {
  decodeTerrainSurfaceBundle,
  TERRAIN_RENDER_GRID_SCALE,
  TERRAIN_SURFACE_FORMAT_VERSION,
  type TerrainSurfaceMeta,
} from './TerrainSurfaceField';
import type { TerrainSurfaceWorkerRequest, TerrainSurfaceWorkerResponse } from './TerrainSurfaceWorkerProtocol';

const DATABASE_NAME = 'three-china-terrain';
const DATABASE_VERSION = 1;
const STORE_NAME = 'derived-terrain';

interface RenderHeightResult {
  data: Float32Array;
  durationMs: number;
}

export class TerrainSurfaceBuilder {
  private readonly worker = new Worker(
    new URL('./TerrainSurfaceWorker.ts', import.meta.url),
    { type: 'module', name: 'terrain-surface' },
  );
  private readonly expectedWidth: number;
  private readonly expectedHeight: number;
  private readonly cacheKey: string;
  private readonly cachedBundle: Promise<ArrayBuffer | undefined>;
  private readonly renderHeights: Promise<RenderHeightResult>;
  private resolveRenderHeights!: (result: RenderHeightResult) => void;
  private rejectRenderHeights!: (error: Error) => void;
  private surface?: Promise<ArrayBuffer>;
  private resolveSurface?: (bundle: ArrayBuffer) => void;
  private rejectSurface?: (error: Error) => void;
  private disposed = false;

  public constructor(manifest: SceneManifest, heights: Int16Array) {
    const meta: TerrainSurfaceMeta = manifest.terrain;
    this.expectedWidth = Math.round(meta.width * TERRAIN_RENDER_GRID_SCALE);
    this.expectedHeight = Math.round(meta.height * TERRAIN_RENDER_GRID_SCALE);
    this.cacheKey = [
      `surface-v${TERRAIN_SURFACE_FORMAT_VERSION}`,
      manifest.version,
      manifest.generatedAt,
      `${this.expectedWidth}x${this.expectedHeight}`,
    ].join(':');
    this.cachedBundle = readCachedBundle(this.cacheKey, this.expectedWidth, this.expectedHeight);
    this.renderHeights = new Promise<RenderHeightResult>((resolve, reject) => {
      this.resolveRenderHeights = resolve;
      this.rejectRenderHeights = reject;
    });
    this.worker.onmessage = this.onMessage;
    this.worker.onerror = (event): void => this.fail(new Error(event.message || 'Terrain surface worker failed.'));
    const request: TerrainSurfaceWorkerRequest = { type: 'initialize', meta, heights };
    this.worker.postMessage(request);
  }

  public async getRenderHeights(): Promise<RenderHeightResult> {
    return this.renderHeights;
  }

  public async buildSurface(relief: Blob, reliefWidth: number, reliefHeight: number): Promise<ArrayBuffer> {
    if (this.surface) return this.surface;
    this.surface = this.createSurfacePromise(relief, reliefWidth, reliefHeight);
    return this.surface;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
  }

  private async createSurfacePromise(
    relief: Blob,
    reliefWidth: number,
    reliefHeight: number,
  ): Promise<ArrayBuffer> {
    await this.renderHeights;
    const cached = await this.cachedBundle;
    if (cached) {
      this.dispose();
      return cached;
    }
    if (this.disposed) throw new Error('Terrain surface builder is disposed.');
    const promise = new Promise<ArrayBuffer>((resolve, reject) => {
      this.resolveSurface = resolve;
      this.rejectSurface = reject;
    });
    const request: TerrainSurfaceWorkerRequest = { type: 'buildSurface', relief, reliefWidth, reliefHeight };
    this.worker.postMessage(request);
    return promise;
  }

  private readonly onMessage = (event: MessageEvent<TerrainSurfaceWorkerResponse>): void => {
    const message = event.data;
    if (message.type === 'error') {
      this.fail(new Error(message.message));
      return;
    }
    if (message.type === 'renderHeights') {
      if (message.width !== this.expectedWidth || message.height !== this.expectedHeight) {
        this.fail(new Error('Terrain render height dimensions are invalid.'));
        return;
      }
      this.resolveRenderHeights({ data: message.renderHeights, durationMs: message.durationMs });
      return;
    }
    try {
      validateBundle(message.bundle, this.expectedWidth, this.expectedHeight);
      this.resolveSurface?.(message.bundle);
      const cacheCopy = message.bundle.slice(0);
      window.setTimeout(() => void writeCachedBundle(this.cacheKey, cacheCopy), 0);
      this.dispose();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  };

  private fail(error: Error): void {
    this.rejectRenderHeights(error);
    this.rejectSurface?.(error);
    this.dispose();
  }
}

function validateBundle(buffer: ArrayBuffer, width: number, height: number): void {
  const levels = decodeTerrainSurfaceBundle(buffer);
  if (levels[0].width !== width || levels[0].height !== height) {
    throw new Error('Cached terrain surface dimensions are invalid.');
  }
}

async function openCache(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return undefined;
  return new Promise<IDBDatabase | undefined>((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = (): void => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => resolve(undefined);
    request.onblocked = (): void => resolve(undefined);
  });
}

async function readCachedBundle(
  key: string,
  expectedWidth: number,
  expectedHeight: number,
): Promise<ArrayBuffer | undefined> {
  const database = await openCache();
  if (!database) return undefined;
  try {
    const value = await new Promise<unknown>((resolve) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = (): void => resolve(request.result);
      request.onerror = (): void => resolve(undefined);
    });
    if (!(value instanceof ArrayBuffer)) return undefined;
    validateBundle(value, expectedWidth, expectedHeight);
    return value;
  } catch {
    return undefined;
  } finally {
    database.close();
  }
}

async function writeCachedBundle(key: string, bundle: ArrayBuffer): Promise<void> {
  const database = await openCache();
  if (!database) return;
  try {
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.clear();
      store.put(bundle, key);
      transaction.oncomplete = (): void => resolve();
      transaction.onerror = (): void => resolve();
      transaction.onabort = (): void => resolve();
    });
  } finally {
    database.close();
  }
}
