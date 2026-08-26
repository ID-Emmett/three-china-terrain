import * as THREE from 'three/webgpu';
import type { SceneLayer } from '../app/SceneLayer';
import type { TerrainData, TerrainValidationReport } from './TerrainData';
import { createTerrainDetailTexture } from './TerrainDetailTexture';
import { TerrainGeometryBuilder } from './TerrainGeometryBuilder';
import { TerrainMaterial } from './TerrainMaterial';
import type { TerrainReliefTileTextures } from './TerrainReliefTileCache';
import {
  applyTerrainSurfaceBundle,
  createTerrainSurfaceTexture,
} from './TerrainSurfaceTexture';

type TerrainGeometryLod = 'overview' | 'regional' | 'detail';

interface TerrainLodSpec {
  step: number;
  columns: number;
  rows: number;
  morphStep?: number;
}

interface TerrainLodLevel {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  ready: boolean;
  building?: Promise<void>;
}

interface TerrainTransition {
  from: TerrainGeometryLod;
  to: TerrainGeometryLod;
  direction: 'refine' | 'coarsen';
  elapsed: number;
}

const LOD_ORDER: TerrainGeometryLod[] = ['overview', 'regional', 'detail'];
const LOD_SPECS: Record<TerrainGeometryLod, TerrainLodSpec> = {
  overview: { step: 4, columns: 4, rows: 3 },
  regional: { step: 2, columns: 6, rows: 4, morphStep: 4 },
  detail: { step: 1, columns: 8, rows: 6, morphStep: 2 },
};

const REGIONAL_ENTER_DISTANCE = 84;
const REGIONAL_EXIT_DISTANCE = 94;
const DETAIL_ENTER_DISTANCE = 26;
const DETAIL_EXIT_DISTANCE = 34;
const MORPH_DURATION_SECONDS = 0.36;
const SKIRT_DEPTH_METERS = 900;
const CHUNK_ALIGNMENT = 4;

export class TerrainLayer implements SceneLayer {
  public readonly object3d = new THREE.Group();
  public readonly material: TerrainMaterial;
  private readonly levels = new Map<TerrainGeometryLod, TerrainLodLevel>();
  private readonly geometryBuilder: TerrainGeometryBuilder;
  private activeLod: TerrainGeometryLod = 'overview';
  private desiredLod: TerrainGeometryLod = 'overview';
  private transition?: TerrainTransition;
  private disposed = false;

  public constructor(
    private readonly data: TerrainData,
    terrainSurface: Promise<ArrayBuffer>,
    coastMask: THREE.Texture,
    chinaMask: THREE.Texture,
    reliefTexture: THREE.Texture,
    reliefTiles: TerrainReliefTileTextures,
    terrainImagery: THREE.Texture,
  ) {
    this.object3d.name = 'TerrainLayer';
    const surfaceTexture = createTerrainSurfaceTexture(data.renderWidth, data.renderHeight);
    const detailTexture = createTerrainDetailTexture(128);
    this.material = new TerrainMaterial(
      coastMask,
      chinaMask,
      surfaceTexture,
      detailTexture,
      reliefTexture,
      reliefTiles,
      terrainImagery,
      data.meta.minimumElevationMeters,
      data.meta.maximumElevationMeters,
    );
    void terrainSurface.then((bundle) => {
      if (!this.disposed) applyTerrainSurfaceBundle(surfaceTexture, bundle);
    }).catch((error: unknown) => {
      console.error('Terrain derived surface generation failed; using the lightweight fallback material.', error);
    });
    this.geometryBuilder = new TerrainGeometryBuilder(data.createWorkerSource());

    for (const lod of LOD_ORDER) {
      const group = new THREE.Group();
      group.name = `${lod}TerrainChunks`;
      group.visible = false;
      this.levels.set(lod, { group, meshes: [], ready: false });
      this.object3d.add(group);
    }
  }

  public async initialize(): Promise<void> {
    await this.ensureLevel('overview');
    if (this.disposed) return;
    this.levels.get('overview')!.group.visible = true;
    this.material.setMorph(1);
    void this.ensureLevel('regional').catch(this.reportBuildError);
  }

  public update(cameraDistance: number, deltaSeconds: number): void {
    this.updateDesiredLod(cameraDistance);
    if (this.desiredLod === 'regional') {
      void this.ensureLevel('regional').catch(this.reportBuildError);
    } else if (this.desiredLod === 'detail') {
      void this.ensureLevel('regional')
        .then(() => this.ensureLevel('detail'))
        .catch(this.reportBuildError);
    }
    if (this.transition) {
      this.advanceTransition(deltaSeconds);
      return;
    }
    this.startNextTransition();
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
    this.geometryBuilder.dispose();
    for (const level of this.levels.values()) {
      for (const mesh of level.meshes) mesh.geometry.dispose();
    }
    this.levels.clear();
    this.material.dispose();
  }

