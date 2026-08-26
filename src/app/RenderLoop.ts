import type * as THREE from 'three/webgpu';

export class RenderLoop {
  private frameId = 0;
  private previousTime = 0;
  private running = false;

  public constructor(
    private readonly frame: (deltaSeconds: number, elapsedSeconds: number) => void,
    private readonly renderer?: THREE.WebGPURenderer,
  ) {}

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.previousTime = performance.now();
    if (this.renderer) this.renderer.setAnimationLoop(this.tick);
    else this.frameId = requestAnimationFrame(this.tick);
  }

  public stop(): void {
    this.running = false;
    if (this.renderer) this.renderer.setAnimationLoop(null);
    else cancelAnimationFrame(this.frameId);
  }

  private readonly tick = (time: number): void => {
    if (!this.running) return;
    const deltaSeconds = Math.min((time - this.previousTime) / 1000, 0.1);
    this.previousTime = time;
    this.frame(deltaSeconds, time / 1000);
    if (!this.renderer) this.frameId = requestAnimationFrame(this.tick);
  };
}
