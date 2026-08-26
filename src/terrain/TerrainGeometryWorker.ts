import { TerrainData } from './TerrainData';
import type {
  TerrainGeometryBuffers,
  TerrainGeometryWorkerRequest,
  TerrainGeometryWorkerResponse,
} from './TerrainGeometryWorkerProtocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<TerrainGeometryWorkerRequest>) => void) | null;
  postMessage(message: TerrainGeometryWorkerResponse, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WorkerScope;
let terrain: TerrainData | undefined;

workerScope.onmessage = (event): void => {
  const message = event.data;
  try {
    if (message.type === 'initialize') {
      terrain = new TerrainData(
        message.source.meta,
        message.source.heights,
        message.source.coastMask,
        message.source.coastMaskWidth,
        message.source.coastMaskHeight,
        message.source.renderHeights,
      );
      workerScope.postMessage({ type: 'initialized' });
      return;
    }
    if (!terrain) throw new Error('Terrain geometry worker has not been initialized.');
    const geometry = terrain.createGeometry(message.options);
    const position = geometry.getAttribute('position').array as Float32Array;
    const morphPosition = geometry.getAttribute('aMorphPosition').array as Float32Array;
    const uv = geometry.getAttribute('uv').array as Float32Array;
    const sourceIndex = geometry.getIndex()?.array;
    const index = sourceIndex ? Uint32Array.from(sourceIndex) : new Uint32Array();
    const buffers: TerrainGeometryBuffers = { position, morphPosition, uv, index };
    workerScope.postMessage(
      { type: 'geometry', requestId: message.requestId, buffers },
      [position.buffer, morphPosition.buffer, uv.buffer, index.buffer],
    );
    geometry.dispose();
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      requestId: message.type === 'build' ? message.requestId : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
