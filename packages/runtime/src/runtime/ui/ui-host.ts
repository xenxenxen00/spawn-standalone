// The HUD host around the carried `scripts/ui.js` render contract (io §3; spawn-engine-contract.md §14; X-39; WP UI1).
//
// Per UI frame (`frame()`, step 7 of the frame driver, docs/architecture.md §4.2; at most 60 Hz whatever the display rate, 30 Hz
// with `setCadence(30)`):
//   1. html = render(ctx, player) inside try/catch; a throw keeps the previous DOM and logs once per distinct message
//   2. an identical string skips to the scans
//   3. hoist: the leading <style> into #ss-style (replaced only when it changes); every sprite <svg> of <symbol>s into the
//      hidden #ss-sprites (merged by id, never re-sent); neither reaches the morph
//   4. split #game's content into its top-level children (hoist.ts scanner), keyed by id or position, compared with last frame's
//   5. H02: /cdn/ URL rewrite of the changed children only (B8's rewriteCdnInText)
//   6. morph: same key sequence → each changed child morphed on its own and #game's own attributes patched directly; otherwise
//      (a screen change, a render that cannot be split, a DOM a page global changed) #ss-root morphed whole
//   7. modal scan → pointer-lock manager; first interactive frame; the menu-backdrop cover flag
//   8. anchors projected with this frame's camera (UI2a)
//
// DOM (io §3.2): the container (`#tome-ui-container`) holds `<style id="ss-style">`, `<svg id="ss-sprites">` and
// `<div id="ss-root">` (the morph target the game's `<div id='game'>` lives in); `onMount` gets `#tome-game-mount`.
import './css/root-vars.css';
import './css/realm.css';
import './css/chrome.css';
import type { UiPort } from '../../compat/core/ports.ts';
import type { GameUiModule, UiPlayerView } from './game-ui.d.ts';
import { Hoister, childKey, parseRender, type ChildPart } from './hoist.ts';
import { attributesOf, morphChild, morphInto, patchAttributes } from './morph.ts';
import { installPageApi, installGlobals, pageTargets, type ActionInjector } from './page-api.ts';
import { defaultPortUiState, makeUiCtx, type PortUiState, type UiRuntimePort } from './ui-ctx.ts';
import { UiEventBus } from './ui-events.ts';
import { resolveUiHostConfig, type ResolvedUiHostConfig, type UiHostConfig } from './ui-host-config.ts';
import { cdnRewriter, rewriteCdnUrls, type TextRewriter } from './url-rewrite.ts';

export interface UiHostDeps {
  /** builds the UiCtx for the local viewer (the kernel, core §7.5; a fake until WP C5) */
  runtime: UiRuntimePort;
  /** the ActionSink (io §4.5) */
  actions: ActionInjector;
  /** the PointerLockManager (io §4.6): told every UI frame whether a modal stands */
  pointer?: { setModal(modal: boolean): void };
  /** the port chrome (UI2b): its own modals count for the scan */
  chrome?: { hasModal(): boolean };
  /** the `data-world-anchor` projector (io §3.7, UI2a) */
  anchors?: { project(root: HTMLElement): void };
  /** H02: `/cdn/` text rewrite; default B8's `rewriteCdnInText` over the installed asset index */
  rewrite?: TextRewriter;
  /** uiEvent acts → window.spawn.on (a new bus when omitted) */
  events?: UiEventBus;
  /** the PortUiState attached as `ctx.port` before each render (default: `defaultPortUiState()`) */
  port?: () => PortUiState;
  /** handlers behind the port page globals (settings bridge, rebinding, chrome, audio) */
  portGlobals?: Readonly<Record<string, (...args: any[]) => void>>;
  /** the `onMount` container (`#tome-game-mount`); default `document.getElementById('tome-game-mount')` */
  gameMount?: HTMLElement | null;
  /** platform policy externalLinks: open a link (default: no-op, Playgama) */
  openLink?: (url: string) => void;
  /** dev log; default console.warn */
  log?: (msg: string) => void;
  /** the options that make the host work for another game; default: PP's values (ui-host-config.ts) */
  config?: UiHostConfig;
  /** where the page globals go; default the page's global objects (page-api.ts pageTargets) */
  pageTarget?: object | readonly object[];
  /** called when the visible `[data-modal]` panel changes */
  onPanelChange?: (from: string | null, to: string | null) => void;
}

