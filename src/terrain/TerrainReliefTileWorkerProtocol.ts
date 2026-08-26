export interface TerrainReliefTileRequest {
  id: number;
  url: string;
  expectedSize: number;
}

export type TerrainReliefTileResponse =
  | { id: number; pixels: ArrayBuffer }
  | { id: number; error: string };
