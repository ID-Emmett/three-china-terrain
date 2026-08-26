import * as THREE from 'three/webgpu';
import type { TerrainMeta } from '../types/scene';

const MIN_TRIANGLE_AREA_UV = 1e-12;
const RENDER_GRID_SCALE = 1.5;

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return p1 + 0.5 * t * (
    p2 - p0
    + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0))
  );
}

export class TerrainData {
  public readonly renderWidth: number;
  public readonly renderHeight: number;
  private readonly renderHeights: Float32Array;
  private readonly renderCoast: Float32Array;
  private readonly coastMask: Uint8Array;
  private readonly coastMaskWidth: number;
  private readonly coastMaskHeight: number;

  public constructor(
    public readonly meta: TerrainMeta,
    public readonly heights: Int16Array,
    coastMask: Uint8Array,
    coastMaskWidth: number,
    coastMaskHeight: number,
  ) {
    // A 1.5x interpolated grid smooths DEM-sized facets without spending a
    // million triangles on values the source DEM does not contain. Relief and
    // generated material detail provide the higher-frequency visual signal.
    this.renderWidth = Math.round(meta.width * RENDER_GRID_SCALE);
    this.renderHeight = Math.round(meta.height * RENDER_GRID_SCALE);
    this.coastMask = coastMask;
    this.coastMaskWidth = coastMaskWidth;
    this.coastMaskHeight = coastMaskHeight;
    this.renderCoast = this.buildRenderCoastGrid();
    this.renderHeights = this.buildRenderHeightGrid();
  }

