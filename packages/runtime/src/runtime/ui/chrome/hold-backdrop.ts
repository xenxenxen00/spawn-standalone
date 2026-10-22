import '../css/hold-backdrop.css';

/** `scripts/ui/main.js:117` */
export const HOLD_BACKDROP_COLOR = '#000000';
/** under `#tome-ui-container` (10), above the canvas */
export const HOLD_BACKDROP_Z = 9;
/** above the port chrome (20) */
export const HOLD_ERROR_Z = 21;
export const HOLD_ERROR_TITLE = 'COULD NOT LOAD THE GAME';

const BACKDROP_STYLE = `position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:${HOLD_BACKDROP_Z};pointer-events:none;background-color:${HOLD_BACKDROP_COLOR};opacity:1`;
const ERROR_STYLE = `position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:${HOLD_ERROR_Z};pointer-events:auto`;

export interface HoldError {
  /** default `HOLD_ERROR_TITLE` */
  title?: string;
  /** one sentence: what could not be loaded */
  detail: string;
  /** RETRY: run the failed needs again */
  onRetry(): void;
  /** LEAVE: back to the lobby */
  onLeave(): void;
}

export interface HoldBackdrop {
  /** the backdrop is in the page */
  readonly visible: boolean;
  /** 0..1, of the current hold */
  readonly progress: number;
  readonly errorShown: boolean;
  /** the backdrop element while it is shown */
  readonly element: HTMLElement | null;
  /** idempotent; a new hold starts at progress 0 */
  show(): void;
  /** 0..1; lower values than the current one, and anything while hidden, are ignored */
  setProgress(fraction: number): void;
  /** shows (or rewrites) the RETRY / LEAVE card; shows the backdrop if it is not up */
  showError(error: HoldError): void;
  clearError(): void;
  /** removes the backdrop and the card now */
  hide(): void;
  dispose(): void;
}

export interface HoldBackdropOptions {
  /** default: the page's document */
  document?: Document;
  /** `#tome-ui-container`: the backdrop goes right before it; default: first in the body */
  container?: HTMLElement | null;
  /** called when the error card appears; default `document.exitPointerLock()` */
  releasePointer?: () => void;
  background?: string;
}

export function createHoldBackdrop(o: HoldBackdropOptions = {}): HoldBackdrop {
  const doc = o.document ?? o.container?.ownerDocument ?? document;
  const container = o.container ?? null;
  const releasePointer =
    o.releasePointer ??
    ((): void => {
      if (doc.pointerLockElement !== null && doc.pointerLockElement !== undefined) doc.exitPointerLock();
    });

  let el: HTMLDivElement | null = null;
  let bar: HTMLDivElement | null = null;
  let fill: HTMLElement | null = null;
  let progress = 0;
  let card: { root: HTMLDivElement; title: HTMLDivElement; text: HTMLParagraphElement; retry: HTMLButtonElement; leave: HTMLButtonElement } | null = null;
  let handlers: HoldError | null = null;

  const paint = (): void => {
    const pct = Math.round(progress * 100);
    if (fill) fill.style.width = `${pct}%`;
    bar?.setAttribute('aria-valuenow', String(pct));
  };

  const show = (): void => {
    if (el !== null) return;
    progress = 0;
    el = doc.createElement('div');
    el.id = 'ss-hold';
    el.className = 'ss-hold';
    el.setAttribute('style', BACKDROP_STYLE);
    if (o.background) el.style.backgroundColor = o.background;
    el.setAttribute('aria-hidden', 'true');
    bar = doc.createElement('div');
    bar.className = 'ss-hold-bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Loading');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    fill = doc.createElement('i');
    bar.append(fill);
    el.append(bar);
    paint();
    const parent = container?.parentNode ?? null;
    if (container !== null && parent !== null) parent.insertBefore(el, container);
    else doc.body.prepend(el);
  };

  const clearError = (): void => {
    card?.root.remove();
    card = null;
    handlers = null;
  };

  const answer = (which: 'onRetry' | 'onLeave'): void => {
    const h = handlers;
    if (h === null || card === null || card.retry.disabled) return;
    card.retry.disabled = true;
    card.leave.disabled = true;
    try {
      h[which]();
    } catch (e) {
      console.error(`[hold] the ${which === 'onRetry' ? 'RETRY' : 'LEAVE'} handler threw`, e);
    }
  };

  const showError = (error: HoldError): void => {
    show();
    if (card === null) {
      const root = doc.createElement('div');
      root.className = 'ss-hold-error';
      root.setAttribute('style', ERROR_STYLE);
      root.setAttribute('role', 'alertdialog');
      root.setAttribute('aria-modal', 'true');
      const box = doc.createElement('div');
      box.className = 'ss-hold-box';
      const title = doc.createElement('div');
      title.className = 'ss-hold-title';
      const text = doc.createElement('p');
      text.className = 'ss-hold-text';
      const actions = doc.createElement('div');
      actions.className = 'ss-hold-actions';
      const make = (label: string, act: 'retry' | 'leave'): HTMLButtonElement => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'ss-hold-action';
        b.dataset['act'] = act;
        b.textContent = label;
        b.addEventListener('click', () => answer(act === 'retry' ? 'onRetry' : 'onLeave'));
        return b;
      };
      const retry = make('RETRY', 'retry');
      const leave = make('LEAVE', 'leave');
      actions.append(retry, leave);
      box.append(title, text, actions);
      root.append(box);
      doc.body.append(root);
      card = { root, title, text, retry, leave };
    }
    handlers = error;
    card.title.textContent = error.title ?? HOLD_ERROR_TITLE;
    card.text.textContent = error.detail;
    card.retry.disabled = false;
    card.leave.disabled = false;
    try {
      releasePointer();
    } catch (e) {
      console.error('[hold] releasing the pointer failed', e);
    }
    card.retry.focus();
  };

  const hide = (): void => {
    clearError();
    el?.remove();
    el = null;
    bar = null;
    fill = null;
    progress = 0;
  };

  return {
    get visible() {
      return el !== null;
    },
    get progress() {
      return progress;
    },
    get errorShown() {
      return card !== null;
    },
    get element() {
      return el;
    },
    show,
    setProgress(fraction) {
      if (el === null || !Number.isFinite(fraction)) return;
      const f = Math.min(1, Math.max(0, fraction));
      if (!(f > progress)) return;
      progress = f;
      paint();
    },
    showError,
    clearError,
    hide,
    dispose: hide,
  };
}
