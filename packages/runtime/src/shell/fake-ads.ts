// Copied from purge-protocol-web ebab692 src/platform/fake-ads.ts (the overlay is read through a local so strict null checks hold).
// Dev-only fake ads (build §6.6, platform-playgama.md §11.4): exercise the pause, mute, input-block and reward flows without
// the QA Tool. select.ts creates them only when `import.meta.env.DEV || __SS_TEST_HOOKS__` and the page has `?fakeAds=1`
// (`?fakeAds=fail` simulates a no-fill), so production builds drop this module.
//
// A shown ad runs the Bridge's order of events on its host adapter:
//   adBusy(true) → host pause + mute (PAUSE_STATE_CHANGED / AUDIO_STATE_CHANGED) → adPause → overlay for `durationMs`
//   (3 s; a CLOSE button ends it early) → adResume → host pause + mute released → adBusy(false) → settle.
// A rewarded ad grants the reward only when it ran to the end. A request while one is in flight answers `busy` at once.
import type { AdHost, AdKind, AdProvider, AdResult, Placement } from '../platform/platform.ts';
import { INTERSTITIAL_PLACEMENTS } from '../platform/platform.ts';

export type FakeAdsMode = 'off' | 'show' | 'fail';

/** `?fakeAds=1` → show, `?fakeAds=fail` → fail (no fill), anything else → off */
export function fakeAdsModeFromQuery(search: string): FakeAdsMode {
  const v = new URLSearchParams(search).get('fakeAds');
  if (v === '1' || v === 'true' || v === 'show') return 'show';
  if (v === 'fail') return 'fail';
  return 'off';
}

export interface FakeAdsOptions {
  mode: Exclude<FakeAdsMode, 'off'>;
  /** how long an ad stays on screen (default 3000 ms) */
  durationMs?: number;
  /** how long a no-fill takes to answer (default 300 ms) */
  failAfterMs?: number;
}

const OVERLAY_STYLE =
  'position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
  'gap:16px;background:rgba(0,0,0,.92);color:#fff;font:600 18px/1.4 system-ui,sans-serif;letter-spacing:.08em;';
const BUTTON_STYLE = 'padding:8px 18px;border:1px solid #fff;background:transparent;color:#fff;font:inherit;cursor:pointer;';

export function createFakeAds(host: AdHost, opts: FakeAdsOptions): AdProvider {
  const durationMs = opts.durationMs ?? 3000;
  const failAfterMs = opts.failAfterMs ?? 300;
  let inFlight = false;
  let cancel: (() => void) | null = null;

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** shows the overlay; resolves true when the ad ran to the end, false when closed early */
  const present = (kind: AdKind, placement: Placement): Promise<boolean> =>
    new Promise((resolve) => {
      const doc = host.document;
      let overlay: HTMLElement | null = null;
      let done = false;
      const finish = (completed: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        overlay?.remove();
        cancel = null;
        resolve(completed);
      };
      const timer = setTimeout(() => finish(true), durationMs);
      cancel = () => finish(false);
      if (doc?.body) {
        const el = doc.createElement('div');
        overlay = el;
        el.setAttribute('data-ss-fake-ad', kind);
        el.setAttribute('style', OVERLAY_STYLE);
        const label = doc.createElement('div');
        label.textContent = `FAKE AD · ${kind} · ${placement}`;
        const close = doc.createElement('button');
        close.type = 'button';
        close.setAttribute('data-ss-fake-ad-close', '');
        close.setAttribute('style', BUTTON_STYLE);
        close.textContent = kind === 'rewarded' ? 'CLOSE (NO REWARD)' : 'CLOSE';
        close.addEventListener('click', () => finish(false));
        el.append(label, close);
        doc.body.append(el);
      }
    });

  const showAd = async (kind: AdKind, placement: Placement): Promise<AdResult> => {
    if (inFlight) return { shown: false, reason: 'busy' };
    inFlight = true;
    host.emit('adBusy', true);
    try {
      if (opts.mode === 'fail') {
        await wait(failAfterMs);
        return { shown: false, reason: 'other' };
      }
      host.setAdHold(true);
      host.emit('adPause');
      const completed = await present(kind, placement);
      host.emit('adResume');
      host.setAdHold(false);
      return { shown: true, rewarded: kind === 'rewarded' && completed };
    } finally {
      inFlight = false;
      host.emit('adBusy', false);
    }
  };

  return {
    showAd,
    placements: INTERSTITIAL_PLACEMENTS,
    rewarded: true,
    dispose: () => cancel?.(),
  };
}
