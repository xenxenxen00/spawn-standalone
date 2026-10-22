// rebind (io §4.7; system-ui.md §3.7a.5): the binding capture behind the CONTROLS
// rebind buttons (E-UI-04) — capture, swap, clear, reset, Escape cancel.
import { describe, expect, it } from 'vitest';
import {
  BindingCapture,
  CAPTURE_PROMPT,
  FLASH_MS,
  installRebind,
  labelForToken,
  type BindsStore,
  type CaptureTarget,
  type RebindDeps,
} from '../../../src/runtime/input/rebind.ts';
import type { InputsDef } from '../../../src/compat/core/types.ts';

const LIVE: InputsDef = {
  actions: {
    jump: { keys: ['space'] },
    fire: { mouse: 'left' },
    ads: { mouse: 'right' },
    reload: { keys: ['r'] },
    heal: { keys: ['q'] },
    ss_req: {},
  },
  axes: { moveX: { keys: 'a/d' } },
};

const LIVE_JSON = JSON.stringify(LIVE);

interface Rig {
  cap: BindingCapture;
  store: BindsStore;
  saves: number;
  applied: InputsDef[];
  flashed: Array<[string, string]>;
  captures: Array<CaptureTarget | null>;
}

function rig(): Rig {
  const r: Rig = {
    cap: null as unknown as BindingCapture,
    store: null as unknown as BindsStore,
    saves: 0,
    applied: [],
    flashed: [],
    captures: [],
  };
  const deps: RebindDeps = {
    live: LIVE,
    store: (r.store = { binds: {}, save: () => void r.saves++ }),
    setInputs: (m) => void r.applied.push(m),
    flash: (a, b) => void r.flashed.push([a, b]),
    onCapture: (t) => void r.captures.push(t),
  };
  r.cap = new BindingCapture(deps);
  return r;
}

const lastApplied = (r: Rig): InputsDef => r.applied[r.applied.length - 1]!;

describe('constants', () => {
  it('the capture prompt and the swap flash length', () => {
    expect(CAPTURE_PROMPT).toBe('PRESS A KEY · ESC CANCELS · DEL CLEARS');
    expect(FLASH_MS).toBe(450);
  });
});

describe('begin', () => {
  it('opens capture on a declared action slot and reports the target', () => {
    const r = rig();
    expect(r.cap.begin('reload', 0)).toBe(true);
    expect(r.cap.capturing).toEqual({ action: 'reload', slot: 0 });
    expect(r.captures).toEqual([{ action: 'reload', slot: 0 }]);
  });

  it('opens capture on the mouse slot (slot = keys.length)', () => {
    const r = rig();
    expect(r.cap.begin('fire', 0)).toBe(true);
    expect(r.cap.capturing).toEqual({ action: 'fire', slot: 0 });
  });

  it('refuses what is not rebindable: unknown actions, data channels, bad slots', () => {
    const r = rig();
    expect(r.cap.begin('ghost', 0)).toBe(false);
    expect(r.cap.begin('ss_req', 0)).toBe(false);
    expect(r.cap.begin('reload', 1)).toBe(false);
    expect(r.cap.begin('reload', -1)).toBe(false);
    expect(r.cap.begin('reload', 0.5)).toBe(false);
    expect(r.cap.begin('axis:ghost', 0)).toBe(false);
    expect(r.cap.capturing).toBeNull();
    expect(r.captures).toEqual([]);
  });

  it('re-begin switches the target', () => {
    const r = rig();
    expect(r.cap.begin('reload', 0)).toBe(true);
    expect(r.cap.begin('heal', 0)).toBe(true);
    expect(r.cap.capturing).toEqual({ action: 'heal', slot: 0 });
  });
});

