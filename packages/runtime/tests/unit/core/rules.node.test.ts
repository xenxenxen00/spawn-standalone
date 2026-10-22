// Engine constants, rule switches and the X-07 pause-reason tables (docs/design/core-runtime.md §3.6, §9.1;
// docs/architecture.md X-07, X-12).
import { describe, expect, it } from 'vitest';
import {
  ACT_NAMES,
  AUDIO_SUSPEND_REASONS,
  ENGINE,
  ENGINE_RULES,
  HOST_PAUSE_REASONS,
  OVERLAY_ESCALATING_REASONS,
  PAUSE_REASONS,
  PAUSE_REASON_OWNER,
  isActName,
  isPauseReason,
  resolveRules,
  suspendsAudio,
} from '../../../src/compat/core/rules.ts';
import type { PauseReason } from '../../../src/compat/core/types.ts';

describe('X-07 pause reasons', () => {
  it('lists the built-in reasons in the order of docs/architecture.md X-07', () => {
    expect(PAUSE_REASONS).toEqual(['boot', 'loading', 'preparing', 'platform', 'hidden', 'overlay', 'orientation', 'gpu', 'test']);
    expect(new Set(PAUSE_REASONS).size).toBe(9);
    expect(Object.isFrozen(PAUSE_REASONS)).toBe(true);
  });

  it('assigns each reason to its one setter: kernel boot/loading, the LOADING gate preparing, the PauseController the rest', () => {
    const by = (owner: string): PauseReason[] => PAUSE_REASONS.filter((r) => PAUSE_REASON_OWNER[r] === owner);
    expect(by('kernel')).toEqual(['boot', 'loading']);
    expect(by('loading-gate')).toEqual(['preparing']);
    expect(by('pause-controller')).toEqual([...HOST_PAUSE_REASONS]);
    expect(HOST_PAUSE_REASONS).toEqual(['platform', 'hidden', 'overlay', 'orientation', 'gpu', 'test']);
  });

  it('suspends audio for platform, ad, hidden, overlay, orientation and gpu only', () => {
    expect(AUDIO_SUSPEND_REASONS).toEqual(['platform', 'hidden', 'overlay', 'orientation', 'gpu']);
    for (const r of PAUSE_REASONS) {
      expect(suspendsAudio([r]), r).toBe(!['boot', 'loading', 'preparing', 'test'].includes(r));
    }
    expect(suspendsAudio([])).toBe(false);
    expect(suspendsAudio(new Set<PauseReason>(['boot', 'loading', 'preparing', 'test']))).toBe(false);
    expect(suspendsAudio(new Set<PauseReason>(['test', 'hidden']))).toBe(true);
  });

  it('escalates platform, ad and hidden pauses during a match to overlay', () => {
    expect(OVERLAY_ESCALATING_REASONS).toEqual(['platform', 'hidden']);
  });

  it('recognises nonempty host reasons at run time', () => {
    for (const r of PAUSE_REASONS) expect(isPauseReason(r)).toBe(true);
    for (const x of ['', undefined, null, 3]) expect(isPauseReason(x), String(x)).toBe(false);
  });
});

describe('engine acts (core §8.6)', () => {
  it('names the seventeen acts (X-47: TR1 adds `milestone`, RH1 `highlightSet` and `highlightClear`); every other emit name is a custom event', () => {
    expect(ACT_NAMES).toEqual([
      'playSound', 'stopSound', 'fx', 'decal', 'screenShake', 'cameraPunch', 'screenFlash', 'hitstop', 'shake', 'impulse',
      'shockwave', 'damageNumber', 'uiEvent', 'slowMo', 'milestone', 'highlightSet', 'highlightClear',
    ]);
    for (const a of ACT_NAMES) expect(isActName(a)).toBe(true);
    // `press` is an ordinary targeted event (contract §6.4), not an act
    for (const x of ['press', 'ss:req', 'haptic', 'PlaySound', undefined]) expect(isActName(x), String(x)).toBe(false);
  });
});

describe('ENGINE constants (core §3.6)', () => {
  it('fixes the clock: 30 Hz, epoch 1,000,000 ms, sims every 3rd tick at phase 2, ≤ 2 ticks per frame', () => {
    expect(ENGINE.TICK_HZ).toBe(30);
    expect(ENGINE.TICK_MS).toBe(1000 / 30);
    expect(ENGINE.NOW_EPOCH_MS).toBe(1_000_000);
    expect(ENGINE.SIM_EVERY_TICKS).toBe(3);
    expect(ENGINE.SIM_TICK_PHASE).toBe(2);
    expect(ENGINE.SIM_EVERY_TICKS * ENGINE.TICK_MS).toBeCloseTo(ENGINE.SIM_CADENCE_MS, 9);
    expect(ENGINE.MAX_TICKS_PER_FRAME).toBe(2);
    expect(ENGINE.MAX_FRAME_DT_MS).toBe(250);
    expect(ENGINE.RIG_DT_MAX_S).toBe(0.1);
  });

  it('fixes the world numbers', () => {
    expect(ENGINE.DRAIN_CAP).toBe(10_000);
    expect(ENGINE.OOB_DEFAULT_DEPTH_M).toBe(64);
    expect(ENGINE.GRAVITY_DEFAULT).toEqual({ x: 0, y: -9.81, z: 0 });
    expect(ENGINE.STATE_WARN_BYTES).toBe(32768);
    expect(ENGINE.CELL_SIZE_M).toBe(128);
    expect(ENGINE.SPATIAL_CELL_M).toBe(16);
  });

  it('is frozen, nested gravity included', () => {
    expect(Object.isFrozen(ENGINE)).toBe(true);
    expect(Object.isFrozen(ENGINE.GRAVITY_DEFAULT)).toBe(true);
  });
});

describe('ENGINE_RULES (core §3.6, §17)', () => {
  it('defaults to the cascade ownership, the samePlace sim reach and onDestroy on unload', () => {
    expect(ENGINE_RULES).toEqual({ spawnerOwnership: 'cascade', defaultEmitReachesSims: 'samePlace', runOnDestroyOnUnload: true });
    expect(Object.isFrozen(ENGINE_RULES)).toBe(true);
  });

  it('applies per-kernel overrides without touching the defaults', () => {
    const r = resolveRules({ spawnerOwnership: 'off' });
    expect(r).toEqual({ spawnerOwnership: 'off', defaultEmitReachesSims: 'samePlace', runOnDestroyOnUnload: true });
    expect(Object.isFrozen(r)).toBe(true);
    expect(ENGINE_RULES.spawnerOwnership).toBe('cascade');
    expect(resolveRules()).toEqual(ENGINE_RULES);
    expect(resolveRules({ defaultEmitReachesSims: undefined } as never)).toEqual(ENGINE_RULES);
  });
});