export interface UiHostStats {
  /** renders called */
  renders: number;
  /** frames whose string differed from the previous one */
  morphs: number;
  /** #ss-root morphed whole */
  fullMorphs: number;
  /** single top-level children morphed */
  childMorphs: number;
  /** render throws */
  errors: number;
}

/** io §3.4: at most 60 Hz; 30 Hz on `minimum` and on `low` above budget */
export type UiCadence = 60 | 30;

/** a frame up to this much early still renders (rAF jitter); the rolling-window guard below keeps the cap exact */
const CADENCE_TOLERANCE_MS = 3;
/** the cap holds in every rolling window of this length: at most `hz` renders in any [t, t + 1000) */
const CADENCE_WINDOW_MS = 1000;
/** two renders this close to exactly one window apart are a tie (float noise of exactly periodic timestamps, e.g. i × 1000 / 60) */
const CADENCE_TIE_MS = 1e-6;
/** render timestamps kept for the window guard: the highest UiCadence */
const CADENCE_RING = 60;

export class UiHost {
  readonly #container: HTMLElement;
  readonly #mod: GameUiModule;
  readonly #deps: UiHostDeps;
  readonly #events: UiEventBus;
  readonly #rewrite: TextRewriter;
  readonly #log: (msg: string) => void;
  readonly #cfg: ResolvedUiHostConfig;
  readonly #reported = new Set<string>();
  readonly #hoist: Hoister;
  readonly #root: HTMLDivElement;
  readonly #stats: UiHostStats = { renders: 0, morphs: 0, fullMorphs: 0, childMorphs: 0, errors: 0 };
  #uninstall: Array<() => void> = [];
  #mounted = false;
  #gameMount: HTMLElement | null = null;

  // render state
  #lastHtml: string | null = null;
  #ssOpen: string | null = null;
  #keys: string[] | null = null;
  #texts: string[] = [];

  // cadence
  #hz: UiCadence = 60;
  #intervalMs = 1000 / 60;
  #acc = 0;
  #prevT: number | null = null;
  readonly #renderTimes = new Float64Array(CADENCE_RING);
  #renderHead = 0;
  #renderCount = 0;

  // scans
  #modal = false;
  #covers = false;
  #interactive = false;
  readonly #interactiveSubs: Array<() => void> = [];
  #panel: string | null = null;

  constructor(container: HTMLElement, mod: GameUiModule, deps: UiHostDeps) {
    this.#container = container;
    this.#mod = mod;
    this.#deps = deps;
    this.#events = deps.events ?? new UiEventBus(deps.log ? { log: deps.log } : {});
    this.#rewrite = deps.rewrite ?? cdnRewriter;
    this.#log = deps.log ?? ((m) => console.warn(m));
    const doc = container.ownerDocument;
    this.#cfg = resolveUiHostConfig(deps.config);
    this.#hoist = new Hoister(doc, { style: this.#cfg.styleId, sprites: this.#cfg.spriteId });
    this.#root = doc.createElement('div');
    this.#root.id = 'ss-root';
  }