  private async ensureLevel(lod: TerrainGeometryLod): Promise<void> {
    const level = this.levels.get(lod)!;
    if (level.ready) return;
    if (level.building) return level.building;
    level.building = this.buildLevel(lod);
    try {
      await level.building;
      level.ready = true;
    } finally {
      level.building = undefined;
    }
  }

  private async buildLevel(lod: TerrainGeometryLod): Promise<void> {
    const spec = LOD_SPECS[lod];
    const columnBounds = alignedChunkBounds(this.data.renderWidth - 1, spec.columns);
    const rowBounds = alignedChunkBounds(this.data.renderHeight - 1, spec.rows);
    const level = this.levels.get(lod)!;
    const builds: Array<Promise<THREE.BufferGeometry>> = [];
    for (let row = 0; row < spec.rows; row += 1) {
      for (let column = 0; column < spec.columns; column += 1) {
        builds.push(this.geometryBuilder.build({
          columnStart: columnBounds[column],
          columnEnd: columnBounds[column + 1],
          rowStart: rowBounds[row],
          rowEnd: rowBounds[row + 1],
          step: spec.step,
          morphStep: spec.morphStep,
          skirtDepthMeters: SKIRT_DEPTH_METERS,
        }));
      }
    }
    const geometries = await Promise.all(builds);
    if (this.disposed) {
      for (const geometry of geometries) geometry.dispose();
      return;
    }
    geometries.forEach((geometry, index) => {
      if (geometry.getAttribute('position').count === 0) {
        geometry.dispose();
        return;
      }
      const column = index % spec.columns;
      const row = Math.floor(index / spec.columns);
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.name = `${lod}Terrain:${column},${row}`;
      mesh.frustumCulled = true;
      mesh.renderOrder = 0;
      level.meshes.push(mesh);
      level.group.add(mesh);
    });
  }

  private updateDesiredLod(cameraDistance: number): void {
    if (this.desiredLod === 'overview') {
      if (cameraDistance < REGIONAL_ENTER_DISTANCE) this.desiredLod = 'regional';
      return;
    }
    if (this.desiredLod === 'regional') {
      if (cameraDistance > REGIONAL_EXIT_DISTANCE) this.desiredLod = 'overview';
      else if (cameraDistance < DETAIL_ENTER_DISTANCE) this.desiredLod = 'detail';
      return;
    }
    if (cameraDistance > DETAIL_EXIT_DISTANCE) this.desiredLod = 'regional';
  }

  private startNextTransition(): void {
    const activeIndex = LOD_ORDER.indexOf(this.activeLod);
    const desiredIndex = LOD_ORDER.indexOf(this.desiredLod);
    if (activeIndex === desiredIndex) return;
    const targetIndex = activeIndex + Math.sign(desiredIndex - activeIndex);
    const target = LOD_ORDER[targetIndex];
    if (!this.levels.get(target)!.ready) return;
    const direction = targetIndex > activeIndex ? 'refine' : 'coarsen';
    this.transition = { from: this.activeLod, to: target, direction, elapsed: 0 };
    if (direction === 'refine') {
      this.levels.get(this.activeLod)!.group.visible = false;
      this.levels.get(target)!.group.visible = true;
      this.activeLod = target;
      this.material.setMorph(0);
    } else {
      this.material.setMorph(1);
    }
  }

  private advanceTransition(deltaSeconds: number): void {
    const transition = this.transition!;
    transition.elapsed += Math.min(deltaSeconds, 0.1);
    const linearProgress = THREE.MathUtils.clamp(transition.elapsed / MORPH_DURATION_SECONDS, 0, 1);
    const eased = THREE.MathUtils.smoothstep(linearProgress, 0, 1);
    this.material.setMorph(transition.direction === 'refine' ? eased : 1 - eased);
    if (linearProgress < 1) return;

    if (transition.direction === 'coarsen') {
      this.levels.get(transition.from)!.group.visible = false;
      this.levels.get(transition.to)!.group.visible = true;
      this.activeLod = transition.to;
    }
    this.material.setMorph(1);
    this.transition = undefined;
    this.startNextTransition();
  }

  private readonly reportBuildError = (error: unknown): void => {
    console.error('Terrain LOD build failed.', error);
  };
}

function alignedChunkBounds(cellCount: number, divisions: number): number[] {
  const output = [0];
  for (let division = 1; division < divisions; division += 1) {
    const ideal = division * cellCount / divisions;
    const aligned = Math.round(ideal / CHUNK_ALIGNMENT) * CHUNK_ALIGNMENT;
    output.push(THREE.MathUtils.clamp(aligned, output[output.length - 1] + CHUNK_ALIGNMENT, cellCount - 1));
  }
  output.push(cellCount);
  return output;
}
