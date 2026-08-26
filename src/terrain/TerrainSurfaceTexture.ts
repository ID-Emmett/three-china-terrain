import * as THREE from 'three/webgpu';
import {
  decodeTerrainSurfaceBundle,
  TERRAIN_SURFACE_MIP_LEVELS,
  type TerrainSurfaceLevel,
} from './TerrainSurfaceField';

/**
 * The placeholder lets the first terrain geometry render before the derived
 * field is ready. Satellite imagery and baked relief remain visible while the
 * material temporarily uses a flat normal and neutral local-shape factor.
 */
export function createTerrainSurfaceTexture(width: number, height: number): THREE.DataTexture {
  const mipmaps: TerrainSurfaceLevel[] = [];
  for (let level = 0; level < TERRAIN_SURFACE_MIP_LEVELS; level += 1) {
    const mipWidth = Math.max(1, Math.floor(width / (2 ** level)));
    const mipHeight = Math.max(1, Math.floor(height / (2 ** level)));
    const data = new Uint8Array(mipWidth * mipHeight * 4);
    data.fill(128);
    for (let offset = 0; offset < data.length; offset += 4) data[offset] = 64;
    mipmaps.push({ data, width: mipWidth, height: mipHeight });
  }
  const base = mipmaps[0];
  const texture = new THREE.DataTexture(
    base.data,
    base.width,
    base.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  configureTexture(texture);
  texture.name = 'TerrainDerivedSurfacePlaceholder';
  texture.mipmaps = mipmaps;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function applyTerrainSurfaceBundle(texture: THREE.DataTexture, buffer: ArrayBuffer): void {
  const mipmaps = decodeTerrainSurfaceBundle(buffer);
  const base = mipmaps[0];
  if (base.width !== texture.image.width || base.height !== texture.image.height
    || mipmaps.length !== texture.mipmaps.length) {
    throw new Error('Terrain derived surface layout does not match its GPU texture.');
  }
  texture.image = { data: base.data, width: base.width, height: base.height };
  texture.mipmaps = mipmaps;
  configureTexture(texture);
  texture.name = 'TerrainDerivedSurface';
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
}

function configureTexture(texture: THREE.DataTexture): void {
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
}
