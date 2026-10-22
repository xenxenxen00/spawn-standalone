// MA3 acceptance: every row of the write-rule table of docs/design/motion-physics-nav.md §3.5.2 (D-MPN-07), the clocks of
// §3.5.3, the reads of §3.5.5 and the not-loaded-yet rules of §3.5.6. One `describe` per table row, in table order.
import { describe, expect, it } from 'vitest';
import { attachAnimHost, createAnimHost, play } from '../../../src/compat/builtin/anim.ts';
import { createAnimChannels } from '../../../src/compat/motion/anim-channel.ts';
import type { CompiledClip } from '../../../src/compat/motion/clip.ts';
import { ClipRegistry } from '../../../src/compat/motion/clip-registry.ts';
import { MIXER_DEFAULTS } from '../../../src/compat/motion/constants.ts';
import { cookAuthoredFile } from '../../../src/compat/motion/cook-authored.ts';
import { type ChannelWrite, Mixer, bindByName } from '../../../src/compat/motion/mixer.ts';
import { Pose } from '../../../src/compat/motion/pose.ts';
import { storeFixture } from '../core/store-fixture.ts';
import { clipOf, quat, smallRig } from './fakes/rig.ts';

const DT = 1 / 30;
const FILE = 'anim/test.yml';
const WALK = `${FILE}#walk`;
const RUN = `${FILE}#run`;
const FIRE = `${FILE}#fire`;
const DIE = `${FILE}#die`;

const AUTHORED = {
  walk: { duration: 1, tracks: { Spine: { roll: [0, 30, 0] }, LeftLeg: { pitch: [0, 40, 0] } } },
  run: { duration: 0.5, tracks: { Spine: { roll: [0, -30, 0] } } },
  fire: { duration: 0.4, tracks: { Head: { pitch: [0, 20, 0] } } },
  die: { duration: 2, tracks: { Hips: { y: [0, -0.5] }, Spine: { pitch: [0, 80] } } },
};

function registryOf(): ClipRegistry {
  const r = new ClipRegistry();
  r.addAuthored(FILE, cookAuthoredFile(FILE, AUTHORED));
  return r;
}

function setup() {
  const registry = registryOf();
  const rig = smallRig();
  const mixer = new Mixer('row-1', rig, { registry });
  return { registry, rig, mixer, pose: new Pose(rig) };
}

/** n sim ticks (tick step H) */
function run(m: { advanceTick(dt: number): void }, n: number): void {
  for (let i = 0; i < n; i++) m.advanceTick(DT);
}

const near = (got: number | null | undefined, want: number, eps = 1e-9): void => {
  expect(typeof got).toBe('number');
  expect(Math.abs((got as number) - want), `${got} vs ${want}`).toBeLessThan(eps);
};

describe('row 1: `anim.ch = null`', () => {
  it('fades the channel out over its blendOut (default 0.1 s), keeps its clock while fading, then removes it', () => {
    const { mixer: m } = setup();
    m.write('loco', { clip: WALK, speed: 2 }, 0);
    run(m, 6);
    near(m.clipTime('loco'), 0.4);
    m.write('loco', null, 6);
    // a cleared channel reads as gone at once (`if (anim.sprint) anim.sprint = null`, humanoid-locomotion.js:167)
    expect(m.view('loco')).toBeNull();
    expect(m.table()).toEqual({});
    expect(m.fading()).toHaveLength(1);
    expect(m.fading()[0]).toMatchObject({ channel: 'loco', clip: WALK, weight: 1 });
    near(m.fading()[0]!.clipTime, 0.4);
    run(m, 1);
    near(m.fading()[0]!.weight, 2 / 3);
    near(m.fading()[0]!.clipTime, 0.4 + 2 / 30); // still at speed 2
    run(m, 1);
    near(m.fading()[0]!.weight, 1 / 3);
    run(m, 1); // 0.1 s = MIXER_DEFAULTS.blendOut
    expect(MIXER_DEFAULTS.blendOut).toBe(0.1);
    expect(m.fading()).toEqual([]);
  });

  it('honours the channel’s own blendOut; blendOut 0 removes it at once', () => {
    const { mixer: m } = setup();
    m.write('act', { clip: FIRE, loop: 'once', blendOut: 0.3 }, 0);
    m.write('act', null, 0);
    run(m, 8);
    expect(m.fading()).toHaveLength(1);
    run(m, 1);
    expect(m.fading()).toEqual([]);
    m.write('act', { clip: FIRE, loop: 'once', blendOut: 0 }, 9);
    m.write('act', null, 9);
    expect(m.fading()).toEqual([]);
  });

  it('is a no-op on a channel that does not play, and a second null does not restart the fade', () => {
    const { mixer: m } = setup();
    m.write('flinchA', null, 0); // enemies clear flinch channels they never set (runtime.js:1100)
    expect(m.fading()).toEqual([]);
    m.write('act', { clip: FIRE }, 0);
    m.write('act', null, 0); // builtin/anim.stop …
    run(m, 1);
    m.write('act', null, 1); // … then `ctx.self.anim[ch] = null` (enemies/motion.js clearChannel)
    near(m.fading()[0]!.weight, 2 / 3);
    run(m, 2);
    expect(m.fading()).toEqual([]);
  });
});

