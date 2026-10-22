import { describe, expect, it } from 'vitest';
import { resolveUiHostConfig } from '../../src/runtime/ui/ui-host-config.ts';
import { defaultPortUiState } from '../../src/runtime/ui/ui-ctx.ts';
import { resolveDataChannels } from '../../src/runtime/input/input-options.ts';
import { Look } from '../../src/runtime/input/look.ts';

describe('public host defaults', () => {
  it('clamps both initial and invalid sensitivity to the authored range', () => {
    const look=new Look({}, {sensitivityRange:[0,0.5]});
    expect(look.sens).toBe(0.5);
    look.setPrefs({sens:NaN});expect(look.sens).toBe(0.5);
  });
  it('accepts authored look tuning without changing the engine delta scale', () => {
    const look = new Look({ sens: 8 }, { sensitivity: 1, sensitivityRange: [0, 10], pitchLimit: 0.25 });
    look.push(100, 100);
    expect(look.integrate()).toEqual({ yaw: -0.48, pitch: -0.25 });
    expect(look.deltasFor(100, 0).lookX).toBeCloseTo(0.48);
    expect(() => new Look({}, { sensitivityRange: [4, 1] })).toThrow(/sensitivityRange/);
  });
  it('accepts an arbitrary UI without game handlers, styles or a modal gate', () => {
    expect(resolveUiHostConfig(undefined)).toMatchObject({
      rootId: 'game', globals: 'auto', gameCss: false, readyWhen: 'firstUiRender',
    });
    expect(defaultPortUiState()).toEqual({});
  });

  it('derives data-only actions from the supplied world, with explicit overrides isolated', () => {
    const inputs = { actions: { submit: {}, move: { keys: ['w'] }, click: { mouse: 'left' as const } } };
    expect([...resolveDataChannels(undefined, inputs)]).toEqual(['submit']);
    expect([...resolveDataChannels({ dataChannels: ['custom'] }, inputs)]).toEqual(['custom']);
    expect([...resolveDataChannels(undefined, { actions: { other: {} } })]).toEqual(['other']);
  });
});
