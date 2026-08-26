import * as THREE from 'three/webgpu';

function hash(x: number, y: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7 + x * y * 0.013) * 43758.5453123;
  return value - Math.floor(value);
}

function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash(x0, y0);
  const b = hash(x0 + 1, y0);
  const c = hash(x0, y0 + 1);
  const d = hash(x0 + 1, y0 + 1);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, sx), THREE.MathUtils.lerp(c, d, sx), sy);
}

function fbm(x: number, y: number, octaves: number): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    value += valueNoise(x * frequency, y * frequency) * amplitude;
    total += amplitude;
    frequency *= 2.03;
    amplitude *= 0.5;
  }
  return value / total;
}

function ridged(x: number, y: number): number {
  return 1 - Math.abs(fbm(x, y, 3) * 2 - 1);
}

/** Shared non-periodic-looking terrain material field. Channels are geology, strata, grain height and moisture. */
export function createTerrainDetailTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const warpX = (fbm(u * 3.7 + 13.2, v * 3.1 - 8.4, 3) - 0.5) * 0.24;
      const warpY = (fbm(u * 3.2 - 4.7, v * 3.8 + 11.9, 3) - 0.5) * 0.24;
      const wx = u + warpX;
      const wy = v + warpY;
      const geology = fbm(wx * 5.2 + 1.7, wy * 4.8 - 2.1, 5);
      const strata = ridged(wx * 8.4 + geology * 1.9, wy * 2.7 - geology * 1.2);
      const grain = fbm(wx * 66.0 + 7.1, wy * 63.0 - 3.8, 3);
      const moisture = fbm(wx * 4.1 - 9.2, wy * 5.0 + 5.7, 4);
      // Bake a toroidal continuation into the borders so linear filtering at
      // the map edge cannot introduce a visible seam.
      const offset = (y * size + x) * 4;
      data[offset] = Math.round(geology * 255);
      data[offset + 1] = Math.round(strata * 255);
      data[offset + 2] = Math.round(grain * 255);
      data[offset + 3] = Math.round(moisture * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'TerrainMaterialDetailField';
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