describe('row 2: a new clip on a channel', () => {
  it('restarts: clipTime = time ?? 0, startTick = tick; the previous clip fades to 0 and the new one ramps 0 → weight over the new blendIn', () => {
    const { mixer: m } = setup();
    m.write('act', { clip: FIRE, loop: 'once', weight: 0.8 }, 10);
    run(m, 3);
    m.write('act', { clip: DIE, loop: 'once', blendIn: 0.2, time: 0.25 }, 13);
    expect(m.view('act')).toMatchObject({ clip: DIE, startTick: 13, elapsed: 0, weight: 1 });
    near(m.clipTime('act'), 0.25);
    expect(m.weight('act')).toBe(0);
    expect(m.fading()).toHaveLength(1);
    expect(m.fading()[0]).toMatchObject({ channel: 'act', clip: FIRE, weight: 0.8 });
    near(m.fading()[0]!.clipTime, 0.1);
    run(m, 3); // half of the 0.2 s cross-fade: linear
    near(m.weight('act'), 0.5);
    near(m.fading()[0]!.weight, 0.4);
    near(m.fading()[0]!.clipTime, 0.2); // the outgoing clip keeps playing
    near(m.clipTime('act'), 0.35);
    run(m, 3);
    near(m.weight('act'), 1);
    expect(m.fading()).toEqual([]);
  });

  it('with no time and no blendIn: starts at 0 at full weight, the previous clip is dropped at once', () => {
    const { mixer: m } = setup();
    m.write('loco', { clip: WALK }, 0);
    run(m, 4);
    m.write('loco', { clip: RUN }, 4);
    expect(m.clipTime('loco')).toBe(0);
    expect(m.weight('loco')).toBe(1);
    expect(m.fading()).toEqual([]);
    expect(m.view('loco')).toMatchObject({ clip: RUN, startTick: 4, duration: 0.5 });
  });

  it('with startTick: the clip continues from (tick − startTick)/30 · speed', () => {
    const { mixer: m } = setup();
    m.write('death', { clip: DIE, loop: 'once', speed: 1.5, startTick: 40 }, 52);
    near(m.clipTime('death'), (12 / 30) * 1.5);
    // the channel itself (re)started at the write: its view says so
    expect(m.view('death')).toMatchObject({ startTick: 52, elapsed: 0, speed: 1.5 });
    run(m, 3);
    near(m.clipTime('death'), (15 / 30) * 1.5);
    near(m.view('death')!.elapsed, 3 / 30);
  });

  it('an explicit time wins over startTick', () => {
    const { mixer: m } = setup();
    m.write('death', { clip: DIE, loop: 'once', startTick: 40, time: 1.25 }, 52);
    near(m.clipTime('death'), 1.25);
  });

  it('a startTick far in the past clamps a `once` clip to its end (a corpse spawned long after the death, X-20)', () => {
    const { mixer: m } = setup();
    m.write('death', { clip: DIE, loop: 'once', startTick: 30 }, 3030);
    expect(m.view('death')).toMatchObject({ progress: 1, finished: true, duration: 2 });
  });
});

