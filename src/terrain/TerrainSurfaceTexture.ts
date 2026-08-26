import * as THREE from 'three/webgpu';

const MAGIC = 'TSF2';

export interface TerrainSurfaceTextures {
  surface: THREE.DataTexture;
  normal: THREE.DataTexture;
  width: number;
  height: number;
  mipLevels: number;
}

export function decodeTerrainSurfaceHeights(
  buffer: ArrayBuffer,
  minimumElevationMeters: number,
  maximumElevationMeters: number,
): Float32Array {
  const view = new DataView(buffer);
  if (buffer.byteLength < 16) throw new Error('Terrain surface field is truncated.');
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== MAGIC) throw new Error(`Unsupported terrain surface field: ${magic}.`);
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const surfaceOffset = 16;
  const byteLength = width * height * 4;
  if (surfaceOffset + byteLength > buffer.byteLength) throw new Error('Terrain surface base level is truncated.');
  const pixels = new Uint8Array(buffer, surfaceOffset, byteLength);
  const heights = new Float32Array(width * height);
  const range = maximumElevationMeters - minimumElevationMeters;
  for (let y = 0; y < height; y += 1) {
    const textureY = height - y - 1;
    for (let x = 0; x < width; x += 1) {
      const offset = (textureY * width + x) * 4;
      const normalized = ((pixels[offset] << 8) | pixels[offset + 1]) / 65535;
      heights[y * width + x] = minimumElevationMeters + normalized * range;
    }
  }
  return heights;
}

export function createTerrainSurfaceTextures(buffer: ArrayBuffer): TerrainSurfaceTextures {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8) throw new Error('Terrain surface field is truncated.');
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== MAGIC) throw new Error(`Unsupported terrain surface field: ${magic}.`);
  const mipLevels = view.getUint32(4, true);
  if (mipLevels < 1 || mipLevels > 16) throw new Error(`Invalid terrain surface mip count: ${mipLevels}.`);
  const surfaceMipmaps: Array<{ data: Uint8Array; width: number; height: number }> = [];
  const normalMipmaps: Array<{ data: Uint8Array; width: number; height: number }> = [];
  let offset = 8;
  for (let level = 0; level < mipLevels; level += 1) {
    if (offset + 8 > buffer.byteLength) throw new Error('Terrain surface mip header is truncated.');
    const width = view.getUint32(offset, true);
    const height = view.getUint32(offset + 4, true);
    offset += 8;
    const byteLength = width * height * 4;
    if (width < 1 || height < 1 || offset + byteLength * 2 > buffer.byteLength) {
      throw new Error(`Invalid terrain surface mip ${level}.`);
    }
    surfaceMipmaps.push({ data: new Uint8Array(buffer, offset, byteLength), width, height });
    offset += byteLength;
    normalMipmaps.push({ data: new Uint8Array(buffer, offset, byteLength), width, height });
    offset += byteLength;
  }
  if (offset !== buffer.byteLength) throw new Error('Terrain surface field contains trailing bytes.');

  const base = surfaceMipmaps[0];
  const createTexture = (
    name: string,
    mipmaps: Array<{ data: Uint8Array; width: number; height: number }>,
  ): THREE.DataTexture => {
    const texture = new THREE.DataTexture(
      mipmaps[0].data,
      mipmaps[0].width,
      mipmaps[0].height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    texture.name = name;
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.mipmaps = mipmaps;
    texture.needsUpdate = true;
    return texture;
  };

  return {
    surface: createTexture('TerrainSurfaceField', surfaceMipmaps),
    normal: createTexture('TerrainNormalField', normalMipmaps),
    width: base.width,
    height: base.height,
    mipLevels,
  };
}
