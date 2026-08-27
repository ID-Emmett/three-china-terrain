import * as THREE from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { ReliefTileLevel, SceneManifest } from '../types/scene';
import type {
  TerrainReliefTileRequest,
  TerrainReliefTileResponse,
  TerrainReliefTileWorkerMessage,
} from './TerrainReliefTileWorkerProtocol';

const LOAD_CONCURRENCY = 3;
const SELECTION_INTERVAL_SECONDS = 0.12;
const FADE_DURATION_SECONDS = 0.38;
const COARSE_ACTIVE_DISTANCE = 110;
const FINE_ACTIVE_DISTANCE = 82;
const TRANSCODER_PATH = '/vendor/basis/';

export type TerrainReliefTileLevelId = 'coarse' | 'fine';

export interface TerrainReliefTileLevelTextures {
  pages: THREE.DataTexture;
  tiles: THREE.DataArrayTexture | THREE.CompressedArrayTexture;
  columns: number;
  rows: number;
  tileSize: number;
  gutter: number;
  compressed: boolean;
}

export interface TerrainReliefTileTextures {
  coarse: TerrainReliefTileLevelTextures;
  fine: TerrainReliefTileLevelTextures;
}

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

interface LevelState {
  id: TerrainReliefTileLevelId;
  config: ReliefTileLevel;
  textures: TerrainReliefTileLevelTextures;
  pagePixels: Uint8Array;
  tilePixels: Uint8Array;
  freeSlots: number[];
  records: Map<string, TileRecord>;
  wanted: Set<string>;
  compressedCapacity: number;
  mipmaps?: Array<{ data: Uint8Array; width: number; height: number }>;
}

interface PendingRequest {
  state: LevelState;
  tile: TileRecord;
}

export class TerrainReliefTileCache {
  public readonly textures: TerrainReliefTileTextures;
  private readonly worker = new Worker(
    new URL('./TerrainReliefTileWorker.ts', import.meta.url),
    { type: 'module', name: 'terrain-relief-tiles' },
  );
  private readonly states: Record<TerrainReliefTileLevelId, LevelState>;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly raycaster = new THREE.Raycaster();
  private readonly intersection = new THREE.Vector3();
  private readonly sourcePoint = new THREE.Vector2();
  private readonly centerUv = new THREE.Vector2();
  private ktx2Loader?: KTX2Loader;
  private requestId = 0;
  private frame = 0;
  private selectionElapsed = Number.POSITIVE_INFINITY;
  private disposed = false;
  private useKtx2 = false;