describe('row 3: the same clip, `once`, speed ≠ 0', () => {
  it('restarts every time: a repeated `fire` on the viewmodel replays (viewmodel.js:451)', () => {
    const { mixer: m } = setup();
    const fire: ChannelWrite = { clip: FIRE, loop: 'once', speed: 1, weight: 1, blendIn: 0.06 };
    m.write('action', fire, 0);
    run(m, 5);
    near(m.clipTime('action'), 5 / 30);
    near(m.view('action')!.elapsed, 5 / 30);
    m.write('action', { ...fire }, 5);
    expect(m.clipTime('action')).toBe(0);
    expect(m.view('action')).toMatchObject({ startTick: 5, elapsed: 0, clip: FIRE });
    // the shot before it cross-fades out over the new blendIn
    expect(m.fading()).toHaveLength(1);
    near(m.fading()[0]!.clipTime, 5 / 30);
    run(m, 2);
    expect(m.fading()).toEqual([]); // 0.06 s
    m.write('action', { ...fire }, 7);
    expect(m.clipTime('action')).toBe(0);
    expect(m.view('action')!.startTick).toBe(7);
  });

  it('restarts a clip that changes from loop to once', () => {
    const { mixer: m } = setup();
    m.write('act', { clip: WALK, loop: 'loop' }, 0);
    run(m, 6);
    m.write('act', { clip: WALK, loop: 'once' }, 6);
    expect(m.clipTime('act')).toBe(0);
    expect(m.view('act')!.startTick).toBe(6);
  });
});

describe('row 4: the same clip with speed 0', () => {
  const loco: ChannelWrite = { clip: WALK, loop: 'loop', speed: 1.5, weight: 1, blendIn: 0.2 };

  it('holds: the clock stops where it is and stays there', () => {
    const { mixer: m } = setup();
    m.write('loco', loco, 0);
    run(m, 10);
    near(m.clipTime('loco'), 0.5);
    m.write('loco', { ...loco, speed: 0 }, 10);
    expect(m.view('loco')).toMatchObject({ speed: 0, startTick: 0, clip: WALK });
    expect(m.fading()).toEqual([]);
    run(m, 30);
    near(m.clipTime('loco'), 0.5);
    // elapsed is sim time since the start, whatever the speed (freezeBody multiplies it by the speed itself)
    near(m.view('loco')!.elapsed, 40 / 30);
  });

  it('seeks to `time` when the write gives one and holds there (the freeze of an authored clip, runtime.js:857)', () => {
    const { mixer: m } = setup();
    m.write('loco', loco, 0);
    run(m, 10);
    m.write('loco', { ...loco, speed: 0, time: 0.25 }, 10);
    near(m.clipTime('loco'), 0.25);
    run(m, 5);
    near(m.clipTime('loco'), 0.25);
    expect(m.view('loco')!.time).toBe(0.25);
  });

  it('holds a `once` clip too (speed 0 wins over the once restart)', () => {
    const { mixer: m } = setup();
    const act: ChannelWrite = { clip: FIRE, loop: 'once', speed: 1, weight: 1, blendIn: 0.08 };
    m.write('act', act, 0);
    run(m, 6);
    m.write('act', { ...act, speed: 0, time: 0.2 }, 6);
    near(m.clipTime('act'), 0.2);
    expect(m.view('act')!.startTick).toBe(0);
    expect(m.fading()).toEqual([]);
    run(m, 9);
    near(m.clipTime('act'), 0.2);
  });

  it('thaw: a loop keeps its clock when the speed comes back, a once clip restarts (runtime.js:869-877)', () => {
    const { mixer: m } = setup();
    m.write('loco', loco, 0);
    m.write('act', { clip: FIRE, loop: 'once', speed: 1 }, 0);
    run(m, 6);
    m.write('loco', { ...loco, speed: 0, time: 0.25 }, 6);
    m.write('act', { clip: FIRE, loop: 'once', speed: 0, time: 0.2 }, 6);
    run(m, 30);
    m.write('loco', { ...loco }, 36); // writeChannel(..., { ...o, time: undefined })
    m.write('act', { clip: FIRE, loop: 'once', speed: 1 }, 36);
    near(m.clipTime('loco'), 0.25);
    expect(m.view('loco')!.startTick).toBe(0);
    expect(m.view('loco')!.time).toBe(undefined);
    expect(m.clipTime('act')).toBe(0);
    expect(m.view('act')!.startTick).toBe(36);
    run(m, 2);
    near(m.clipTime('loco'), 0.25 + (2 / 30) * 1.5);
  });
});

