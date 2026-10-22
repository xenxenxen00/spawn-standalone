import { afterEach, describe, expect, it, vi } from 'vitest';
import * as port from '../../src/compat/builtin/port.ts';
import portDefault, {
  PORT_FLAG_DEFAULTS,
  fidelity,
  installPortFlags,
  onPortFlagChange,
  portFlag,
  resetPortFlags,
  setPortFlag,
} from '../../src/compat/builtin/port.ts';

afterEach(() => {
  resetPortFlags();
});

/** the suite stub's lookup (tools/spawn-suite/hooks/ss-stub-hooks.ts portStub), over a table */
function stubLookup(T: Record<string, unknown>) {
  const key = (kind: string, id: string): string => (id.startsWith(`${kind}.`) ? id : `${kind}.${id}`);
  return {
    fidelity: (id: string) => T[key('fidelity', String(id))] === true,
    portFlag: (name: string): unknown => {
      const n = String(name);
      if (n in T) return T[n];
      const k = key('port', n);
      if (k in T) return T[k];
      const c = key('content', n);
      if (c in T) return T[c];
      return undefined;
    },
  };
}

describe('the neutral defaults', () => {
  it('installs no application flags implicitly', () => {
    expect(PORT_FLAG_DEFAULTS).toEqual({}); expect(port.flags).toEqual({});
    expect(fidelity('example')).toBe(false); expect(portFlag('example')).toBeUndefined();
    expect(Object.isFrozen(PORT_FLAG_DEFAULTS)).toBe(true); expect(Object.isFrozen(port.flags)).toBe(true);
  });
});

const FIX_FLAGS = [{ id: 'effect', defaultOn: true }, { id: 'detail', defaultOn: false }];
const portFlagTable = (profile: string): Record<string, unknown> => ({ 'fidelity.effect': true, 'fidelity.detail': profile === 'all-fixes', 'port.simCaps': 'host-selected', 'content.botCount': 3 });

describe('the lookup the edits were written against', () => {
  it('answers like the live-suite stub for both flag profiles', () => {
    for (const profile of ['default', 'all-fixes'] as const) {
      const table = portFlagTable(profile);
      installPortFlags(table);
      const stub = stubLookup(table);
      for (const id of [...FIX_FLAGS.map((f) => f.id), ...FIX_FLAGS.map((f) => `fidelity.${f.id}`), 'FX-77', 'DR-18']) {
        expect(fidelity(id), `${profile} fidelity(${id})`).toBe(stub.fidelity(id));
      }
      for (const name of ['simCaps', 'botCount', 'port.simCaps', 'content.botCount', 'fidelity.DR-18', 'screenFlash', 'ads.toLobby', 'nav.bakeAtLoad', 'missing']) {
        expect(portFlag(name), `${profile} portFlag(${name})`).toEqual(stub.portFlag(name));
      }
    }
  });

  it('reads the key as given before port.<name> before content.<name>', () => {
    installPortFlags({ simCaps: 'raw', 'port.simCaps': 'low', 'content.simCaps': 'c', 'content.only': 3, 'port.both': 'p', 'content.both': 'c' });
    expect(portFlag('simCaps')).toBe('raw');
    expect(portFlag('only')).toBe(3);
    expect(portFlag('both')).toBe('p');
  });

  it('exports what the edited modules import: named fidelity / portFlag / flags and a default object', () => {
    expect(typeof port.fidelity).toBe('function');
    expect(typeof port.portFlag).toBe('function');
    expect(portDefault.fidelity).toBe(fidelity);
    expect(portDefault.portFlag).toBe(portFlag);
    expect(portDefault.flags).toBe(port.flags);
  });
});

describe('install and runtime overrides', () => {
  it('installPortFlags lays the build\'s table (host inputs) over the defaults; flags is a live binding', () => {
    installPortFlags({ 'fidelity.FX-04': true, 'port.simCaps': 'low' });
    expect(fidelity('FX-04')).toBe(true);
    expect(fidelity('FX-01')).toBe(false); // an absent key remains absent
    expect(port.flags['port.simCaps']).toBe('low');
    expect(portDefault.flags['port.simCaps']).toBe('low');
    installPortFlags({ 'fidelity.FX-20': false }); // a second install starts again from the defaults
    expect(fidelity('FX-04')).toBe(false);
    expect(fidelity('FX-20')).toBe(false);
  });

  it('setPortFlag overrides one key over the installed table; undefined clears the override', () => {
    setPortFlag('port.simCaps', 'low'); // the low / minimum tiers (X-38)
    expect(portFlag('simCaps')).toBe('low');
    installPortFlags({ ...PORT_FLAG_DEFAULTS, 'port.simCaps': 'live' });
    expect(portFlag('simCaps')).toBe('low'); // an override outlives a re-install
    setPortFlag('port.simCaps', undefined);
    expect(portFlag('simCaps')).toBe('live');
    expect(() => setPortFlag('', 1)).toThrow(TypeError);
  });

  it('tells subscribers about every effective change', () => {
    const seen: Array<[string, unknown]> = [];
    const off = onPortFlagChange((key, value) => seen.push([key, value]));
    setPortFlag('port.screenFlash', 'overlay');
    setPortFlag('port.screenFlash', 'overlay'); // no change
    setPortFlag('port.screenFlash', undefined);
    installPortFlags({ ...PORT_FLAG_DEFAULTS, 'port.rawMouse': true });
    off();
    setPortFlag('port.rawMouse', false);
    expect(seen).toEqual([
      ['port.screenFlash', 'overlay'],
      ['port.screenFlash', undefined],
      ['port.rawMouse', true],
    ]);
  });

  it('a throwing subscriber does not stop the others', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = vi.fn();
    onPortFlagChange(() => {
      throw new Error('x');
    });
    onPortFlagChange(b);
    setPortFlag('port.simCaps', 'low');
    expect(b).toHaveBeenCalledWith('port.simCaps', 'low');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('copies installed values (a later mutation of the source table changes nothing)', () => {
    const src: Record<string, unknown> = { 'nav.bakeAtLoad': ['custom-place'] };
    installPortFlags(src);
    (src['nav.bakeAtLoad'] as string[]).push('x');
    src['nav.bakeAtLoad'] = [];
    expect(portFlag('nav.bakeAtLoad')).toEqual(['custom-place']);
  });

  it('resetPortFlags restores the defaults and drops overrides and subscribers', () => {
    const fn = vi.fn();
    onPortFlagChange(fn);
    installPortFlags({});
    setPortFlag('port.simCaps', 'low');
    fn.mockClear();
    resetPortFlags();
    expect(port.flags).toEqual(PORT_FLAG_DEFAULTS);
    setPortFlag('port.simCaps', 'low');
    expect(fn).not.toHaveBeenCalled();
  });
});
