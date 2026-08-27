export interface TerrainReliefTileRequest {
  type: 'load';
  id: number;
  url: string;
  expectedSize: number;
  format: 'webp' | 'ktx2';
}

export interface TerrainReliefTileCancel {
  type: 'cancel';
  id: number;
}

export type TerrainReliefTileWorkerMessage = TerrainReliefTileRequest | TerrainReliefTileCancel;

export type TerrainReliefTileResponse =
  | { id: number; pixels: ArrayBuffer }
  | { id: number; encoded: ArrayBuffer }
  | { id: number; error: string };