describe('row 5: the same clip, loop or pingpong, anything else changed', () => {
  it('keeps the clock; the weight ramps linearly from the current effective weight over the write’s blendIn; the speed applies from now', () => {
    const { mixer: m } = setup();
    m.write('walk', { clip: WALK, loop: 'loop', weight: 1, speed: 1, blendIn: 0.15 }, 0);
    run(m, 9);
    near(m.weight('walk'), 1);
    near(m.clipTime('walk'), 0.3);
    m.write('walk', { clip: WALK, loop: 'loop', weight: 0.001, speed: 2, blendIn: 0.15 }, 9);
    near(m.clipTime('walk'), 0.3);
    expect(m.view('walk')).toMatchObject({ startTick: 0, weight: 0.001, speed: 2 });
    expect(m.fading()).toEqual([]);
    near(m.weight('walk'), 1);
    run(m, 1);
    near(m.clipTime('walk'), 0.3 + 2 / 30);
    near(m.weight('walk'), 1 + (0.001 - 1) * (DT / 0.15));
    run(m, 4);
    near(m.weight('walk'), 0.001);
  });

  it('a new weight while a ramp is in flight starts from where the ramp is', () => {
    const { mixer: m } = setup();
    m.write('walk', { clip: WALK, weight: 1, blendIn: 0.2 }, 0);
    run(m, 3); // half way up
    near(m.weight('walk'), 0.5);
    m.write('walk', { clip: WALK, weight: 0.1, blendIn: 0.1 }, 3);
    near(m.weight('walk'), 0.5);
    run(m, 3);
    near(m.weight('walk'), 0.1);
  });

  it('blendIn 0 applies the new weight at once; a pingpong channel keeps its clock the same way', () => {
    const { mixer: m } = setup();
    m.write('sway', { clip: WALK, loop: 'pingpong', weight: 1 }, 0);
    run(m, 45); // 1.5 s into a 1 s clip: on the way back, at 0.5
    m.write('sway', { clip: WALK, loop: 'pingpong', weight: 0.25 }, 45);
    near(m.weight('sway'), 0.25);
    near(m.clipTime('sway'), 1.5);
    near(m.view('sway')!.progress, 0.5);
    expect(m.view('sway')!.finished).toBe(false);
  });
});

describe('row 6: an equal write of a loop channel', () => {
  it('is a no-op, tick after tick (humanoid-locomotion.js:268): the clock runs, the first ramp completes, nothing restarts', () => {
    const { mixer: m } = setup();
    const w: ChannelWrite = { clip: WALK, loop: 'loop', weight: 1, speed: 1.2, blendIn: 0.15 };
    m.write('walk', w, 0);
    for (let tick = 1; tick <= 3; tick++) {
      run(m, 1);
      m.write('walk', { ...w }, tick);
    }
    // a ramp restarted by every write would never be linear
    near(m.weight('walk'), (3 * DT) / 0.15);
    for (let tick = 4; tick <= 21; tick++) {
      run(m, 1);
      m.write('walk', { ...w }, tick);
    }
    near(m.weight('walk'), 1);
    near(m.clipTime('walk'), (21 / 30) * 1.2);
    expect(m.view('walk')).toMatchObject({ startTick: 0, clip: WALK, speed: 1.2 });
    near(m.view('walk')!.elapsed, 21 / 30);
    expect(m.fading()).toEqual([]);
  });
});

