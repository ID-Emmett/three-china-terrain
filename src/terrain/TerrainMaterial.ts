import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  dot,
  float,
  fract,
  int,
  length,
  min,
  mix,
  positionWorld,
  positionLocal,
  smoothstep,
  sqrt,
  texture,
  transformNormalToView,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { TERRAIN_LOD_DEFAULTS } from './TerrainLodConfig';
import type { TerrainReliefTileTextures } from './TerrainReliefTileCache';

type UniformEntry<T> = { value: T };

type TerrainColorName =
  | 'uLowlandColor'
  | 'uDrylandColor'
  | 'uForestColor'
  | 'uPlateauColor'
  | 'uRockColor'
  | 'uSnowColor';

/** Natural satellite terrain with zoom-8 residual normals and continuous LOD. */
export class TerrainMaterial extends THREE.MeshStandardNodeMaterial {
  public readonly uniforms: Record<string, UniformEntry<unknown>>;
  private readonly surfaceTexture: THREE.DataTexture;
  private readonly detailTexture: THREE.DataTexture;

  public constructor(
    coastMask: THREE.Texture,
    chinaMask: THREE.Texture,
    surfaceTexture: THREE.DataTexture,
    detailTexture: THREE.DataTexture,
    reliefTexture: THREE.Texture,
    reliefTiles: TerrainReliefTileTextures,
    terrainImagery: THREE.Texture,
    minimumElevationMeters: number,
    maximumElevationMeters: number,
  ) {
    super({
      dithering: true,
      toneMapped: true,
      transparent: true,
      roughness: 0.9,
      metalness: 0,
    });
    this.surfaceTexture = surfaceTexture;
    this.detailTexture = detailTexture;

    const mapUv = uv();
    const distance = length(cameraPosition.sub(positionWorld));
    const materialMip = smoothstep(68, 260, distance).mul(3);
    const surfaceField = texture(surfaceTexture, mapUv).level(materialMip);
    const reliefField = texture(reliefTexture, mapUv).level(materialMip.mul(0.72));
    const assetSize = reliefTiles.fine.tileSize + reliefTiles.fine.gutter * 2;
    const sampleTileLevel = (level: typeof reliefTiles.fine) => {
      const page = texture(level.pages, mapUv).level(float(0));
      const pageTexel = vec2(1 / level.columns, 1 / level.rows);
      const pageLeft = texture(level.pages, mapUv.sub(vec2(pageTexel.x, 0))).level(float(0));
      const pageRight = texture(level.pages, mapUv.add(vec2(pageTexel.x, 0))).level(float(0));
      const pageDown = texture(level.pages, mapUv.sub(vec2(0, pageTexel.y))).level(float(0));
      const pageUp = texture(level.pages, mapUv.add(vec2(0, pageTexel.y))).level(float(0));
      const tileCoordinates = mapUv.mul(vec2(level.columns, level.rows));
      const localTileUv = fract(tileCoordinates);
      // WebP pixels are flipped in the decode worker before upload. GPU block
      // compression cannot be flipped during upload, so KTX2 needs the same
      // orientation correction in sampling space.
      const orientedTileUv = level.compressed
        ? vec2(localTileUv.x, float(1).sub(localTileUv.y))
        : localTileUv;
      const tileUv = orientedTileUv
        .mul(level.tileSize / assetSize)
        .add(level.gutter / assetSize);
      const tileLayer = int(page.r.mul(255).add(0.5));
      const tile = texture(level.tiles, tileUv).depth(tileLayer);
      // Wider fallback feathering hides the coarse/fine page boundary while a
      // neighboring fine tile is still being fetched or has been evicted.
      const tileEdgeWidth = float(0.16);
      const leftEdge = mix(smoothstep(0, tileEdgeWidth, fract(tileCoordinates.x)), float(1), pageLeft.g);
      const rightEdge = mix(smoothstep(0, tileEdgeWidth, float(1).sub(fract(tileCoordinates.x))), float(1), pageRight.g);
      const downEdge = mix(smoothstep(0, tileEdgeWidth, fract(tileCoordinates.y)), float(1), pageDown.g);
      const upEdge = mix(smoothstep(0, tileEdgeWidth, float(1).sub(fract(tileCoordinates.y))), float(1), pageUp.g);
      return { page, tile, fade: page.g.mul(leftEdge).mul(rightEdge).mul(downEdge).mul(upEdge) };
    };
    const coarseSample = sampleTileLevel(reliefTiles.coarse);
    const fineSample = sampleTileLevel(reliefTiles.fine);
    const detailUv = vec2(
      mapUv.x.mul(17.3).add(mapUv.y.mul(5.1)),
      mapUv.y.mul(19.1).sub(mapUv.x.mul(4.3)),
    );
    const detailField = texture(detailTexture, detailUv);
    const satellite = texture(terrainImagery, mapUv).rgb;
    const coastValue = texture(coastMask, mapUv).r;
    const chinaValue = texture(chinaMask, mapUv).r;
    const elevation = surfaceField.r;
    const localShapeFactor = surfaceField.g.mul(0.14).add(0.9);
    const broadLight = reliefField.g.mul(2).sub(1);
    const mediumLight = reliefField.b.mul(2).sub(1);
    const fineLight = reliefField.a.mul(2).sub(1);

    const minElevation = uniform(minimumElevationMeters);
    const maxElevation = uniform(maximumElevationMeters);
    const lowland = uniform(new THREE.Color('#6f8873'));
    const dryland = uniform(new THREE.Color('#a3835d'));
    const forest = uniform(new THREE.Color('#4f7d52'));
    const plateau = uniform(new THREE.Color('#969572'));
    const rock = uniform(new THREE.Color('#a89b83'));
    const snow = uniform(new THREE.Color('#d8d8c8'));
    const brightness = uniform(0.98);
    const contrast = uniform(1.18);
    const saturation = uniform(1.04);
    const warmth = uniform(0.18);
    const roughness = uniform(0.9);
    const detailStrength = uniform(1.22);
    const materialDistance = uniform(TERRAIN_LOD_DEFAULTS.materialDistance);
    const detailDistance = uniform(TERRAIN_LOD_DEFAULTS.detailDistance);
    const rockThreshold = uniform(0.44);
    const snowThreshold = uniform(0.94);
    const hazeStrength = uniform(0.08);
    const edgeFade = uniform(0.14);
    const geometryMorph = uniform(1);

    const materialLod = float(1).sub(
      smoothstep(materialDistance.mul(0.52), materialDistance, distance),
    );
    const detailLod = float(1).sub(
      smoothstep(detailDistance.mul(0.34), detailDistance, distance),
    );
    // The tile cache already performs view-aware LOD selection. Applying a
    // second per-fragment distance cutoff here creates a screen-sized band when
    // a shallow camera angle puts the far half of the same tile beyond the
    // threshold. A resident tile should therefore stay active across its full
    // footprint; missing pages still fall back through the base relief field.
    const coarseFade = coarseSample.fade;
    const fineFade = fineSample.fade;
    const heightResidual = mix(
      reliefField.r.mul(2).sub(1),
      coarseSample.tile.a.mul(2).sub(1),
      coarseFade,
    );
    const heightResidualFine = mix(
      heightResidual,
      fineSample.tile.a.mul(2).sub(1),
      fineFade,
    );

    const detailedNormalXZ = surfaceField.ba.mul(2).sub(1);
    const detailedNormalY = sqrt(float(1).sub(dot(detailedNormalXZ, detailedNormalXZ)).max(0));
    const detailedNormalLocal = vec3(
      detailedNormalXZ.x,
      detailedNormalY,
      detailedNormalXZ.y,
    ).normalize();
    const tileNormalXZ = fineSample.tile.rg.mul(2).sub(1);
    const tileNormalY = sqrt(float(1).sub(dot(tileNormalXZ, tileNormalXZ)).max(0));
    const tileNormalLocal = vec3(tileNormalXZ.x, tileNormalY, tileNormalXZ.y).normalize();
    const coarseNormalXZ = coarseSample.tile.rg.mul(2).sub(1);
    const coarseNormalY = sqrt(float(1).sub(dot(coarseNormalXZ, coarseNormalXZ)).max(0));
    const coarseNormalLocal = vec3(coarseNormalXZ.x, coarseNormalY, coarseNormalXZ.y).normalize();
    const residentNormalLocal = mix(detailedNormalLocal, coarseNormalLocal, coarseFade);
    const fineNormalLocal = mix(residentNormalLocal, tileNormalLocal, fineFade).normalize();
    const terrainNormalLocal = mix(
      vec3(0, 1, 0),
      fineNormalLocal,
      float(0.88).add(detailLod.mul(0.12)),
    ).normalize();
    const terrainNormalView = transformNormalToView(terrainNormalLocal);

    const flatness = terrainNormalLocal.y.clamp(0, 1);
    const steepness = float(1).sub(flatness);
    const satelliteLuma = dot(satellite, vec3(0.2126, 0.7152, 0.0722));
    const satelliteColor = mix(vec3(satelliteLuma), satellite, 1.08).mul(1.16);

    // The palette only supports real imagery; it does not synthesize mountain
    // bands independently of the high-resolution elevation field.
    const dryness = smoothstep(0.08, 0.68, elevation);
    let palette = mix(lowland, dryland, dryness);
    const vegetationSignal = satellite.g.sub(satellite.r.mul(0.82));
    const forestMask = smoothstep(0.015, 0.13, vegetationSignal)
      .mul(float(1).sub(smoothstep(0.48, 0.70, elevation)))
      .mul(float(0.62).add(flatness.mul(0.38)));
    palette = mix(palette, forest, forestMask.mul(0.72));
    const plateauMask = smoothstep(0.28, 0.46, elevation)
      .mul(float(1).sub(smoothstep(0.65, 0.78, elevation)));
    palette = mix(palette, plateau, plateauMask.mul(0.44));

    const rockMask = smoothstep(
      rockThreshold.sub(0.14),
      rockThreshold.add(0.18),
      elevation.add(steepness.mul(0.38)),
    );
    const rockColor = rock.mul(satelliteLuma.mul(0.64).add(0.58));
    palette = mix(palette, rockColor, rockMask.mul(0.74));
    const snowMask = smoothstep(
      snowThreshold.sub(0.08),
      snowThreshold.add(0.04),
      elevation,
    ).mul(smoothstep(0.12, 0.74, flatness));
    palette = mix(palette, snow, snowMask);

    const imageryWeight = materialLod.mul(-0.08).add(0.88);
    let terrainColor = mix(palette, satelliteColor, imageryWeight);

    // A tiny generated field restores material grain lost when the geographic
    // relief texture is downsampled. It is distance-gated and never changes the
    // broad, data-authored mountain silhouette.
    const microDetail = detailField.r.sub(0.5).mul(0.34)
      .add(detailField.g.sub(0.5).mul(0.28))
      .add(detailField.b.sub(0.5).mul(0.38));
    terrainColor = terrainColor.mul(
      float(1).add(
        microDetail.mul(detailLod).mul(detailStrength).mul(0.085),
      ),
    );

    // Select one aligned relief scale at a time so the same ridge is never
    // triple-lit by broad, medium and fine channels.
    let reliefLight = mix(broadLight, mediumLight, materialLod.mul(0.82));
    reliefLight = mix(reliefLight, fineLight, detailLod.mul(0.72));
    reliefLight = mix(reliefLight, coarseSample.tile.b.mul(2).sub(1), coarseFade.mul(0.92));
    reliefLight = mix(reliefLight, fineSample.tile.b.mul(2).sub(1), fineFade.mul(0.92));
    // Relief channels reveal terrain below the geometry resolution. A biased
    // response preserves fill light on the shaded face while keeping the
    // sun-facing ridge edge crisp, matching aerial terrain photography.
    const reliefContrast = float(1).add(
      reliefLight.mul(detailStrength).mul(0.27),
    ).clamp(0.7, 1.34);
    terrainColor = terrainColor.mul(reliefContrast);

    const ridgeHighlight = smoothstep(0.18, 0.78, reliefLight)
      .mul(detailStrength)
      .mul(detailLod)
      .clamp(0, 0.62);
    const valleyFill = smoothstep(0.18, 0.82, reliefLight.negate())
      .mul(detailStrength)
      .mul(detailLod)
      .clamp(0, 0.54);
    terrainColor = mix(
      terrainColor,
      terrainColor.mul(vec3(1.18, 1.14, 1.06)),
      ridgeHighlight.mul(0.38),
    );
    terrainColor = mix(
      terrainColor,
      terrainColor.mul(vec3(0.82, 0.88, 0.86)),
      valleyFill.mul(0.28),
    );

    const ridgeMask = smoothstep(0.08, 0.62, heightResidualFine)
      .mul(materialLod)
      .mul(detailStrength)
      .clamp(0, 0.46);
    const valleyMask = smoothstep(0.10, 0.64, heightResidualFine.negate())
      .mul(materialLod)
      .mul(detailStrength)
      .clamp(0, 0.38);
    terrainColor = mix(
      terrainColor,
      terrainColor.mul(vec3(1.10, 1.055, 0.98)),
      ridgeMask.mul(0.20),
    );
    terrainColor = mix(
      terrainColor,
      terrainColor.mul(vec3(0.72, 0.82, 0.76)),
      valleyMask.mul(0.18),
    );

    terrainColor = terrainColor.mul(localShapeFactor);
    terrainColor = mix(
      terrainColor,
      terrainColor.mul(vec3(1.08, 1.025, 0.92)),
      ridgeMask.mul(warmth).mul(0.28),
    );

    const luminance = dot(terrainColor, vec3(0.2126, 0.7152, 0.0722));
    terrainColor = mix(vec3(luminance), terrainColor, saturation)
      .sub(0.5)
      .mul(contrast)
      .add(0.5)
      .mul(brightness)
      .clamp(0, 1.4);

    const atmosphericColor = vec3(0.025, 0.07, 0.09);
    const haze = smoothstep(95, 280, distance).mul(hazeStrength);
    terrainColor = mix(terrainColor, atmosphericColor, haze.clamp(0, 0.78));
    const chinaFocus = smoothstep(0.47, 0.56, chinaValue);
    const contextColor = mix(terrainColor, atmosphericColor, 0.62).mul(0.94);
    terrainColor = mix(contextColor, terrainColor, chinaFocus);

    const edgeDistance = min(
      min(mapUv.x, float(1).sub(mapUv.x)),
      min(mapUv.y, float(1).sub(mapUv.y)),
    );
    const edgeMask = smoothstep(0, edgeFade, edgeDistance);
    const edgeVisibility = mix(edgeMask, float(1), chinaFocus);
    terrainColor = mix(terrainColor, atmosphericColor, float(1).sub(edgeVisibility).mul(0.82));

    this.positionNode = mix(attribute('aMorphPosition', 'vec3'), positionLocal, geometryMorph);
    this.normalNode = terrainNormalView;
    this.colorNode = terrainColor;
    this.roughnessNode = roughness.mul(float(0.94).sub(snowMask.mul(0.15))).clamp(0.5, 1);
    this.metalnessNode = float(0);
    this.emissiveNode = vec3(0.026, 0.032, 0.026);
    this.opacityNode = smoothstep(0.49, 0.51, coastValue).mul(edgeVisibility);

    this.uniforms = {
      uMinElevation: { value: minElevation.value },
      uMaxElevation: { value: maxElevation.value },
      uBrightness: { value: brightness.value },
      uContrast: { value: contrast.value },
      uSaturation: { value: saturation.value },
      uWarmth: { value: warmth.value },
      uRoughness: { value: roughness.value },
      uDetailStrength: { value: detailStrength.value },
      uMaterialDistance: { value: materialDistance.value },
      uDetailDistance: { value: detailDistance.value },
      uRockThreshold: { value: rockThreshold.value },
      uSnowThreshold: { value: snowThreshold.value },
      uHazeStrength: { value: hazeStrength.value },
      uEdgeFade: { value: edgeFade.value },
      uGeometryMorph: { value: geometryMorph.value },
      uLowlandColor: { value: lowland.value },
      uDrylandColor: { value: dryland.value },
      uForestColor: { value: forest.value },
      uPlateauColor: { value: plateau.value },
      uRockColor: { value: rock.value },
      uSnowColor: { value: snow.value },
    };
    this.userData.nodes = {
      minElevation,
      maxElevation,
      brightness,
      contrast,
      saturation,
      warmth,
      roughness,
      detailStrength,
      materialDistance,
      detailDistance,
      rockThreshold,
      snowThreshold,
      hazeStrength,
      edgeFade,
      geometryMorph,
      lowland,
      dryland,
      forest,
      plateau,
      rock,
      snow,
    };
  }

