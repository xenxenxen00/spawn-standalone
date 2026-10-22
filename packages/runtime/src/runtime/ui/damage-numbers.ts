// UI2b damage numbers: one short-lived floating DOM label per act, projected from
// a world position. Uses the injected renderer projection contract — no rendering
// dependency enters UI (the app passes its world→screen projector).

import type { ScreenPoint, UiClock, Vec3Like } from './chrome/types.ts';
import { systemClock } from './chrome/types.ts';

/** the `damageNumber` sink act payload */
export interface DamageNumberAct {
  position: Vec3Like;
  text: string;
  /** styling hook (e.g. 'crit', 'heal'); reflected as data-kind */
  kind?: string;
  /** the label colour (the live emit's `color`, a CSS colour; an invalid value is ignored by the CSSOM) */
  color?: string;
  /** the live emit's `size`: a scale on the base font size (css/chrome.css `--ss-dmg-size`) */
  size?: number;
  /** the live emit's `lifetime` in ms (the sink converts seconds); default: the layer's lifetime */
  lifetimeMs?: number;
}

export interface DamageNumbersDeps {
  /** the renderer projection contract: world → CSS px; null = behind camera, skip */
  project(point: Vec3Like): ScreenPoint | null;
  clock?: UiClock;
  lifetimeMs?: number;
}

export const DAMAGE_LIFETIME_MS = 900;

export class DamageNumbers {
  readonly layer: HTMLDivElement;
  readonly #doc: Document;
  readonly #project: (point: Vec3Like) => ScreenPoint | null;
  readonly #clock: UiClock;
  readonly #lifetime: number;

  constructor(doc: Document, parent: HTMLElement, deps: DamageNumbersDeps) {
    this.#doc = doc;
    this.#project = deps.project;
    this.#clock = deps.clock ?? systemClock();
    this.#lifetime = deps.lifetimeMs ?? DAMAGE_LIFETIME_MS;
    const layer = doc.createElement('div');
    layer.className = 'ss-damage-layer';
    layer.setAttribute('aria-hidden', 'true');
    parent.appendChild(layer);
    this.layer = layer;
  }

  spawn(act: DamageNumberAct): void {
    const pt = this.#project(act.position);
    if (!pt) return;
    const el = this.#doc.createElement('div');
    el.className = 'ss-damage';
    if (act.kind !== undefined) el.setAttribute('data-kind', act.kind);
    el.textContent = act.text;
    el.style.left = `${pt.x}px`;
    el.style.top = `${pt.y}px`;
    if (act.color !== undefined) el.style.color = act.color;
    if (act.size !== undefined && Number.isFinite(act.size) && act.size > 0) el.style.setProperty('--ss-dmg-size', String(act.size));
    const lifetime = act.lifetimeMs !== undefined && Number.isFinite(act.lifetimeMs) && act.lifetimeMs > 0 ? act.lifetimeMs : this.#lifetime;
    // the rise-and-fade animation (css/chrome.css) runs over the label's own lifetime
    el.style.setProperty('--ss-dmg-life', `${lifetime}ms`);
    this.layer.appendChild(el);
    this.#clock.after(lifetime, () => el.remove());
  }

  dispose(): void {
    this.layer.remove();
  }
}