  public createGeometry(options: TerrainGeometryOptions = {}): THREE.BufferGeometry {
    const { sceneWidth, sceneDepth, sceneUnitsPerMeter } = this.meta;
    const width = this.renderWidth;
    const height = this.renderHeight;
    const columnStart = THREE.MathUtils.clamp(Math.floor(options.columnStart ?? 0), 0, width - 2);
    const columnEnd = THREE.MathUtils.clamp(Math.floor(options.columnEnd ?? width - 1), columnStart + 1, width - 1);
    const rowStart = THREE.MathUtils.clamp(Math.floor(options.rowStart ?? 0), 0, height - 2);
    const rowEnd = THREE.MathUtils.clamp(Math.floor(options.rowEnd ?? height - 1), rowStart + 1, height - 1);
    const step = Math.max(1, Math.floor(options.step ?? 1));
    const diagnostics = options.diagnostics ?? false;
    const columns: number[] = [];
    const rows: number[] = [];
    for (let column = columnStart; column < columnEnd; column += step) columns.push(column);
    for (let row = rowStart; row < rowEnd; row += step) rows.push(row);
    columns.push(columnEnd);
    rows.push(rowEnd);
    const positions: number[] = [];
    const elevations: number[] = [];
    const coastValues: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const vertexMap = new Map<string, number>();
    const addVertex = (vertex: TerrainVertex): number => {
      const key = `${vertex.u.toFixed(9)},${vertex.v.toFixed(9)}`;
      const existing = vertexMap.get(key);
      if (existing !== undefined) return existing;
      const index = positions.length / 3;
      vertexMap.set(key, index);
      positions.push(
        (vertex.u - 0.5) * sceneWidth,
        vertex.height * sceneUnitsPerMeter,
        (vertex.v - 0.5) * sceneDepth,
      );
      if (diagnostics) {
        elevations.push(vertex.height);
        coastValues.push(vertex.coast);
      }
      uvs.push(vertex.u, 1 - vertex.v);
      return index;
    };

    for (let rowIndex = 0; rowIndex < rows.length - 1; rowIndex += 1) {
      const row = rows[rowIndex];
      const nextRow = rows[rowIndex + 1];
      for (let columnIndex = 0; columnIndex < columns.length - 1; columnIndex += 1) {
        const column = columns[columnIndex];
        const nextColumn = columns[columnIndex + 1];
        const u0 = column / (width - 1);
        const u1 = nextColumn / (width - 1);
        const v0 = row / (height - 1);
        const v1 = nextRow / (height - 1);
        const a = this.makeVertex(u0, v0, false);
        const b = this.makeVertex(u1, v0, false);
        const c = this.makeVertex(u0, v1, false);
        const d = this.makeVertex(u1, v1, false);
        if ((Math.floor(row / step) + Math.floor(column / step)) % 2 === 0) {
          this.appendClippedTriangle([a, c, b], true, addVertex, indices);
          this.appendClippedTriangle([b, c, d], true, addVertex, indices);
        } else {
          this.appendClippedTriangle([a, c, d], true, addVertex, indices);
          this.appendClippedTriangle([a, d, b], true, addVertex, indices);
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (diagnostics) {
      geometry.setAttribute('aElevation', new THREE.Float32BufferAttribute(elevations, 1));
      geometry.setAttribute('aCoast', new THREE.Float32BufferAttribute(coastValues, 1));
    }
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.userData.terrainGrid = { columnStart, columnEnd, rowStart, rowEnd, step };
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  public createOceanGeometry(): THREE.BufferGeometry {
    const { sceneWidth, sceneDepth } = this.meta;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -sceneWidth / 2, 0, -sceneDepth / 2,
      sceneWidth / 2, 0, -sceneDepth / 2,
      -sceneWidth / 2, 0, sceneDepth / 2,
      sceneWidth / 2, 0, sceneDepth / 2,
    ], 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
      0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    ], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
      0, 1, 1, 1, 0, 0, 1, 0,
    ], 2));
    geometry.setIndex([0, 2, 1, 1, 2, 3]);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /**
   * Upload a filtered, UV-aligned terrain field for fragment shading.
   *
   * Keeping these fields in a texture is important: interpolating curvature
   * and cavity as vertex attributes makes every DEM triangle visible as a
   * separate color patch in close views.
   */
  public createSurfaceTexture(): THREE.DataTexture {
    const width = this.renderWidth;
    const height = this.renderHeight;
    // Elevation uses two normalized bytes (16-bit precision). Curvature and
    // cavity use the remaining channels, cutting this field to one quarter of
    // the equivalent RGBA32F upload.
    const data = new Uint8Array(width * height * 4);
    const elevationRange = Math.max(1, this.meta.maximumElevationMeters - this.meta.minimumElevationMeters);
    const sample = (x: number, y: number): number => this.renderHeights[
      THREE.MathUtils.clamp(y, 0, height - 1) * width
      + THREE.MathUtils.clamp(x, 0, width - 1)
    ];
    for (let sourceY = 0; sourceY < height; sourceY += 1) {
      const targetY = height - sourceY - 1;
      for (let x = 0; x < width; x += 1) {
        const offset = (targetY * width + x) * 4;
        const center = sample(x, sourceY);
        const left2 = sample(x - 2, sourceY);
        const right2 = sample(x + 2, sourceY);
        const up2 = sample(x, sourceY - 2);
        const down2 = sample(x, sourceY + 2);
        const curvatureRaw = (left2 + right2 + up2 + down2 - center * 4) * 0.25;
        const ringAverage = (left2 + right2 + up2 + down2) * 0.25;
        const localRelief = Math.max(
          24,
          Math.abs(right2 - left2) * 0.5 + Math.abs(down2 - up2) * 0.5,
        );
        const elevation = THREE.MathUtils.clamp(
          (center - this.meta.minimumElevationMeters) / elevationRange,
          0,
          1,
        );
        const encodedElevation = Math.round(elevation * 65535);
        data[offset] = encodedElevation >>> 8;
        data[offset + 1] = encodedElevation & 0xff;
        data[offset + 2] = Math.round(
          (THREE.MathUtils.clamp(curvatureRaw / 180, -1, 1) * 0.5 + 0.5) * 255,
        );
        data[offset + 3] = Math.round(
          THREE.MathUtils.clamp(0.5 + (ringAverage - center) / localRelief, 0, 1) * 255,
        );
      }
    }
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.name = 'TerrainSurfaceField';
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    // The field is sampled for height/normal reconstruction, not displayed as
    // a color texture. Avoid runtime float-mipmap generation, which is both
    // unnecessary at this resolution and stalls some WebGPU backends.
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  public validateGeometry(geometry: THREE.BufferGeometry): TerrainValidationReport {
    const positions = geometry.getAttribute('position');
    const elevation = geometry.getAttribute('aElevation');
    const coastAttribute = geometry.getAttribute('aCoast');
    const uv = geometry.getAttribute('uv');
    const index = geometry.getIndex();
    if (!positions || !elevation || !coastAttribute || !uv || !index) {
      throw new Error('Terrain validation requires indexed position, elevation, coast and UV data.');
    }

    let coastVertexCount = 0;
    let waterVertexCount = 0;
    let maximumCoastHeightMeters = 0;
    let maximumCoastIsoError = 0;
    for (let vertex = 0; vertex < positions.count; vertex += 1) {
      const coast = coastAttribute.getX(vertex);
      const height = elevation.getX(vertex);
      if (coast < 0.5 - 1e-6) waterVertexCount += 1;
      if (Math.abs(coast - 0.5) <= 1e-7) {
        coastVertexCount += 1;
        maximumCoastHeightMeters = Math.max(maximumCoastHeightMeters, Math.abs(height));
        maximumCoastIsoError = Math.max(maximumCoastIsoError, Math.abs(coast - 0.5));
      }
    }

    let degenerateTriangleCount = 0;
    let minimumTriangleAreaUv = Number.POSITIVE_INFINITY;
    let maximumSurfaceErrorMeters = 0;
    let worstSurfaceSample: TerrainValidationReport['worstSurfaceSample'];
    for (let offset = 0; offset < index.count; offset += 3) {
      const a = index.getX(offset);
      const b = index.getX(offset + 1);
      const c = index.getX(offset + 2);
      const au = uv.getX(a);
      const av = 1 - uv.getY(a);
      const bu = uv.getX(b);
      const bv = 1 - uv.getY(b);
      const cu = uv.getX(c);
      const cv = 1 - uv.getY(c);
      const twiceArea = Math.abs((bu - au) * (cv - av) - (bv - av) * (cu - au));
      minimumTriangleAreaUv = Math.min(minimumTriangleAreaUv, twiceArea * 0.5);
      if (twiceArea <= 1e-14) degenerateTriangleCount += 1;
      const centroidU = (au + bu + cu) / 3;
      const centroidV = (av + bv + cv) / 3;
      const renderedHeight = (elevation.getX(a) + elevation.getX(b) + elevation.getX(c)) / 3;
      const sampledHeight = this.sampleUv(centroidU, centroidV);
      const surfaceError = Math.abs(renderedHeight - sampledHeight);
      if (surfaceError > maximumSurfaceErrorMeters) {
        maximumSurfaceErrorMeters = surfaceError;
        worstSurfaceSample = {
          u: centroidU,
          v: centroidV,
          renderedHeight,
          sampledHeight,
          vertices: [
            { u: au, v: av, height: elevation.getX(a), coast: coastAttribute.getX(a) },
            { u: bu, v: bv, height: elevation.getX(b), coast: coastAttribute.getX(b) },
            { u: cu, v: cv, height: elevation.getX(c), coast: coastAttribute.getX(c) },
          ],
        };
      }
    }

    return {
      vertices: positions.count,
      triangles: index.count / 3,
      coastVertexCount,
      waterVertexCount,
      degenerateTriangleCount,
      maximumCoastHeightMeters,
      maximumCoastIsoError,
      maximumSurfaceErrorMeters,
      minimumTriangleAreaUv,
      worstSurfaceSample,
    };
  }

  /** Exact interpolation used by the rendered alternating-triangle grid. */
  public sampleUv(u: number, v: number): number {
    for (const triangle of this.landTrianglesAt(u, v)) {
      const height = barycentricHeight({ u, v }, triangle[0], triangle[1], triangle[2]);
      if (height !== null) return height;
    }
    return 0;
  }

  private sampleBaseUv(u: number, v: number): number {
    const width = this.renderWidth;
    const height = this.renderHeight;
    const x = THREE.MathUtils.clamp(u, 0, 1) * (width - 1);
    const y = THREE.MathUtils.clamp(v, 0, 1) * (height - 1);
    const x0 = Math.min(width - 2, Math.floor(x));
    const y0 = Math.min(height - 2, Math.floor(y));
    const tx = x - x0;
    const ty = y - y0;
    const a = this.renderHeights[y0 * width + x0];
    const b = this.renderHeights[y0 * width + x0 + 1];
    const c = this.renderHeights[(y0 + 1) * width + x0];
    const d = this.renderHeights[(y0 + 1) * width + x0 + 1];
    if ((x0 + y0) % 2 === 0) {
      if (tx + ty <= 1) return a * (1 - tx - ty) + b * tx + c * ty;
      return b * (1 - ty) + c * (1 - tx) + d * (tx + ty - 1);
    }
    if (ty >= tx) return a * (1 - ty) + c * (ty - tx) + d * tx;
    return a * (1 - tx) + d * ty + b * (tx - ty);
  }

  /** Split a segment at every edge of the final clipped triangle mesh. */
  public drapeSegment(
    a: { u: number; v: number },
    b: { u: number; v: number },
  ): Array<[{ u: number; v: number; height: number }, { u: number; v: number; height: number }]> {
    const width = this.renderWidth;
    const height = this.renderHeight;
    const ts = [0, 1];
    const addIntersection = (t: number): void => {
      if (t > 1e-8 && t < 1 - 1e-8) ts.push(t);
    };
    const du = b.u - a.u;
    const dv = b.v - a.v;
    if (Math.abs(du) > 1e-12) {
      const minX = Math.ceil(Math.min(a.u, b.u) * (width - 1));
      const maxX = Math.floor(Math.max(a.u, b.u) * (width - 1));
      for (let x = minX; x <= maxX; x += 1) addIntersection((x / (width - 1) - a.u) / du);
    }
    if (Math.abs(dv) > 1e-12) {
      const minY = Math.ceil(Math.min(a.v, b.v) * (height - 1));
      const maxY = Math.floor(Math.max(a.v, b.v) * (height - 1));
      for (let y = minY; y <= maxY; y += 1) addIntersection((y / (height - 1) - a.v) / dv);
    }
    ts.sort((left, right) => left - right);
    const uniqueTs = ts.filter((value, index) => index === 0 || Math.abs(value - ts[index - 1]) > 1e-8);
    const output: Array<[{ u: number; v: number; height: number }, { u: number; v: number; height: number }]> = [];
    for (let index = 0; index < uniqueTs.length - 1; index += 1) {
      const startT = uniqueTs[index];
      const endT = uniqueTs[index + 1];
      const midT = (startT + endT) * 0.5;
      const start = { u: a.u + du * startT, v: a.v + dv * startT };
      const end = { u: a.u + du * endT, v: a.v + dv * endT };
      const mid = { u: a.u + du * midT, v: a.v + dv * midT };
      // The grid diagonal is the only remaining planar break inside a cell.
      const cellX = Math.min(width - 2, Math.max(0, Math.floor(mid.u * (width - 1))));
      const cellY = Math.min(height - 2, Math.max(0, Math.floor(mid.v * (height - 1))));
      const diagonalStart = (cellX + cellY) % 2 === 0
        ? { u: (cellX + 1) / (width - 1), v: cellY / (height - 1) }
        : { u: cellX / (width - 1), v: cellY / (height - 1) };
      const diagonalEnd = (cellX + cellY) % 2 === 0
        ? { u: cellX / (width - 1), v: (cellY + 1) / (height - 1) }
        : { u: (cellX + 1) / (width - 1), v: (cellY + 1) / (height - 1) };
      const diagonalT = intersectParameter(start, end, diagonalStart, diagonalEnd);
      const planarBreaks = [0, 1];
      if (diagonalT !== null && diagonalT > 1e-8 && diagonalT < 1 - 1e-8) planarBreaks.push(diagonalT);
      planarBreaks.sort((left, right) => left - right);

      for (let planarIndex = 0; planarIndex < planarBreaks.length - 1; planarIndex += 1) {
        const planarStart = interpolatePoint(start, end, planarBreaks[planarIndex]);
        const planarEnd = interpolatePoint(start, end, planarBreaks[planarIndex + 1]);
        const planarMid = interpolatePoint(planarStart, planarEnd, 0.5);
        const landTriangles = this.surfaceTrianglesAt(planarMid.u, planarMid.v);
        const surfaceBreaks = [0, 1];

        // A clipped triangle may be a quad. Split at both coast edges and its fan diagonal.
        for (const triangle of landTriangles) {
          for (let edge = 0; edge < 3; edge += 1) {
            const edgeT = intersectParameter(
              planarStart,
              planarEnd,
              triangle[edge],
              triangle[(edge + 1) % 3],
            );
            if (edgeT !== null && edgeT > 1e-8 && edgeT < 1 - 1e-8) surfaceBreaks.push(edgeT);
          }
        }

        surfaceBreaks.sort((left, right) => left - right);
        const uniqueBreaks = surfaceBreaks.filter((value, breakIndex) => (
          breakIndex === 0 || Math.abs(value - surfaceBreaks[breakIndex - 1]) > 1e-8
        ));
        for (let surfaceIndex = 0; surfaceIndex < uniqueBreaks.length - 1; surfaceIndex += 1) {
          const surfaceStart = interpolatePoint(planarStart, planarEnd, uniqueBreaks[surfaceIndex]);
          const surfaceEnd = interpolatePoint(planarStart, planarEnd, uniqueBreaks[surfaceIndex + 1]);
          const surfaceMid = interpolatePoint(surfaceStart, surfaceEnd, 0.5);
          const containingTriangle = landTriangles.find((triangle) => (
            barycentricHeight(surfaceMid, triangle[0], triangle[1], triangle[2]) !== null
          ));
          if (!containingTriangle) {
            output.push([
              { ...surfaceStart, height: 0 },
              { ...surfaceEnd, height: 0 },
            ]);
            continue;
          }
          output.push([
            {
              ...surfaceStart,
              height: barycentricHeight(surfaceStart, containingTriangle[0], containingTriangle[1], containingTriangle[2])
                ?? this.sampleUv(surfaceStart.u, surfaceStart.v),
            },
            {
              ...surfaceEnd,
              height: barycentricHeight(surfaceEnd, containingTriangle[0], containingTriangle[1], containingTriangle[2])
                ?? this.sampleUv(surfaceEnd.u, surfaceEnd.v),
            },
          ]);
        }
      }
    }
    return output;
  }

  private buildRenderHeightGrid(): Float32Array {
    const output = new Float32Array(this.renderWidth * this.renderHeight);
    for (let y = 0; y < this.renderHeight; y += 1) {
      const v = y / (this.renderHeight - 1);
      for (let x = 0; x < this.renderWidth; x += 1) {
        output[y * this.renderWidth + x] = this.sampleSourceSmooth(
          x / (this.renderWidth - 1),
          v,
        );
      }
    }

    // A small edge-preserving pass removes isolated source-DEM spikes that
    // otherwise read as razor-dark ravines after vertical exaggeration. Sea
    // cells and the one-cell shoreline band stay untouched so the coast mask
    // remains watertight.
    const smoothed = new Float32Array(output);
    for (let y = 1; y < this.renderHeight - 1; y += 1) {
      for (let x = 1; x < this.renderWidth - 1; x += 1) {
        const index = y * this.renderWidth + x;
        const center = output[index];
        if (center <= 0) continue;
        const north = output[index - this.renderWidth];
        const south = output[index + this.renderWidth];
        const west = output[index - 1];
        const east = output[index + 1];
        const northwest = output[index - this.renderWidth - 1];
        const northeast = output[index - this.renderWidth + 1];
        const southwest = output[index + this.renderWidth - 1];
        const southeast = output[index + this.renderWidth + 1];
        if ([north, south, west, east, northwest, northeast, southwest, southeast].some((value) => value <= 0)) continue;
        const blur = (
          center * 4
          + (north + south + west + east) * 2
          + northwest + northeast + southwest + southeast
        ) / 16;
        smoothed[index] = THREE.MathUtils.lerp(center, blur, 0.18);
      }
    }
    return smoothed;
  }

  private buildRenderCoastGrid(): Float32Array {
    const output = new Float32Array(this.renderWidth * this.renderHeight);
    for (let y = 0; y < this.renderHeight; y += 1) {
      for (let x = 0; x < this.renderWidth; x += 1) {
        output[y * this.renderWidth + x] = this.sampleRawCoast(
          x / (this.renderWidth - 1),
          y / (this.renderHeight - 1),
        );
      }
    }
    return output;
  }

  private sampleSourceSmooth(u: number, v: number): number {
    const { width, height } = this.meta;
    const x = THREE.MathUtils.clamp(u, 0, 1) * (width - 1);
    const y = THREE.MathUtils.clamp(v, 0, 1) * (height - 1);
    const x1 = Math.floor(x);
    const y1 = Math.floor(y);
    const tx = x - x1;
    const ty = y - y1;
    const sample = (sx: number, sy: number): number => this.heights[
      THREE.MathUtils.clamp(sy, 0, height - 1) * width
      + THREE.MathUtils.clamp(sx, 0, width - 1)
    ];

    let containsSea = false;
    let localMinimum = Number.POSITIVE_INFINITY;
    let localMaximum = Number.NEGATIVE_INFINITY;
    let row0 = 0;
    let row1 = 0;
    let row2 = 0;
    let row3 = 0;
    for (let row = -1; row <= 2; row += 1) {
      const p0 = sample(x1 - 1, y1 + row);
      const p1 = sample(x1, y1 + row);
      const p2 = sample(x1 + 1, y1 + row);
      const p3 = sample(x1 + 2, y1 + row);
      containsSea ||= p0 === 0 || p1 === 0 || p2 === 0 || p3 === 0;
      localMinimum = Math.min(localMinimum, p0, p1, p2, p3);
      localMaximum = Math.max(localMaximum, p0, p1, p2, p3);
      const value = cubic(p0, p1, p2, p3, tx);
      if (row === -1) row0 = value;
      else if (row === 0) row1 = value;
      else if (row === 1) row2 = value;
      else row3 = value;
    }
    if (!containsSea) {
      return THREE.MathUtils.clamp(cubic(row0, row1, row2, row3, ty), localMinimum, localMaximum);
    }

    const a = sample(x1, y1);
    const b = sample(x1 + 1, y1);
    const c = sample(x1, y1 + 1);
    const d = sample(x1 + 1, y1 + 1);
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(a, b, tx),
      THREE.MathUtils.lerp(c, d, tx),
      ty,
    );
  }

