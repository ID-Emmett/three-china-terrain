import type { TerrainData } from '../terrain/TerrainData';

export interface DecodedBoundaryData {
  positions: Float32Array;
  provinceAdcodes: Int32Array;
  ringCount: number;
  segmentCount: number;
  sourceSegmentCount: number;
  maximumSurfaceErrorMeters: number;
  worstSample?: { u: number; v: number; renderedHeight: number; sampledHeight: number };
}

interface BoundaryPoint {
  u: number;
  v: number;
}

function segmentKey(a: BoundaryPoint, b: BoundaryPoint): string {
  const aKey = `${a.u.toFixed(8)},${a.v.toFixed(8)}`;
  const bKey = `${b.u.toFixed(8)},${b.v.toFixed(8)}`;
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

function pushPoint(
  positions: number[],
  point: BoundaryPoint & { height: number },
  terrain: TerrainData,
): void {
  positions.push(
    (point.u - 0.5) * terrain.meta.sceneWidth,
    point.height * terrain.meta.sceneUnitsPerMeter,
    (point.v - 0.5) * terrain.meta.sceneDepth,
  );
}

export function decodeBoundaryBuffers(buffers: ArrayBuffer[], terrain: TerrainData): DecodedBoundaryData {
  const positions: number[] = [];
  const provinceAdcodes: number[] = [];
  const seenSegments = new Set<string>();
  let ringCount = 0;
  let sourceSegmentCount = 0;
  let maximumSurfaceErrorMeters = 0;
  let worstSample: DecodedBoundaryData['worstSample'];

  for (const buffer of buffers) {
    const view = new DataView(buffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'LGB4') throw new Error(`Unsupported boundary format: ${magic}`);

    const bufferRingCount = view.getUint32(4, true);
    ringCount += bufferRingCount;
    let offset = 8;
    for (let ring = 0; ring < bufferRingCount; ring += 1) {
      const provinceAdcode = view.getInt32(offset, true);
      const pointCount = view.getUint32(offset + 4, true);
      offset += 8;
      if (pointCount === 0) continue;
      let previous: BoundaryPoint = {
        u: view.getFloat32(offset, true),
        v: view.getFloat32(offset + 4, true),
      };
      offset += 8;
      for (let pointIndex = 1; pointIndex < pointCount; pointIndex += 1) {
        const current: BoundaryPoint = {
          u: view.getFloat32(offset, true),
          v: view.getFloat32(offset + 4, true),
        };
        offset += 8;
        const key = segmentKey(previous, current);
        if (!seenSegments.has(key) && (previous.u !== current.u || previous.v !== current.v)) {
          seenSegments.add(key);
          sourceSegmentCount += 1;
          for (const [start, end] of terrain.drapeSegment(previous, current)) {
            pushPoint(positions, start, terrain);
            pushPoint(positions, end, terrain);
            provinceAdcodes.push(provinceAdcode);
            for (const fraction of [0.25, 0.5, 0.75]) {
              const sampleU = start.u + (end.u - start.u) * fraction;
              const sampleV = start.v + (end.v - start.v) * fraction;
              const renderedHeight = start.height + (end.height - start.height) * fraction;
              const sampledHeight = terrain.sampleUv(sampleU, sampleV);
              const error = Math.abs(renderedHeight - sampledHeight);
              if (error > maximumSurfaceErrorMeters) {
                maximumSurfaceErrorMeters = error;
                worstSample = { u: sampleU, v: sampleV, renderedHeight, sampledHeight };
              }
            }
          }
        }
        previous = current;
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    provinceAdcodes: new Int32Array(provinceAdcodes),
    ringCount,
    segmentCount: positions.length / 6,
    sourceSegmentCount,
    maximumSurfaceErrorMeters,
    worstSample,
  };
}

export function decodeBoundaryBuffer(buffer: ArrayBuffer, terrain: TerrainData): DecodedBoundaryData {
  return decodeBoundaryBuffers([buffer], terrain);
}
