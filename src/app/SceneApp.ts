import * as THREE from 'three/webgpu';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Inspector } from 'three/addons/inspector/Inspector.js';
import type { ParametersGroup } from 'three/addons/inspector/tabs/Parameters.js';
import type { AdminLevel, SceneAssets } from '../types/scene';
import { AdminLodController } from '../admin/AdminLodController';
import { BoundaryLayer } from '../admin/BoundaryLayer';
import { LabelLayer } from '../admin/LabelLayer';
import { AtmosphereLayer } from '../atmosphere/AtmosphereLayer';
import { BusinessLabelLayer } from '../business/BusinessLabelLayer';
import { STATIONS, stationsForMode, type RouteMode } from '../business/BusinessData';
import { RouteLayer } from '../business/RouteLayer';
import { StationLayer } from '../business/StationLayer';
import { createDebugParams, type DebugParams } from '../debug/DebugParams';
import { OceanLayer } from '../ocean/OceanLayer';
import { TerrainData } from '../terrain/TerrainData';
import { TerrainLayer } from '../terrain/TerrainLayer';
import { TERRAIN_LOD_RANGES, TERRAIN_SCENE_WIDTH_UNITS } from '../terrain/TerrainLodConfig';
import { createMapMaskTexture } from '../terrain/MapMaskTexture';
import { TerrainReliefTileCache } from '../terrain/TerrainReliefTileCache';
import { TerrainSurfaceBuilder } from '../terrain/TerrainSurfaceBuilder';
import { WeatherLayer } from '../weather/WeatherLayer';
import { AssetManifestLoader } from './AssetManifestLoader';
import { CameraController } from './CameraController';
import { RenderLoop } from './RenderLoop';
import { ModeToolbar } from './ModeToolbar';

