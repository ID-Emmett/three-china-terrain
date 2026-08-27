import * as THREE from 'three/webgpu';

export type WeatherTextureKind = 'cloud' | 'rain' | 'mist' | 'wind';

export function createCloudVolumeTexture(seed: number, variant = 0, size = 192): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const offsetX = (seed * 0.013 + variant * 17.7) % 97;
  const offsetY = (seed * 0.021 + variant * 31.1) % 89;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x / (size - 1) * 2 - 1;
      const py = y / (size - 1) * 2 - 1;
      const envelope = cloudEnvelope(px, py, variant);
      const coarse = fbm((px + offsetX) * 2.1, (py + offsetY) * 2.1, seed);
      const fine = fbm((px - offsetY) * 4.8, (py + offsetX) * 4.8, seed + 67);
      const density = smoothstep(0.22, 0.82, envelope * (0.62 + coarse * 0.54 + fine * 0.18));
      const light = THREE.MathUtils.clamp(0.62 + (-py * 0.13) + coarse * 0.2 + fine * 0.08, 0.38, 1);
      const offset = (y * size + x) * 4;
      data[offset] = Math.round(105 + 135 * light);
      data[offset + 1] = Math.round(118 + 130 * light);
      data[offset + 2] = Math.round(125 + 125 * light);
      data[offset + 3] = Math.round(Math.pow(density, 0.82) * 255);
    }
  }
  return finishTexture(data, size);
}

/** Procedural RGBA textures keep weather assets local, deterministic and cheap to stream. */
export function createWeatherTexture(kind: WeatherTextureKind, size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) * 0.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = (x - center) / center;
      const py = (y - center) / center;
      const alpha = textureAlpha(kind, px, py);
      const offset = (y * size + x) * 4;
      const tint = kind === 'cloud' ? [232, 241, 240] : kind === 'wind' ? [222, 242, 240] : [200, 235, 244];
      data[offset] = tint[0];
      data[offset + 1] = tint[1];
      data[offset + 2] = tint[2];
      data[offset + 3] = Math.round(alpha * 255);
    }
  }
  return finishTexture(data, size);
}

function finishTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function cloudEnvelope(x: number, y: number, variant: number): number {
  const stretch = variant % 2 === 0 ? 1 : 1.16;
  const base = Math.max(0, 1 - Math.hypot(x / stretch, (y - 0.13) * 1.65));
  const left = Math.max(0, 1 - Math.hypot((x + 0.43) * 1.4, (y + 0.02) * 2.05));
  const crown = Math.max(0, 1 - Math.hypot((x + 0.03) * 1.55, (y + 0.33) * 1.52));
  const right = Math.max(0, 1 - Math.hypot((x - 0.43) * 1.55, (y + 0.02) * 2.15));
  return Math.pow(Math.max(base * 0.76, left, crown, right), 0.72);
}

function fbm(x: number, y: number, seed: number): number {
  let value = 0;
  let amplitude = 0.56;
  let frequency = 1;
  let total = 0;
  for (let octave = 0; octave < 5; octave += 1) {
    value += valueNoise(x * frequency, y * frequency, seed + octave * 101) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }
  return value / total;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hashNoise(ix, iy, seed);
  const b = hashNoise(ix + 1, iy, seed);
  const c = hashNoise(ix, iy + 1, seed);
  const d = hashNoise(ix + 1, iy + 1, seed);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, sx), THREE.MathUtils.lerp(c, d, sx), sy);
}

function hashNoise(x: number, y: number, seed: number): number {
  let value = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function smoothstep(min: number, max: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}

function textureAlpha(kind: WeatherTextureKind, x: number, y: number): number {
  if (kind === 'cloud') {
    const lobeA = softCircle(x + 0.48, y + 0.02, 0.48, 2.2);
    const lobeB = softCircle(x + 0.08, y - 0.13, 0.57, 1.8);
    const lobeC = softCircle(x - 0.38, y + 0.05, 0.43, 2.4);
    const underside = softCircle(x, y - 0.19, 0.75, 1.7);
    return THREE.MathUtils.clamp(Math.max(lobeA, lobeB, lobeC) * 0.9 + underside * 0.12, 0, 1);
  }
  if (kind === 'rain') {
    return Math.pow(Math.max(0, 1 - Math.abs(x)), 0.42)
      * Math.pow(Math.max(0, 1 - Math.abs(y)), 0.38);
  }
  if (kind === 'mist') {
    const edge = Math.pow(Math.max(0, 1 - Math.hypot(x, y)), 0.7);
    const noise = 0.78 + 0.22 * Math.sin(x * 12 + y * 8);
    return edge * noise;
  }
  const endFade = Math.max(0, 1 - Math.max(0, Math.abs(x) - 0.58) / 0.42);
  const edgeFade = Math.pow(Math.max(0, 1 - Math.abs(y)), 0.38);
  return endFade * edgeFade;
}

function softCircle(x: number, y: number, radius: number, power: number): number {
  return Math.pow(Math.max(0, 1 - Math.hypot(x, y) / radius), power);
}
