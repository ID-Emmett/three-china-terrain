export type AdminLevel = 'province' | 'city';

export interface TerrainMeta {
  width: number;
  height: number;
  minimumElevationMeters: number;
  maximumElevationMeters: number;
  sceneWidth: number;
  sceneDepth: number;
  sceneUnitsPerMeter: number;
  bounds: {
    west: number;
    east: number;
    south: number;
    north: number;
  };
}

export interface SceneManifest {
  version: number;
  generatedAt: string;
  terrain: TerrainMeta & {
    metaUrl: string;
    heightUrl: string;
    reliefTextureUrl: string;
    reliefWidth: number;
    reliefHeight: number;
    reliefResidualRangeMeters: number;
  };
  terrainImagery: {
    url: string;
    width: number;
    height: number;
    colorSpace: 'srgb';
  };
  ocean: {
    maskUrl: string;
    maskWidth: number;
    maskHeight: number;
    maskChannels: 1;
  };
  china: {
    maskUrl: string;
    maskWidth: number;
    maskHeight: number;
    maskChannels: 1;
  };
  boundaries: Record<AdminLevel, string>;
  labels: Record<AdminLevel, string>;
  adminSummary: Record<AdminLevel, {
    features: number;
    rings: number;
    lines: number;
    segments: number;
    points: number;
    labels: number;
  }>;
  assetBytes: Record<string, number>;
  topology: {
    landMask: string;
    coastIsoValue: 0.5;
    surface: 'shared-clipped-triangle-mesh';
    boundaryHeight: 'runtime-final-terrain-triangle-sampling';
    boundaryFormat: 'LGB4-uv-province';
  };
  sources: Record<string, string>;
}

export interface AdminLabelDatum {
  adcode: number;
  name: string;
  level: AdminLevel;
  u: number;
  v: number;
}

export interface SceneAssets {
  manifest: SceneManifest;
  heights: Int16Array;
  terrainRelief: ImageBitmap;
  terrainImagery: ImageBitmap;
  oceanMask: Uint8Array;
  chinaMask: Uint8Array;
  provinceBoundary: ArrayBuffer;
  provinceLabels: AdminLabelDatum[];
  loadDurationMs: number;
}

export interface DeferredAdminAssets {
  cityBoundary: ArrayBuffer;
  cityLabels: AdminLabelDatum[];
}