export class SceneApp {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 0.5, 800);
  private readonly renderer: THREE.WebGPURenderer;
  private readonly labelRenderer = new CSS2DRenderer();
  private readonly renderLoop: RenderLoop;
  private readonly assetLoader = new AssetManifestLoader();
  private readonly params: DebugParams = createDebugParams();
  private readonly onResize = (): void => this.requestResize();
  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.renderLoop.stop();
    else this.renderLoop.start();
  };
  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pendingPointer = { x: event.clientX, y: event.clientY };
    if (this.pointerPickFrame !== 0) return;
    this.pointerPickFrame = window.requestAnimationFrame(() => {
      this.pointerPickFrame = 0;
      if (!this.pendingPointer || this.disposed) return;
      const route = this.routeLayer.pick(
        this.pendingPointer.x,
        this.pendingPointer.y,
        this.camera,
        this.renderer.domElement,
      );
      const id = route?.id ?? null;
      if (id === this.routeLayer.hovered?.id) return;
      this.routeLayer.setHovered(id);
      this.routeLayer.setStyle(this.params.route, false);
      this.stationLayer.setHovered(route);
      this.businessLabels.setHovered(route);
      this.renderer.domElement.style.cursor = route ? 'pointer' : 'grab';
    });
  };

  private assets!: SceneAssets;
  private cameraController!: CameraController;
  private atmosphere!: AtmosphereLayer;
  private terrain!: TerrainLayer;
  private terrainSurfaceBuilder?: TerrainSurfaceBuilder;
  private terrainReliefTiles?: TerrainReliefTileCache;
  private coastMaskTexture!: THREE.DataTexture;
  private chinaMaskTexture!: THREE.DataTexture;
  private terrainReliefTexture!: THREE.Texture;
  private terrainImageryTexture!: THREE.Texture;
  private ocean!: OceanLayer;
  private boundaries!: BoundaryLayer;
  private labels!: LabelLayer;
  private adminLod!: AdminLodController;
  private routeLayer!: RouteLayer;
  private stationLayer!: StationLayer;
  private businessLabels!: BusinessLabelLayer;
  private weatherLayer!: WeatherLayer;
  private modeToolbar!: ModeToolbar;
  private inspector?: Inspector;
  private lastMetricUpdate = 0;
  private metricSnapshotQueued = false;
  private metricFrameCount = 0;
  private metricElapsed = 0;
  private lastLabelLayout = 0;
  private lastLabelRender = 0;
  private currentMode: RouteMode = 'radial';
  private pointerPickFrame = 0;
  private pendingPointer?: { x: number; y: number };
  private deferredAdminHandle?: number;
  private resizeQueued = false;
  private resizeInProgress = false;
  private inspectorHidden = false;
  private disposed = false;

  public constructor(private readonly container: HTMLElement) {
    this.scene.background = new THREE.Color('#819399');
    this.renderer = new THREE.WebGPURenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.params.environment.exposure;
    this.renderer.shadowMap.enabled = false;
    this.renderer.info.autoReset = true;
    this.renderer.domElement.className = 'webgl-canvas';

    this.renderLoop = new RenderLoop(this.renderFrame, this.renderer);

    this.labelRenderer.domElement.className = 'label-layer';
    this.labelRenderer.domElement.style.pointerEvents = 'none';
    this.container.append(this.renderer.domElement, this.labelRenderer.domElement);
  }

  public async initialize(): Promise<void> {
    if (import.meta.env.DEV) {
      const { Inspector } = await import('three/addons/inspector/Inspector.js');
      this.inspector = new Inspector();
      this.renderer.inspector = this.inspector;
    }
    await this.renderer.init();
    this.params.metrics.backend = this.renderer.backend.constructor.name;
    this.assets = await this.assetLoader.load();
    this.params.metrics.dataLoadMs = Math.round(this.assets.loadDurationMs);
    this.coastMaskTexture = createMapMaskTexture(
      this.assets.oceanMask,
      this.assets.manifest.ocean.maskWidth,
      this.assets.manifest.ocean.maskHeight,
    );
    this.chinaMaskTexture = createMapMaskTexture(
      this.assets.chinaMask,
      this.assets.manifest.china.maskWidth,
      this.assets.manifest.china.maskHeight,
    );
    this.terrainImageryTexture = new THREE.Texture(this.assets.terrainImagery);
    this.terrainImageryTexture.name = 'NASABlueMarbleTerrainImagery';
    this.terrainImageryTexture.colorSpace = THREE.SRGBColorSpace;
    this.terrainImageryTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.terrainImageryTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.terrainImageryTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.terrainImageryTexture.magFilter = THREE.LinearFilter;
    this.terrainImageryTexture.generateMipmaps = true;
    this.terrainImageryTexture.needsUpdate = true;
    this.terrainReliefTexture = new THREE.Texture(this.assets.terrainRelief);
    this.terrainReliefTexture.name = 'TerrainMultiscaleRelief';
    this.terrainReliefTexture.colorSpace = THREE.NoColorSpace;
    this.terrainReliefTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.terrainReliefTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.terrainReliefTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.terrainReliefTexture.magFilter = THREE.LinearFilter;
    this.terrainReliefTexture.generateMipmaps = true;
    this.terrainReliefTexture.needsUpdate = true;
    this.terrainReliefTiles = new TerrainReliefTileCache(this.assets.manifest, this.renderer);
    await this.terrainReliefTiles.initialize();
    this.terrainSurfaceBuilder = new TerrainSurfaceBuilder(this.assets.manifest, this.assets.heights);
    const terrainPrepareStartedAt = performance.now();
    const renderHeightResult = await this.terrainSurfaceBuilder.getRenderHeights();
    this.params.metrics.dataLoadMs = Math.round(
      this.assets.loadDurationMs + performance.now() - terrainPrepareStartedAt,
    );
    const terrainSurface = this.terrainSurfaceBuilder.buildSurface(
      this.assets.terrainReliefBlob,
      this.assets.manifest.terrain.reliefWidth,
      this.assets.manifest.terrain.reliefHeight,
    );
    const terrainData = new TerrainData(
      this.assets.manifest.terrain,
      this.assets.heights,
      this.assets.oceanMask,
      this.assets.manifest.ocean.maskWidth,
      this.assets.manifest.ocean.maskHeight,
      renderHeightResult.data,
    );
    this.atmosphere = new AtmosphereLayer();
    this.terrain = new TerrainLayer(
      terrainData,
      terrainSurface,
      this.coastMaskTexture,
      this.chinaMaskTexture,
      this.terrainReliefTexture,
      this.terrainReliefTiles.textures,
      this.terrainImageryTexture,
    );
    await this.terrain.initialize();
    this.ocean = new OceanLayer(terrainData, this.coastMaskTexture);
    this.boundaries = new BoundaryLayer(
      this.assets.provinceBoundary,
      undefined,
      terrainData,
    );
    this.labels = new LabelLayer(
      this.assets.provinceLabels,
      undefined,
      terrainData,
    );
    this.routeLayer = new RouteLayer(terrainData);
    this.stationLayer = new StationLayer(terrainData);
    this.businessLabels = new BusinessLabelLayer(terrainData);
    this.weatherLayer = new WeatherLayer(
      STATIONS,
      (stationId) => this.stationLayer.getStationPosition(stationId),
    );
    this.modeToolbar = new ModeToolbar((mode) => this.setMode(mode));
    this.container.append(this.modeToolbar.element);

    this.scene.add(
      this.atmosphere.object3d,
      this.terrain.object3d,
      this.ocean.object3d,
      this.boundaries.object3d,
      this.labels.object3d,
      this.routeLayer.object3d,
      this.stationLayer.object3d,
      this.weatherLayer.object3d,
      this.businessLabels.object3d,
    );

    this.cameraController = new CameraController(
      this.camera,
      this.renderer.domElement,
      terrainData,
    );
    this.cameraController.setViewportAspect(
      Math.max(1, this.container.clientWidth) / Math.max(1, this.container.clientHeight),
      true,
    );
    this.adminLod = new AdminLodController(
      this.cameraController,
      this.boundaries,
      this.labels,
      this.params.admin,
    );

    this.applyTerrainParams();
    this.applyOceanParams();
    this.applyEnvironmentParams();
    this.applyAllBoundaryStyles();
    this.applyBusinessParams();
    // Start with the whole China terrain in frame. Route modes still update
    // their station set, but an automatic Guangdong close-up hides the
    // macro-relief the map is meant to showcase.
    this.setMode('radial', false);
    if (this.inspector) {
      this.setupInspectorParameters();
      const inspectorPanel = this.inspector.domElement.querySelector('.profiler-panel.visible');
      if (inspectorPanel) {
        this.inspector.domElement.querySelector<HTMLButtonElement>('.profiler-toggle')?.click();
      }
    }
    this.adminLod.update(0);
    this.applyResize();

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    document.querySelector('#loading')?.classList.add('is-hidden');
    this.renderLoop.start();
    this.scheduleDeferredAdminLoad();
  }

  public dispose(): void {
    this.disposed = true;
    this.renderLoop.stop();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    if (this.pointerPickFrame !== 0) window.cancelAnimationFrame(this.pointerPickFrame);
    if (this.deferredAdminHandle !== undefined) {
      window.clearTimeout(this.deferredAdminHandle);
    }
    this.cameraController?.dispose();
    this.adminLod?.dispose();
    this.atmosphere?.dispose();
    this.terrain?.dispose();
    this.terrainSurfaceBuilder?.dispose();
    this.terrainReliefTiles?.dispose();
    this.ocean?.dispose();
    this.boundaries?.dispose();
    this.labels?.dispose();
    this.routeLayer?.dispose();
    this.stationLayer?.dispose();
    this.businessLabels?.dispose();
    this.weatherLayer?.dispose();
    this.modeToolbar?.dispose();
    this.coastMaskTexture?.dispose();
    this.chinaMaskTexture?.dispose();
    this.terrainImageryTexture?.dispose();
    this.terrainReliefTexture?.dispose();
    this.assets?.terrainImagery.close();
    this.assets?.terrainRelief.close();
    this.renderer.dispose();
  }

  public runGeometryValidation(): {
    terrain: ReturnType<TerrainData['validateGeometry']>;
    boundaries: ReturnType<BoundaryLayer['getDiagnostics']>;
  } {
    return {
      terrain: this.terrain.validateGeometry(),
      boundaries: this.boundaries.getDiagnostics(),
    };
  }

  private readonly renderFrame = (deltaSeconds: number, elapsedSeconds: number): void => {
    if (this.inspector && !this.inspectorHidden) this.hideInspectorPanel();
    // WebGPU/WebGL node renderers finalize counters asynchronously. Read the
    // completed previous frame before submitting the next one.
    this.updateMetrics(deltaSeconds, elapsedSeconds);
    const cameraChanged = this.cameraController.update();
    const cameraDistance = this.cameraController.getDistance();
    this.terrainReliefTiles?.update(
      this.camera,
      this.cameraController.controls.target,
      cameraDistance,
      deltaSeconds,
    );
    this.terrain.update(cameraDistance, deltaSeconds);
    this.ocean.update(elapsedSeconds);
    this.routeLayer.update(
      deltaSeconds,
      elapsedSeconds,
      this.params.route,
    );
    this.stationLayer.update(deltaSeconds, this.camera, this.container.clientHeight);
    this.weatherLayer.tick(
      deltaSeconds,
      elapsedSeconds,
      this.camera,
      this.container.clientHeight,
    );
    this.adminLod.update(deltaSeconds);

    this.renderer.render(this.scene, this.camera);
    if (cameraChanged || elapsedSeconds - this.lastLabelRender >= 0.1) {
      this.lastLabelRender = elapsedSeconds;
      this.labelRenderer.render(this.scene, this.camera);
    }
    if (cameraChanged || elapsedSeconds - this.lastLabelLayout >= 0.15) {
      this.lastLabelLayout = elapsedSeconds;
      this.labels.updateCollision(this.camera, this.container.clientWidth, this.container.clientHeight);
      this.businessLabels.update(
        this.camera,
        this.container.clientWidth,
        this.container.clientHeight,
        this.params.station,
      );
    }
  };

  private updateMetrics(deltaSeconds: number, elapsedSeconds: number): void {
    this.metricFrameCount += 1;
    this.metricElapsed += deltaSeconds;
    if (elapsedSeconds - this.lastMetricUpdate < 0.5) return;
    this.lastMetricUpdate = elapsedSeconds;

    this.params.metrics.fps = Math.round(this.metricFrameCount / Math.max(this.metricElapsed, 0.001));
    this.params.metrics.currentLod = `${this.adminLod.currentLod}/${this.terrain.getGeometryLod()}`;
    this.params.metrics.cameraDistance = Number(this.cameraController.getDistance().toFixed(2));
    this.params.metrics.reliefTiles = this.terrainReliefTiles?.getResidentCount() ?? 0;
    this.metricFrameCount = 0;
    this.metricElapsed = 0;
    if (!this.metricSnapshotQueued) {
      this.metricSnapshotQueued = true;
      window.setTimeout(() => {
        this.metricSnapshotQueued = false;
        if (this.disposed) return;
        this.params.metrics.drawCalls = this.renderer.info.render.drawCalls;
        this.params.metrics.triangles = this.renderer.info.render.triangles;
        this.params.metrics.geometries = this.renderer.info.memory.geometries;
        this.params.metrics.textures = this.renderer.info.memory.textures;
      }, 0);
    }
  }

  private applyTerrainParams(): void {
    const params = this.params.terrain;
    this.cameraController?.setExaggeration(params.exaggeration);
    this.terrain.setExaggeration(params.exaggeration);
    this.boundaries.setExaggeration(params.exaggeration);
    this.labels.setExaggeration(params.exaggeration);
    this.routeLayer?.setExaggeration(params.exaggeration);
    this.stationLayer?.setExaggeration(params.exaggeration);
    this.businessLabels?.setExaggeration(params.exaggeration);
    this.weatherLayer?.setExaggeration(params.exaggeration);
    this.terrain.setWireframe(params.wireframe);
    this.terrain.setNumeric('uBrightness', params.brightness);
    this.terrain.setNumeric('uContrast', params.contrast);
    this.terrain.setNumeric('uSaturation', params.saturation);
    this.terrain.setNumeric('uWarmth', params.warmth);
    this.terrain.setNumeric('uRoughness', params.roughness);
    this.terrain.setNumeric('uDetailStrength', params.detailStrength);
    this.terrain.setNumeric('uMaterialDistance', params.materialDistance);
    this.terrain.setNumeric('uDetailDistance', params.detailDistance);
    this.terrain.setNumeric('uRockThreshold', params.rockThreshold);
    this.terrain.setNumeric('uSnowThreshold', params.snowThreshold);
    this.terrain.setNumeric('uHazeStrength', params.hazeStrength);
    this.terrain.setNumeric('uEdgeFade', this.params.environment.edgeFade);
    this.terrain.setColor('uLowlandColor', params.lowlandColor);
    this.terrain.setColor('uDrylandColor', params.drylandColor);
    this.terrain.setColor('uForestColor', params.forestColor);
    this.terrain.setColor('uPlateauColor', params.plateauColor);
    this.terrain.setColor('uRockColor', params.rockColor);
    this.terrain.setColor('uSnowColor', params.snowColor);
  }

  private applyOceanParams(): void {
    const params = this.params.ocean;
    this.ocean.object3d.visible = params.visible;
    this.ocean.material.setNumeric('uShallowRange', params.shallowRange);
    this.ocean.material.setNumeric('uCoastWidth', params.coastWidth);
    this.ocean.material.setNumeric('uWaveSpeed', params.waveSpeed);
    this.ocean.material.setNumeric('uWaveStrength', params.waveStrength);
    this.ocean.material.setNumeric('uFineStrength', params.fineStrength);
    this.ocean.material.setNumeric('uFresnelStrength', params.fresnel);
    this.ocean.material.setNumeric('uSunSpecular', params.sunSpecular);
    this.ocean.material.setNumeric('uReflectionStrength', params.reflection);
    this.ocean.material.setNumeric('uOpacity', params.opacity);
    this.ocean.material.setNumeric('uEdgeFade', this.params.environment.edgeFade);
    this.ocean.material.setColor('uShallowColor', params.shallowColor);
    this.ocean.material.setColor('uShelfColor', params.shelfColor);
    this.ocean.material.setColor('uDeepColor', params.deepColor);
  }

  private applyEnvironmentParams(): void {
    const params = this.params.environment;
    this.atmosphere.setSun(params.sunAzimuth, params.sunElevation);
    this.atmosphere.setSunIntensity(params.sunIntensity);
    this.atmosphere.setAmbientIntensity(params.ambientIntensity);
    this.atmosphere.setHazeColor(params.fogColor);
    this.renderer.toneMappingExposure = params.exposure;
    this.scene.background = new THREE.Color(params.fogColor);

    this.scene.fog = new THREE.FogExp2(params.fogColor, params.fogDensity);
    this.applyTerrainParams();
    this.applyOceanParams();
  }

  private applyBusinessParams(): void {
    this.routeLayer.setStyle(this.params.route);
    this.stationLayer.setStyle(this.params.station);
    this.businessLabels.applyStyle(this.params.station);
    this.weatherLayer.setStyle(this.params.weather);
  }

  public setMode(mode: RouteMode, focusStations = true): void {
    this.currentMode = mode;
    this.routeLayer.setMode(mode);
    this.routeLayer.setStyle(this.params.route, false);
    this.stationLayer.setMode(mode);
    this.stationLayer.setHovered(null);
    this.businessLabels.setMode(mode);
    this.businessLabels.setHovered(null);
    const modeStations = stationsForMode(mode);
    this.weatherLayer.setActiveStations(modeStations.map((station) => station.id));
    this.modeToolbar.setMode(mode);
    this.adminLod.setActiveProvinceAdcodes(modeStations.map((station) => station.provinceAdcode));
    if (focusStations) this.cameraController.focusUvPoints(modeStations);
  }

  private applyBoundaryStyle(level: AdminLevel): void {
    const colorKey = `${level}Color` as keyof DebugParams['admin'];
    const opacityKey = `${level}Opacity` as keyof DebugParams['admin'];
    const widthKey = `${level}Width` as keyof DebugParams['admin'];
    this.boundaries.setColor(level, this.params.admin[colorKey] as string);
    this.boundaries.setOpacity(level, this.params.admin[opacityKey] as number);
    this.boundaries.setLineWidth(level, this.params.admin[widthKey] as number);
  }

  private applyAllBoundaryStyles(): void {
    this.applyBoundaryStyle('province');
    this.applyBoundaryStyle('city');
    this.labels.setOpacity('province', this.params.admin.provinceOpacity * 0.72);
    this.labels.setOpacity('city', this.params.admin.cityOpacity * 0.76);
    this.labels.setColor('province', this.params.admin.provinceLabelColor);
    this.labels.setColor('city', this.params.admin.cityLabelColor);
    this.labels.setFontSize('province', this.params.admin.provinceLabelSize);
    this.labels.setFontSize('city', this.params.admin.cityLabelSize);
  }

  private setupInspectorParameters(): void {
    if (!this.inspector) return;
    const root: ParametersGroup = this.inspector.createParameters('场景参数');
    const terrain = root.addFolder('地形着色');
    terrain.add(this.params.terrain, 'exaggeration', 1, 80, 0.1).name('高度夸张').onChange(() => this.applyTerrainParams());
    terrain.add(this.params.terrain, 'brightness', 0.4, 1.6, 0.01).name('亮度').onChange(() => this.applyTerrainParams());
    terrain.add(this.params.terrain, 'contrast', 0.6, 1.8, 0.01).name('对比度').onChange(() => this.applyTerrainParams());
    terrain.add(this.params.terrain, 'saturation', 0, 1.5, 0.01).name('饱和度').onChange(() => this.applyTerrainParams());
    terrain.add(this.params.terrain, 'warmth', 0, 0.6, 0.01).name('冷暖色比例').onChange(() => this.applyTerrainParams());
    terrain.add(this.params.terrain, 'roughness', 0, 1, 0.01).name('粗糙度').onChange(() => this.applyTerrainParams());
    terrain.add(this.params.terrain, 'detailStrength', 0, 1.5, 0.01).name('地表纹理').onChange(() => this.applyTerrainParams());
    const terrainLod = terrain.addFolder('材质 LOD');
    const materialRange = TERRAIN_LOD_RANGES.materialDistance;
    terrainLod.add(
      this.params.terrain,
      'materialDistance',
      materialRange.min,
      materialRange.max,
      materialRange.step,
    ).name(`中景材质距离（全图 ${TERRAIN_SCENE_WIDTH_UNITS}）`).onChange(() => this.applyTerrainParams());
    const detailRange = TERRAIN_LOD_RANGES.detailDistance;
    terrainLod.add(
      this.params.terrain,
      'detailDistance',
      detailRange.min,
      detailRange.max,
      detailRange.step,
    ).name('近景结构距离').onChange(() => this.applyTerrainParams());
    terrainLod.add(this.params.metrics, 'cameraDistance').name('实时相机距离').listen();
    terrainLod.add(this.params.metrics, 'reliefTiles').name('高清地形页').listen();
    terrain.add(this.params.terrain, 'rockThreshold', 0.15, 0.8, 0.01).name('岩石海拔').onChange(() => this.applyTerrainParams());
    terrain.add(this.params.terrain, 'snowThreshold', 0.45, 1, 0.01).name('积雪海拔').onChange(() => this.applyTerrainParams());
    terrain.add(this.params.terrain, 'hazeStrength', 0, 1, 0.01).name('远景雾化').onChange(() => this.applyTerrainParams());
    terrain.add(this.params.terrain, 'wireframe').name('线框').onChange(() => this.applyTerrainParams());
    const terrainColors = {
      lowland: new THREE.Color(this.params.terrain.lowlandColor),
      dryland: new THREE.Color(this.params.terrain.drylandColor),
      forest: new THREE.Color(this.params.terrain.forestColor),
      plateau: new THREE.Color(this.params.terrain.plateauColor),
      rock: new THREE.Color(this.params.terrain.rockColor),
      snow: new THREE.Color(this.params.terrain.snowColor),
    };
    const terrainColorKeys: Record<keyof typeof terrainColors, 'lowlandColor' | 'drylandColor' | 'forestColor' | 'plateauColor' | 'rockColor' | 'snowColor'> = {
      lowland: 'lowlandColor',
      dryland: 'drylandColor',
      forest: 'forestColor',
      plateau: 'plateauColor',
      rock: 'rockColor',
      snow: 'snowColor',
    };
    for (const [key, label] of [['lowland', '地形基础色'], ['dryland', '暖色焦点'], ['forest', '阴影色'], ['plateau', '高程中间色'], ['rock', '高程高色'], ['snow', '高光色']] as const) {
      terrain.addColor(terrainColors, key).name(label).onChange((value) => {
        this.params.terrain[terrainColorKeys[key]] = `#${value.getHexString()}`;
        this.applyTerrainParams();
      });
    }

    const ocean = root.addFolder('海洋');
    ocean.add(this.params.ocean, 'visible').name('显示').onChange(() => this.applyOceanParams());
    ocean.add(this.params.ocean, 'shallowRange', 0.02, 0.45, 0.01).name('浅海范围').onChange(() => this.applyOceanParams());
    ocean.add(this.params.ocean, 'coastWidth', 0.01, 0.2, 0.005).name('岸线泡沫').onChange(() => this.applyOceanParams());
    ocean.add(this.params.ocean, 'waveSpeed', 0, 1.5, 0.01).name('波速').onChange(() => this.applyOceanParams());
    ocean.add(this.params.ocean, 'waveStrength', 0, 1.2, 0.01).name('波幅').onChange(() => this.applyOceanParams());
    ocean.add(this.params.ocean, 'fineStrength', 0, 1.5, 0.01).name('细波').onChange(() => this.applyOceanParams());
    ocean.add(this.params.ocean, 'fresnel', 0, 1.5, 0.01).name('菲涅尔').onChange(() => this.applyOceanParams());
    ocean.add(this.params.ocean, 'sunSpecular', 0, 2, 0.01).name('太阳反射').onChange(() => this.applyOceanParams());
    ocean.add(this.params.ocean, 'reflection', 0, 1.5, 0.01).name('天空反射').onChange(() => this.applyOceanParams());
    ocean.add(this.params.ocean, 'opacity', 0.4, 1, 0.01).name('透明度').onChange(() => this.applyOceanParams());
    const oceanColors = {
      shallow: new THREE.Color(this.params.ocean.shallowColor),
      shelf: new THREE.Color(this.params.ocean.shelfColor),
      deep: new THREE.Color(this.params.ocean.deepColor),
    };
    const oceanColorKeys: Record<keyof typeof oceanColors, 'shallowColor' | 'shelfColor' | 'deepColor'> = {
      shallow: 'shallowColor',
      shelf: 'shelfColor',
      deep: 'deepColor',
    };
    for (const [key, label] of [['shallow', '浅海'], ['shelf', '大陆架'], ['deep', '深海']] as const) {
      ocean.addColor(oceanColors, key).name(label).onChange((value) => {
        this.params.ocean[oceanColorKeys[key]] = `#${value.getHexString()}`;
        this.applyOceanParams();
      });
    }

    const admin = root.addFolder('行政区');
    for (const key of ['showProvince', 'showCity', 'showProvinceLabels', 'showCityLabels'] as const) admin.add(this.params.admin, key).name(key).onChange(() => this.adminLod.update(0));
    admin.add(this.params.admin, 'cityDistance', 30, 120, 1).name('市界LOD距离').onChange(() => this.adminLod.update(0));
    admin.add(this.params.admin, 'cityTransitionWidth', 8, 60, 1).name('市界过渡宽度').onChange(() => this.adminLod.update(0));
    admin.add(this.params.admin, 'cityLabelNearDistance', 8, 70, 1).name('市名近距').onChange(() => this.adminLod.update(0));
    admin.add(this.params.admin, 'cityLabelFarDistance', 20, 120, 1).name('市名远距').onChange(() => this.adminLod.update(0));
    admin.add(this.params.admin, 'lodFadeSeconds', 0, 1.2, 0.01).name('市级淡入时间').onChange(() => this.adminLod.update(0));
    const adminColors = { province: new THREE.Color(this.params.admin.provinceColor), city: new THREE.Color(this.params.admin.cityColor) };
    admin.addColor(adminColors, 'province').name('省界颜色').onChange((value) => { this.params.admin.provinceColor = `#${value.getHexString()}`; this.applyBoundaryStyle('province'); });
    admin.addColor(adminColors, 'city').name('市界颜色').onChange((value) => { this.params.admin.cityColor = `#${value.getHexString()}`; this.applyBoundaryStyle('city'); });
    const adminLabelColors = { province: new THREE.Color(this.params.admin.provinceLabelColor), city: new THREE.Color(this.params.admin.cityLabelColor) };
    admin.addColor(adminLabelColors, 'province').name('省名颜色').onChange((value) => { this.params.admin.provinceLabelColor = `#${value.getHexString()}`; this.applyAllBoundaryStyles(); });
    admin.addColor(adminLabelColors, 'city').name('市名颜色').onChange((value) => { this.params.admin.cityLabelColor = `#${value.getHexString()}`; this.applyAllBoundaryStyles(); });
    admin.add(this.params.admin, 'provinceOpacity', 0, 1, 0.01).name('省界透明度').onChange(() => this.applyBoundaryStyle('province'));
    admin.add(this.params.admin, 'cityOpacity', 0, 1, 0.01).name('市界透明度').onChange(() => this.applyBoundaryStyle('city'));
    admin.add(this.params.admin, 'provinceWidth', 0.3, 4, 0.05).name('省界宽度').onChange(() => this.applyBoundaryStyle('province'));
    admin.add(this.params.admin, 'cityWidth', 0.2, 3, 0.05).name('市界宽度').onChange(() => this.applyBoundaryStyle('city'));
    admin.add(this.params.admin, 'provinceLabelSize', 8, 24, 1).name('省名字号').onChange(() => this.applyAllBoundaryStyles());
    admin.add(this.params.admin, 'cityLabelSize', 8, 24, 1).name('市名字号').onChange(() => this.applyAllBoundaryStyles());

    const environment = root.addFolder('环境');
    environment.add(this.params.environment, 'sunAzimuth', 0, 360, 1).name('太阳方位').onChange(() => this.applyEnvironmentParams());
    environment.add(this.params.environment, 'sunElevation', 2, 78, 1).name('太阳高度').onChange(() => this.applyEnvironmentParams());
    environment.add(this.params.environment, 'sunIntensity', 0, 4, 0.01).name('太阳光强度').onChange(() => this.applyEnvironmentParams());
    environment.add(this.params.environment, 'ambientIntensity', 0, 3, 0.01).name('环境光强度').onChange(() => this.applyEnvironmentParams());
    environment.add(this.params.environment, 'fogDensity', 0, 0.018, 0.0001).name('雾密度').onChange(() => this.applyEnvironmentParams());
    environment.add(this.params.environment, 'edgeFade', 0.01, 0.2, 0.005).name('边缘融合').onChange(() => this.applyEnvironmentParams());
    environment.add(this.params.environment, 'exposure', 0.35, 1.8, 0.01).name('曝光').onChange(() => this.applyEnvironmentParams());
    environment.add(this.params.environment, 'dprLimit', 1, 2, 0.1).name('DPR 上限').onChange(() => this.requestResize());
    const envColor = { fog: new THREE.Color(this.params.environment.fogColor) };
    environment.addColor(envColor, 'fog').name('雾颜色').onChange((value) => { this.params.environment.fogColor = `#${value.getHexString()}`; this.applyEnvironmentParams(); });

    const route = root.addFolder('路线');
    const routeColors = {
      main: new THREE.Color(this.params.route.mainColor),
      hover: new THREE.Color(this.params.route.hoverColor),
    };
    route.addColor(routeColors, 'main').name('主路线颜色').onChange((value) => { this.params.route.mainColor = `#${value.getHexString()}`; this.routeLayer.setStyle(this.params.route); });
    route.addColor(routeColors, 'hover').name('Hover 强调色').onChange((value) => { this.params.route.hoverColor = `#${value.getHexString()}`; this.routeLayer.setStyle(this.params.route); });
    route.add(this.params.route, 'pixelWidth', 0.8, 7, 0.1).name('屏幕像素宽度').onChange(() => this.routeLayer.setStyle(this.params.route));
    route.add(this.params.route, 'dashLength', 0.1, 2.5, 0.01).name('虚线段长度（场景单位）').onChange(() => this.routeLayer.setStyle(this.params.route));
    route.add(this.params.route, 'dashGap', 0.05, 2, 0.01).name('虚线间隔（场景单位）').onChange(() => this.routeLayer.setStyle(this.params.route));
    route.add(this.params.route, 'dashRoundness', 0, 1, 0.01).name('虚线圆角').onChange(() => this.routeLayer.setStyle(this.params.route));
    route.add(this.params.route, 'glowRange', 0, 18, 0.1).name('发光范围').onChange(() => this.routeLayer.setStyle(this.params.route));
    route.add(this.params.route, 'glowIntensity', 0, 2, 0.01).name('发光强度').onChange(() => this.routeLayer.setStyle(this.params.route));
    route.add(this.params.route, 'opacity', 0, 1, 0.01).name('路线透明度').onChange(() => this.routeLayer.setStyle(this.params.route));
    route.add(this.params.route, 'flowSpeed', 0, 3, 0.01).name('流动速度');
    route.add(this.params.route, 'flowDirection', { '正向': -1, '反向': 1 }).name('流动方向');
    route.add(this.params.route, 'flowLength', 0.2, 3, 0.05).name('流光长度');
    route.add(this.params.route, 'liftHeight', 0.01, 0.6, 0.01).name('贴地抬升高度').onChange(() => this.routeLayer.setStyle(this.params.route));
    route.add(this.params.route, 'arcHeight', 0, 3, 0.05).name('发散飞线弧高').onChange(() => this.routeLayer.setStyle(this.params.route));

    const station = root.addFolder('站点和标签');
    station.add(this.params.station, 'pixelSize', 5, 34, 1).name('站点屏幕像素尺寸').onChange(() => this.applyBusinessParams());
    station.add(this.params.station, 'haloSize', 1, 3, 0.05).name('站点光晕尺寸').onChange(() => this.applyBusinessParams());
    station.add(this.params.station, 'haloOpacity', 0, 1, 0.01).name('站点光晕透明度').onChange(() => this.applyBusinessParams());
    station.add(this.params.station, 'centerBrightness', 0.5, 2, 0.01).name('站点中心亮度').onChange(() => this.applyBusinessParams());
    station.add(this.params.station, 'labelFontSize', 9, 20, 1).name('标签字号').onChange(() => this.applyBusinessParams());
    station.add(this.params.station, 'labelOpacity', 0, 1, 0.01).name('标签透明度').onChange(() => this.applyBusinessParams());
    station.add(this.params.station, 'labelBackgroundOpacity', 0, 0.8, 0.01).name('标签背景透明度').onChange(() => this.applyBusinessParams());
    station.add(this.params.station, 'labelDistance', 20, 240, 1).name('标签显示距离');
    station.add(this.params.station, 'labelClusterDistance', 0, 30, 1).name('标签聚合距离');

    const weather = root.addFolder('天气');
    weather.add(this.params.weather, 'enabled').name('天气图层开关').onChange(() => this.weatherLayer.setStyle(this.params.weather));
    weather.add(this.params.weather, 'intensity', 0, 1, 0.01).name('天气强度').onChange(() => this.weatherLayer.setStyle(this.params.weather));
    weather.add(this.params.weather, 'rainDensity', 0, 1, 0.01).name('降雨密度').onChange(() => this.weatherLayer.setStyle(this.params.weather));
    weather.add(this.params.weather, 'windSpeed', 0, 3, 0.01).name('风速');
    weather.add(this.params.weather, 'cloudScale', 0.2, 2, 0.05).name('云团尺度').onChange(() => this.weatherLayer.setStyle(this.params.weather));
    weather.add(this.params.weather, 'opacity', 0, 1, 0.01).name('天气透明度').onChange(() => this.weatherLayer.setStyle(this.params.weather));
  }

  private hideInspectorPanel(): void {
    if (!this.inspector) return;
    const panel = this.inspector.domElement.querySelector('.profiler-panel.visible');
    if (panel) {
      this.inspector.domElement.querySelector<HTMLButtonElement>('.profiler-toggle')?.click();
    }
    const miniPanel = this.inspector.domElement.querySelector('.profiler-mini-panel.visible');
    if (miniPanel) {
      this.inspector.domElement.querySelector<HTMLButtonElement>('.builtin-tab-btn.active')?.click();
    }
    this.inspectorHidden = true;
  }

  private scheduleDeferredAdminLoad(): void {
    const load = (): void => {
      this.deferredAdminHandle = undefined;
      void this.loadDeferredAdmin();
    };
    this.deferredAdminHandle = window.setTimeout(load, 400);
  }

  private async loadDeferredAdmin(): Promise<void> {
    try {
      const assets = await this.assetLoader.loadDeferredAdmin(this.assets.manifest);
      if (this.disposed) return;
      this.boundaries.setLevelData('city', [assets.cityBoundary]);
      this.labels.setLevelData('city', assets.cityLabels);
      this.applyBoundaryStyle('city');
      this.labels.setOpacity('city', this.params.admin.cityOpacity * 0.76);
      this.labels.setColor('city', this.params.admin.cityLabelColor);
      this.labels.setFontSize('city', this.params.admin.cityLabelSize);
      const activeStations = stationsForMode(this.currentMode);
      this.adminLod.setActiveProvinceAdcodes(
        activeStations.map((station) => station.provinceAdcode),
      );
      this.adminLod.update(0);
    } catch (error) {
      console.warn('Deferred city data failed to load.', error);
    }
  }

  private requestResize(): void {
    this.resizeQueued = true;
    if (!this.resizeInProgress) void this.flushResize();
  }

  private async flushResize(): Promise<void> {
    this.resizeInProgress = true;
    this.renderLoop.stop();
    try {
      do {
        this.resizeQueued = false;
        const backend = this.renderer.backend as unknown as {
          device?: { queue?: { onSubmittedWorkDone?: () => Promise<unknown> } };
        };
        await backend.device?.queue?.onSubmittedWorkDone?.();
      } while (this.resizeQueued);
      if (!this.disposed) this.applyResize();
    } finally {
      this.resizeInProgress = false;
      if (!this.disposed && !document.hidden) this.renderLoop.start();
    }
  }

  private applyResize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const responsiveLimit = width <= 768
      ? Math.min(1.2, this.params.environment.dprLimit)
      : this.params.environment.dprLimit;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, responsiveLimit));
    this.renderer.setSize(width, height, false);
    this.labelRenderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.cameraController?.setViewportAspect(this.camera.aspect);
    this.camera.updateProjectionMatrix();
    this.boundaries?.resize(this.renderer.domElement.width, this.renderer.domElement.height);
  }
}