  public constructor(
    private readonly manifest: SceneManifest,
    renderer: THREE.WebGPURenderer,
  ) {
    const config = manifest.terrain.reliefTiles;
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
    const mobile = window.innerWidth <= 640 || deviceMemory <= 4;
    const makeState = (id: TerrainReliefTileLevelId): LevelState => {
      const level = config.levels[id];
      const fallbackCapacity = level.fallbackResidentTiles ?? level.maxResidentTiles;
      const maxResident = id === 'fine' && mobile
        ? Math.min(24, fallbackCapacity)
        : fallbackCapacity;
      const compressedCapacity = id === 'fine' && mobile
        ? Math.min(40, level.maxResidentTiles)
        : level.maxResidentTiles;
      const assetSize = config.tileSize + config.gutter * 2;
      const pagePixels = new Uint8Array(level.columns * level.rows * 4);
      const tilePixels = new Uint8Array(assetSize * assetSize * 4 * maxResident);
      const pages = new THREE.DataTexture(
        pagePixels,
        level.columns,
        level.rows,
        THREE.RGBAFormat,
        THREE.UnsignedByteType,
      );
      pages.name = `TerrainReliefPageTable-${id}`;
      pages.colorSpace = THREE.NoColorSpace;
      pages.wrapS = THREE.ClampToEdgeWrapping;
      pages.wrapT = THREE.ClampToEdgeWrapping;
      pages.minFilter = THREE.NearestFilter;
      pages.magFilter = THREE.NearestFilter;
      pages.generateMipmaps = false;
      pages.needsUpdate = true;
      const tiles = new THREE.DataArrayTexture(tilePixels, assetSize, assetSize, maxResident);
      tiles.name = `TerrainReliefTileArray-${id}`;
      tiles.format = THREE.RGBAFormat;
      tiles.type = THREE.UnsignedByteType;
      tiles.colorSpace = THREE.NoColorSpace;
      tiles.wrapS = THREE.ClampToEdgeWrapping;
      tiles.wrapT = THREE.ClampToEdgeWrapping;
      tiles.minFilter = THREE.LinearFilter;
      tiles.magFilter = THREE.LinearFilter;
      tiles.generateMipmaps = false;
      tiles.needsUpdate = true;
      return {
        id,
        config: level,
        textures: {
          pages,
          tiles,
          columns: level.columns,
          rows: level.rows,
          tileSize: config.tileSize,
          gutter: config.gutter,
          compressed: false,
        },
        pagePixels,
        tilePixels,
        freeSlots: Array.from({ length: maxResident }, (_, index) => maxResident - index - 1),
        records: new Map(),
        wanted: new Set(),
        compressedCapacity,
      };
    };
    this.states = { coarse: makeState('coarse'), fine: makeState('fine') };
    this.textures = {
      coarse: this.states.coarse.textures,
      fine: this.states.fine.textures,
    };

    if (config.levels.coarse.ktx2UrlTemplate && config.levels.fine.ktx2UrlTemplate) {
      try {
        const loader = new KTX2Loader();
        loader.setTranscoderPath(TRANSCODER_PATH);
        loader.detectSupport(renderer);
        this.ktx2Loader = loader;
      } catch (error) {
        console.warn('KTX2 support detection failed; using WebP relief tiles.', error);
      }
    }
    this.worker.onmessage = this.onWorkerMessage;
    this.worker.onerror = (event): void => console.error('Terrain relief tile worker failed.', event.message);
  }

  /** Resolves the compressed format once, before TerrainMaterial captures texture bindings. */
  public async initialize(): Promise<void> {
    if (!this.ktx2Loader) return;
    try {
      const probe = await this.fetchKtx2(this.states.coarse, 0, 0);
      // KTX2Loader can legally return an RGBA32 transcoding fallback when the
      // adapter exposes no block-compression feature. That path would still be
      // represented as CompressedTexture, but cannot be stored in a compressed
      // array texture, so keep the reliable WebP decoder in that case.
      if ((probe.format as number) === THREE.RGBAFormat || (probe.format as number) === THREE.RGBFormat) {
        probe.dispose();
        throw new Error('GPU block compression is unavailable.');
      }
      this.createCompressedArrays(probe);
      probe.dispose();
      this.useKtx2 = true;
    } catch (error) {
      console.warn('KTX2 tile probe failed; using WebP relief tiles.', error);
      this.ktx2Loader.dispose();
      this.ktx2Loader = undefined;
    }
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
    this.selectTiles(this.states.coarse, camera, target, cameraDistance, COARSE_ACTIVE_DISTANCE);
    this.selectTiles(this.states.fine, camera, target, cameraDistance, FINE_ACTIVE_DISTANCE);
    this.cancelStaleRequests();
    this.evictStaleTiles(this.states.coarse);
    this.evictStaleTiles(this.states.fine);
    this.pumpLoads();
  }

