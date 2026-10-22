// UI2b damage numbers: short-lived floating DOM labels projected from world position.
// Uses the injected renderer projection contract; no rendering dependency in UI.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DamageNumbers, DAMAGE_LIFETIME_MS } from '../../../src/runtime/ui/damage-numbers.ts';
import type { ScreenPoint, Vec3Like } from '../../../src/runtime/ui/chrome/types.ts';
import { createManualClock, type ManualClock } from './fake-clock.ts';

function mount(): HTMLElement {
  const m = document.createElement('div');
  m.id = 'port-chrome';
  document.body.appendChild(m);
  return m;
}

let m: HTMLElement;
let clock: ManualClock;

beforeEach(() => {
  m = mount();
  clock = createManualClock(0);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('damage numbers', () => {
  it('spawns a label at the projected screen point', () => {
    const seen: Vec3Like[] = [];
    const nums = new DamageNumbers(document, m, {
      clock,
      project: (p) => {
        seen.push(p);
        return { x: 100, y: 200 } as ScreenPoint;
      },
    });
    nums.spawn({ position: { x: 1, y: 2, z: 3 }, text: '-12' });
    expect(seen).toEqual([{ x: 1, y: 2, z: 3 }]);
    const label = m.querySelector('.ss-damage');
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe('-12');
    expect((label as HTMLElement).style.left).toBe('100px');
    expect((label as HTMLElement).style.top).toBe('200px');
  });

  it('skips labels whose projection is null (behind the camera)', () => {
    const nums = new DamageNumbers(document, m, { clock, project: () => null });
    nums.spawn({ position: { x: 0, y: 0, z: 0 }, text: '-12' });
    expect(m.querySelector('.ss-damage')).toBeNull();
  });

  it('labels expire after the lifetime', () => {
    const nums = new DamageNumbers(document, m, { clock, project: () => ({ x: 10, y: 10 }) });
    nums.spawn({ position: { x: 0, y: 0, z: 0 }, text: '-12' });
    nums.spawn({ position: { x: 0, y: 0, z: 0 }, text: '-7' });
    expect(m.querySelectorAll('.ss-damage')).toHaveLength(2);
    clock.advance(DAMAGE_LIFETIME_MS);
    expect(m.querySelectorAll('.ss-damage')).toHaveLength(0);
  });

  it('reflects the damage kind for styling', () => {
    const nums = new DamageNumbers(document, m, { clock, project: () => ({ x: 10, y: 10 }) });
    nums.spawn({ position: { x: 0, y: 0, z: 0 }, text: '-99', kind: 'crit' });
    expect(m.querySelector('.ss-damage')!.getAttribute('data-kind')).toBe('crit');
  });

  it("takes the act's colour, size and own lifetime (scripts/director/ammo.js)", () => {
    const nums = new DamageNumbers(document, m, { clock, project: () => ({ x: 10, y: 10 }) });
    nums.spawn({ position: { x: 0, y: 0, z: 0 }, text: '+AMMO', color: '#e8c060', size: 1.1, lifetimeMs: 1200 });
    const label = m.querySelector<HTMLElement>('.ss-damage')!;
    expect(label.style.color).toBe('rgb(232, 192, 96)');
    expect(label.style.getPropertyValue('--ss-dmg-size')).toBe('1.1');
    expect(label.style.getPropertyValue('--ss-dmg-life')).toBe('1200ms');
    clock.advance(DAMAGE_LIFETIME_MS);
    expect(m.querySelector('.ss-damage')).not.toBeNull();
    clock.advance(1200 - DAMAGE_LIFETIME_MS);
    expect(m.querySelector('.ss-damage')).toBeNull();
  });

  it('dispose removes the layer', () => {
    const nums = new DamageNumbers(document, m, { clock, project: () => ({ x: 10, y: 10 }) });
    nums.dispose();
    expect(m.querySelector('.ss-damage-layer')).toBeNull();
  });
});