describe('capture', () => {
  it('a keydown rebinds the slot, persists overrides-only, and rebuilds the effective map', () => {
    const r = rig();
    expect(r.cap.begin('reload', 0)).toBe(true);
    expect(r.cap.keyDown('KeyT')).toBe('consumed');
    expect(r.cap.capturing).toBeNull();
    expect(r.store.binds).toEqual({ actions: { reload: { keys: ['KeyT'] } } });
    expect(r.saves).toBe(1);
    expect(lastApplied(r).actions!['reload']).toEqual({ keys: ['KeyT'] });
    // the live map is never mutated or shared
    expect(JSON.stringify(LIVE)).toBe(LIVE_JSON);
    expect(r.captures[r.captures.length - 1]).toBeNull();
  });

  it('capturing the token the slot already holds is a no-op', () => {
    const r = rig();
    r.cap.begin('reload', 0);
    r.cap.keyDown('KeyT');
    const saves = r.saves;
    r.cap.begin('reload', 0);
    r.cap.keyDown('KeyT');
    expect(r.saves).toBe(saves);
    expect(r.store.binds).toEqual({ actions: { reload: { keys: ['KeyT'] } } });
  });

  it('rebinding back to the live token removes the override entry', () => {
    const r = rig();
    r.cap.begin('reload', 0);
    r.cap.keyDown('KeyT');
    expect(r.store.binds).toEqual({ actions: { reload: { keys: ['KeyT'] } } });
    r.cap.begin('reload', 0);
    r.cap.keyDown('r');
    expect(r.store.binds).toEqual({});
    expect(lastApplied(r).actions!['reload']).toEqual({ keys: ['r'] });
  });

  it('events are ignored while not capturing', () => {
    const r = rig();
    expect(r.cap.keyDown('KeyT')).toBe('ignored');
    expect(r.cap.pointerDown(0)).toBe('ignored');
    expect(r.cap.wheel('wheelUp')).toBe('ignored');
    expect(r.store.binds).toEqual({});
    expect(r.saves).toBe(0);
  });

  it('a pointer button captures a mouse token onto a key slot', () => {
    const r = rig();
    r.cap.begin('reload', 0);
    expect(r.cap.pointerDown(3)).toBe('consumed');
    expect(r.store.binds).toEqual({ actions: { reload: { keys: [], mouse: 'mouse4' } } });
    expect(lastApplied(r).actions!['reload']).toEqual({ keys: [], mouse: 'mouse4' });
  });

  it('buttons outside 0-4 are ignored and the capture stays open', () => {
    const r = rig();
    r.cap.begin('reload', 0);
    expect(r.cap.pointerDown(9)).toBe('ignored');
    expect(r.cap.capturing).toEqual({ action: 'reload', slot: 0 });
  });

  it('a wheel pulse captures a wheel token', () => {
    const r = rig();
    r.cap.begin('fire', 0);
    expect(r.cap.wheel('wheelDown')).toBe('consumed');
    expect(r.store.binds).toEqual({ actions: { fire: { mouse: 'wheelDown' } } });
  });

  it('an invalid wheel direction is ignored', () => {
    const r = rig();
    r.cap.begin('fire', 0);
    expect(r.cap.wheel('sideways' as 'wheelUp')).toBe('ignored');
    expect(r.cap.capturing).toEqual({ action: 'fire', slot: 0 });
  });
});

describe('Escape cancels', () => {
  it('nothing is written, nothing is persisted, the capture ends', () => {
    const r = rig();
    r.cap.begin('reload', 0);
    expect(r.cap.keyDown('Escape')).toBe('consumed');
    expect(r.cap.capturing).toBeNull();
    expect(r.store.binds).toEqual({});
    expect(r.saves).toBe(0);
    expect(r.applied).toEqual([]);
    expect(r.captures[r.captures.length - 1]).toBeNull();
  });

  it('cancel() ends a capture without changes', () => {
    const r = rig();
    r.cap.begin('reload', 0);
    r.cap.cancel();
    expect(r.cap.capturing).toBeNull();
    expect(r.saves).toBe(0);
  });
});

describe('Delete clears', () => {
  it('Delete empties the slot', () => {
    const r = rig();
    r.cap.begin('heal', 0);
    expect(r.cap.keyDown('Delete')).toBe('consumed');
    expect(r.store.binds).toEqual({ actions: { heal: { keys: [] } } });
    expect(lastApplied(r).actions!['heal']).toEqual({ keys: [] });
    expect(r.saves).toBe(1);
  });

  it('Delete on the mouse slot drops the mouse binding', () => {
    const r = rig();
    r.cap.begin('fire', 0);
    r.cap.keyDown('Delete');
    expect(r.store.binds).toEqual({ actions: { fire: { mouse: null } } });
    expect(lastApplied(r).actions!['fire']).toEqual({});
  });
});

describe('swap', () => {
  it('a token held by another action is swapped onto it and both rows flash', () => {
    const r = rig();
    // heal's live 'q' Spawn token is the same physical key as the captured 'KeyQ': swap
    r.cap.begin('reload', 0);
    r.cap.keyDown('KeyQ');
    expect(r.store.binds).toEqual({
      actions: { reload: { keys: ['KeyQ'] }, heal: { keys: ['r'] } },
    });
    expect(r.flashed).toEqual([['reload', 'heal']]);
    expect(r.saves).toBe(1);
    expect(lastApplied(r).actions!['reload']).toEqual({ keys: ['KeyQ'] });
    expect(lastApplied(r).actions!['heal']).toEqual({ keys: ['r'] });
  });

  it('a mouse token held by another action swaps the mouse bindings', () => {
    const r = rig();
    r.cap.begin('fire', 0);
    r.cap.pointerDown(2); // right, held by ads
    expect(r.store.binds).toEqual({
      actions: { fire: { mouse: 'right' }, ads: { mouse: 'left' } },
    });
    expect(r.flashed).toEqual([['fire', 'ads']]);
  });

  it('a key held by an axis half swaps with the axis', () => {
    const r = rig();
    r.cap.begin('reload', 0);
    r.cap.keyDown('KeyA'); // the neg half of moveX
    expect(r.store.binds).toEqual({
      actions: { reload: { keys: ['KeyA'] } },
      axes: { moveX: 'r/d' },
    });
    expect(r.flashed).toEqual([['reload', 'axis:moveX']]);
  });
});

