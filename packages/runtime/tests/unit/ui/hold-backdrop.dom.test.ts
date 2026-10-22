// WP X2 (docs/architecture.md §5.3 "hold presentation"; io §3.2, §3.10): the opaque backdrop the LOADING gate puts under the
// HUD while it holds, with the port's progress bar at its bottom edge, and the RETRY / LEAVE card of a failed need.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_BACKDROP_COLOR, HOLD_BACKDROP_Z, HOLD_ERROR_TITLE, HOLD_ERROR_Z, createHoldBackdrop, type HoldBackdrop } from '../../../src/runtime/ui/chrome/hold-backdrop.ts';

/** the game's LOADING card as `scripts/ui/hud.js:267-272` renders it into #game */
const CARD =
  '<div class="loading"><div class="box"><div class="hd"><span>DEPLOYING TO</span></div><div class="bd" style="padding:.7em 1em"><div class="h1">GALLOW FARM</div><div class="dim" style="margin-top:.5em;font-size:.9em;line-height:1.4">Stay near the doors.</div></div></div></div>';

let container: HTMLElement;
let hold: HoldBackdrop;
let released: number;

beforeEach(() => {
  document.body.innerHTML = `<canvas id="ss-canvas"></canvas><div id="tome-ui-container"><style id="ss-style"></style><div id="ss-root"><div id='game'>${CARD}</div></div></div><div id="tome-game-mount"></div><div id="ss-boot"></div>`;
  container = document.getElementById('tome-ui-container')!;
  released = 0;
  hold = createHoldBackdrop({ container, releasePointer: () => void released++ });
});

afterEach(() => {
  hold.dispose();
  document.body.replaceChildren();
});

const backdrop = (): HTMLElement | null => document.getElementById('ss-hold');
const card = (): HTMLElement | null => document.querySelector('.ss-hold-error');
const fill = (): HTMLElement => backdrop()!.querySelector('.ss-hold-bar > i')!;
const bar = (): HTMLElement => backdrop()!.querySelector('.ss-hold-bar')!;
const button = (label: string): HTMLButtonElement => [...card()!.querySelectorAll('button')].find((b) => b.textContent === label)!;