  public getResidentCount(): number {
    let count = 0;
    for (const state of Object.values(this.states)) {
      for (const record of state.records.values()) if (record.ready) count += 1;
    }
    return count;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.pending.keys()) this.worker.postMessage({ type: 'cancel', id } satisfies TerrainReliefTileWorkerMessage);
    this.worker.terminate();
    this.ktx2Loader?.dispose();
    for (const state of Object.values(this.states)) {
      state.records.clear();
      state.wanted.clear();
      state.textures.pages.dispose();
      state.textures.tiles.dispose();
    }
    this.pending.clear();
  }

  private selectTiles(
    state: LevelState,
    camera: THREE.PerspectiveCamera,
    target: THREE.Vector3,
    cameraDistance: number,
    activeDistance: number,
  ): void {
    state.wanted.clear();
    if (cameraDistance >= activeDistance) return;
    const bounds = this.visibleUvBounds(camera, target);
    const paddingX = 1 / state.config.columns;
    const paddingY = 1 / state.config.rows;
    bounds.min.x = THREE.MathUtils.clamp(bounds.min.x - paddingX, 0, 1);
    bounds.max.x = THREE.MathUtils.clamp(bounds.max.x + paddingX, 0, 1);
    bounds.min.y = THREE.MathUtils.clamp(bounds.min.y - paddingY, 0, 1);
    bounds.max.y = THREE.MathUtils.clamp(bounds.max.y + paddingY, 0, 1);
    const minX = Math.max(0, Math.floor(bounds.min.x * state.config.columns));
    const maxX = Math.min(state.config.columns - 1, Math.floor(bounds.max.x * state.config.columns));
    const minY = Math.max(0, Math.floor(bounds.min.y * state.config.rows));
    const maxY = Math.min(state.config.rows - 1, Math.floor(bounds.max.y * state.config.rows));
    this.centerUv.set(
      THREE.MathUtils.clamp(target.x / this.manifest.terrain.sceneWidth + 0.5, 0, 1),
      THREE.MathUtils.clamp(target.z / this.manifest.terrain.sceneDepth + 0.5, 0, 1),
    );
    const candidates: Array<{ x: number; y: number; distance: number }> = [];
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const du = (x + 0.5) / state.config.columns - this.centerUv.x;
        const dv = (y + 0.5) / state.config.rows - this.centerUv.y;
        candidates.push({ x, y, distance: du * du + dv * dv });
      }
    }
    candidates.sort((left, right) => left.distance - right.distance);
    for (const candidate of candidates.slice(0, state.freeSlots.length + state.records.size)) {
      const key = `${candidate.x},${candidate.y}`;
      state.wanted.add(key);
      const record = state.records.get(key);
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

  private cancelStaleRequests(): void {
    for (const [id, pending] of this.pending) {
      if (pending.state.wanted.has(pending.tile.key)) continue;
      this.pending.delete(id);
      this.worker.postMessage({ type: 'cancel', id } satisfies TerrainReliefTileWorkerMessage);
      this.releaseTile(pending.state, pending.tile);
    }
  }

  private evictStaleTiles(state: LevelState): void {
    for (const tile of [...state.records.values()]) {
      if (!tile.ready || state.wanted.has(tile.key)) continue;
      this.clearPage(state, tile);
      this.releaseTile(state, tile);
    }
  }

  private pumpLoads(): void {
    if (this.pending.size >= LOAD_CONCURRENCY) return;
    const missing: Array<{ state: LevelState; key: string; priority: number }> = [];
    for (const state of Object.values(this.states)) {
      for (const key of state.wanted) {
        if (!state.records.has(key)) missing.push({ state, key, priority: state.id === 'coarse' ? 0 : 1 });
      }
    }
    missing.sort((left, right) => left.priority - right.priority || this.tileDistance(left.state, left.key) - this.tileDistance(right.state, right.key));
    while (this.pending.size < LOAD_CONCURRENCY && missing.length > 0) {
      const next = missing.shift()!;
      const slot = this.acquireSlot(next.state);
      if (slot === undefined) return;
      const [x, y] = next.key.split(',').map(Number);
      const requestId = ++this.requestId;
      const tile: TileRecord = {
        key: next.key,
        x,
        y,
        slot,
        requestId,
        lastUsed: this.frame,
        fade: 0,
        ready: false,
      };
      next.state.records.set(next.key, tile);
      this.pending.set(requestId, { state: next.state, tile });
      const request: TerrainReliefTileRequest = {
        type: 'load',
        id: requestId,
        url: this.tileUrl(next.state, x, y),
        expectedSize: this.manifest.terrain.reliefTiles.tileSize + this.manifest.terrain.reliefTiles.gutter * 2,
        format: this.useKtx2 ? 'ktx2' : 'webp',
      };
      this.worker.postMessage(request);
    }
  }

  private acquireSlot(state: LevelState): number | undefined {
    const free = state.freeSlots.pop();
    if (free !== undefined) return free;
    const evictable = [...state.records.values()]
      .filter((tile) => tile.ready && !state.wanted.has(tile.key))
      .sort((left, right) => left.lastUsed - right.lastUsed)[0];
    if (!evictable) return undefined;
    this.clearPage(state, evictable);
    state.records.delete(evictable.key);
    return evictable.slot;
  }

  private readonly onWorkerMessage = (event: MessageEvent<TerrainReliefTileResponse>): void => {
    const pending = this.pending.get(event.data.id);
    if (!pending) return;
    this.pending.delete(event.data.id);
    if ('error' in event.data) {
      this.releaseTile(pending.state, pending.tile);
      if (event.data.error !== 'aborted') console.warn(`Terrain relief tile ${pending.tile.key} failed: ${event.data.error}`);
      this.pumpLoads();
      return;
    }
    if (this.useKtx2 && 'encoded' in event.data) {
      void this.completeKtx2Tile(pending, event.data.encoded).catch((error: unknown) => {
        console.warn(`Terrain KTX2 tile ${pending.tile.key} failed; keeping fallback.`, error);
        this.releaseTile(pending.state, pending.tile);
        this.pumpLoads();
      });
      return;
    }
    if (!pending.state.wanted.has(pending.tile.key)) {
      this.releaseTile(pending.state, pending.tile);
      this.pumpLoads();
      return;
    }
    if (!('pixels' in event.data)) return;
    this.uploadPixels(pending.state, pending.tile, new Uint8Array(event.data.pixels));
    this.pumpLoads();
  };

  private async completeKtx2Tile(pending: PendingRequest, encoded: ArrayBuffer): Promise<void> {
    if (!pending.state.wanted.has(pending.tile.key)) {
      this.releaseTile(pending.state, pending.tile);
      this.pumpLoads();
      return;
    }
    const texture = await this.parseKtx2(encoded);
    if (!pending.state.wanted.has(pending.tile.key)) {
      texture.dispose();
      this.releaseTile(pending.state, pending.tile);
      this.pumpLoads();
      return;
    }
    const mipmaps = pending.state.mipmaps;
    if (!mipmaps || texture.mipmaps.length !== mipmaps.length) throw new Error('KTX2 mipmap layout mismatch.');
    for (let index = 0; index < mipmaps.length; index += 1) {
      const source = texture.mipmaps[index].data as Uint8Array;
      const target = mipmaps[index].data;
      target.set(source, pending.tile.slot * source.byteLength);
    }
    texture.dispose();
    const tiles = pending.state.textures.tiles as THREE.CompressedArrayTexture;
    tiles.addLayerUpdate(pending.tile.slot);
    tiles.needsUpdate = true;
    pending.tile.ready = true;
    pending.tile.fade = 0;
    this.writePage(pending.state, pending.tile);
    this.pumpLoads();
  }

  private uploadPixels(state: LevelState, tile: TileRecord, pixels: Uint8Array): void {
    const layerSize = pixels.length;
    state.tilePixels.set(pixels, tile.slot * layerSize);
    const tiles = state.textures.tiles as THREE.DataArrayTexture;
    tiles.addLayerUpdate(tile.slot);
    tiles.needsUpdate = true;
    tile.ready = true;
    tile.fade = 0;
    this.writePage(state, tile);
  }

  private releaseTile(state: LevelState, tile: TileRecord): void {
    if (state.records.get(tile.key) !== tile) return;
    state.records.delete(tile.key);
    state.freeSlots.push(tile.slot);
  }

  private advanceFades(deltaSeconds: number): void {
    for (const state of Object.values(this.states)) {
      let changed = false;
      for (const tile of state.records.values()) {
        if (!tile.ready || tile.fade >= 1) continue;
        tile.fade = Math.min(1, tile.fade + deltaSeconds / FADE_DURATION_SECONDS);
        this.writePage(state, tile, false);
        changed = true;
      }
      if (changed) state.textures.pages.needsUpdate = true;
    }
  }

  private writePage(state: LevelState, tile: TileRecord, update = true): void {
    const targetY = state.config.rows - tile.y - 1;
    const offset = (targetY * state.config.columns + tile.x) * 4;
    state.pagePixels[offset] = tile.slot;
    state.pagePixels[offset + 1] = Math.round(THREE.MathUtils.smoothstep(tile.fade, 0, 1) * 255);
    state.pagePixels[offset + 2] = 255;
    state.pagePixels[offset + 3] = 255;
    if (update) state.textures.pages.needsUpdate = true;
  }

  private clearPage(state: LevelState, tile: TileRecord): void {
    const targetY = state.config.rows - tile.y - 1;
    const offset = (targetY * state.config.columns + tile.x) * 4;
    state.pagePixels.fill(0, offset, offset + 4);
    state.textures.pages.needsUpdate = true;
  }

  private tileDistance(state: LevelState, key: string): number {
    const [x, y] = key.split(',').map(Number);
    const du = (x + 0.5) / state.config.columns - this.centerUv.x;
    const dv = (y + 0.5) / state.config.rows - this.centerUv.y;
    return du * du + dv * dv;
  }

  private tileUrl(state: LevelState, x: number, y: number): string {
    const template = this.useKtx2 ? state.config.ktx2UrlTemplate! : state.config.urlTemplate;
    const path = template.replace('{x}', String(x)).replace('{y}', String(y));
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}v=${encodeURIComponent(`${this.manifest.version}-${this.manifest.generatedAt}`)}`;
  }

  private async fetchKtx2(state: LevelState, x: number, y: number): Promise<THREE.CompressedTexture> {
    const template = state.config.ktx2UrlTemplate!;
    const path = template.replace('{x}', String(x)).replace('{y}', String(y));
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetch(`${path}${separator}v=${encodeURIComponent(`${this.manifest.version}-${this.manifest.generatedAt}`)}`, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return this.parseKtx2(await response.arrayBuffer());
  }

  private parseKtx2(buffer: ArrayBuffer): Promise<THREE.CompressedTexture> {
    if (!this.ktx2Loader) return Promise.reject(new Error('KTX2 loader is unavailable.'));
    return new Promise((resolve, reject) => this.ktx2Loader!.parse(buffer, resolve, reject));
  }

  private createCompressedArrays(probe: THREE.CompressedTexture): void {
    const config = this.manifest.terrain.reliefTiles;
    for (const state of Object.values(this.states)) {
      const currentCapacity = state.freeSlots.length + state.records.size;
      for (let slot = currentCapacity; slot < state.compressedCapacity; slot += 1) {
        state.freeSlots.push(slot);
      }
      const depth = state.compressedCapacity;
      const mipmaps = probe.mipmaps.map((mipmap) => ({
        data: new Uint8Array(mipmap.data.byteLength * depth),
        width: mipmap.width,
        height: mipmap.height,
      }));
      const tiles = new THREE.CompressedArrayTexture(
        mipmaps,
        config.tileSize + config.gutter * 2,
        config.tileSize + config.gutter * 2,
        depth,
        probe.format,
        probe.type,
      );
      tiles.name = `TerrainReliefTileArray-${state.id}-KTX2`;
      tiles.colorSpace = THREE.NoColorSpace;
      tiles.wrapS = THREE.ClampToEdgeWrapping;
      tiles.wrapT = THREE.ClampToEdgeWrapping;
      tiles.minFilter = probe.minFilter;
      tiles.magFilter = probe.magFilter;
      tiles.generateMipmaps = false;
      tiles.needsUpdate = true;
      state.mipmaps = mipmaps;
      state.textures.tiles.dispose();
      state.textures.tiles = tiles;
      state.textures.compressed = true;
      // The compressed path never uploads raw RGBA pages; release the fallback
      // staging array so mobile devices do not retain both representations.
      state.tilePixels = new Uint8Array(0);
    }
  }
}
