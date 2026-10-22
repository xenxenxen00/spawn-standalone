import type { Vec3 } from '../../../compat/core/types.ts';
import type { PointerSample, RawInputEvent } from '../input-log.ts';
import { TOUCH } from './config.ts';
import { aimGain, type AimTargetQuery } from './aim-friction.ts';
import { TouchButtons, type TouchActionInput } from './buttons.ts';
import { pushTouchLook } from './look-pad.ts';
import { touchScheme, controlLayout, type TouchScheme } from './scheme.ts';
import { RotatePrompt, type OrientationPause } from './rotate-prompt.ts';
import { sprintHeld, stickAxes } from './stick.ts';
import './touch.css';

export interface TouchInput extends TouchActionInput {
  push(event: RawInputEvent): void;
  setAxis(axis: string, value: number | null): void;
  setTouchActive(on: boolean): void;
  /** the cursor (canvas px and NDC): written by the `press` / `tap` gestures of a TouchScheme */
  setPointer?(p: PointerSample): void;
}

export interface TouchFrameState {
  modal?: boolean; place?: string; eye?: Vec3; yaw?: number; pitch?: number;
  touchAimFriction?: boolean; hudScale?: number;
}

export interface TouchLayerOptions {
  container: HTMLElement; input: TouchInput; read(): TouchFrameState; aimTargets?: AimTargetQuery;
  maxTouchPoints?: () => number; now?: () => number; doc?: Document; window?: Window; chromeMount?: HTMLElement;
  pause?: OrientationPause; isPortrait?: () => boolean;
  /** what the layer draws and drives; default no controls, stick, look or gestures */
  scheme?: TouchScheme;
  /** the canvas rect the gesture pointer is measured in; default the whole viewport */
  pointerSpace?: () => { left: number; top: number; width: number; height: number };
  /**
   * The class of the layer's root element; default `ss-touch-controls`. A game that wants its own name passes it here; the
   * root then also carries `data-touch-root`, which the stock stylesheet matches, so the look is unchanged.
   */
  rootClass?: string;
  /**
   * Opt-in, default none: the root takes every pointer event, so it covers sibling UI). With a surface the root gets
   * `pointer-events: none` and only its controls take pointer events, so HUD buttons and panels beside it stay tappable; the
   * empty-space gestures (stick, look, tap, press) are read from pointer events that start on this element (the canvas) instead.
   */
  surface?: HTMLElement;
}

/** a touch counts as a tap within this travel (px) and time (ms) */
const TAP_SLOP_PX = 12;
const TAP_MAX_MS = 600;

interface PointerTrack { kind: 'stick' | 'look' | 'button' | 'press' | 'tap'; x: number; y: number; startX: number; startY?: number; t0?: number }

export class TouchLayer {
  readonly #options: TouchLayerOptions;
  readonly #doc: Document;
  readonly #win: Window;
  readonly #now: () => number;
  readonly #buttons: TouchButtons;
  readonly #scheme: TouchScheme;
  readonly #pointers = new Map<number, PointerTrack>();
  readonly #elements = new Map<string, HTMLButtonElement>();
  readonly #onDown: (e: PointerEvent) => void;
  readonly #onMove: (e: PointerEvent) => void;
  readonly #onUp: (e: PointerEvent) => void;
  readonly #onBlur: () => void;
  readonly #rotate: RotatePrompt | null;
  #controls: HTMLDivElement | null = null;
  #stick: HTMLDivElement | null = null;
  #state: TouchFrameState = {};
  #mounted = false;
  #visible = true;
  #blocked = false;
  #stickMagnitude = 0;
  #stickOriginX = 0;
  #stickOriginY = 0;
  #scale = 1;
  #sprintSince: number | null = null;
  #sprinting = false;

