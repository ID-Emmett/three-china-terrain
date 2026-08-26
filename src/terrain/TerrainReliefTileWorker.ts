/// <reference lib="webworker" />

import type {
  TerrainReliefTileRequest,
  TerrainReliefTileResponse,
} from './TerrainReliefTileWorkerProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<TerrainReliefTileRequest>): void => {
  void decodeTile(event.data);
};

async function decodeTile(request: TerrainReliefTileRequest): Promise<void> {
  try {
    const response = await fetch(request.url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const bitmap = await createImageBitmap(await response.blob(), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    if (bitmap.width !== request.expectedSize || bitmap.height !== request.expectedSize) {
      bitmap.close();
      throw new Error(`unexpected ${bitmap.width}x${bitmap.height} tile`);
    }

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      bitmap.close();
      throw new Error('2D decoding context is unavailable');
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const source = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const pixels = new Uint8Array(source.length);
    const stride = canvas.width * 4;
    for (let sourceY = 0; sourceY < canvas.height; sourceY += 1) {
      const targetY = canvas.height - sourceY - 1;
      pixels.set(source.subarray(sourceY * stride, (sourceY + 1) * stride), targetY * stride);
    }
    const message: TerrainReliefTileResponse = { id: request.id, pixels: pixels.buffer };
    scope.postMessage(message, [pixels.buffer]);
  } catch (error) {
    const message: TerrainReliefTileResponse = {
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(message);
  }
}
