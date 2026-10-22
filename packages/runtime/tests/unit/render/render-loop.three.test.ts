// WP R0: the render loop (render §3.4; docs/architecture.md X-08, X-11, §4.2). It has no frame order of its own: the frame
// driver calls `update(frame)` and `render()`; the loop supplies the entry points, the rAF hand-over (three's own animation
// loop while a renderer exists, the loop's own `requestAnimationFrame` while a device-loss rebuild has none; exactly one chain
// at any time), the first-frame signal, the frame-time ring for the governor, and the per-frame `setShaderTime(frame.now)` that
// makes `builtin/tsl`'s `time` follow the presentation clock.
//
// Project `three` because the shader-time uniform is a TSL node; no renderer: three's loop is a fake that calls its callback
// from the same fake rAF queue a browser would.
import { beforeEach, describe, expect, it } from 'vitest';
import { time as builtinTime } from '../../../src/compat/builtin/tsl.ts';
import { FRAME_TIME_SAMPLES, UPDATE_STAGES, createRenderLoop, type FrameInfo, type LoopClock, type RenderLoopControl } from '../../../src/render/engine/render-loop.ts';
import { setShaderTime, shaderTime } from '../../../src/render/shader-time.ts';

const frame = (over: Partial<FrameInfo> = {}): FrameInfo => ({ now: 0, dt: 1 / 60, realDt: 1 / 60, alpha: 0, frameIndex: 0, paused: false, ...over });