  constructor(options: TouchLayerOptions) {
    this.#options = options;
    this.#doc = options.doc ?? document;
    this.#win = options.window ?? window;
    this.#now = options.now ?? (() => performance.now());
    this.#scheme = options.scheme ?? touchScheme({});
    this.#buttons = new TouchButtons(options.input, this.#scheme);
    this.#rotate = options.chromeMount && options.pause
      ? new RotatePrompt({ doc: this.#doc, mount: options.chromeMount, enabled: true, pause: options.pause,
          window: this.#win, ...(options.isPortrait ? { isPortrait: options.isPortrait } : {}) })
      : null;
    this.#onDown = (e) => this.#pointerDown(e);
    this.#onMove = (e) => this.#pointerMove(e);
    this.#onUp = (e) => this.#pointerUp(e);
    this.#onBlur = () => this.#releaseAll();
  }

  mount(): void {
    if (this.#mounted || (this.#options.maxTouchPoints?.() ?? this.#win.navigator.maxTouchPoints ?? 0) <= 0) return;
    this.#mounted = true;
    const root = this.#doc.createElement('div');
    const rootClass = this.#options.rootClass;
    root.className = rootClass !== undefined && rootClass !== '' ? rootClass : 'ss-touch-controls';
    if (root.className !== 'ss-touch-controls') root.setAttribute('data-touch-root', '');
    root.setAttribute('aria-label', 'Touch controls');
    const surface = this.#options.surface;
    if (surface) {
      root.setAttribute('data-touch-passthrough', '');
      root.style.pointerEvents = 'none';
      surface.addEventListener('pointerdown', this.#onDown);
    }
    root.addEventListener('pointerdown', this.#onDown);
    root.addEventListener('pointermove', this.#onMove);
    root.addEventListener('pointerup', this.#onUp);
    root.addEventListener('pointercancel', this.#onUp);
    root.addEventListener('lostpointercapture', this.#onUp);
    this.#win.addEventListener('blur', this.#onBlur);
    for (const def of this.#scheme.controls) {
      const { id, label } = def;
      const at = controlLayout(def);
      const button = this.#doc.createElement('button');
      button.type = 'button';
      button.className = `ss-touch-button ss-touch-${id}`;
      if (surface) button.style.pointerEvents = 'auto';
      button.dataset['touch'] = id;
      button.setAttribute('aria-label', label);
      button.textContent = label;
      button.style.setProperty('--touch-size', `calc(${at.size}px * var(--touch-scale,1))`);
      button.style.setProperty('--touch-x', `${at.x}%`);
      button.style.setProperty('--touch-y', `${at.y}%`);
      root.appendChild(button);
      this.#elements.set(id, button);
    }
    if (this.#scheme.stick) this.#stick = this.#doc.createElement('div');
    if (this.#stick) {
      this.#stick.className = 'ss-touch-stick';
      this.#stick.hidden = true;
      this.#stick.style.setProperty('--stick-size', `${TOUCH.stickRadius * 2}px`);
      root.appendChild(this.#stick);
    }
    this.#options.container.appendChild(root);
    this.#controls = root;
    this.#rotate?.mount();
    this.frame();
  }

  setVisible(visible: boolean): void { this.#visible = visible; this.frame(); }

  /** Called from the app's UI frame after modal/context state has been refreshed. */
  frame(): void {
    if (!this.#mounted || !this.#controls) return;
    this.#syncBlocking();
    this.#scale = touchScale(this.#win.innerWidth, this.#win.innerHeight, this.#state.hudScale);
    this.#controls.style.setProperty('--touch-scale', String(this.#scale));
    for (const [id, button] of this.#elements) {
      button.dataset['pressed'] = this.#buttons.isPressed(id) ? 'true' : 'false';
    }
    if (this.#stick) this.#stick.hidden = ![...this.#pointers.values()].some((p) => p.kind === 'stick');
    if ([...this.#pointers.values()].some((p) => p.kind === 'stick')) {
      const heldFor = this.#sprintSince === null ? 0 : this.#now() - this.#sprintSince;
      this.#setSprint(sprintHeld(this.#stickMagnitude, heldFor, this.#sprinting));
    }
  }

  dispose(): void {
    this.#releaseAll();
    this.#rotate?.dispose();
    this.#options.surface?.removeEventListener('pointerdown', this.#onDown);
    if (this.#controls) {
      this.#controls.removeEventListener('pointerdown', this.#onDown);
      this.#controls.removeEventListener('pointermove', this.#onMove);
      this.#controls.removeEventListener('pointerup', this.#onUp);
      this.#controls.removeEventListener('pointercancel', this.#onUp);
      this.#controls.removeEventListener('lostpointercapture', this.#onUp);
      this.#controls.remove();
    }
    this.#win.removeEventListener('blur', this.#onBlur);
    this.#controls = null;
    this.#mounted = false;
    this.#elements.clear();
  }

  #pointerDown(e: PointerEvent): void {
    if (e.pointerType !== 'touch' || e.button !== 0 || this.#syncBlocking() || this.#pointers.has(e.pointerId)) return;
    e.preventDefault();
    this.#options.input.setTouchActive(true);
    const target = (e.target as Element).closest<HTMLElement>('[data-touch]');
    const control = target?.dataset['touch'];
    const x = e.clientX, y = e.clientY;
    const { stick, gestures } = this.#scheme;
    if (control) {
      this.#buttons.press(e.pointerId, control);
      this.#pointers.set(e.pointerId, { kind: 'button', x, y, startX: x });
    } else if (stick && x <= this.#win.innerWidth * TOUCH.movePocket / 100) {
      this.#pointers.set(e.pointerId, { kind: 'stick', x, y, startX: x });
      this.#stickMagnitude = 0;
      this.#sprintSince = null;
      this.#stickOriginX = x;
      this.#stickOriginY = y;
      this.#stick?.style.setProperty('left', `${x}px`);
      this.#stick?.style.setProperty('top', `${y}px`);
    } else if (gestures.press) {
      this.#pointers.set(e.pointerId, { kind: 'press', x, y, startX: x });
      this.#setPointer(x, y);
      this.#options.input.injectAction(gestures.press, undefined, true);
    } else if (gestures.tap) {
      this.#pointers.set(e.pointerId, { kind: 'tap', x, y, startX: x, startY: y, t0: this.#now() });
      this.#setPointer(x, y);
    } else if (this.#scheme.look) this.#pointers.set(e.pointerId, { kind: 'look', x, y, startX: x });
    try { this.#controls?.setPointerCapture(e.pointerId); } catch { /* capture can fail after a browser cancels the pointer */ }
    this.frame();
  }

  #pointerMove(e: PointerEvent): void {
    if (this.#syncBlocking()) return;
    const track = this.#pointers.get(e.pointerId);
    if (!track) return;
    const dx = e.clientX - track.x, dy = e.clientY - track.y;
    track.x = e.clientX;
    track.y = e.clientY;
    if (track.kind === 'press' || track.kind === 'tap') {
      this.#setPointer(e.clientX, e.clientY);
      return;
    }
    if (track.kind === 'stick') {
      const dx = e.clientX - this.#stickOriginX, dy = e.clientY - this.#stickOriginY;
      const radius = TOUCH.stickRadius * this.#scale;
      const axes = stickAxes(dx, dy, radius);
      this.#stickMagnitude = axes.magnitude;
      const distance = Math.hypot(dx, dy);
      const clamp = distance > radius ? radius / distance : 1;
      this.#stick?.style.setProperty('--stick-x', `${dx * clamp}px`);
      this.#stick?.style.setProperty('--stick-y', `${dy * clamp}px`);
      if (axes.magnitude >= TOUCH.sprintThreshold) this.#sprintSince ??= this.#now();
      else if (!this.#sprinting) this.#sprintSince = null;
      const st = this.#scheme.stick;
      if (st) {
        this.#options.input.setAxis(st.x, axes.moveX);
        this.#options.input.setAxis(st.y, axes.moveZ);
      }
      return;
    }
    if (track.kind === 'look') this.#look(dx, dy);
  }

  #pointerUp(e: PointerEvent): void {
    const track = this.#pointers.get(e.pointerId);
    if (!track) return;
    this.#pointers.delete(e.pointerId);
    this.#buttons.release(e.pointerId);
    if (track.kind === 'press') {
      this.#options.input.injectAction(this.#scheme.gestures.press!, undefined, false);
    } else if (track.kind === 'tap') {
      this.#setPointer(e.clientX, e.clientY);
      const near = Math.hypot(e.clientX - track.startX, e.clientY - (track.startY ?? e.clientY)) <= TAP_SLOP_PX;
      if (near && this.#now() - (track.t0 ?? 0) <= TAP_MAX_MS) this.#pulse(this.#scheme.gestures.tap!);
    } else if (track.kind === 'stick') {
      this.#releaseStickAxes();
      this.#setSprint(false);
      this.#stickMagnitude = 0;
      this.#sprintSince = null;
      this.#stick?.style.setProperty('--stick-x', '0px');
      this.#stick?.style.setProperty('--stick-y', '0px');

    }
    this.frame();
  }

  #look(dx: number, dy: number): void {
    const gain = aimGain({
      enabled: this.#state.touchAimFriction === true,
      ...(this.#state.place ? { place: this.#state.place } : {}),
      ...(this.#state.eye ? { eye: this.#state.eye } : {}),
      ...(this.#state.yaw !== undefined ? { yaw: this.#state.yaw } : {}),
      ...(this.#state.pitch !== undefined ? { pitch: this.#state.pitch } : {}),
      ...(this.#options.aimTargets ? { query: this.#options.aimTargets } : {}),
    });
    pushTouchLook(this.#options.input, dx, dy, gain);
  }

  #releaseAll(): void {
    for (const t of this.#pointers.values()) if (t.kind === 'press') this.#options.input.injectAction(this.#scheme.gestures.press!, undefined, false);
    this.#pointers.clear();
    this.#buttons.reset();
    this.#releaseStickAxes();
    this.#setSprint(false);
    this.#stickMagnitude = 0;
    this.#sprintSince = null;
    if (this.#stick) this.#stick.hidden = true;
    this.#stick?.style.setProperty('--stick-x', '0px');
    this.#stick?.style.setProperty('--stick-y', '0px');
  }

  #syncBlocking(): boolean {
    this.#state = this.#options.read();
    this.#rotate?.refresh();
    const blocked = !this.#visible || this.#state.modal === true || this.#rotate?.visible === true;
    if (blocked && !this.#blocked) this.#releaseAll();
    this.#blocked = blocked;
    if (this.#controls) this.#controls.hidden = blocked;
    return blocked;
  }

  #setSprint(on: boolean): void {
    const sprint = this.#scheme.stick ? this.#scheme.stick.sprint : undefined;
    if (!sprint || this.#sprinting === on) return;
    this.#sprinting = on;
    this.#options.input.injectAction(sprint, undefined, on);
  }

  #releaseStickAxes(): void {
    const st = this.#scheme.stick;
    if (!st) return;
    this.#options.input.setAxis(st.x, null);
    this.#options.input.setAxis(st.y, null);
  }

  /** the finger of a world gesture becomes the input pointer (canvas px and NDC) */
  #setPointer(clientX: number, clientY: number): void {
    const input = this.#options.input;
    if (!input.setPointer) return;
    const r = this.#options.pointerSpace?.() ?? { left: 0, top: 0, width: this.#win.innerWidth, height: this.#win.innerHeight };
    if (!(r.width > 0 && r.height > 0)) return;
    const px = clientX - r.left;
    const py = clientY - r.top;
    input.setPointer({ x: px, y: py, ndcX: (px / r.width) * 2 - 1, ndcY: 1 - (py / r.height) * 2 });
  }

  #pulse(action: string): void {
    this.#options.input.injectAction(action, undefined, true);
    this.#options.input.injectAction(action, undefined, false);
  }


}

/** Fits the reference layout to the viewport, then applies the clamped HUD-size preference. */
export function touchScale(width: number, height: number, hudScale = 1): number {
  const viewport = Math.min(width / TOUCH.referenceWidth, height / TOUCH.referenceHeight);
  const preference = Number.isFinite(hudScale)
    ? Math.max(TOUCH.minScale, Math.min(TOUCH.maxScale, hudScale))
    : 1;
  return Math.max(TOUCH.minScale, Math.min(TOUCH.maxScale, viewport * preference));
}