describe('row 7: mutating a read view', () => {
  it('does nothing: views and tables are fresh snapshots (`anim.walk.speed = 0`, AGENTS.md:139)', () => {
    const { mixer: m } = setup();
    m.write('walk', { clip: WALK, speed: 1.2 }, 0);
    const view = m.view('walk') as unknown as Record<string, unknown>;
    view['speed'] = 0;
    view['weight'] = 0;
    view['clip'] = RUN;
    const table = m.table() as unknown as Record<string, Record<string, unknown>>;
    table['walk']!['speed'] = 0;
    delete table['walk'];
    expect(m.view('walk')).toMatchObject({ clip: WALK, speed: 1.2, weight: 1 });
    expect(m.view('walk')).not.toBe(m.view('walk'));
    expect(m.table()).not.toBe(m.table());
    expect(Object.keys(m.table())).toEqual(['walk']);
    run(m, 1);
    near(m.clipTime('walk'), 1.2 / 30);
  });
});

/** a store with the anim / mixer channels and `builtin/anim` over it */
function world() {
  const f = storeFixture();
  const clock = { tick: 0 };
  const registry = registryOf();
  const anim = createAnimChannels({ clock, registry });
  anim.register(f.store.channels);
  const host = createAnimHost({ registry, file: (path) => (path === FILE ? { authored: AUTHORED } : undefined) });
  const ctx = attachCtx({ session: {}, getObject: (id: string) => (f.store.get(id) ? f.store.handle(f.store.get(id)!, 'platform') : null) });
  function attachCtx<T extends object>(c: T): T {
    attachAnimHost(c, host);
    return c;
  }
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      anim.port.advanceTick(DT);
      clock.tick++;
    }
  };
  return { f, clock, registry, anim, host, ctx, tick };
}

describe('row 8: `play(ctx, target, clip, {channel, …})` (builtin/anim)', () => {
  it('follows the same rules, with loop true → `loop` and false → `once`', () => {
    const w = world();
    const row = w.f.add({ id: 'enemy-1' });
    const self = w.f.store.handle(row, 'platform') as Record<string, any>;
    const hollow = { name: 'lunge', duration: 0.6, tracks: { Spine: { pitch: [0, 50, 0] } } };

    expect(play(w.ctx, self as never, hollow, { channel: 'act', loop: false, speed: 1.1, weight: 1, blendIn: 0.08 })).toBe('act');
    const m = w.anim.get('enemy-1')!;
    expect(self.anim.act).toMatchObject({ loop: 'once', speed: 1.1, weight: 1, blendIn: 0.08, startTick: 0 });
    w.tick(6);
    near(m.clipTime('act'), 0.22);
    // the same clip again, once: restart
    play(w.ctx, self as never, hollow, { channel: 'act', loop: false, speed: 1.1, weight: 1, blendIn: 0.08 });
    expect(m.clipTime('act')).toBe(0);
    expect(self.anim.act.startTick).toBe(6);

    expect(play(w.ctx, self as never, hollow, { channel: 'loco', loop: true, speed: 1 })).toBe('loco');
    expect(self.anim.loco.loop).toBe('loop');
    w.tick(5);
    // the same clip again, loop: the clock is kept, the weight re-ramps
    play(w.ctx, self as never, hollow, { channel: 'loco', loop: true, speed: 1, weight: 0.001, blendIn: 0.2 });
    near(m.clipTime('loco'), 5 / 30);
    expect(self.anim.loco).toMatchObject({ weight: 0.001, startTick: 6 });
    // speed 0 holds and seeks (the freeze)
    play(w.ctx, self as never, hollow, { channel: 'loco', loop: 'loop', speed: 0, time: 0.3 });
    w.tick(4);
    near(m.clipTime('loco'), 0.3);
    expect(play(w.ctx, self as never, hollow, { channel: 'sway', loop: 'pingpong' })).toBe('sway');
    expect(self.anim.sway.loop).toBe('pingpong');
  });
});

