import type { TerrainSurfaceMeta } from './TerrainSurfaceField';

export type TerrainSurfaceWorkerRequest =
  | { type: 'initialize'; meta: TerrainSurfaceMeta; heights: Int16Array }
  | { type: 'buildSurface'; relief: Blob; reliefWidth: number; reliefHeight: number };

export type TerrainSurfaceWorkerResponse =
  | { type: 'renderHeights'; renderHeights: Float32Array; width: number; height: number; durationMs: number }
  | { type: 'surface'; bundle: ArrayBuffer; durationMs: number }
  | { type: 'error'; message: string };
