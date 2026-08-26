import * as THREE from 'three/webgpu';
import type { SceneManifest } from '../types/scene';
import type {
  TerrainReliefTileRequest,
  TerrainReliefTileResponse,
} from './TerrainReliefTileWorkerProtocol';

const LOAD_CONCURRENCY = 3;
const SELECTION_INTERVAL_SECONDS = 0.12;
const FADE_DURATION_SECONDS = 0.38;
const ACTIVE_DISTANCE = 92;

interface TileRecord {
  key: string;
  x: number;
  y: number;
  slot: number;
  requestId: number;
  lastUsed: number;
  fade: number;
  ready: boolean;
}

interface PendingRequest {
  tile: TileRecord;
}

export interface TerrainReliefTileTextures {
  pages: THREE.DataTexture;
  tiles: THREE.DataArrayTexture;
  columns: number;
  rows: number;
  tileSize: number;
  gutter: number;
}

export class TerrainReliefTileCache {
  public readonly textures: TerrainReliefTileTextures;
  private readonly worker = new Worker(
    new URL('./TerrainReliefTileWorker.ts', import.meta.url),
    { type: 'module', name: 'terrain-relief-tiles' },
  );
  private readonly pagePixels: Uint8Array;
  private readonly tilePixels: Uint8Array;
  private readonly records = new Map<string, TileRecord>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly wanted = new Set<string>();
  private readonly freeSlots: number[];
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly raycaster = new THREE.Raycaster();
  private readonly intersection = new THREE.Vector3();
  private readonly sourcePoint = new THREE.Vector2();
  private readonly centerUv = new THREE.Vector2();
  private requestId = 0;
  private frame = 0;
  private selectionElapsed = Number.POSITIVE_INFINITY;
  private disposed = false;