describe('row 9: a spawn-time `mixer: {ch: {clip, …, startTick}}`', () => {
  it('creates the channels at spawn; with startTick the clip continues mid-way (corpses, gore/corpse.js)', () => {
    const w = world();
    w.clock.tick = 200;
    // what corpse.js cleanMixer copies from the dying enemy's `row.mixer`
    const row = w.f.add({
      id: 'corpse-1',
      props: { mixer: { act: { clip: DIE, weight: 1, speed: 1.2, loop: 'once', blendIn: 0.08, blendOut: 0.1, startTick: 185 }, loco: { clip: WALK, weight: 0.001, speed: 1, loop: 'loop', blendIn: 0.2, blendOut: 0.1, startTick: 20 } } },
    });
    w.anim.rowSpawned(row);
    const m = w.anim.get('corpse-1')!;
    near(m.clipTime('act'), (15 / 30) * 1.2);
    near(m.clipTime('loco'), 6);
    const h = w.f.store.handle(row, 'platform') as Record<string, any>;
    expect(h.mixer.act).toMatchObject({ clip: DIE, loop: 'once', startTick: 200, duration: 2 });
    expect(h.anim.act).toEqual(h.mixer.act); // "mixer and anim read one table"
    w.tick(30);
    near(m.clipTime('act'), (45 / 30) * 1.2);
    w.tick(60);
    expect(h.mixer.act.finished).toBe(true);
  });

  it('does not reproduce the live quirk: a spawn-time clip equal to the first channel write still runs its clock (enemies/kit.js:35-37)', () => {
    const w = world();
    const row = w.f.add({ id: 'enemy-2', props: { mixer: { loco: { clip: WALK, loop: 'loop', speed: 1 } } } });
    w.anim.rowSpawned(row);
    const h = w.f.store.handle(row, 'platform') as Record<string, any>;
    h.anim.loco = { clip: WALK, loop: 'loop', speed: 1 };
    w.tick(9);
    near(w.anim.get('enemy-2')!.clipTime('loco'), 0.3);
    near(h.anim.loco.elapsed, 0.3);
  });
});

describe('defaults and ignored fields (§3.5.2)', () => {
  it('fills the defaults a write leaves out: loop `loop`, speed 1, weight 1, blendIn 0, blendOut 0.1', () => {
    const { mixer: m } = setup();
    m.write('idle', { clip: WALK }, 4);
    expect(m.view('idle')).toEqual({
      clip: WALK,
      loop: 'loop',
      speed: 1,
      weight: 1,
      blendIn: 0,
      blendOut: 0.1,
      startTick: 4,
      elapsed: 0,
      duration: 1,
      progress: 0,
      finished: false,
    });
  });

  it('ignores the read-only fields a written object carries (`Object.assign({}, anim.walk, {weight})`, player/body.js:52)', () => {
    const { mixer: m } = setup();
    m.write('walk', { clip: WALK, loop: 'loop', weight: 1, speed: 1.3, blendIn: 0.15 }, 0);
    run(m, 12);
    const rewritten = Object.assign({}, m.view('walk'), { weight: 0.001 });
    expect(rewritten).toMatchObject({ elapsed: 0.4, duration: 1, finished: false, startTick: 0 });
    m.write('walk', rewritten, 12);
    near(m.clipTime('walk'), 0.52);
    expect(m.view('walk')).toMatchObject({ startTick: 0, weight: 0.001, speed: 1.3, blendIn: 0.15 });
    near(m.view('walk')!.elapsed, 0.4);
    expect(m.fading()).toEqual([]);
  });

  it('ignores a write that names no clip, and anything that is not a channel object', () => {
    const { mixer: m } = setup();
    m.write('sit', { loop: 'loop', weight: 1 } as unknown as ChannelWrite, 0);
    m.write('sit', 'walk' as unknown as ChannelWrite, 0);
    m.write('sit', { clip: 42 } as unknown as ChannelWrite, 0);
    expect(m.table()).toEqual({});
    m.write('walk', { clip: WALK }, 0);
    run(m, 3);
    m.write('walk', { weight: 0.5 } as unknown as ChannelWrite, 3);
    expect(m.view('walk')).toMatchObject({ weight: 1, startTick: 0 });
  });

  it('takes bad numbers as absent: the defaults apply', () => {
    const { mixer: m } = setup();
    m.write('walk', { clip: WALK, speed: Number.NaN, weight: -3, blendIn: -1, loop: 'forever' } as unknown as ChannelWrite, 0);
    expect(m.view('walk')).toMatchObject({ speed: 1, weight: 0, blendIn: 0, loop: 'loop' });
  });
});

