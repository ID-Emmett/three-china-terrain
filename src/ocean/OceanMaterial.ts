import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  abs,
  float,
  length,
  min,
  mix,
  positionWorld,
  pow,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';

type UniformEntry<T> = { value: T };

type OceanColorName = 'uShallowColor' | 'uShelfColor' | 'uDeepColor';

function hashGrid(x: number, y: number, seed: number): number {
  let value = Math.imul(x + seed * 17, 374761393) + Math.imul(y + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff * 2 - 1;
}

function samplePeriodicNoiseRect(
  u: number,
  v: number,
  cellsX: number,
  cellsY: number,
  seed: number,
): number {
  const x = u * cellsX;
  const y = v * cellsY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const at = (offsetX: number, offsetY: number): number => hashGrid(
    (x0 + offsetX + cellsX) % cellsX,
    (y0 + offsetY + cellsY) % cellsY,
    seed,
  );
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(at(0, 0), at(1, 0), sx),
    THREE.MathUtils.lerp(at(0, 1), at(1, 1), sx),
    sy,
  );
}

function createWaterNormalTexture(size = 128): THREE.DataTexture {
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const u = x / size;
    const v = y / size;
    // Use incommensurate bands and a small domain warp. The tile remains
    // periodic for repeatable mipmaps, but aligned octaves no longer produce
    // the obvious checkerboard repetition visible from far away.
    const warpX = samplePeriodicNoiseRect(u, v, 7, 7, 11) * 0.03;
    const warpY = samplePeriodicNoiseRect(u, v, 9, 9, 23) * 0.03;
    heights[y * size + x] = samplePeriodicNoiseRect(u, v, 7, 7, 29) * 0.38
      + samplePeriodicNoiseRect(u + warpX, v + warpY, 13, 11, 41) * 0.28
      + samplePeriodicNoiseRect(u - warpY * 0.7, v + warpX * 0.7, 23, 19, 53) * 0.23
      + samplePeriodicNoiseRect(u + warpY * 0.45, v - warpX * 0.45, 47, 41, 71) * 0.11;
  }
  const data = new Uint8Array(size * size * 4);
  const slopeScale = 1.6 * (size / 128);
  const at = (x: number, y: number): number => heights[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    // Keep the encoded slope invariant when the normal texture resolution
    // changes. Without this compensation, a 256 map has half the adjacent
    // height delta of a 128 map and therefore looks softer despite more data.
    const dx = (at(x + 1, y) - at(x - 1, y)) * slopeScale;
    const dy = (at(x, y + 1) - at(x, y - 1)) * slopeScale;
    const inv = 1 / Math.hypot(dx, dy, 1);
    const offset = (y * size + x) * 4;
    data[offset] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
    data[offset + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
    data[offset + 2] = Math.round((inv * 0.5 + 0.5) * 255);
    data[offset + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'ProceduralWaterNormal';
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Compact game-style water: two triangles and one generated normal map.
 * The normal map's mip chain is used as a distance LOD so the far ocean stays
 * smooth while close views retain layered ripple detail.
 */
export class OceanMaterial extends THREE.MeshStandardNodeMaterial {
  public readonly uniforms: Record<string, UniformEntry<unknown>>;
  private readonly elapsedNode = uniform(0);
  private readonly waterNormalTexture: THREE.DataTexture;

  public constructor(coastMask: THREE.Texture) {
    super({
      transparent: true,
      depthWrite: false,
      // Water is shaded from the procedural signal below. Letting the scene's
      // directional light multiply the noisy normal creates the broad milky
      // patches seen in close views, especially under high terrain exposure.
      roughness: 0.52,
      metalness: 0,
      side: THREE.FrontSide,
      toneMapped: true,
      dithering: true,
    });
    this.lights = false;

    this.waterNormalTexture = createWaterNormalTexture(128);

    const shallow = uniform(new THREE.Color('#2e817b'));
    const shelf = uniform(new THREE.Color('#155a6c'));
    const deep = uniform(new THREE.Color('#082f46'));
    const shallowRange = uniform(0.16);
    const coastWidth = uniform(0.055);
    const waveSpeed = uniform(0.42);
    const waveStrength = uniform(0.62);
    const fineStrength = uniform(0.38);
    const fresnelStrength = uniform(0.5);
    const sunSpecular = uniform(0.32);
    const reflectionStrength = uniform(0.42);
    const opacity = uniform(0.94);
    const mapUv = uv();
    const edgeFade = uniform(0.08);
    const coastDistance = texture(coastMask, mapUv).r;
    const timeNode = this.elapsedNode.mul(waveSpeed);

    // Two differently oriented scales break up tiling without adding geometry.
    // The low-frequency band carries the swell and the second adds close detail.
    const viewDistance = length(cameraPosition.sub(positionWorld));
    // Detail LOD is intentionally independent from the colour haze. The
    // closest band keeps mip 0, the middle band filters progressively, and
    // the overview band never evaluates the noisy base level.
    const detailFade = float(1).sub(smoothstep(28, 132, viewDistance));
    const overviewFade = smoothstep(96, 300, viewDistance);
    const noiseMip = smoothstep(24, 260, viewDistance).mul(2.8);
    const swellUv = mapUv.mul(vec2(6.2, 6.2)).add(vec2(timeNode.mul(0.006), timeNode.mul(-0.004)));
    const rippleUvA = vec2(mapUv.y, mapUv.x.negate()).mul(vec2(15, 15)).add(vec2(timeNode.mul(0.012), timeNode.mul(0.008)));
    // The detail band uses the texture's own fine cells at a moderate UV
    // scale. A much higher scale reads as sub-pixel blur instead of grain.
    const sampleSwell = texture(this.waterNormalTexture, swellUv).level(noiseMip.mul(0.45)).xyz;
    const sampleA = texture(this.waterNormalTexture, rippleUvA).level(noiseMip.mul(0.9)).xyz;
    const mediumWeight = float(0.24).add(detailFade.mul(0.76));
    const fineWeight = detailFade.mul(float(0.18).add(float(0.82).sub(overviewFade))).clamp(0, 1);
    const waveAmplitude = waveStrength.mul(0.8).add(0.5);
    const fineAmplitude = fineStrength.mul(1.3).add(0.5);
    const rippleValue = sampleSwell.x.mul(0.42)
      .add(sampleA.y.mul(0.58).mul(mediumWeight).mul(fineWeight));
    const fineGrain = sampleA.x.mul(0.58).add(sampleA.y.mul(0.42));

    const waterDistance = float(0.5).sub(coastDistance).mul(2).clamp(0, 1);
    const coastBand = float(1).sub(smoothstep(0, coastWidth, waterDistance));
    const shallowMask = float(1).sub(smoothstep(shallowRange.mul(0.08), shallowRange, waterDistance));
    const deepMask = smoothstep(shallowRange.mul(1.2), 0.86, waterDistance);
    let waterColor = mix(shelf, shallow, shallowMask);
    waterColor = mix(waterColor, deep, deepMask);

    // Keep albedo nearly static; the eye reads movement from normal highlights.
    const grainContrast = fineGrain.sub(0.5)
      .mul(float(0.12).add(detailFade.mul(0.18)))
      .mul(fineAmplitude);
    waterColor = waterColor.mul(float(0.982).add(grainContrast));
    waterColor = waterColor.mul(float(1).add(rippleValue.sub(0.5).mul(0.012).mul(waveAmplitude)));

    const viewDirection = cameraPosition.sub(positionWorld).normalize();
    const fresnel = pow(float(1).sub(viewDirection.y.clamp(0, 1)), 4).mul(fresnelStrength);
    const skyReflection = mix(
      vec3(0.12, 0.26, 0.32),
      vec3(0.42, 0.59, 0.61),
      viewDirection.y.clamp(0, 1),
    );
    waterColor = mix(waterColor, skyReflection, fresnel.mul(reflectionStrength).clamp(0, 0.5));
    // The custom unlit path needs a small ambient lift to remain legible on
    // deep water. This is deliberately uniform and cannot create the broad
    // directional patches produced by the scene sun.
    waterColor = waterColor.mul(float(1.8).add(viewDirection.y.clamp(0, 1).mul(0.14)));

    // Narrow, cool glints read as small wavelets instead of a broad light
    // reflection. The fine band is deliberately gated twice to keep the
    // highlight sparse and crisp.
    const crest = smoothstep(0.5, 0.64, fineGrain)
      .mul(smoothstep(0.48, 0.64, sampleA.y))
      .mul(float(0.24).add(detailFade.mul(0.76)));
    const sparkle = smoothstep(0.055, 0.16, abs(fineGrain.sub(0.5)))
      .mul(smoothstep(0.05, 0.17, abs(sampleA.y.sub(0.5))))
      .mul(float(0.2).add(detailFade.mul(0.8)));
    const sunBand = crest.mul(float(0.18).add(fresnel.mul(0.2))).mul(sunSpecular);
    waterColor = waterColor.add(vec3(0.38, 0.68, 0.74).mul(sunBand));
    waterColor = waterColor.add(vec3(0.16, 0.4, 0.48).mul(sparkle.mul(fineAmplitude).mul(0.3)));

    const foam = crest.mul(coastBand).mul(0.045);
    waterColor = mix(waterColor, vec3(0.53, 0.75, 0.72), foam);

    const distanceHaze = smoothstep(180, 420, length(cameraPosition.sub(positionWorld))).mul(0.2);
    waterColor = mix(waterColor, vec3(0.15, 0.25, 0.29), distanceHaze);

    // The water plane is a coverage carrier. Its outer boundary should resolve
    // into the atmosphere instead of exposing the rectangular data extent.
    const edgeDistance = min(
      min(mapUv.x, float(1).sub(mapUv.x)),
      min(mapUv.y, float(1).sub(mapUv.y)),
    );
    const edgeMask = smoothstep(0, edgeFade, edgeDistance);
    waterColor = mix(waterColor, vec3(0.15, 0.25, 0.29), float(1).sub(edgeMask).mul(0.72));

    this.colorNode = waterColor;
    const waterAlpha = float(1).sub(smoothstep(0.46, 0.54, coastDistance));
    this.opacityNode = opacity.mul(waterAlpha).mul(edgeMask);

    this.uniforms = {
      uTime: { value: 0 },
      uShallowRange: { value: shallowRange.value },
      uCoastWidth: { value: coastWidth.value },
      uWaveSpeed: { value: waveSpeed.value },
      uWaveStrength: { value: waveStrength.value },
      uFineStrength: { value: fineStrength.value },
      uFresnelStrength: { value: fresnelStrength.value },
      uSunSpecular: { value: sunSpecular.value },
      uReflectionStrength: { value: reflectionStrength.value },
      uOpacity: { value: opacity.value },
      uEdgeFade: { value: edgeFade.value },
      uShallowColor: { value: shallow.value },
      uShelfColor: { value: shelf.value },
      uDeepColor: { value: deep.value },
    };
    this.userData.nodes = {
      shallow,
      shelf,
      deep,
      shallowRange,
      coastWidth,
      waveSpeed,
      waveStrength,
      fineStrength,
      fresnelStrength,
      sunSpecular,
      reflectionStrength,
      opacity,
      edgeFade,
      elapsed: this.elapsedNode,
    };
  }

  public update(elapsedSeconds: number): void {
    this.uniforms.uTime.value = elapsedSeconds;
    this.elapsedNode.value = elapsedSeconds;
  }

  public setColor(name: OceanColorName, value: string): void {
    const nodeNames: Record<OceanColorName, string> = {
      uShallowColor: 'shallow',
      uShelfColor: 'shelf',
      uDeepColor: 'deep',
    };
    const color = this.uniforms[name]?.value as THREE.Color | undefined;
    if (color) color.set(value);
    const node = (this.userData.nodes as Record<string, { value: unknown }>)[nodeNames[name]];
    if (node) (node.value as THREE.Color).set(value);
  }

  public setNumeric(name: string, value: number): void {
    const nodeNames: Record<string, string> = {
      uShallowRange: 'shallowRange',
      uCoastWidth: 'coastWidth',
      uWaveSpeed: 'waveSpeed',
      uWaveStrength: 'waveStrength',
      uFineStrength: 'fineStrength',
      uFresnelStrength: 'fresnelStrength',
      uSunSpecular: 'sunSpecular',
      uReflectionStrength: 'reflectionStrength',
      uOpacity: 'opacity',
      uEdgeFade: 'edgeFade',
    };
    const entry = this.uniforms[name];
    if (entry) entry.value = value;
    const node = (this.userData.nodes as Record<string, { value: unknown }>)[nodeNames[name]];
    if (node) node.value = value;
  }

  public override dispose(): void {
    this.waterNormalTexture.dispose();
    super.dispose();
  }
}