  /** installs the page API and the port globals, builds the host DOM, calls `onMount(#tome-game-mount, player)` */
  mount(): void {
    if (this.#mounted) return;
    this.#mounted = true;
    this.#container.replaceChildren(this.#hoist.style, this.#hoist.sprites, this.#root);
    if (this.#cfg.styles.length > 0) this.#hoist.setStyle(this.#cfg.styles.join('\n'));
    const pageDeps = { actions: this.#deps.actions, events: this.#events, globals: this.#cfg.globals, ...(this.#deps.pageTarget ? { target: this.#deps.pageTarget } : {}), ...(this.#deps.openLink ? { openLink: this.#deps.openLink } : {}) };
    this.#uninstall.push(installPageApi(pageDeps, this.#mod));
    if (this.#deps.portGlobals) this.#uninstall.push(installGlobals(pageTargets(this.#deps.pageTarget), this.#deps.portGlobals));
    this.#gameMount = this.#deps.gameMount !== undefined ? this.#deps.gameMount : this.#findOrMakeGameMount();
    if (this.#gameMount && this.#mod.onMount) {
      try {
        this.#mod.onMount(this.#gameMount, this.#player());
      } catch (e) {
        this.#once(`ui: onMount failed: ${message(e)}`);
      }
    }
  }

  /** once per rAF, after the camera (§1); `nowMs` = the rAF timestamp (default performance.now()) */
  frame(nowMs: number = performance.now()): void {
    if (!this.#due(nowMs)) return;
    let html: string | null = null;
    try {
      const { ctx, player } = makeUiCtx(this.#deps.runtime, this.#portState());
      this.#stats.renders++;
      const out = this.#mod.default(ctx, player);
      html = typeof out === 'string' ? out : out == null ? '' : String(out);
    } catch (e) {
      this.#stats.errors++;
      this.#once(`ui: render failed: ${message(e)}`);
    }
    if (html !== null && html !== this.#lastHtml) {
      try {
        this.#apply(html);
        this.#lastHtml = html;
        this.#stats.morphs++;
      } catch (e) {
        this.#lastHtml = null; // retry next frame from a whole morph
        this.#keys = null;
        this.#once(`ui: DOM update failed: ${message(e)}`);
      }
    }
    this.#scan();
    if (this.#deps.anchors) {
      try {
        this.#deps.anchors.project(this.#root);
      } catch (e) {
        this.#once(`ui: anchors failed: ${message(e)}`);
      }
    }
  }

  setCadence(hz: UiCadence): void {
    // a lower cap holds from the switch on: the second before it ran at the higher rate, and counting it would freeze the HUD
    // until that history ages out. A higher cap keeps the history (it already satisfies the higher cap).
    if (hz < this.#hz) this.#renderCount = 0;
    this.#hz = hz;
    this.#intervalMs = 1000 / hz;
  }

  /** X-04: once, on the first frame whose morphed #game holds a [data-modal] panel (`UiHostConfig.readyWhen` changes the rule) (a late subscriber is called at once) */
  onFirstInteractiveFrame(cb: () => void): void {
    if (this.#interactive) cb();
    else this.#interactiveSubs.push(cb);
  }

  /** true while the live menu backdrop (the opaque `.ss-blank` video, scripts/ui/main.js:114-117) covers the viewport */
  coversScene(): boolean {
    return this.#covers;
  }

  /** true while a `[data-modal]` panel or a chrome modal stands (last UI frame) */
  hasModal(): boolean {
    return this.#modal;
  }

  /** the kernel's UiPort (core §15.8): markDirty is a hint (the render runs every UI frame: it reads `ctx.now()`), uiEvent → bus */
  uiPort(): UiPort {
    return {
      markDirty: () => {},
      uiEvent: (name, payload) => this.#events.emit(name, payload),
    };
  }

  get events(): UiEventBus {
    return this.#events;
  }

  defaultPortState(): PortUiState {
    return defaultPortUiState();
  }

  stats(): Readonly<UiHostStats> {
    return { ...this.#stats };
  }

  /** onDestroy, globals removed, host DOM emptied */
  dispose(): void {
    if (this.#mounted && this.#gameMount && this.#mod.onDestroy) {
      try {
        this.#mod.onDestroy(this.#gameMount);
      } catch (e) {
        this.#once(`ui: onDestroy failed: ${message(e)}`);
      }
    }
    for (const off of this.#uninstall.splice(0).reverse()) off();
    this.#hoist.clear();
    this.#root.replaceChildren();
    this.#container.replaceChildren();
    this.#mounted = false;
    this.#lastHtml = null;
    this.#keys = null;
    this.#ssOpen = null;
    this.#texts = [];
    this.#panel = null;
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Cadence by accumulated time: a frame renders once the time since the last render reaches the interval minus a small jitter
   * tolerance; the debt carries over and is clamped after a render (no catch-up burst after a stall). The tolerance alone lets
   * `hz + 1` renders land inside one second (at a 144 Hz rAF: 61), so a rolling-window guard also refuses a render while the
   * `hz`-th previous one is under a second ago; the refused frame keeps its accumulated time and renders on the next rAF.
   */
  #due(now: number): boolean {
    if (this.#prevT === null) {
      this.#prevT = now;
      this.#acc = 0;
      this.#renderCount = 0;
    } else {
      const dt = now - this.#prevT;
      this.#prevT = now;
      if (dt > 0) this.#acc += dt;
      else if (dt < 0) this.#renderCount = 0; // a new time base: the window history no longer applies
      if (this.#acc + CADENCE_TOLERANCE_MS < this.#intervalMs) return false;
      if (!this.#windowAdmits(now, dt)) return false;
      this.#acc = Math.min(this.#acc - this.#intervalMs, CADENCE_TOLERANCE_MS);
    }
    this.#renderTimes[this.#renderHead] = now;
    this.#renderHead = (this.#renderHead + 1) % CADENCE_RING;
    if (this.#renderCount < CADENCE_RING) this.#renderCount++;
    return true;
  }

  /**
   * At most `hz` renders in any rolling second: a render is admitted once the `hz`-th previous render is a full window old. A tie
   * (exactly one window apart up to float noise) is admitted only when this frame alone fills the interval (a rAF at or below the
   * cap, where refusing would drop a whole frame); on a faster rAF it waits one rAF frame, which costs less than an interval.
   */
  #windowAdmits(now: number, dt: number): boolean {
    const hz = this.#hz;
    if (this.#renderCount < hz) return true;
    const oldest = this.#renderTimes[(this.#renderHead - hz + CADENCE_RING) % CADENCE_RING] ?? -Infinity;
    const over = now - oldest - CADENCE_WINDOW_MS;
    if (over > CADENCE_TIE_MS) return true;
    if (over < -CADENCE_TIE_MS) return false;
    return dt + CADENCE_TOLERANCE_MS >= this.#intervalMs;
  }

  /** index.html has `#tome-game-mount` (build §3.5); a page without one gets it next to the container */
  #findOrMakeGameMount(): HTMLElement {
    const doc = this.#container.ownerDocument;
    const found = doc.getElementById('tome-game-mount');
    if (found) return found;
    const el = doc.createElement('div');
    el.id = 'tome-game-mount';
    this.#container.after(el);
    this.#uninstall.push(() => el.remove());
    return el;
  }

  #portState(): PortUiState {
    return this.#deps.port ? this.#deps.port() : defaultPortUiState();
  }

  #player(): UiPlayerView | null {
    try {
      return makeUiCtx(this.#deps.runtime, this.#portState()).player;
    } catch {
      return null;
    }
  }

  #apply(html: string): void {
    const parts = parseRender(html, this.#cfg.rootId);
    if (parts.style !== null) this.#hoist.setStyle(rewriteCdnUrls([...this.#cfg.styles, parts.style].join('\n'),this.#rewrite));
    if (parts.ssOpen === null) {
      // no #ss: the error plate, '' before main.js loads (ui.js:27), anything else
      this.#full(rewriteCdnUrls(parts.body, this.#rewrite), null, null, []);
      return;
    }
    if (parts.children === null) {
      this.#full(`${parts.ssOpen}${rewriteCdnUrls(parts.inner, this.#rewrite)}</div>`, parts.ssOpen, null, []);
      return;
    }
    const kids: ChildPart[] = [];
    for (const c of parts.children) {
      if (c.tag === 'svg' && this.#hoist.hoistSprite(c.html)) continue;
      kids.push(c);
    }
    const keys = kids.map((c, i) => childKey(c.tag, keyId(c.key), i));
    const texts = kids.map((c) => c.html);
    const ss = this.#root.firstElementChild;
    if (this.#keys !== null && this.#ssOpen !== null && sameKeys(keys, this.#keys) && ss instanceof Element && ss.id === this.#cfg.rootId && this.#domMatches(ss, kids)) {
      if (parts.ssOpen !== this.#ssOpen) {
        patchAttributes(ss, attributesOf(this.#container.ownerDocument, parts.ssOpen));
        this.#ssOpen = parts.ssOpen;
      }
      for (let i = 0; i < texts.length; i++) {
        if (texts[i] === this.#texts[i]) continue;
        morphChild(ss.children[i]!, rewriteCdnUrls(texts[i]!, this.#rewrite));
        this.#stats.childMorphs++;
      }
      this.#texts = texts;
      return;
    }
    const inner = texts.map((t) => rewriteCdnUrls(t, this.#rewrite)).join('');
    this.#full(`${parts.ssOpen}${inner}</div>`, parts.ssOpen, keys, texts);
  }

  #full(html: string, ssOpen: string | null, keys: string[] | null, texts: string[]): void {
    morphInto(this.#root, html);
    this.#stats.fullMorphs++;
    this.#ssOpen = ssOpen;
    this.#keys = keys;
    this.#texts = texts;
  }

  /** the DOM still holds one element per key (a page global may have removed one: ssWelcomeClose, ssClick) */
  #domMatches(ss: Element, kids: readonly ChildPart[]): boolean {
    const els = ss.children;
    if (els.length !== kids.length) return false;
    for (let i = 0; i < kids.length; i++) {
      const el = els[i]!;
      const k = kids[i]!;
      if (el.localName !== k.tag) return false;
      const id = keyId(k.key);
      if (id !== null && el.id !== id) return false;
    }
    return true;
  }

  #scan(): void {
    const root = this.#root;
    const modal = root.querySelector('[data-modal]') !== null || (this.#deps.chrome?.hasModal() ?? false);
    this.#modal = modal;
    this.#covers = root.querySelector(`#${this.#cfg.rootId} > ${this.#cfg.blankSelector}`) !== null;
    this.#trackPanel();
    if (this.#deps.pointer) {
      try {
        this.#deps.pointer.setModal(modal);
      } catch (e) {
        this.#once(`ui: pointer setModal failed: ${message(e)}`);
      }
    }
    if (!this.#interactive && this.#readyNow(root)) {
      this.#interactive = true;
      for (const cb of this.#interactiveSubs.splice(0)) {
        try {
          cb();
        } catch (e) {
          this.#once(`ui: onFirstInteractiveFrame subscriber failed: ${message(e)}`);
        }
      }
    }
  }

  /** UiHostConfig.readyWhen: is this frame the first interactive one */
  #readyNow(root: Element): boolean {
    const when = this.#cfg.readyWhen;
    if (when === 'modal') return root.querySelector(`#${this.#cfg.rootId} [data-modal]`) !== null;
    if (when === 'firstFrame') return true;
    if (when === 'firstUiRender') return (this.#lastHtml ?? '').trim() !== '';
    try {
      return root.querySelector(when) !== null;
    } catch {
      this.#once(`ui: readyWhen ${JSON.stringify(when)} is not a valid selector`);
      return false;
    }
  }

  #trackPanel(): void {
    const el = this.#root.querySelector('[data-modal]');
    const next = el === null ? null : (el.getAttribute('data-panel') ?? (el.id !== '' ? el.id : 'modal'));
    const prev = this.#panel;
    if (prev === next) return;
    this.#panel = next;
    try {
      this.#deps.onPanelChange?.(prev, next);
    } catch (e) {
      this.#once(`ui: onPanelChange failed: ${message(e)}`);
    }
  }

  #once(msg: string): void {
    if (this.#reported.has(msg)) return;
    this.#reported.add(msg);
    this.#log(msg);
  }
}

/** the id part of a `tag#id` key, null for a positional `tag@n` key */
function keyId(key: string): string | null {
  const h = key.indexOf('#');
  return h === -1 ? null : key.slice(h + 1);
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