describe('clocks and reads (§3.5.3, §3.5.5)', () => {
  it('a `once` clip holds its last frame, reports finished and stays in the table until it is cleared (player/body.js:43)', () => {
    const { mixer: m, pose, rig } = setup();
    m.write('death', { clip: DIE, loop: 'once' }, 0);
    run(m, 45);
    expect(m.view('death')!.finished).toBe(false);
    near(m.view('death')!.progress, 0.75);
    run(m, 30);
    expect(m.view('death')).toMatchObject({ finished: true, progress: 1, duration: 2 });
    near(m.view('death')!.elapsed, 2.5);
    m.evaluate(pose, 0);
    const hips = rig.index('Hips');
    expect(pose.t[hips * 3 + 1]).toBeCloseTo(0.5, 6); // bind 1 m − 0.5 m: the last key
    run(m, 300);
    expect(Object.keys(m.table())).toEqual(['death']);
    m.evaluate(pose, 0.5);
    expect(pose.t[hips * 3 + 1]).toBeCloseTo(0.5, 6);
  });

  it('progress is the place inside the cycle for a loop, clip time over duration for a once clip', () => {
    const { mixer: m } = setup();
    m.write('walk', { clip: WALK, loop: 'loop' }, 0);
    m.write('act', { clip: FIRE, loop: 'once' }, 0);
    run(m, 36); // 1.2 s
    near(m.view('walk')!.progress, 0.2, 1e-6);
    expect(m.view('walk')!.finished).toBe(false);
    expect(m.view('act')).toMatchObject({ progress: 1, finished: true });
    expect(m.view('nope')).toBeNull();
  });

  it('evaluate(pose, alpha) samples at clipTime + alpha·dt·speed without moving the sim clock', () => {
    const { mixer: m, pose, rig } = setup();
    m.write('death', { clip: DIE, loop: 'once', speed: 3 }, 0);
    run(m, 5); // clip time 0.5 of 2 s; Hips y falls linearly 0 → −0.5
    const y = (): number => pose.t[rig.index('Hips') * 3 + 1]!;
    m.evaluate(pose, 0);
    expect(y()).toBeCloseTo(1 - 0.125, 6);
    m.evaluate(pose, 0.5); // + 0.5 · (1/30) · 3 = 0.05 s
    expect(y()).toBeCloseTo(1 - 0.1375, 6);
    m.evaluate(pose, 0);
    expect(y()).toBeCloseTo(1 - 0.125, 6);
    near(m.clipTime('death'), 0.5);
  });

  it('reads a clip object back as its identity string', () => {
    const { mixer: m } = setup();
    const inline = { name: 'wave', duration: 1, tracks: { Head: { yaw: [0, 30] } } };
    m.write('act', { clip: inline }, 0);
    expect(m.view('act')).toMatchObject({ clip: 'inline#wave', duration: 1 });
    // the same object again is the same clip: a loop keeps its clock
    run(m, 6);
    m.write('act', { clip: inline }, 6);
    near(m.clipTime('act'), 0.2);
  });
});