  public constructor(private readonly manifest: SceneManifest) {
    const config = manifest.terrain.reliefTiles;
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
    const mobileBudget = window.innerWidth <= 640 || deviceMemory <= 4 ? 24 : config.maxResidentTiles;
    const residentTiles = Math.min(config.maxResidentTiles, mobileBudget, 254);
    const assetSize = config.tileSize + config.gutter * 2;
    this.pagePixels = new Uint8Array(config.columns * config.rows * 4);
    this.tilePixels = new Uint8Array(assetSize * assetSize * 4 * residentTiles);

    const pages = new THREE.DataTexture(
      this.pagePixels,
      config.columns,
      config.rows,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    pages.name = 'TerrainReliefPageTable';
    pages.colorSpace = THREE.NoColorSpace;
    pages.wrapS = THREE.ClampToEdgeWrapping;
    pages.wrapT = THREE.ClampToEdgeWrapping;
    pages.minFilter = THREE.NearestFilter;
    pages.magFilter = THREE.NearestFilter;
    pages.generateMipmaps = false;
    pages.needsUpdate = true;

    const tiles = new THREE.DataArrayTexture(this.tilePixels, assetSize, assetSize, residentTiles);
    tiles.name = 'TerrainReliefTileArray';
    tiles.format = THREE.RGBAFormat;
    tiles.type = THREE.UnsignedByteType;
    tiles.colorSpace = THREE.NoColorSpace;
    tiles.wrapS = THREE.ClampToEdgeWrapping;
    tiles.wrapT = THREE.ClampToEdgeWrapping;
    tiles.minFilter = THREE.LinearFilter;
    tiles.magFilter = THREE.LinearFilter;
    tiles.generateMipmaps = false;
    tiles.needsUpdate = true;

    this.textures = {
      pages,
      tiles,
      columns: config.columns,
      rows: config.rows,
      tileSize: config.tileSize,
      gutter: config.gutter,
    };
    this.freeSlots = Array.from({ length: residentTiles }, (_, index) => residentTiles - index - 1);
    this.worker.onmessage = this.onWorkerMessage;
    this.worker.onerror = (event): void => console.error('Terrain relief tile worker failed.', event.message);
  }

  public update(
    camera: THREE.PerspectiveCamera,
    target: THREE.Vector3,
    cameraDistance: number,
    deltaSeconds: number,
  ): void {
    if (this.disposed) return;
    this.frame += 1;
    this.advanceFades(deltaSeconds);
    this.selectionElapsed += deltaSeconds;
    if (this.selectionElapsed < SELECTION_INTERVAL_SECONDS) return;
    this.selectionElapsed = 0;
    this.selectTiles(camera, target, cameraDistance);
    this.pumpLoads();
  }

  public getResidentCount(): number {
    let count = 0;
    for (const record of this.records.values()) if (record.ready) count += 1;
    return count;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.records.clear();
    this.pending.clear();
    this.wanted.clear();
    this.textures.pages.dispose();
    this.textures.tiles.dispose();
  }

  private selectTiles(
    camera: THREE.PerspectiveCamera,
    target: THREE.Vector3,
    cameraDistance: number,
  ): void {
    this.wanted.clear();
    if (cameraDistance >= ACTIVE_DISTANCE) return;
    const config = this.manifest.terrain.reliefTiles;
    const bounds = this.visibleUvBounds(camera, target);
    const paddingX = 1 / config.columns;
    const paddingY = 1 / config.rows;
    bounds.min.x = THREE.MathUtils.clamp(bounds.min.x - paddingX, 0, 1);
    bounds.max.x = THREE.MathUtils.clamp(bounds.max.x + paddingX, 0, 1);
    bounds.min.y = THREE.MathUtils.clamp(bounds.min.y - paddingY, 0, 1);
    bounds.max.y = THREE.MathUtils.clamp(bounds.max.y + paddingY, 0, 1);

    const minX = Math.max(0, Math.floor(bounds.min.x * config.columns));
    const maxX = Math.min(config.columns - 1, Math.floor(bounds.max.x * config.columns));
    const minY = Math.max(0, Math.floor(bounds.min.y * config.rows));
    const maxY = Math.min(config.rows - 1, Math.floor(bounds.max.y * config.rows));
    this.centerUv.set(
      THREE.MathUtils.clamp(target.x / this.manifest.terrain.sceneWidth + 0.5, 0, 1),
      THREE.MathUtils.clamp(target.z / this.manifest.terrain.sceneDepth + 0.5, 0, 1),
    );
    const candidates: Array<{ x: number; y: number; distance: number }> = [];
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const du = (x + 0.5) / config.columns - this.centerUv.x;
        const dv = (y + 0.5) / config.rows - this.centerUv.y;
        candidates.push({ x, y, distance: du * du + dv * dv });
      }
    }
    candidates.sort((left, right) => left.distance - right.distance);
    for (const candidate of candidates.slice(0, this.freeSlots.length + this.records.size)) {
      const key = `${candidate.x},${candidate.y}`;
      this.wanted.add(key);
      const record = this.records.get(key);
      if (record) record.lastUsed = this.frame;
    }
  }

  private visibleUvBounds(camera: THREE.PerspectiveCamera, target: THREE.Vector3): THREE.Box2 {
    const meta = this.manifest.terrain;
    const bounds = new THREE.Box2();
    const ndcPoints = [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0], [0, 0], [1, 0],
      [-1, 1], [0, 1], [1, 1],
    ] as const;
    for (const [x, y] of ndcPoints) {
      this.sourcePoint.set(x, y);
      this.raycaster.setFromCamera(this.sourcePoint, camera);
      const point = this.raycaster.ray.intersectPlane(this.plane, this.intersection);
      if (!point) continue;
      bounds.expandByPoint(new THREE.Vector2(
        point.x / meta.sceneWidth + 0.5,
        point.z / meta.sceneDepth + 0.5,
      ));
    }
    const targetUv = new THREE.Vector2(
      target.x / meta.sceneWidth + 0.5,
      target.z / meta.sceneDepth + 0.5,
    );
    bounds.expandByPoint(targetUv);
    if (bounds.isEmpty()) bounds.setFromCenterAndSize(targetUv, new THREE.Vector2(0.25, 0.25));
    return bounds;
  }

  private pumpLoads(): void {
    if (this.pending.size >= LOAD_CONCURRENCY) return;
    const missing = [...this.wanted]
      .filter((key) => !this.records.has(key))
      .sort((left, right) => this.tileDistance(left) - this.tileDistance(right));
    while (this.pending.size < LOAD_CONCURRENCY && missing.length > 0) {
      const key = missing.shift()!;
      const [x, y] = key.split(',').map(Number);
      const slot = this.acquireSlot();
      if (slot === undefined) return;
      const requestId = ++this.requestId;
      const tile: TileRecord = {
        key,
        x,
        y,
        slot,
        requestId,
        lastUsed: this.frame,
        fade: 0,
        ready: false,
      };
      this.records.set(key, tile);
      this.pending.set(requestId, { tile });
      const request: TerrainReliefTileRequest = {
        id: requestId,
        url: this.tileUrl(x, y),
        expectedSize: this.manifest.terrain.reliefTiles.tileSize
          + this.manifest.terrain.reliefTiles.gutter * 2,
      };
      this.worker.postMessage(request);
    }
  }

  private acquireSlot(): number | undefined {
    const free = this.freeSlots.pop();
    if (free !== undefined) return free;
    const evictable = [...this.records.values()]
      .filter((tile) => tile.ready && !this.wanted.has(tile.key))
      .sort((left, right) => left.lastUsed - right.lastUsed)[0];
    if (!evictable) return undefined;
    this.clearPage(evictable);
    this.records.delete(evictable.key);
    return evictable.slot;
  }

  private readonly onWorkerMessage = (event: MessageEvent<TerrainReliefTileResponse>): void => {
    const pending = this.pending.get(event.data.id);
    if (!pending) return;
    this.pending.delete(event.data.id);
    const { tile } = pending;
    if ('error' in event.data) {
      console.warn(`Terrain relief tile ${tile.key} failed: ${event.data.error}`);
      this.records.delete(tile.key);
      this.freeSlots.push(tile.slot);
      this.pumpLoads();
      return;
    }
    if (!this.wanted.has(tile.key)) {
      this.records.delete(tile.key);
      this.freeSlots.push(tile.slot);
      this.pumpLoads();
      return;
    }
    const pixels = new Uint8Array(event.data.pixels);
    const layerSize = pixels.length;
    this.tilePixels.set(pixels, tile.slot * layerSize);
    this.textures.tiles.addLayerUpdate(tile.slot);
    this.textures.tiles.needsUpdate = true;
    tile.ready = true;
    tile.fade = 0;
    this.writePage(tile);
    this.pumpLoads();
  };

  private advanceFades(deltaSeconds: number): void {
    let changed = false;
    for (const tile of this.records.values()) {
      if (!tile.ready || tile.fade >= 1) continue;
      tile.fade = Math.min(1, tile.fade + deltaSeconds / FADE_DURATION_SECONDS);
      this.writePage(tile, false);
      changed = true;
    }
    if (changed) this.textures.pages.needsUpdate = true;
  }

  private writePage(tile: TileRecord, update = true): void {
    const config = this.manifest.terrain.reliefTiles;
    const targetY = config.rows - tile.y - 1;
    const offset = (targetY * config.columns + tile.x) * 4;
    this.pagePixels[offset] = tile.slot;
    this.pagePixels[offset + 1] = Math.round(THREE.MathUtils.smoothstep(tile.fade, 0, 1) * 255);
    this.pagePixels[offset + 2] = 255;
    this.pagePixels[offset + 3] = 255;
    if (update) this.textures.pages.needsUpdate = true;
  }

  private clearPage(tile: TileRecord): void {
    const config = this.manifest.terrain.reliefTiles;
    const targetY = config.rows - tile.y - 1;
    const offset = (targetY * config.columns + tile.x) * 4;
    this.pagePixels.fill(0, offset, offset + 4);
    this.textures.pages.needsUpdate = true;
  }

  private tileDistance(key: string): number {
    const [x, y] = key.split(',').map(Number);
    const config = this.manifest.terrain.reliefTiles;
    const du = (x + 0.5) / config.columns - this.centerUv.x;
    const dv = (y + 0.5) / config.rows - this.centerUv.y;
    return du * du + dv * dv;
  }

  private tileUrl(x: number, y: number): string {
    const config = this.manifest.terrain.reliefTiles;
    const path = config.urlTemplate.replace('{x}', String(x)).replace('{y}', String(y));
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}v=${encodeURIComponent(`${this.manifest.version}-${this.manifest.generatedAt}`)}`;
  }
}
