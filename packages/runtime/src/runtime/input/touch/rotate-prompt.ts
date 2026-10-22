
export interface OrientationPause {
  add(reason: 'orientation'): void;
  remove(reason: 'orientation'): void;
}

export interface RotatePromptOptions {
  doc: Document;
  mount: HTMLElement;
  enabled: boolean;
  pause: OrientationPause;
  window?: Window;
  isPortrait?: () => boolean;
}

export class RotatePrompt {
  readonly el: HTMLDivElement;
  readonly #options: RotatePromptOptions;
  readonly #win: Window;
  #mounted = false;
  #visible = false;

  constructor(options: RotatePromptOptions) {
    this.#options = options;
    this.#win = options.window ?? window;
    const el = options.doc.createElement('div');
    el.className = 'ss-touch-rotate';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Rotate device');
    el.textContent = 'Turn your device sideways';
    el.hidden = true;
    this.el = el;
  }

  get visible(): boolean { return this.#visible; }

  mount(): void {
    if (this.#mounted || !this.#options.enabled) return;
    this.#mounted = true;
    this.#options.mount.appendChild(this.el);
    this.#win.addEventListener('resize', this.refresh);
    this.#win.addEventListener('orientationchange', this.refresh);
    this.refresh();
  }

  refresh = (): void => {
    if (!this.#mounted) return;
    const portrait = this.#options.isPortrait?.() ?? this.#win.matchMedia?.('(orientation: portrait)').matches ?? this.#win.innerHeight > this.#win.innerWidth;
    if (portrait === this.#visible) return;
    this.#visible = portrait;
    this.el.hidden = !portrait;
    if (portrait) this.#options.pause.add('orientation');
    else this.#options.pause.remove('orientation');
  };

  dispose(): void {
    if (this.#mounted) {
      this.#win.removeEventListener('resize', this.refresh);
      this.#win.removeEventListener('orientationchange', this.refresh);
      if (this.#visible) this.#options.pause.remove('orientation');
    }
    this.#mounted = false;
    this.#visible = false;
    this.el.remove();
  }
}
