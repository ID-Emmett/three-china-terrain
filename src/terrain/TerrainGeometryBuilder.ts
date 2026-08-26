import * as THREE from 'three/webgpu';
import type { TerrainGeometryOptions } from './TerrainData';
import type {
  TerrainGeometryWorkerRequest,
  TerrainGeometryWorkerResponse,
  TerrainWorkerSource,
} from './TerrainGeometryWorkerProtocol';

export class TerrainGeometryBuilder {
  private readonly worker = new Worker(
    new URL('./TerrainGeometryWorker.ts', import.meta.url),
    { type: 'module', name: 'terrain-geometry' },
  );
  private readonly pending = new Map<number, {
    resolve: (geometry: THREE.BufferGeometry) => void;
    reject: (error: Error) => void;
  }>();
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private nextRequestId = 1;
  private disposed = false;

  public constructor(source: TerrainWorkerSource) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.onmessage = this.onMessage;
    this.worker.onerror = (event): void => {
      const error = new Error(event.message || 'Terrain geometry worker failed.');
      this.rejectReady(error);
      this.rejectAll(error);
    };
    const request: TerrainGeometryWorkerRequest = { type: 'initialize', source };
    this.worker.postMessage(request);
  }

  public async build(options: TerrainGeometryOptions): Promise<THREE.BufferGeometry> {
    await this.ready;
    if (this.disposed) throw new Error('Terrain geometry builder is disposed.');
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<THREE.BufferGeometry>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const request: TerrainGeometryWorkerRequest = { type: 'build', requestId, options };
      this.worker.postMessage(request);
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.rejectAll(new Error('Terrain geometry builder was disposed.'));
  }

  private readonly onMessage = (event: MessageEvent<TerrainGeometryWorkerResponse>): void => {
    const message = event.data;
    if (message.type === 'initialized') {
      this.resolveReady();
      return;
    }
    if (message.type === 'error') {
      const error = new Error(message.message);
      if (message.requestId === undefined) {
        this.rejectReady(error);
        this.rejectAll(error);
      } else {
        this.pending.get(message.requestId)?.reject(error);
        this.pending.delete(message.requestId);
      }
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(message.buffers.position, 3));
    geometry.setAttribute('aMorphPosition', new THREE.BufferAttribute(message.buffers.morphPosition, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(message.buffers.uv, 2));
    geometry.setIndex(new THREE.BufferAttribute(message.buffers.index, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    pending.resolve(geometry);
    this.pending.delete(message.requestId);
  };

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