  private makeVertex(u: number, v: number, forceSeaLevel: boolean): TerrainVertex {
    const coast = this.sampleCoast(u, v);
    const baseHeight = forceSeaLevel ? 0 : this.sampleBaseUv(u, v);
    // Quantized coast pixels can leave a one-vertex land sliver with a large DEM
    // value. Fade only this sub-pixel band to sea level so the final shoreline is
    // smooth and never contains a vertical spike.
    const coastRamp = THREE.MathUtils.smoothstep(coast, 0.5, 0.505);
    const height = baseHeight * coastRamp;
    return { u, v, height, coast };
  }

  private appendClippedTriangle(
    triangle: TerrainVertex[],
    keepLand: boolean,
    addVertex: (vertex: TerrainVertex) => number,
    indices: number[],
  ): void {
    for (const clippedTriangle of this.triangulateClipped(triangle, keepLand)) {
      const root = addVertex(clippedTriangle[0]);
      const next = addVertex(clippedTriangle[1]);
      const last = addVertex(clippedTriangle[2]);
      if (root !== next && next !== last && last !== root) indices.push(root, next, last);
    }
  }

  private triangulateClipped(triangle: TerrainVertex[], keepLand = true): TerrainVertex[][] {
    const polygon = this.clipTriangle(triangle, keepLand);
    const triangles: TerrainVertex[][] = [];
    for (let index = 1; index < polygon.length - 1; index += 1) {
      const candidate: TerrainVertex[] = [polygon[0], polygon[index], polygon[index + 1]];
      const area = Math.abs(
        (candidate[1].u - candidate[0].u) * (candidate[2].v - candidate[0].v)
        - (candidate[1].v - candidate[0].v) * (candidate[2].u - candidate[0].u),
      ) * 0.5;
      if (area > MIN_TRIANGLE_AREA_UV) triangles.push(candidate);
    }
    return triangles;
  }

