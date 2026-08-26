export const TERRAIN_LOD_DEFAULTS = {
  // Scene units: the China terrain is roughly 120 units wide. The default
  // radial camera is about 9.7 units from its target, but its frustum reaches
  // several province widths, so the medium band must remain active well past
  // the camera radius. High-frequency bands stay short to avoid moire.
  // The default province framing sits around 60-75 scene units. Keep the
  // low-frequency mountain network fully active there; it fades only when the
  // camera is far enough away that a ridge is below a few pixels.
  materialDistance: 128,
  detailDistance: 104,
} as const;

export const TERRAIN_LOD_RANGES = {
  materialDistance: { min: 24, max: 180, step: 1 },
  detailDistance: { min: 12, max: 110, step: 1 },
} as const;

// The full China terrain spans 120 scene units. These bands are intentionally
// city/province-scale rather than real-world metre distances.
export const TERRAIN_SCENE_WIDTH_UNITS = 120;