  public setColor(name: TerrainColorName, value: string): void {
    const nodeNames: Record<TerrainColorName, string> = {
      uLowlandColor: 'lowland',
      uDrylandColor: 'dryland',
      uForestColor: 'forest',
      uPlateauColor: 'plateau',
      uRockColor: 'rock',
      uSnowColor: 'snow',
    };
    const color = this.uniforms[name]?.value as THREE.Color | undefined;
    if (color) color.set(value);
    const node = (this.userData.nodes as Record<string, { value: unknown }>)[nodeNames[name]];
    if (node) (node.value as THREE.Color).set(value);
  }

  public setNumeric(name: string, value: number): void {
    const entry = this.uniforms[name];
    if (entry) entry.value = value;
    const nodeNames: Record<string, string> = {
      uBrightness: 'brightness',
      uContrast: 'contrast',
      uSaturation: 'saturation',
      uWarmth: 'warmth',
      uRoughness: 'roughness',
      uDetailStrength: 'detailStrength',
      uMaterialDistance: 'materialDistance',
      uDetailDistance: 'detailDistance',
      uRockThreshold: 'rockThreshold',
      uSnowThreshold: 'snowThreshold',
      uHazeStrength: 'hazeStrength',
      uEdgeFade: 'edgeFade',
      uGeometryMorph: 'geometryMorph',
    };
    const node = (this.userData.nodes as Record<string, { value: unknown }>)[nodeNames[name]];
    if (node) node.value = value;
  }

  public setMorph(value: number): void {
    this.setNumeric('uGeometryMorph', THREE.MathUtils.clamp(value, 0, 1));
  }

  public override dispose(): void {
    this.surfaceTexture.dispose();
    this.detailTexture.dispose();
    super.dispose();
  }
}
