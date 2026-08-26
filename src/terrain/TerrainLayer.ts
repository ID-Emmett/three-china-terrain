import * as THREE from 'three/webgpu';
import type { SceneLayer } from '../app/SceneLayer';
import type { TerrainData, TerrainValidationReport } from './TerrainData';
import { createTerrainDetailTexture } from './TerrainDetailTexture';
import { TerrainMaterial } from './TerrainMaterial';

type TerrainGeometryLod = 'overview' | 'regional' | 'detail';

interface TerrainLodSpec {
  step: number;
  columns: number;
  rows: number;
}

interface TerrainLodLevel {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  nextChunk: number;
  ready: boolean;
}

const LOD_SPECS: Record<TerrainGeometryLod, TerrainLodSpec> = {
  overview: { step: 4, columns: 4, rows: 3 },
  regional: { step: 2, columns: 6, rows: 4 },
  detail: { step: 1, columns: 8, rows: 6 },
};

const REGIONAL_DISTANCE = 88;
const DETAIL_DISTANCE = 28;

export class TerrainLayer implements SceneLayer {
  public readonly object3d = new THREE.Group();
  public readonly material: TerrainMaterial;
  private readonly levels = new Map<TerrainGeometryLod, TerrainLodLevel>();
  private readonly buildQueue: TerrainGeometryLod[] = [];
  private activeLod: TerrainGeometryLod = 'overview';
  private desiredLod: TerrainGeometryLod = 'overview';
  private idleHandle?: number;
  private disposed = false;

  public constructor(
    private readonly data: TerrainData,
    coastMask: THREE.Texture,
    chinaMask: THREE.Texture,
    reliefTexture: THREE.Texture,
    terrainImagery: THREE.Texture,
    reliefResidualRangeMeters: number,
  ) {
    this.object3d.name = 'TerrainLayer';
    const surfaceTexture = data.createSurfaceTexture();
    const detailTexture = createTerrainDetailTexture(128);
    this.material = new TerrainMaterial(
      coastMask,
      chinaMask,
      surfaceTexture,
      detailTexture,
      reliefTexture,
      terrainImagery,
      reliefResidualRangeMeters,
      data.meta.minimumElevationMeters,
      data.meta.maximumElevationMeters,
      data.meta.sceneWidth,
      data.meta.sceneDepth,
      data.meta.sceneUnitsPerMeter,
    );

    for (const lod of ['overview', 'regional', 'detail'] as const) {
      const group = new THREE.Group();
      group.name = `${lod}TerrainChunks`;
      group.visible = lod === 'overview';
      this.levels.set(lod, { group, meshes: [], nextChunk: 0, ready: false });
      this.object3d.add(group);
    }

    this.buildLevelImmediately('overview');
    this.enqueueBuild('regional');
  }

  public update(cameraDistance: number): void {
    this.desiredLod = cameraDistance < DETAIL_DISTANCE
      ? 'detail'
      : cameraDistance < REGIONAL_DISTANCE ? 'regional' : 'overview';
    if (this.desiredLod === 'detail') {
      this.enqueueBuild('regional');
      this.enqueueBuild('detail');
    } else if (this.desiredLod === 'regional') {
      this.enqueueBuild('regional');
    }
    this.activateBestReadyLevel();
  }

  public setExaggeration(value: number): void {
    this.object3d.scale.y = value;
  }

  public setWireframe(value: boolean): void {
    this.material.wireframe = value;
  }

  public setNumeric(name: string, value: number): void {
    this.material.setNumeric(name, value);
  }

  public setColor(name: Parameters<TerrainMaterial['setColor']>[0], value: string): void {
    this.material.setColor(name, value);
  }

  public validateGeometry(): TerrainValidationReport {
    const geometry = this.data.createGeometry({ diagnostics: true });
    try {
      return this.data.validateGeometry(geometry);
    } finally {
      geometry.dispose();
    }
  }

  public getGeometryLod(): TerrainGeometryLod {
    return this.activeLod;
  }

  public dispose(): void {
    this.disposed = true;
    if (this.idleHandle !== undefined) {
      window.clearTimeout(this.idleHandle);
    }
    for (const level of this.levels.values()) {
      for (const mesh of level.meshes) mesh.geometry.dispose();
    }
    this.levels.clear();
    this.buildQueue.length = 0;
    this.material.dispose();
  }

  private buildLevelImmediately(lod: TerrainGeometryLod): void {
    const spec = LOD_SPECS[lod];
    const level = this.levels.get(lod)!;
    while (level.nextChunk < spec.columns * spec.rows) this.buildNextChunk(lod);
    level.ready = true;
  }

  private buildNextChunk(lod: TerrainGeometryLod): void {
    const spec = LOD_SPECS[lod];
    const level = this.levels.get(lod)!;
    const chunk = level.nextChunk;
    const chunkX = chunk % spec.columns;
    const chunkY = Math.floor(chunk / spec.columns);
    const cellWidth = this.data.renderWidth - 1;
    const cellHeight = this.data.renderHeight - 1;
    const columnStart = Math.floor(chunkX * cellWidth / spec.columns);
    const columnEnd = Math.floor((chunkX + 1) * cellWidth / spec.columns);
    const rowStart = Math.floor(chunkY * cellHeight / spec.rows);
    const rowEnd = Math.floor((chunkY + 1) * cellHeight / spec.rows);
    const geometry = this.data.createGeometry({
      columnStart,
      columnEnd,
      rowStart,
      rowEnd,
      step: spec.step,
    });
    level.nextChunk += 1;
    if (geometry.getAttribute('position').count === 0) {
      geometry.dispose();
      return;
    }

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = `${lod}Terrain:${chunkX},${chunkY}`;
    mesh.frustumCulled = true;
    mesh.renderOrder = 0;
    level.meshes.push(mesh);
    level.group.add(mesh);
  }

  private enqueueBuild(lod: TerrainGeometryLod): void {
    const level = this.levels.get(lod)!;
    if (level.ready || this.buildQueue.includes(lod)) return;
    this.buildQueue.push(lod);
    this.scheduleBuild();
  }

  private scheduleBuild(): void {
    if (this.disposed || this.idleHandle !== undefined || this.buildQueue.length === 0) return;
    const run = (): void => {
      this.idleHandle = undefined;
      if (this.disposed) return;
      const lod = this.buildQueue[0];
      const level = this.levels.get(lod)!;
      const spec = LOD_SPECS[lod];
      this.buildNextChunk(lod);
      if (level.nextChunk >= spec.columns * spec.rows) {
        level.ready = true;
        this.buildQueue.shift();
        this.activateBestReadyLevel();
      }
      this.scheduleBuild();
    };
    this.idleHandle = window.setTimeout(run, 16);
  }

  private activateBestReadyLevel(): void {
    const regionalReady = this.levels.get('regional')!.ready;
    const detailReady = this.levels.get('detail')!.ready;
    const nextLod = this.desiredLod === 'detail' && detailReady
      ? 'detail'
      : this.desiredLod !== 'overview' && regionalReady ? 'regional' : 'overview';
    if (nextLod === this.activeLod) return;
    for (const [lod, level] of this.levels) level.group.visible = lod === nextLod;
    this.activeLod = nextLod;
  }
}
