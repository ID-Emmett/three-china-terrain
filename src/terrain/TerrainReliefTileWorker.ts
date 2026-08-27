/// <reference lib="webworker" />

import type {
  TerrainReliefTileRequest,
  TerrainReliefTileResponse,
  TerrainReliefTileWorkerMessage,
} from './TerrainReliefTileWorkerProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const controllers = new Map<number, AbortController>();

scope.onmessage = (event: MessageEvent<TerrainReliefTileWorkerMessage>): void => {
  if (event.data.type === 'cancel') {
    controllers.get(event.data.id)?.abort();
    return;
  }
  const controller = new AbortController();
  controllers.set(event.data.id, controller);
  void decodeTile(event.data, controller.signal).finally(() => controllers.delete(event.data.id));
};

async function decodeTile(request: TerrainReliefTileRequest, signal: AbortSignal): Promise<void> {
  try {
    const response = await fetch(request.url, { cache: 'force-cache', signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    if (request.format === 'ktx2') {
      const encoded = await response.arrayBuffer();
      const message: TerrainReliefTileResponse = { id: request.id, encoded };
      scope.postMessage(message, [encoded]);
      return;
    }
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
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      const targetY = canvas.height - sourceY - 1;
      pixels.set(source.subarray(sourceY * stride, (sourceY + 1) * stride), targetY * stride);
    }
    const message: TerrainReliefTileResponse = { id: request.id, pixels: pixels.buffer };
    scope.postMessage(message, [pixels.buffer]);
  } catch (error) {
    const aborted = signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    const message: TerrainReliefTileResponse = {
      id: request.id,
      error: aborted ? 'aborted' : error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(message);
  }
}
