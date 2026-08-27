import { TERRAIN_LOD_DEFAULTS } from '../terrain/TerrainLodConfig';
import type { WeatherStyle } from '../types/weather';

export interface DebugParams {
  terrain: {
    exaggeration: number;
    brightness: number;
    contrast: number;
    saturation: number;
    warmth: number;
    roughness: number;
    detailStrength: number;
    materialDistance: number;
    detailDistance: number;
    rockThreshold: number;
    snowThreshold: number;
    hazeStrength: number;
    lowlandColor: string;
    drylandColor: string;
    forestColor: string;
    plateauColor: string;
    rockColor: string;
    snowColor: string;
    wireframe: boolean;
  };
  ocean: {
    visible: boolean;
    shallowColor: string;
    shelfColor: string;
    deepColor: string;
    shallowRange: number;
    coastWidth: number;
    waveSpeed: number;
    waveStrength: number;
    fineStrength: number;
    fresnel: number;
    sunSpecular: number;
    reflection: number;
    opacity: number;
  };
  admin: {
    showProvince: boolean;
    showCity: boolean;
    showProvinceLabels: boolean;
    showCityLabels: boolean;
    provinceColor: string;
    cityColor: string;
    provinceLabelColor: string;
    cityLabelColor: string;
    provinceLabelOpacity: number;
    cityLabelOpacity: number;
    provinceOpacity: number;
    cityOpacity: number;
    provinceWidth: number;
    cityWidth: number;
    provinceLabelSize: number;
    cityLabelSize: number;
    cityDistance: number;
    cityTransitionWidth: number;
    cityLabelNearDistance: number;
    cityLabelFarDistance: number;
    lodFadeSeconds: number;
  };
  environment: {
    sunAzimuth: number;
    sunElevation: number;
    sunIntensity: number;
    ambientIntensity: number;
    fogColor: string;
    fogDensity: number;
    edgeFade: number;
    exposure: number;
    dprLimit: number;
  };
  route: {
    mainColor: string;
    routeAColor: string;
    routeBColor: string;
    hoverColor: string;
    pixelWidth: number;
    dashLength: number;
    dashGap: number;
    dashRoundness: number;
    glowRange: number;
    glowIntensity: number;
    opacity: number;
    flowSpeed: number;
    flowDirection: number;
    flowLength: number;
    liftHeight: number;
    arcHeight: number;
  };
  station: {
    pixelSize: number;
    haloSize: number;
    haloOpacity: number;
    centerBrightness: number;
    labelFontSize: number;
    labelOpacity: number;
    labelBackgroundOpacity: number;
    labelDistance: number;
    labelClusterDistance: number;
  };
  weather: WeatherStyle;
  metrics: {
    fps: number;
    drawCalls: number;
    triangles: number;
    geometries: number;
    textures: number;
    dataLoadMs: number;
    backend: string;
    currentLod: string;
    cameraDistance: number;
    reliefTiles: number;
  };
}

export function createDebugParams(): DebugParams {
  return {
    terrain: {
      // Keep relief readable at city distance without turning filtered DEM
      // slopes into razor-dark ravines in close views.
      // Chinese province-scale ridges need enough vertical relief to read in
      // the default radial view; the DEM itself remains unchanged.
      exaggeration: 12.0,
      brightness: 1.04,
      contrast: 1.1,
      saturation: 1.02,
      warmth: 0.18,
      roughness: 0.9,
      detailStrength: 1.28,
      materialDistance: TERRAIN_LOD_DEFAULTS.materialDistance,
      detailDistance: TERRAIN_LOD_DEFAULTS.detailDistance,
      rockThreshold: 0.44,
      snowThreshold: 0.94,
      hazeStrength: 0.08,
      lowlandColor: '#6f8873',
      drylandColor: '#a3835d',
      forestColor: '#4f7d52',
      plateauColor: '#969572',
      rockColor: '#a89b83',
      snowColor: '#d8d8c8',
      wireframe: false,
    },
    ocean: {
      visible: true,
      shallowColor: '#17434a',
      shelfColor: '#0c2733',
      deepColor: '#06141d',
      shallowRange: 0.16,
      coastWidth: 0.055,
      waveSpeed: 0.42,
      waveStrength: 0.62,
      fineStrength: 0.38,
      fresnel: 0.5,
      sunSpecular: 0.32,
      reflection: 0.25,
      opacity: 0.92,
    },
    admin: {
      showProvince: true,
      showCity: true,
      showProvinceLabels: true,
      showCityLabels: true,
      provinceColor: '#e0eee7',
      cityColor: '#a9c9c0',
      provinceLabelColor: '#eef3f0',
      cityLabelColor: '#d8e2df',
      provinceLabelOpacity: 0.9,
      cityLabelOpacity: 0.72,
      provinceOpacity: 0.38,
      cityOpacity: 0.3,
      provinceWidth: 1.1,
      cityWidth: 0.75,
      provinceLabelSize: 12,
      cityLabelSize: 11,
      cityDistance: 70,
      cityTransitionWidth: 26,
      cityLabelNearDistance: 24,
      cityLabelFarDistance: 52,
      lodFadeSeconds: 0.28,
    },
    environment: {
      sunAzimuth: 236,
      sunElevation: 48,
      sunIntensity: 1.55,
      ambientIntensity: 1.6,
      fogColor: '#2b4042',
      fogDensity: 0.0007,
      edgeFade: 0.14,
      exposure: 1.08,
      dprLimit: 1.4,
    },
    route: {
      mainColor: '#25d8dc',
      routeAColor: '#ffad45',
      routeBColor: '#24bfe8',
      hoverColor: '#fff3cf',
      pixelWidth: 7,
      dashLength: 0.22,
      dashGap: 0.17,
      dashRoundness: 0.82,
      glowRange: 18,
      glowIntensity: 2,
      opacity: 0.97,
      flowSpeed: 0.49,
      flowDirection: -1,
      flowLength: 0.7,
      liftHeight: 0.04,
      arcHeight: 0.75,
    },
    station: {
      pixelSize: 18,
      haloSize: 1.1,
      haloOpacity: 0.92,
      centerBrightness: 1.05,
      labelFontSize: 11,
      labelOpacity: 0.94,
      labelBackgroundOpacity: 0.12,
      labelDistance: 125,
      labelClusterDistance: 6,
    },
    weather: {
      enabled: true,
      intensity: 0.72,
      rainDensity: 0.72,
      windSpeed: 0.75,
      cloudScale: 0.75,
      opacity: 0.65,
    },
    metrics: {
      fps: 0,
      drawCalls: 0,
      triangles: 0,
      geometries: 0,
      textures: 0,
      dataLoadMs: 0,
      backend: 'initializing',
      currentLod: 'country',
      cameraDistance: 0,
      reliefTiles: 0,
    },
  };
}
