import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  dot,
  float,
  length,
  min,
  mix,
  positionWorld,
  smoothstep,
  texture,
  transformNormalToView,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { TERRAIN_LOD_DEFAULTS } from './TerrainLodConfig';

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
  private readonly reliefTexture: THREE.Texture;
  private readonly detailTexture: THREE.DataTexture;

  public constructor(
    coastMask: THREE.Texture,
    chinaMask: THREE.Texture,
    surfaceTexture: THREE.DataTexture,
    detailTexture: THREE.DataTexture,
    reliefTexture: THREE.Texture,
    terrainImagery: THREE.Texture,
    reliefResidualRangeMeters: number,
    minimumElevationMeters: number,
    maximumElevationMeters: number,
    sceneWidth: number,
    sceneDepth: number,
    sceneUnitsPerMeter: number,
  ) {
    super({
      dithering: true,
      toneMapped: true,
      transparent: true,
      roughness: 0.9,
      metalness: 0,
    });
    this.surfaceTexture = surfaceTexture;
    this.reliefTexture = reliefTexture;
    this.detailTexture = detailTexture;

    const mapUv = uv();
    const surfaceField = texture(surfaceTexture, mapUv);
    const reliefField = texture(reliefTexture, mapUv);
    const detailUv = vec2(
      mapUv.x.mul(17.3).add(mapUv.y.mul(5.1)),
      mapUv.y.mul(19.1).sub(mapUv.x.mul(4.3)),
    );
    const detailField = texture(detailTexture, detailUv);
    const satellite = texture(terrainImagery, mapUv).rgb;
    const coastValue = texture(coastMask, mapUv).r;
    const chinaValue = texture(chinaMask, mapUv).r;
    const elevation = surfaceField.r.mul(256).add(surfaceField.g).div(257).clamp(0, 1);
    const curvature = surfaceField.b.mul(2).sub(1);
    const cavity = surfaceField.a;
    const heightResidual = reliefField.r.mul(2).sub(1);
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

    const distance = length(cameraPosition.sub(positionWorld));
    const materialLod = float(1).sub(
      smoothstep(materialDistance.mul(0.52), materialDistance, distance),
    );
    const detailLod = float(1).sub(
      smoothstep(detailDistance.mul(0.34), detailDistance, distance),
    );

    // The mesh object's Y scale already applies the user-controlled vertical
    // exaggeration to both positions and normals. Repeating that scale here
    // made an exaggeration of 10 behave like 100 and crushed near slopes into
    // black grooves.
    const surfaceImage = surfaceTexture.image;
    const surfaceTexel = vec2(
      1 / (surfaceImage.width - 1),
      1 / (surfaceImage.height - 1),
    );
    const heightRangeLocal = float(maximumElevationMeters - minimumElevationMeters)
      .mul(sceneUnitsPerMeter);
    const surfaceLeft = texture(surfaceTexture, mapUv.add(vec2(surfaceTexel.x.negate(), 0)));
    const surfaceRight = texture(surfaceTexture, mapUv.add(vec2(surfaceTexel.x, 0)));
    const surfaceUp = texture(surfaceTexture, mapUv.add(vec2(0, surfaceTexel.y.negate())));
    const surfaceDown = texture(surfaceTexture, mapUv.add(vec2(0, surfaceTexel.y)));
    const heightLeft = surfaceLeft.r.mul(256).add(surfaceLeft.g).div(257);
    const heightRight = surfaceRight.r.mul(256).add(surfaceRight.g).div(257);
    const heightUp = surfaceUp.r.mul(256).add(surfaceUp.g).div(257);
    const heightDown = surfaceDown.r.mul(256).add(surfaceDown.g).div(257);
    const baseSlopeX = heightRight.sub(heightLeft)
      .mul(heightRangeLocal)
      .div(float(2 * sceneWidth / (surfaceImage.width - 1)));
    const baseSlopeZ = heightDown.sub(heightUp)
      .mul(heightRangeLocal)
      .div(float(2 * sceneDepth / (surfaceImage.height - 1)));
    const baseNormalLocal = vec3(baseSlopeX.negate(), 1, baseSlopeZ.negate()).normalize();
    const overviewNormalLocal = mix(baseNormalLocal, vec3(0, 1, 0), 0.12).normalize();

    // R stores signed zoom-8 elevation residual. Its gradient adds tributary
    // ridges without changing the broad mesh silhouette.
    const reliefImage = reliefTexture.image as { width: number; height: number };
    const reliefTexel = vec2(
      1 / (reliefImage.width - 1),
      1 / (reliefImage.height - 1),
    );
    const residualLeft = texture(reliefTexture, mapUv.add(vec2(reliefTexel.x.negate(), 0))).r;
    const residualRight = texture(reliefTexture, mapUv.add(vec2(reliefTexel.x, 0))).r;
    const residualUp = texture(reliefTexture, mapUv.add(vec2(0, reliefTexel.y.negate()))).r;
    const residualDown = texture(reliefTexture, mapUv.add(vec2(0, reliefTexel.y))).r;
    const residualRangeLocal = float(reliefResidualRangeMeters)
      .mul(sceneUnitsPerMeter);
    const residualSlopeX = residualRight.sub(residualLeft)
      .mul(residualRangeLocal)
      .div(float(sceneWidth / (reliefImage.width - 1)));
    const residualSlopeZ = residualDown.sub(residualUp)
      .mul(residualRangeLocal)
      .div(float(sceneDepth / (reliefImage.height - 1)));
    const detailedNormalLocal = vec3(
      baseSlopeX.add(residualSlopeX.mul(0.92)).negate(),
      1,
      baseSlopeZ.add(residualSlopeZ.mul(0.92)).negate(),
    ).normalize();
    const terrainNormalLocal = mix(
      overviewNormalLocal,
      detailedNormalLocal,
      detailLod.mul(0.9),
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

    const ridgeMask = smoothstep(0.08, 0.62, heightResidual)
      .mul(materialLod)
      .mul(detailStrength)
      .clamp(0, 0.46);
    const valleyMask = smoothstep(0.10, 0.64, heightResidual.negate())
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

    terrainColor = terrainColor
      .mul(float(0.94).add(cavity.oneMinus().mul(0.06)))
      .mul(float(0.98).add(curvature.mul(0.035)));
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
    };
    const node = (this.userData.nodes as Record<string, { value: unknown }>)[nodeNames[name]];
    if (node) node.value = value;
  }

  public override dispose(): void {
    this.surfaceTexture.dispose();
    this.reliefTexture.dispose();
    this.detailTexture.dispose();
    super.dispose();
  }
}
