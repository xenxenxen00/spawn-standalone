// K3: GameDeps.rigs reaches installRenderBridge as `rigs`; absent, the bridge option object is empty (PP).
import { describe, expect, it, vi } from 'vitest';

// install.ts reads the vendor virtual module at import; the unit config has no plugin for it
vi.mock('virtual:ss/vendor', () => ({ vendor: {} }));
import { rigsBridgeOption } from '../../src/render/world/install.ts';
import { ScriptRigs } from '../../src/render/rig/script-rigs.ts';

describe('GameDeps.rigs', () => {
  it('forwards the very cache the game handed in', () => {
    const rigs = new ScriptRigs();
    expect(rigsBridgeOption({ rigs }).rigs).toBe(rigs);
  });
  it('adds nothing without it', () => {
    expect(rigsBridgeOption({})).toEqual({});
    expect('rigs' in rigsBridgeOption({})).toBe(false);
  });
});