/** a browser's rAF queue: `tick()` is one animation frame */
class FakeRaf implements LoopClock {
  #next = 1;
  #queue = new Map<number, FrameRequestCallback>();
  /** live requests at the end of each frame: the number of rAF chains */
  chains: number[] = [];
  requested = 0;
  cancelled = 0;
  timeMs = 0;
  requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = this.#next++;
    this.#queue.set(id, cb);
    this.requested++;
    return id;
  };
  cancelAnimationFrame = (id: number): void => {
    if (this.#queue.delete(id)) this.cancelled++;
  };
  get pending(): number {
    return this.#queue.size;
  }
  tick(n = 1): void {
    for (let i = 0; i < n; i++) {
      const due = [...this.#queue.values()];
      this.#queue.clear();
      this.timeMs += 16;
      for (const cb of due) cb(this.timeMs);
      this.chains.push(this.#queue.size);
    }
  }
}

/** three's renderer as far as the loop sees it: `init()` starts a chain that runs for the renderer's life (render §3.4) */
class FakeThreeRenderer {
  callback: ((t: number) => void) | null = null;
  sets: Array<'fn' | 'null'> = [];
  #raf: FakeRaf;
  #id: number | null = null;
  constructor(raf: FakeRaf) {
    this.#raf = raf;
    const update = (t: number): void => {
      this.#id = raf.requestAnimationFrame(update);
      this.callback?.(t);
    };
    this.#id = raf.requestAnimationFrame(update);
  }
  setAnimationLoop = (cb: ((t: number) => void) | null): Promise<void> => {
    this.callback = cb;
    this.sets.push(cb === null ? 'null' : 'fn');
    return Promise.resolve();
  };
  /** renderer.dispose(): the only thing that stops three's chain */
  dispose(): void {
    if (this.#id !== null) this.#raf.cancelAnimationFrame(this.#id);
    this.#id = null;
    this.callback = null;
  }
}

interface Rig {
  loop: RenderLoopControl;
  raf: FakeRaf;
  draws: { n: number; ok: boolean };
  resize: { pending: boolean; flushed: number };
}

function rig(): Rig {
  const raf = new FakeRaf();
  const draws = { n: 0, ok: true };
  const resize = { pending: false, flushed: 0 };
  const loop = createRenderLoop({
    clock: raf,
    draw: () => {
      if (!draws.ok) return false;
      draws.n++;
      return true;
    },
    flushResize: () => {
      resize.flushed++;
      const was = resize.pending;
      resize.pending = false;
      return was;
    },
  });
  return { loop, raf, draws, resize };
}

beforeEach(() => setShaderTime(0));

describe('update(frame): the shader `time` follows the presentation clock (X-11)', () => {
  it('update({ now: 1500 }) sets builtin/tsl’s time to 1.5 s', () => {
    const { loop } = rig();
    loop.update(frame({ now: 1500 }));
    expect(shaderTime.value).toBe(1.5);
    expect(builtinTime).toBe(shaderTime);
    expect((builtinTime as unknown as { value: number }).value).toBe(1.5);
  });

  it('an unchanged `now` (hitstop, or a paused presentation clock) holds it', () => {
    const { loop } = rig();
    loop.update(frame({ now: 2000, frameIndex: 1 }));
    loop.update(frame({ now: 2000, frameIndex: 2, dt: 0 }));
    loop.update(frame({ now: 2000, frameIndex: 3, dt: 0, paused: true }));
    expect(shaderTime.value).toBe(2);
  });

  it('holds while paused (the driver skips update and render) and continues from where it stopped', () => {
    // a PresentationClock as the app shell runs it: real time passes, presentation time only while not paused
    const clock = { nowMs: 0, update: (realDtS: number, paused: boolean) => void (clock.nowMs += paused ? 0 : realDtS * 1000) };
    const { loop, draws } = rig();
    const step = (paused: boolean, i: number): void => {
      clock.update(0.25, paused);
      if (paused) return; // docs/architecture.md §4.2: steps 4 and 6 do not run while paused
      loop.update(frame({ now: clock.nowMs, frameIndex: i, paused }));
      loop.render();
    };
    for (let i = 0; i < 4; i++) step(false, i);
    expect(shaderTime.value).toBe(1);
    const drawn = draws.n;
    for (let i = 4; i < 44; i++) step(true, i); // 10 s of pause
    expect(shaderTime.value).toBe(1);
    expect(draws.n).toBe(drawn);
    step(false, 44);
    expect(shaderTime.value).toBe(1.25);
  });

  it('wraps every 3600 s', () => {
    const { loop } = rig();
    loop.update(frame({ now: 3_600_000 + 2500 }));
    expect(shaderTime.value).toBeCloseTo(2.5, 9);
    loop.update(frame({ now: 3_599_000 }));
    expect(shaderTime.value).toBe(3599);
  });

  it('a frame without a usable `now` is refused before any stage runs', () => {
    const { loop } = rig();
    let ran = 0;
    loop.setStage('feed', () => void ran++);
    loop.update(frame({ now: 700 }));
    expect(() => loop.update(frame({ now: Number.NaN }))).toThrow(RangeError);
    expect(() => loop.update(frame({ now: -1 }))).toThrow(RangeError);
    expect(shaderTime.value).toBe(0.7);
    expect(ran).toBe(1);
  });

  it('runs the presentation stages in the fixed order of §4.2 step 4, the shader time between lights and uploads', () => {
    const { loop } = rig();
    expect(UPDATE_STAGES).toEqual(['feed', 'bridge', 'mixer', 'corpses', 'fx', 'decals', 'lights', 'shaderTime', 'uploads']);
    const order: string[] = [];
    // registered in a scrambled order, as later work packages will
    for (const name of ['uploads', 'lights', 'feed', 'fx', 'mixer', 'decals', 'bridge', 'corpses'] as const) {
      loop.setStage(name, (f) => void order.push(`${name}@${f.frameIndex}:${shaderTime.value}`));
    }
    loop.update(frame({ now: 5000, frameIndex: 9 }));
    expect(order).toEqual(['feed@9:0', 'bridge@9:0', 'mixer@9:0', 'corpses@9:0', 'fx@9:0', 'decals@9:0', 'lights@9:0', 'uploads@9:5']);
    expect(() => loop.setStage('shaderTime' as never, () => undefined)).toThrow(/shaderTime/);
    expect(() => loop.setStage('audio' as never, () => undefined)).toThrow(RangeError);
  });

  it('a stage can be replaced and removed; with none the update is just the clock', () => {
    const { loop } = rig();
    let a = 0;
    let b = 0;
    loop.setStage('fx', () => void a++);
    loop.update(frame({ now: 1 }));
    loop.setStage('fx', () => void b++);
    loop.update(frame({ now: 2 }));
    loop.setStage('fx', null);
    loop.update(frame({ now: 3 }));
    expect([a, b]).toEqual([1, 1]);
    expect(loop.lastFrame).toMatchObject({ now: 3 });
  });

  it('keeps a ring of realDt for the governor, oldest first', () => {
    const { loop } = rig();
    expect(loop.frameTimes()).toEqual(new Float32Array(0));
    for (let i = 1; i <= 3; i++) loop.update(frame({ now: i, realDt: i / 100 }));
    expect([...loop.frameTimes()].map((x) => +x.toFixed(4))).toEqual([0.01, 0.02, 0.03]);
    for (let i = 4; i <= FRAME_TIME_SAMPLES + 2; i++) loop.update(frame({ now: i, realDt: i / 100 }));
    const ring = loop.frameTimes();
    expect(ring).toHaveLength(FRAME_TIME_SAMPLES);
    expect(ring[0]).toBeCloseTo(0.03, 5);
    expect(ring.at(-1)).toBeCloseTo((FRAME_TIME_SAMPLES + 2) / 100, 5);
  });
});

describe('render() and the first-frame signal (X-04: this is not game_ready)', () => {
  it('render() draws through the pipeline and can be called at any time', () => {
    const { loop, draws } = rig();
    loop.render();
    loop.render();
    expect(draws.n).toBe(2);
  });

  it('onFirstFrame fires once, after the first frame that was actually drawn', () => {
    const { loop, draws } = rig();
    const seen: string[] = [];
    loop.onFirstFrame(() => seen.push(`a:${draws.n}`));
    loop.onFirstFrame(() => seen.push(`b:${draws.n}`));
    expect(loop.firstFramePresented).toBe(false);
    loop.render();
    expect(seen).toEqual(['a:1', 'b:1']);
    expect(loop.firstFramePresented).toBe(true);
    loop.render();
    loop.render();
    expect(seen).toHaveLength(2);
  });

  it('a render() that drew nothing (no pipeline yet, device lost) is not a first frame', () => {
    const { loop, draws } = rig();
    let fired = 0;
    loop.onFirstFrame(() => fired++);
    draws.ok = false;
    loop.render();
    loop.render();
    expect(fired).toBe(0);
    draws.ok = true;
    loop.render();
    expect(fired).toBe(1);
  });

  it('unsubscribe before the first frame', () => {
    const { loop } = rig();
    let fired = 0;
    const off = loop.onFirstFrame(() => fired++);
    off();
    off();
    loop.render();
    expect(fired).toBe(0);
  });

  it('a late subscriber is called once, on a microtask, and can still unsubscribe before it runs', async () => {
    const { loop } = rig();
    loop.render();
    let late = 0;
    let cancelled = 0;
    loop.onFirstFrame(() => late++);
    const off = loop.onFirstFrame(() => cancelled++);
    expect(late).toBe(0); // never synchronously inside onFirstFrame()
    off();
    await Promise.resolve();
    expect([late, cancelled]).toEqual([1, 0]);
    loop.render();
    await Promise.resolve();
    expect(late).toBe(1);
  });

  it('a listener that throws does not stop the others', () => {
    const { loop } = rig();
    let reached = false;
    loop.onFirstFrame(() => {
      throw new Error('veil');
    });
    loop.onFirstFrame(() => void (reached = true));
    expect(() => loop.render()).not.toThrow();
    expect(reached).toBe(true);
  });
});

describe('setAnimationLoop: the rAF hand-over (X-08, X-46)', () => {
  it('without a renderer the step rides the loop’s own requestAnimationFrame, once per frame', () => {
    const { loop, raf } = rig();
    const times: number[] = [];
    expect(loop.source).toBe('idle');
    expect(raf.pending).toBe(0); // no step, no chain
    loop.setAnimationLoop((t) => times.push(t));
    expect(loop.source).toBe('own');
    raf.tick(5);
    expect(times).toEqual([16, 32, 48, 64, 80]);
    expect(raf.chains).toEqual([1, 1, 1, 1, 1]);
  });

  it('setAnimationLoop(null) clears the step and stops the own chain', () => {
    const { loop, raf } = rig();
    let n = 0;
    loop.setAnimationLoop(() => n++);
    raf.tick(2);
    loop.setAnimationLoop(null);
    raf.tick(3);
    expect(n).toBe(2);
    expect(raf.pending).toBe(0);
    expect(loop.source).toBe('idle');
  });

  it('setting the step twice does not start a second chain', () => {
    const { loop, raf } = rig();
    let a = 0;
    let b = 0;
    loop.setAnimationLoop(() => a++);
    loop.setAnimationLoop(() => b++);
    raf.tick(4);
    expect([a, b]).toEqual([0, 4]);
    expect(raf.chains).toEqual([1, 1, 1, 1]);
  });

  it('after the hand-over exactly one rAF chain runs: three’s; the step runs once per frame', () => {
    const { loop, raf } = rig();
    // the frame driver before the engine exists: its own chain (src/app/frame.ts)
    let stepCalls = 0;
    const step = (): void => void stepCalls++;
    let driverId: number | null = null;
    const driver = (): void => {
      driverId = raf.requestAnimationFrame(driver);
      step();
    };
    driverId = raf.requestAnimationFrame(driver);
    raf.tick(3);
    expect(stepCalls).toBe(3);
    expect(raf.chains).toEqual([1, 1, 1]);

    // the engine arrives: renderer.init() has started three's loop (a second chain, for this one frame)
    const three = new FakeThreeRenderer(raf);
    loop.attachRenderer(three);
    expect(loop.source).toBe('three');
    // the hand-over (X-08): cancel the driver's chain, hand the step to the renderer
    raf.cancelAnimationFrame(driverId!);
    loop.setAnimationLoop(step);

    raf.chains.length = 0;
    stepCalls = 0;
    raf.tick(20);
    expect(stepCalls).toBe(20); // step calls == frames
    expect(raf.chains).toEqual(new Array(20).fill(1)); // one live request after every frame
    expect(three.sets).toEqual(['fn']);
  });

  it('attaching a renderer moves a running step from the own chain to three’s without a doubled or a dropped frame', () => {
    const { loop, raf } = rig();
    let n = 0;
    loop.setAnimationLoop(() => n++);
    raf.tick(2);
    const three = new FakeThreeRenderer(raf);
    loop.attachRenderer(three);
    raf.chains.length = 0;
    raf.tick(5);
    expect(n).toBe(7);
    expect(raf.chains).toEqual([1, 1, 1, 1, 1]);
  });

  it('setAnimationLoop(null) on three’s loop stops the step; three’s chain goes on (it cannot be stopped, X-46)', () => {
    const { loop, raf } = rig();
    const three = new FakeThreeRenderer(raf);
    loop.attachRenderer(three);
    let n = 0;
    loop.setAnimationLoop(() => n++);
    raf.tick(2);
    loop.setAnimationLoop(null);
    raf.tick(3);
    expect(n).toBe(2);
    expect(raf.pending).toBe(1);
    expect(loop.source).toBe('three');
  });

  it('a lost device does not move the step: three’s loop still calls it (render() just draws nothing)', () => {
    const { loop, raf, draws } = rig();
    const three = new FakeThreeRenderer(raf);
    loop.attachRenderer(three);
    let n = 0;
    loop.setAnimationLoop(() => {
      n++;
      loop.render();
    });
    raf.tick(2);
    draws.ok = false; // the device is lost
    raf.tick(3);
    expect(n).toBe(5);
    expect(draws.n).toBe(2);
    expect(raf.chains.slice(-3)).toEqual([1, 1, 1]);
  });

  it('during a rebuild (no renderer) the facade keeps calling the step from its own rAF, then hands back', () => {
    const { loop, raf } = rig();
    const first = new FakeThreeRenderer(raf);
    loop.attachRenderer(first);
    let n = 0;
    loop.setAnimationLoop(() => n++);
    raf.tick(3);

    // X3's rebuild: detach, dispose the old renderer (its chain ends), build the next one
    loop.detachRenderer();
    first.dispose();
    expect(loop.source).toBe('own');
    expect(first.sets).toEqual(['fn', 'null']);
    raf.chains.length = 0;
    raf.tick(4);
    expect(n).toBe(7);
    expect(raf.chains).toEqual([1, 1, 1, 1]);

    const second = new FakeThreeRenderer(raf);
    loop.attachRenderer(second);
    raf.chains.length = 0;
    raf.tick(4);
    expect(n).toBe(11);
    expect(raf.chains).toEqual([1, 1, 1, 1]);
    expect(loop.source).toBe('three');
  });

  it('detaching with no step leaves no chain behind; dispose clears everything', () => {
    const { loop, raf } = rig();
    const three = new FakeThreeRenderer(raf);
    loop.attachRenderer(three);
    loop.detachRenderer();
    three.dispose();
    expect(raf.pending).toBe(0);
    expect(loop.source).toBe('idle');

    let n = 0;
    loop.setAnimationLoop(() => n++);
    raf.tick(1);
    loop.dispose();
    raf.tick(3);
    expect(n).toBe(1);
    expect(raf.pending).toBe(0);
  });

  it('a step that throws does not end the own chain', () => {
    const { loop, raf } = rig();
    let n = 0;
    loop.setAnimationLoop(() => {
      n++;
      if (n === 2) throw new Error('step');
    });
    raf.tick(1);
    expect(() => raf.tick(1)).toThrow('step');
    raf.tick(2);
    expect(n).toBe(4);
  });
});

describe('resize rides the frame (render §3.3: debounced to one animation frame)', () => {
  it('a pending resize is flushed once per frame, before the step', () => {
    const { loop, raf, resize } = rig();
    const order: string[] = [];
    loop.setAnimationLoop(() => order.push(`step:${resize.flushed}`));
    raf.tick(2);
    expect(order).toEqual(['step:1', 'step:2']);
  });

  it('a resize while paused triggers one render() (the step draws nothing while paused)', () => {
    const { loop, raf, resize, draws } = rig();
    let paused = false;
    loop.setAnimationLoop(() => {
      if (!paused) loop.render();
    });
    raf.tick(1);
    expect(draws.n).toBe(1);
    paused = true;
    raf.tick(3);
    expect(draws.n).toBe(1);
    resize.pending = true;
    raf.tick(1);
    expect(draws.n).toBe(2);
    raf.tick(3);
    expect(draws.n).toBe(2);
  });

  it('a resize in a frame the step renders anyway is not drawn twice', () => {
    const { loop, raf, resize, draws } = rig();
    loop.setAnimationLoop(() => loop.render());
    raf.tick(1);
    resize.pending = true;
    raf.tick(1);
    expect(draws.n).toBe(2);
  });

  it('a resize before the first frame draws nothing by itself (the veil is still up)', () => {
    const { loop, raf, resize, draws } = rig();
    loop.setAnimationLoop(() => undefined);
    resize.pending = true;
    raf.tick(2);
    expect(draws.n).toBe(0);
  });

  it('requestPresent() gets one render() on the next frame when the step draws nothing (a tier change resized the canvas)', () => {
    const { loop, raf, draws } = rig();
    let paused = false;
    loop.setAnimationLoop(() => {
      if (!paused) loop.render();
    });
    raf.tick(1);
    paused = true;
    loop.requestPresent();
    expect(draws.n).toBe(1); // not inside the call: on the next animation frame
    raf.tick(1);
    expect(draws.n).toBe(2);
    raf.tick(3);
    expect(draws.n).toBe(2);

    // a frame the step renders anyway is not drawn twice
    paused = false;
    loop.requestPresent();
    raf.tick(1);
    expect(draws.n).toBe(3);
  });

  it('on three’s loop the resize is flushed even without a step', () => {
    const { loop, raf, resize, draws } = rig();
    loop.render(); // a first frame exists
    loop.attachRenderer(new FakeThreeRenderer(raf));
    resize.pending = true;
    raf.tick(1);
    expect(resize.flushed).toBe(1);
    expect(draws.n).toBe(2);
  });
});