describe('the hold backdrop', () => {
  it('adds nothing to the page until it is shown', () => {
    expect(backdrop()).toBeNull();
    expect(card()).toBeNull();
    expect(hold.visible).toBe(false);
    expect(hold.element).toBeNull();
    hold.setProgress(0.5);
    hold.hide();
    expect(document.body.children).toHaveLength(4);
  });

  it("is opaque, the menu's own #0b0a0c, fixed over the whole viewport, takes no pointer event and sits under #game", () => {
    hold.show();
    const el = backdrop()!;
    expect(hold.visible).toBe(true);
    expect(hold.element).toBe(el);
    expect(HOLD_BACKDROP_COLOR).toBe('#000000');
    expect(el.style.position).toBe('fixed');
    expect(el.style.backgroundColor).toBe('rgb(0, 0, 0)');
    expect(el.style.opacity).toBe('1');
    expect(el.style.pointerEvents).toBe('none');
    expect([el.style.left, el.style.top, el.style.width, el.style.height]).toEqual(['0px', '0px', '100vw', '100vh']);
    // under the HUD: before the UI container in the page, and below its layer (io §3.2: the container is z-index 10, the
    // game mount 11, the touch layer 12, the chrome and its rail band 20)
    expect(el.nextElementSibling).toBe(container);
    expect(el.compareDocumentPosition(document.getElementById('game')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(Number(el.style.zIndex)).toBe(HOLD_BACKDROP_Z);
    expect(HOLD_BACKDROP_Z).toBeLessThan(10);
    expect(HOLD_BACKDROP_Z).toBeGreaterThan(0); // above the canvas
    expect(container.contains(el)).toBe(false);
    // not a modal, not part of the game's render
    expect(el.hasAttribute('data-modal')).toBe(false);
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it("leaves the game's LOADING card exactly as the HUD rendered it", () => {
    const before = container.innerHTML;
    hold.show();
    hold.setProgress(0.4);
    expect(container.innerHTML).toBe(before);
    hold.hide();
    expect(container.innerHTML).toBe(before);
    expect(container.querySelector('#game .loading .h1')!.textContent).toBe('GALLOW FARM');
  });

  it('show is idempotent and hide removes it at once', () => {
    hold.show();
    const el = backdrop();
    hold.setProgress(0.3);
    hold.show();
    expect(document.querySelectorAll('#ss-hold')).toHaveLength(1);
    expect(backdrop()).toBe(el);
    expect(hold.progress).toBe(0.3);
    hold.hide();
    expect(backdrop()).toBeNull();
    expect(hold.visible).toBe(false);
    hold.hide();
    expect(document.body.children).toHaveLength(4);
  });

  it('carries a thin progress bar at its bottom edge that never goes back', () => {
    hold.show();
    expect(bar().getAttribute('role')).toBe('progressbar');
    expect(fill().style.width).toBe('0%');
    hold.setProgress(0.25);
    expect(fill().style.width).toBe('25%');
    expect(bar().getAttribute('aria-valuenow')).toBe('25');
    hold.setProgress(0.1);
    expect(fill().style.width).toBe('25%');
    hold.setProgress(Number.NaN);
    hold.setProgress(-3);
    expect(hold.progress).toBe(0.25);
    hold.setProgress(7);
    expect(hold.progress).toBe(1);
    expect(fill().style.width).toBe('100%');
    // a new hold starts from nothing
    hold.hide();
    hold.show();
    expect(hold.progress).toBe(0);
    expect(fill().style.width).toBe('0%');
  });

  it('without a container it goes first in the body, still under everything else', () => {
    const lone = createHoldBackdrop();
    lone.show();
    expect(document.body.firstElementChild).toBe(lone.element);
    lone.dispose();
    expect(backdrop()).toBeNull();
  });
});

describe('the RETRY / LEAVE card of a failed need', () => {
  it('shows the message with both buttons above the chrome, and frees the pointer', () => {
    hold.show();
    const onRetry = vi.fn();
    const onLeave = vi.fn();
    hold.showError({ detail: 'The map could not be built.', onRetry, onLeave });
    const el = card()!;
    expect(hold.errorShown).toBe(true);
    expect(el.getAttribute('role')).toBe('alertdialog');
    expect(el.querySelector('.ss-hold-title')!.textContent).toBe(HOLD_ERROR_TITLE);
    expect(el.querySelector('.ss-hold-text')!.textContent).toBe('The map could not be built.');
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['RETRY', 'LEAVE']);
    expect(el.style.pointerEvents).toBe('auto');
    expect(Number(el.style.zIndex)).toBe(HOLD_ERROR_Z);
    expect(HOLD_ERROR_Z).toBeGreaterThan(20);
    expect(released).toBe(1);
    expect(document.activeElement).toBe(button('RETRY'));
    // the backdrop is still there, under it
    expect(backdrop()).not.toBeNull();
  });

  it('a button answers once; the card stays until it is cleared or replaced', () => {
    hold.show();
    const onRetry = vi.fn();
    const onLeave = vi.fn();
    hold.showError({ detail: 'first', onRetry, onLeave });
    button('RETRY').click();
    button('RETRY').click();
    button('LEAVE').click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
    expect(button('RETRY').disabled && button('LEAVE').disabled).toBe(true);

    // the retry failed again: the same card, live buttons, the new text
    const again = vi.fn();
    hold.showError({ title: 'STILL NOT LOADED', detail: 'second', onRetry: again, onLeave });
    expect(document.querySelectorAll('.ss-hold-error')).toHaveLength(1);
    expect(card()!.querySelector('.ss-hold-title')!.textContent).toBe('STILL NOT LOADED');
    expect(card()!.querySelector('.ss-hold-text')!.textContent).toBe('second');
    button('LEAVE').click();
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(again).not.toHaveBeenCalled();

    hold.clearError();
    expect(card()).toBeNull();
    expect(hold.errorShown).toBe(false);
    expect(backdrop()).not.toBeNull();
  });

  it('hide takes the card away with the backdrop, and a handler that throws does not break the page', () => {
    hold.show();
    hold.showError({
      detail: 'x',
      onRetry: () => {
        throw new Error('retry broke');
      },
      onLeave: () => undefined,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => button('RETRY').click()).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
    hold.hide();
    expect(card()).toBeNull();
    expect(backdrop()).toBeNull();
    expect(document.body.children).toHaveLength(4);
  });

  it('an error shown while nothing holds shows the backdrop too (the card never floats over the scene)', () => {
    hold.showError({ detail: 'x', onRetry: () => undefined, onLeave: () => undefined });
    expect(backdrop()).not.toBeNull();
    expect(card()).not.toBeNull();
  });
});