describe('clips that cannot bind yet (§3.5.6)', () => {
  it('keeps a write made before the rig exists, its clock running from the write tick; setRig binds it', () => {
    const registry = registryOf();
    const m = new Mixer('row-2', null, { registry });
    m.write('loco', { clip: WALK, speed: 1.5 }, 0);
    run(m, 10);
    near(m.clipTime('loco'), 0.5);
    expect(m.view('loco')).toMatchObject({ clip: WALK, duration: 1, startTick: 0 });
    const rig = smallRig();
    const pose = new Pose(rig);
    m.evaluate(pose, 0); // no rig yet: nothing is written
    expect(Array.from(pose.dirty)).toEqual([0, 0, 0, 0, 0]);
    m.setRig(rig);
    m.evaluate(pose, 0);
    const spine = rig.index('Spine');
    const want = quat(0, 0, 30); // roll [0, 30, 0] at 0.5 s
    for (let k = 0; k < 4; k++) expect(pose.r[spine * 4 + k]).toBeCloseTo(want[k]!, 6);
  });

  it('keeps a clip the registry calls pending and binds it on a later tick; a missing clip plays nothing but reads back', () => {
    const registry = registryOf();
    const loaded: Record<string, CompiledClip> = {};
    registry.setLibrary({ get: (address) => loaded[address] ?? (address === 'cdn/clip-walk-loop.glb' ? 'pending' : undefined) });
    const rig = smallRig('lib.rig');
    const m = new Mixer('row-3', rig, { registry });
    const pose = new Pose(rig);
    m.write('loco', { clip: 'cdn/clip-walk-loop.glb' }, 0);
    m.write('act', { clip: 'cdn/clip-nope.glb' }, 0);
    expect(m.view('loco')).toMatchObject({ clip: 'cdn/clip-walk-loop.glb', duration: 0, progress: 0, finished: false });
    expect(m.view('act')).toMatchObject({ clip: 'cdn/clip-nope.glb', duration: 0 });
    run(m, 3);
    m.evaluate(pose, 0);
    expect(Array.from(pose.dirty)).toEqual([0, 0, 0, 0, 0]);
    // the library group arrives: an absolute clip on this very rig
    loaded['cdn/clip-walk-loop.glb'] = clipOf('cdn/clip-walk-loop.glb', 'absolute', 1, [{ bone: 'Head', prop: 'position', times: [0, 1], values: [0, 0.4, 0, 0, 1.4, 0] }], { sourceRig: 'lib.rig' });
    run(m, 3); // retried per tick
    m.evaluate(pose, 0);
    expect(m.view('loco')!.duration).toBe(1);
    expect(pose.t[rig.index('Head') * 3 + 1]).toBeCloseTo(0.4 + 0.2, 6); // the clock ran while it was pending: 0.2 s
  });

  it('rebind() resolves a clip whose source was registered after the write (a missing clip is not asked again by itself)', () => {
    const registry = new ClipRegistry();
    const rig = smallRig();
    const m = new Mixer('row-4', rig, { registry });
    const pose = new Pose(rig);
    m.write('act', { clip: FIRE, loop: 'once' }, 0);
    run(m, 3);
    expect(m.view('act')).toMatchObject({ clip: FIRE, duration: 0 });
    registry.addAuthored(FILE, cookAuthoredFile(FILE, AUTHORED)); // the actors set lands
    run(m, 3);
    expect(m.view('act')!.duration).toBe(0);
    m.rebind();
    expect(m.view('act')).toMatchObject({ duration: 0.4, startTick: 0 });
    m.evaluate(pose, 0);
    expect(pose.dirty[rig.index('Head')]).toBe(1); // 0.2 s in: the head is mid-nod
  });

  it('an absolute clip of another rig waits for a binder that can retarget it', () => {
    const registry = registryOf();
    const lib = clipOf('cdn/clip-idle-loop.glb', 'absolute', 1, [{ bone: 'Head', prop: 'position', times: [0], values: [0, 9, 0] }], { sourceRig: 'library-src' });
    registry.setLibrary({ get: (a) => (a === lib.id ? lib : undefined) });
    const rig = smallRig();
    const pose = new Pose(rig);
    const plain = new Mixer('row-5', rig, { registry });
    plain.write('idle', { clip: lib.id }, 0);
    plain.evaluate(pose, 0);
    expect(Array.from(pose.dirty)).toEqual([0, 0, 0, 0, 0]);
    expect(plain.view('idle')).toMatchObject({ clip: lib.id, duration: 1 }); // resolved, in the table, not bound
    // the seam `retarget.ts` fills: a binder that maps the source rig onto this one
    const retargeting = new Mixer('row-6', rig, { registry, bind: (clip, r) => bindByName(clip, r) });
    retargeting.write('idle', { clip: lib.id }, 0);
    retargeting.evaluate(pose, 0);
    expect(pose.t[rig.index('Head') * 3 + 1]).toBe(9);
  });
});
