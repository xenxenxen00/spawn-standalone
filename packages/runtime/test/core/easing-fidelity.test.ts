// `easeOutBack` is not a Spawn easing, so it is not one here. Spawn's engine api reference lists 23 `builtin/easing` curves
// (api-reference.md:1468: linear, easeOutBounce, and the In/Out/InOut of Quad, Cubic, Quart, Quint, Sine, Expo, Circ); neither it nor
// the llms-full doc build names a Back curve. A game that asks for one ran on Spawn with the unknown-name fallback, which is linear,
// so the standalone keeps linear for fidelity (a Back curve would make the same game animate differently here). This pins both.
import { describe, expect, it } from 'vitest';
import { EASINGS } from '../../src/compat/builtin/tween.ts';

const DOCUMENTED = [
  'linear', 'easeOutBounce',
  ...['Quad', 'Cubic', 'Quart', 'Quint', 'Sine', 'Expo', 'Circ'].flatMap((c) => [`easeIn${c}`, `easeOut${c}`, `easeInOut${c}`]),
];

describe('easing names follow the documented list', () => {
  it('has exactly the documented curves, and no Back curve', () => {
    expect(Object.keys(EASINGS).sort()).toEqual([...DOCUMENTED].sort());
    expect(EASINGS).not.toHaveProperty('easeOutBack');
    expect(EASINGS).not.toHaveProperty('easeInBack');
  });
});
