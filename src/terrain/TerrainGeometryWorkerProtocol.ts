import type { TerrainMeta } from '../types/scene';
import type { TerrainGeometryOptions } from './TerrainData';

export interface TerrainWorkerSource {
  meta: TerrainMeta;
  heights: Int16Array;
  renderHeights: Float32Array;
  coastMask: Uint8Array;
  coastMaskWidth: number;
  coastMaskHeight: number;
}

export type TerrainGeometryWorkerRequest =
  | { type: 'initialize'; source: TerrainWorkerSource }
  | { type: 'build'; requestId: number; options: TerrainGeometryOptions };

export interface TerrainGeometryBuffers {
  position: Float32Array;
  morphPosition: Float32Array;
  uv: Float32Array;
  index: Uint32Array;
}

export type TerrainGeometryWorkerResponse =
  | { type: 'initialized' }
  | { type: 'geometry'; requestId: number; buffers: TerrainGeometryBuffers }
  | { type: 'error'; requestId?: number; message: string };
