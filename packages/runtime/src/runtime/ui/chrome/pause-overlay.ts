// UI2b pause overlay: the chrome modal shown while a match is paused (§3.10).
//
// A chrome modal: Chrome.hasModal() reports it for the UiHost modal scan
// (UiHostDeps.chrome), which informs the pointer-lock manager. The overlay itself
// never decides *when* to show — Chrome gates it on gameplayActive, so it can never
// stand in LOBBY or RESULTS.

import type { PageGlobals } from './types.ts';
import { globalPageGlobals } from './types.ts';

/** pause reason → the label §3.10 requires */
export type PauseReason = string;
export interface PauseOverlayOptions {
 labels?: Readonly<Record<string,string>>;
 panels?: readonly {id:string;label:string}[];
 hint?: string;
}

export const PAUSE_REASON_LABELS: Record<PauseReason, string> = {
  user: 'PAUSED',
  ad: 'AD BREAK',
  background: 'GAME IN BACKGROUND',
};

export class PauseOverlay {
  readonly el: HTMLDivElement;
  readonly #doc: Document;
  readonly #globals: PageGlobals;
  readonly #labels: Readonly<Record<string,string>>;
  #dialog: HTMLDivElement;
  #reasonEl: HTMLElement;
  #resumeBtn: HTMLButtonElement;
  #visible = false;
  #prevFocus: Element | null = null;
  readonly #onKey: (e: KeyboardEvent) => void;

  constructor(doc: Document, parent: HTMLElement, globals?: PageGlobals, options: PauseOverlayOptions = {}) {
    this.#doc = doc;
    this.#labels = options.labels ?? PAUSE_REASON_LABELS;
    this.#globals = globals ?? globalPageGlobals();
    const el = doc.createElement('div');
    el.className = 'ss-pause';
    el.setAttribute('data-modal', '');
    el.hidden = true;

    const dialog = doc.createElement('div');
    dialog.className = 'ss-pause-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Paused');

    const reason = doc.createElement('p');
    reason.className = 'ss-pause-reason';
    dialog.appendChild(reason);
    this.#reasonEl = reason;

    const actions = doc.createElement('div');
    actions.className = 'ss-pause-actions';
    const g = this.#globals;
    this.#resumeBtn = this.#actionButton(actions, 'RESUME', () => g.resume());
    for (const panel of options.panels ?? []) this.#actionButton(actions, panel.label, () => g.nav(panel.id));
    this.#actionButton(actions, 'MUTE', () => g.mute());
    dialog.appendChild(actions);

    const hint = doc.createElement('p');
    hint.className = 'ss-pause-hint';
    hint.textContent = options.hint ?? '';
    hint.hidden = !options.hint;
    dialog.appendChild(hint);

    el.appendChild(dialog);
    parent.appendChild(el);
    this.el = el;
    this.#dialog = dialog;
    this.#onKey = (e) => this.#trapTab(e);
  }

  get visible(): boolean {
    return this.#visible;
  }

  show(reason: PauseReason = 'user'): void {
    this.#reasonEl.textContent = this.#labels[reason] ?? reason;
    if (this.#visible) return;
    this.#visible = true;
    this.#prevFocus = this.#doc.activeElement;
    this.el.hidden = false;
    this.el.addEventListener('keydown', this.#onKey);
    this.#resumeBtn.focus();
  }

  hide(): void {
    if (!this.#visible) return;
    this.#visible = false;
    this.el.hidden = true;
    this.el.removeEventListener('keydown', this.#onKey);
    const prev = this.#prevFocus as HTMLElement | null;
    this.#prevFocus = null;
    if (prev && typeof prev.focus === 'function') prev.focus();
  }

  dispose(): void {
    this.el.removeEventListener('keydown', this.#onKey);
    this.el.remove();
  }

  #actionButton(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
    const btn = this.#doc.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    parent.appendChild(btn);
    return btn;
  }

  /** keeps Tab cycling inside the dialog while it stands */
  #trapTab(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    const btns = Array.from(this.#dialog.querySelectorAll('button'));
    if (btns.length === 0) return;
    const first = btns[0]!;
    const last = btns[btns.length - 1]!;
    const active = this.#doc.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