describe('reset', () => {
  it('ssBindReset empties the overrides and rebuilds the live map', () => {
    const r = rig();
    r.cap.begin('reload', 0);
    r.cap.keyDown('KeyT');
    r.cap.begin('axis:moveX', 0);
    r.cap.keyDown('KeyJ');
    expect(r.store.binds).not.toEqual({});
    r.cap.reset();
    expect(r.store.binds).toEqual({});
    expect(r.saves).toBe(3);
    expect(lastApplied(r)).toEqual(LIVE);
    expect(r.cap.capturing).toBeNull();
  });

  it('reset ends an open capture', () => {
    const r = rig();
    r.cap.begin('reload', 0);
    r.cap.reset();
    expect(r.cap.capturing).toBeNull();
    expect(r.captures[r.captures.length - 1]).toBeNull();
  });
});

describe('axes', () => {
  it('an axis exposes its two key halves as slots 0/1', () => {
    const r = rig();
    expect(r.cap.begin('axis:moveX', 0)).toBe(true);
    r.cap.keyDown('KeyJ');
    expect(r.store.binds).toEqual({ axes: { moveX: 'KeyJ/d' } });
    expect(lastApplied(r).axes!['moveX']).toEqual({ keys: 'KeyJ/d' });
    expect(r.cap.begin('axis:moveX', 1)).toBe(true);
    r.cap.keyDown('KeyL');
    expect(r.store.binds).toEqual({ axes: { moveX: 'KeyJ/KeyL' } });
  });

  it('a non-key token is ignored on an axis and the capture stays open', () => {
    const r = rig();
    r.cap.begin('axis:moveX', 0);
    expect(r.cap.pointerDown(0)).toBe('consumed');
    expect(r.cap.capturing).toEqual({ action: 'axis:moveX', slot: 0 });
    expect(r.store.binds).toEqual({});
    expect(r.saves).toBe(0);
  });

  it('Delete is refused on an axis: a pair cannot have an empty half', () => {
    const r = rig();
    r.cap.begin('axis:moveX', 0);
    expect(r.cap.keyDown('Delete')).toBe('consumed');
    expect(r.cap.capturing).toEqual({ action: 'axis:moveX', slot: 0 });
    expect(r.store.binds).toEqual({});
  });

  it('rebinding an axis half back to live removes the override', () => {
    const r = rig();
    r.cap.begin('axis:moveX', 0);
    r.cap.keyDown('KeyJ');
    r.cap.begin('axis:moveX', 0);
    r.cap.keyDown('a');
    expect(r.store.binds).toEqual({});
  });
});

describe('labelForToken', () => {
  it('codes, mouse and wheel tokens print as keycaps', () => {
    expect(labelForToken('KeyE')).toBe('E');
    expect(labelForToken('Digit1')).toBe('1');
    expect(labelForToken('Numpad0')).toBe('NUM 0');
    expect(labelForToken('ArrowUp')).toBe('UP');
    expect(labelForToken('space')).toBe('SPACE');
    expect(labelForToken('mouse4')).toBe('MOUSE 4');
    expect(labelForToken('mouse5')).toBe('MOUSE 5');
    expect(labelForToken('left')).toBe('LEFT CLICK');
    expect(labelForToken('right')).toBe('RIGHT CLICK');
    expect(labelForToken('wheelUp')).toBe('WHEEL UP');
    expect(labelForToken('wheelDown')).toBe('WHEEL DOWN');
  });

  it('layout-aware letters when a layout map is known', () => {
    expect(labelForToken('q', new Map([['KeyQ', 'a']]))).toBe('A');
  });
});

describe('installRebind', () => {
  it('publishes ssBind/ssBindReset/ssCapture/ssBindingCapture on the target', () => {
    const target: Record<string, unknown> = {};
    const deps: RebindDeps = {
      live: LIVE,
      store: { binds: {}, save: () => {} },
      setInputs: () => {},
    };
    const cap = installRebind(target, deps);
    expect(target['ssBindingCapture']).toBe(cap);
    const ssBind = target['ssBind'] as (a: string, s: number) => boolean;
    const ssBindReset = target['ssBindReset'] as () => void;
    expect(ssBind('reload', 0)).toBe(true);
    expect(target['ssCapture']).toEqual({ action: 'reload', slot: 0 });
    (cap.keyDown as (c: string) => string)('KeyT');
    expect(target['ssCapture']).toBeNull();
    expect(deps.store.binds).toEqual({ actions: { reload: { keys: ['KeyT'] } } });
    ssBindReset();
    expect(deps.store.binds).toEqual({});
  });
});

describe('the live map is never mutated', () => {
  it('holds across every operation', () => {
    const r = rig();
    r.cap.begin('reload', 0);
    r.cap.keyDown('KeyT');
    r.cap.begin('fire', 0);
    r.cap.pointerDown(2);
    r.cap.begin('heal', 0);
    r.cap.keyDown('Delete');
    r.cap.begin('axis:moveX', 1);
    r.cap.keyDown('KeyL');
    r.cap.reset();
    expect(JSON.stringify(LIVE)).toBe(LIVE_JSON);
  });
});
