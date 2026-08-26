import {
  buildTerrainRenderHeightGrid,
  buildTerrainSurfaceBundle,
  type TerrainSurfaceMeta,
} from './TerrainSurfaceField';
import type { TerrainSurfaceWorkerRequest, TerrainSurfaceWorkerResponse } from './TerrainSurfaceWorkerProtocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<TerrainSurfaceWorkerRequest>) => void) | null;
  postMessage(message: TerrainSurfaceWorkerResponse, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WorkerScope;
let meta: TerrainSurfaceMeta | undefined;
let renderHeights: Float32Array | undefined;
let renderWidth = 0;
let renderHeight = 0;

workerScope.onmessage = async (event): Promise<void> => {
  try {
    if (event.data.type === 'initialize') {
      const startedAt = performance.now();
      meta = event.data.meta;
      const grid = buildTerrainRenderHeightGrid(meta, event.data.heights);
      renderHeights = grid.data;
      renderWidth = grid.width;
      renderHeight = grid.height;
      const output = renderHeights.slice();
      workerScope.postMessage({
        type: 'renderHeights',
        renderHeights: output,
        width: renderWidth,
        height: renderHeight,
        durationMs: performance.now() - startedAt,
      }, [output.buffer]);
      return;
    }
    if (!meta || !renderHeights) throw new Error('Terrain surface worker has not been initialized.');
    const startedAt = performance.now();
    const bitmap = await createImageBitmap(event.data.relief, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    try {
      if (bitmap.width !== event.data.reliefWidth || bitmap.height !== event.data.reliefHeight) {
        throw new Error('Terrain relief dimensions do not match the manifest.');
      }
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Terrain surface worker cannot read relief pixels.');
      context.drawImage(bitmap, 0, 0);
      const reliefPixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const bundle = buildTerrainSurfaceBundle(
        meta,
        renderHeights,
        renderWidth,
        renderHeight,
        reliefPixels,
        bitmap.width,
        bitmap.height,
      );
      workerScope.postMessage({
        type: 'surface',
        bundle,
        durationMs: performance.now() - startedAt,
      }, [bundle]);
    } finally {
      bitmap.close();
    }
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