  private clipTriangle(triangle: TerrainVertex[], keepLand = true): TerrainVertex[] {
    const clipped: TerrainVertex[] = [];
    for (let index = 0; index < triangle.length; index += 1) {
      const current = triangle[index];
      const previous = triangle[(index + triangle.length - 1) % triangle.length];
      const currentInside = keepLand ? current.coast >= 0.5 : current.coast <= 0.5;
      const previousInside = keepLand ? previous.coast >= 0.5 : previous.coast <= 0.5;
      if (currentInside !== previousInside) {
        const t = (0.5 - previous.coast) / (current.coast - previous.coast);
        clipped.push({
          u: previous.u + (current.u - previous.u) * t,
          v: previous.v + (current.v - previous.v) * t,
          height: 0,
          coast: 0.5,
        });
      }
      if (currentInside) clipped.push(current);
    }
    return clipped;
  }

  private landTrianglesAt(u: number, v: number): TerrainVertex[][] {
    const width = this.renderWidth;
    const height = this.renderHeight;
    const x = THREE.MathUtils.clamp(u, 0, 1) * (width - 1);
    const y = THREE.MathUtils.clamp(v, 0, 1) * (height - 1);
    const cellX = Math.min(width - 2, Math.floor(x));
    const cellY = Math.min(height - 2, Math.floor(y));
    const tx = x - cellX;
    const ty = y - cellY;
    const u0 = cellX / (width - 1);
    const u1 = (cellX + 1) / (width - 1);
    const v0 = cellY / (height - 1);
    const v1 = (cellY + 1) / (height - 1);
    const a = this.makeVertex(u0, v0, false);
    const b = this.makeVertex(u1, v0, false);
    const c = this.makeVertex(u0, v1, false);
    const d = this.makeVertex(u1, v1, false);
    let triangle: TerrainVertex[];
    if ((cellX + cellY) % 2 === 0) {
      triangle = tx + ty <= 1 ? [a, c, b] : [b, c, d];
    } else {
      triangle = ty >= tx ? [a, c, d] : [a, d, b];
    }
    return this.triangulateClipped(triangle, true);
  }

