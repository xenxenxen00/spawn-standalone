// UI2b trophy toast: `.ss-toast`, z-index 30 — below the pause overlay,
// beside the rail. A polite live region; auto-dismisses.

import type { UiClock } from './types.ts';
import { systemClock } from './types.ts';

export interface ToastInfo {
  title: string;
  subtitle?: string;
}

/** §3.10: the toast stacks below the pause overlay */
export const TOAST_Z_INDEX = 30;
export const TOAST_DURATION_MS = 4000;

export class Toast {
  readonly #doc: Document;
  readonly #parent: HTMLElement;
  readonly #clock: UiClock;
  #el: HTMLDivElement | null = null;
  #cancel: (() => void) | null = null;

  constructor(doc: Document, parent: HTMLElement, clock?: UiClock) {
    this.#doc = doc;
    this.#parent = parent;
    this.#clock = clock ?? systemClock();
  }

  /** the currently shown toast, if any */
  get el(): HTMLDivElement | null {
    return this.#el;
  }

  show(info: ToastInfo): void {
    this.dismiss();
    const el = this.#doc.createElement('div');
    el.className = 'ss-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    const title = this.#doc.createElement('p');
    title.className = 'ss-toast-title';
    title.textContent = info.title;
    el.appendChild(title);
    if (info.subtitle !== undefined) {
      const sub = this.#doc.createElement('p');
      sub.className = 'ss-toast-sub';
      sub.textContent = info.subtitle;
      el.appendChild(sub);
    }
    this.#parent.appendChild(el);
    this.#el = el;
    this.#cancel = this.#clock.after(TOAST_DURATION_MS, () => this.dismiss());
  }

  dismiss(): void {
    if (this.#cancel) {
      this.#cancel();
      this.#cancel = null;
    }
    if (this.#el) {
      this.#el.remove();
      this.#el = null;
    }
  }

  dispose(): void {
    this.dismiss();
  }
}
