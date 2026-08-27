import type { RouteMode } from '../business/BusinessData';

export class ModeToolbar {
  public readonly element = document.createElement('div');
  private readonly modeControl = document.createElement('div');
  private readonly routeLegend = document.createElement('div');
  private readonly buttons = new Map<RouteMode, HTMLButtonElement>();

  public constructor(onModeChange: (mode: RouteMode) => void) {
    this.element.className = 'map-controls';
    this.modeControl.className = 'mode-toolbar';
    this.modeControl.setAttribute('role', 'group');
    this.modeControl.setAttribute('aria-label', '线路模式');
    for (const [mode, label] of [
      ['comparison', '线路比较'],
      ['radial', '线路发散'],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.mode = mode;
      button.addEventListener('click', () => onModeChange(mode));
      this.modeControl.append(button);
      this.buttons.set(mode, button);
    }

    this.routeLegend.className = 'route-legend';
    this.routeLegend.setAttribute('aria-label', '比较线路图例');
    for (const [kind, label] of [
      ['a', '路线 A · 宝安机场'],
      ['b', '路线 B · 云山江北 / 东祥东星'],
    ] as const) {
      const item = document.createElement('span');
      item.className = 'route-legend__item';
      const swatch = document.createElement('i');
      swatch.className = `route-legend__swatch route-legend__swatch--${kind}`;
      swatch.setAttribute('aria-hidden', 'true');
      item.append(swatch, label);
      this.routeLegend.append(item);
    }
    this.element.append(this.modeControl, this.routeLegend);
    this.setMode('comparison');
  }

  public setMode(mode: RouteMode): void {
    for (const [key, button] of this.buttons) {
      button.classList.toggle('is-active', key === mode);
      button.setAttribute('aria-pressed', String(key === mode));
    }
    this.routeLegend.hidden = mode !== 'comparison';
  }

  public setRouteColors(routeA: string, routeB: string): void {
    this.element.style.setProperty('--route-a', routeA);
    this.element.style.setProperty('--route-b', routeB);
  }

  public dispose(): void {
    this.element.remove();
    this.buttons.clear();
  }
}