  private surfaceTrianglesAt(u: number, v: number): TerrainVertex[][] {
    return this.landTrianglesAt(u, v);
  }

  private sampleCoast(u: number, v: number): number {
    const width = this.renderWidth;
    const height = this.renderHeight;
    const x = THREE.MathUtils.clamp(u, 0, 1) * (width - 1);
    const y = THREE.MathUtils.clamp(v, 0, 1) * (height - 1);
    const x0 = Math.min(width - 2, Math.floor(x));
    const y0 = Math.min(height - 2, Math.floor(y));
    const tx = x - x0;
    const ty = y - y0;
    const a = this.renderCoast[y0 * width + x0];
    const b = this.renderCoast[y0 * width + x0 + 1];
    const c = this.renderCoast[(y0 + 1) * width + x0];
    const d = this.renderCoast[(y0 + 1) * width + x0 + 1];
    if ((x0 + y0) % 2 === 0) {
      if (tx + ty <= 1) return a * (1 - tx - ty) + b * tx + c * ty;
      return b * (1 - ty) + c * (1 - tx) + d * (tx + ty - 1);
    }
    if (ty >= tx) return a * (1 - ty) + c * (ty - tx) + d * tx;
    return a * (1 - tx) + d * ty + b * (tx - ty);
  }

  private sampleRawCoast(u: number, v: number): number {
    const x = THREE.MathUtils.clamp(u * this.coastMaskWidth - 0.5, 0, this.coastMaskWidth - 1);
    const y = THREE.MathUtils.clamp(v * this.coastMaskHeight - 0.5, 0, this.coastMaskHeight - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(this.coastMaskWidth - 1, x0 + 1);
    const y1 = Math.min(this.coastMaskHeight - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const at = (px: number, py: number): number => this.coastMask[py * this.coastMaskWidth + px] / 255;
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(at(x0, y0), at(x1, y0), tx),
      THREE.MathUtils.lerp(at(x0, y1), at(x1, y1), tx),
      ty,
    );
  }
}

interface TerrainVertex {
  u: number;
  v: number;
  height: number;
  coast: number;
}

export interface TerrainGeometryOptions {
  columnStart?: number;
  columnEnd?: number;
  rowStart?: number;
  rowEnd?: number;
  step?: number;
  diagnostics?: boolean;
}

export interface TerrainValidationReport {
  vertices: number;
  triangles: number;
  coastVertexCount: number;
  waterVertexCount: number;
  degenerateTriangleCount: number;
  maximumCoastHeightMeters: number;
  maximumCoastIsoError: number;
  maximumSurfaceErrorMeters: number;
  minimumTriangleAreaUv: number;
  worstSurfaceSample?: {
    u: number;
    v: number;
    renderedHeight: number;
    sampledHeight: number;
    vertices: Array<{ u: number; v: number; height: number; coast: number }>;
  };
}

function intersectParameter(
  a: { u: number; v: number },
  b: { u: number; v: number },
  c: { u: number; v: number },
  d: { u: number; v: number },
): number | null {
  const denominator = (b.u - a.u) * (d.v - c.v) - (b.v - a.v) * (d.u - c.u);
  if (Math.abs(denominator) < 1e-12) return null;
  const t = ((c.u - a.u) * (d.v - c.v) - (c.v - a.v) * (d.u - c.u)) / denominator;
  const s = ((c.u - a.u) * (b.v - a.v) - (c.v - a.v) * (b.u - a.u)) / denominator;
  return t >= -1e-8 && t <= 1 + 1e-8 && s >= -1e-8 && s <= 1 + 1e-8 ? THREE.MathUtils.clamp(t, 0, 1) : null;
}

function interpolatePoint(
  a: { u: number; v: number },
  b: { u: number; v: number },
  t: number,
): { u: number; v: number } {
  return {
    u: a.u + (b.u - a.u) * t,
    v: a.v + (b.v - a.v) * t,
  };
}

function barycentricHeight(
  point: { u: number; v: number },
  a: TerrainVertex,
  b: TerrainVertex,
  c: TerrainVertex,
): number | null {
  const denominator = (b.v - c.v) * (a.u - c.u) + (c.u - b.u) * (a.v - c.v);
  if (Math.abs(denominator) < 1e-16) return null;
  const wa = ((b.v - c.v) * (point.u - c.u) + (c.u - b.u) * (point.v - c.v)) / denominator;
  const wb = ((c.v - a.v) * (point.u - c.u) + (a.u - c.u) * (point.v - c.v)) / denominator;
  const wc = 1 - wa - wb;
  if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7) return null;
  return wa * a.height + wb * b.height + wc * c.height;
}
