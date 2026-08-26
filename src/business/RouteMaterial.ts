import * as THREE from 'three/webgpu';
import { smoothstep, uniform, uv } from 'three/tsl';

export class RouteMaterial extends THREE.Line2NodeMaterial {
  private readonly glow: boolean;
  private readonly colorNodeUniform = uniform(new THREE.Color('#29e6e6'));
  private readonly opacityUniform = uniform(0.9);
  private readonly dimUniform = uniform(1);
  private readonly dashSizeUniform = uniform(0.82);
  private readonly gapSizeUniform = uniform(0.58);
  private readonly offsetUniform = uniform(0);
  private dimTarget = 1;

  public constructor(glow = false) {
    super({
      dashed: true,
      linewidth: 2.4,
      transparent: true,
      blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      alphaToCoverage: true,
    });
    this.glow = glow;
    this.worldUnits = false;
    this.dashed = true;
    this.dashSizeNode = this.dashSizeUniform;
    this.gapSizeNode = this.gapSizeUniform;
    this.offsetNode = this.offsetUniform;

    const centerLight = smoothstep(0.04, 0.9, uv().x.abs()).oneMinus();
    this.colorNode = this.colorNodeUniform.mul(centerLight.mul(0.22).add(0.78));
    const opacity = this.opacityUniform.mul(this.dimUniform).clamp(0, 1);
    this.opacityNode = this.glow
      ? opacity.mul(smoothstep(0.18, 0.86, uv().x.abs()).oneMinus())
      : opacity;
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
    this.opacityUniform.value = this.glow
      ? options.opacity * (0.12 + Math.min(1, options.glowStrength) * 0.26)
      : options.opacity;
    this.linewidth = this.glow
      ? options.width + Math.max(2.5, options.glowRange)
      : options.width;
    this.alphaToCoverage = !this.glow && options.roundness > 0.1;
  }

  public setInteraction(_selected: boolean, dimmed: boolean): void {
    this.dimTarget = dimmed ? 0.34 : 1;
  }

  public update(
    deltaSeconds: number,
    elapsedSeconds: number,
    speed: number,
    direction: number,
    dashLength: number,
    gapLength: number,
  ): void {
    const response = 1 - Math.exp(-Math.min(deltaSeconds, 0.1) * 10);
    this.dimUniform.value = THREE.MathUtils.lerp(this.dimUniform.value, this.dimTarget, response);
    this.dashSizeUniform.value = Math.max(0.001, dashLength);
    this.gapSizeUniform.value = Math.max(0.001, gapLength);
    this.offsetUniform.value = elapsedSeconds * speed * direction;
  }
}
