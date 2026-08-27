import * as THREE from 'three/webgpu';
import { smoothstep, uniform, uv } from 'three/tsl';

export type RouteMaterialLayer = 'halo' | 'dash' | 'pulse';

export class RouteMaterial extends THREE.Line2NodeMaterial {
  private readonly colorNodeUniform = uniform(new THREE.Color('#29e6e6'));
  private readonly highlightNodeUniform = uniform(new THREE.Color('#eaffff'));
  private readonly opacityUniform = uniform(0.9);
  private readonly interactionUniform = uniform(1);
  private readonly dashSizeUniform = uniform(0.48);
  private readonly gapSizeUniform = uniform(0.34);
  private readonly offsetUniform = uniform(0);
  private interactionTarget = 1;

  public constructor(private readonly layer: RouteMaterialLayer) {
    super({
      dashed: true,
      linewidth: 2.6,
      transparent: true,
      blending: layer === 'dash' ? THREE.NormalBlending : THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      alphaToCoverage: layer !== 'halo',
    });
    this.worldUnits = false;
    this.dashed = true;
    this.dashSizeNode = this.dashSizeUniform;
    this.gapSizeNode = this.gapSizeUniform;
    this.offsetNode = this.offsetUniform;

    const across = uv().x.abs();
    const softEdge = smoothstep(0.08, 1, across).oneMinus();
    const centerLight = smoothstep(0.02, 0.7, across).oneMinus();

    if (layer === 'halo') {
      this.colorNode = this.colorNodeUniform.mul(centerLight.mul(0.16).add(0.84));
      this.opacityNode = this.opacityUniform
        .mul(this.interactionUniform)
        .mul(softEdge.mul(softEdge))
        .clamp(0, 1);
    } else if (layer === 'pulse') {
      this.colorNode = this.highlightNodeUniform;
      this.opacityNode = this.opacityUniform
        .mul(this.interactionUniform)
        .mul(softEdge)
        .clamp(0, 1);
    } else {
      this.colorNode = this.colorNodeUniform
        .mul(centerLight.mul(0.12).add(0.88))
        .add(this.highlightNodeUniform.mul(centerLight.mul(0.08)));
      this.opacityNode = this.opacityUniform
        .mul(this.interactionUniform)
        .mul(softEdge)
        .clamp(0, 1);
    }
  }

  public setStyle(options: {
    color: string;
    highlightColor: string;
    opacity: number;
    width: number;
    glowRange: number;
    glowStrength: number;
    roundness: number;
  }): void {
    this.colorNodeUniform.value.set(options.color);
    this.highlightNodeUniform.value.set(options.highlightColor);

    if (this.layer === 'halo') {
      this.opacityUniform.value = options.opacity
        * (0.14 + THREE.MathUtils.clamp(options.glowStrength, 0, 2) * 0.16);
      this.linewidth = options.width + Math.max(4, options.glowRange);
    } else if (this.layer === 'pulse') {
      this.opacityUniform.value = Math.min(1, options.opacity * 0.98);
      this.linewidth = Math.max(1.1, options.width * 0.42);
    } else {
      this.opacityUniform.value = Math.min(1, options.opacity * 0.96);
      this.linewidth = options.width;
    }
    this.alphaToCoverage = this.layer !== 'halo' && options.roundness > 0.1;
  }

  public setInteraction(selected: boolean, dimmed: boolean): void {
    this.interactionTarget = dimmed ? 0.16 : selected ? 1.12 : 1;
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    speed: number,
    direction: number,
    dashLength: number,
    gapLength: number,
  ): void {
    const response = 1 - Math.exp(-Math.min(deltaSeconds, 0.1) * 12);
    this.interactionUniform.value = THREE.MathUtils.lerp(
      this.interactionUniform.value,
      this.interactionTarget,
      response,
    );

    const safeDash = Math.max(0.04, dashLength);
    const safeGap = Math.max(0.04, gapLength);
    const period = safeDash + safeGap;
    if (this.layer === 'pulse') {
      const pulseLength = THREE.MathUtils.clamp(safeDash * 0.24, 0.055, period * 0.34);
      this.dashSizeUniform.value = pulseLength;
      this.gapSizeUniform.value = Math.max(0.04, period - pulseLength);
    } else {
      this.dashSizeUniform.value = safeDash;
      this.gapSizeUniform.value = safeGap;
    }
    this.offsetUniform.value = elapsedSeconds * speed * direction;
  }
}
