// A headless harness may stub a bare `window` and leave no `performance` in the realm. The kernel tick, the physics step with
// its profile on, the kcc memo timers and the nav clock read the clock through `perfNow()`, which falls back to `Date.now()`.
// (The Rapier wasm glue itself is fine with a bare window: it only reads `window.performance` as an option.)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { perfNow } from '../../../src/compat/core/perf-now.ts';
import { ensurePhysics } from '../../../src/compat/physics/port.ts';
import { kccMemo } from '../../../src/compat/physics/rapier/kcc-memo.ts';
import type { ObjectView } from '../../../src/compat/core/types.ts';
import { kernelWorld, LIVE_PLAYER_PHYSICS, type KernelWorld, type MiniCtx } from './kernel-fixture.ts';
import { FLOOR, GRAVITY } from './rapier-fixtures.ts';

let w: KernelWorld | undefined;
afterEach(() => {
  vi.unstubAllGlobals();
  kccMemo.timing = false;
  w?.dispose();
});

describe('a realm without performance', () => {
  it('perfNow reads performance when there is one and Date.now() when not', () => {
    expect(perfNow()).toBeLessThan(Date.now());
    vi.stubGlobal('performance', undefined);
    expect(Math.abs(perfNow() - Date.now())).toBeLessThan(50);
    vi.stubGlobal('performance', {});
    expect(Math.abs(perfNow() - Date.now())).toBeLessThan(50);
  });

  it('a place ticks, with physics profiling and kcc timing on, under a bare window and no performance', async () => {
    await ensurePhysics();
    w = await kernelWorld({
      places: { yard: { parts: [FLOOR] } },
      modules: {
        'scripts/test/fall.js': {
          update: (ctx: MiniCtx, dt: number) => {
            const self = ctx.self as ObjectView & { velocity: { x: number; y: number; z: number } };
            self.velocity = { x: 0, y: self.velocity.y + GRAVITY * dt, z: 0 };
          },
        },
      },
      player: { tags: ['player', 'teammate'], physics: LIVE_PLAYER_PHYSICS, behavior: 'scripts/test/fall.js' },
    });
    await w.enter('yard');
    const body = w.human('yard', { x: 0, y: 0.5, z: 0 });
    const world = w.port.world('yard')!;
    world.profile = { controllerMs: 0, substepsMs: 0 };
    kccMemo.timing = true;
    vi.stubGlobal('window', {});
    vi.stubGlobal('performance', undefined);
    expect(() => w!.ticks(30)).not.toThrow();
    expect(body.tf.grounded).toBe(true);
    expect(Number.isFinite(world.profile.substepsMs)).toBe(true);
  });
});
