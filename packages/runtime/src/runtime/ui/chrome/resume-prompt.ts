// The resume prompt (io §3.9 row 3, §3.10; WP UI2a): "CLICK TO RESUME" over a 35 % dim, plain DOM in the port chrome layer
// (`#port-chrome`, io §3.2), styled by css/chrome.css.
//
// This is the view only: it shows, hides and reports clicks. When it shows and what a click does are the rules of
// ../modal-lock.ts. The whole layer is the click target, and the listener calls its subscribers synchronously, so a subscriber
// that requests the pointer lock does so inside the user gesture. It carries no `data-modal` and is not counted by
// `PortChrome.hasModal()` (UI2b): a modal would make the canvas stop requesting the lock and release a lock just obtained.
// Shown and hidden through the `hidden` attribute, so it stays hidden when the stylesheet has not loaded.
import '../css/chrome.css';

export const RESUME_PROMPT_TEXT = 'CLICK TO RESUME';

export class ResumePrompt {
  readonly element: HTMLDivElement;
  readonly #subs = new Set<() => void>();
  readonly #onClick = (): void => {
    for (const fn of [...this.#subs]) fn();
  };

  /** `parent` = the chrome layer (`#port-chrome`); the prompt is appended to it, hidden */
  constructor(parent: HTMLElement) {
    const doc = parent.ownerDocument;
    const el = doc.createElement('div');
    el.className = 'pc-resume';
    el.hidden = true;
    el.setAttribute('role', 'button');
    const plate = doc.createElement('div');
    plate.className = 'pc-resume-plate';
    plate.textContent = RESUME_PROMPT_TEXT;
    el.append(plate);
    el.addEventListener('click', this.#onClick);
    parent.append(el);
    this.element = el;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  show(): void {
    if (this.element.hidden) this.element.hidden = false;
  }

  hide(): void {
    if (!this.element.hidden) this.element.hidden = true;
  }

  /** called synchronously inside the click (a user gesture); returns the unsubscribe */
  onClick(fn: () => void): () => void {
    this.#subs.add(fn);
    return () => void this.#subs.delete(fn);
  }

  /** removes the DOM and the listeners */
  dispose(): void {
    this.element.removeEventListener('click', this.#onClick);
    this.#subs.clear();
    this.element.hidden = true;
    this.element.remove();
  }
}
