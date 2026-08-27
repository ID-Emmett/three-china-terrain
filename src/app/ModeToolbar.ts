import type { RouteMode } from '../business/BusinessData';

export class ModeToolbar {
  public readonly element = document.createElement('div');
  private readonly modeControl = document.createElement('div');
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
    this.element.append(this.modeControl);
    this.setMode('comparison');
  }

  public setMode(mode: RouteMode): void {
    for (const [key, button] of this.buttons) {
      button.classList.toggle('is-active', key === mode);
      button.setAttribute('aria-pressed', String(key === mode));
    }
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
