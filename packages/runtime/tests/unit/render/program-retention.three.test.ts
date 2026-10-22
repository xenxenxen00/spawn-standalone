// src/render/engine/program-retention.ts on three r186's own `Pipelines` (src/renderers/common/Pipelines.js), with a stand-in
// backend and info (no renderer, no GPU). three releases a render object before it builds the one that replaces it, so a
// program whose text the next user writes again is compiled and linked again; with the retention the next user takes the
// idle stages and pipeline back. A three upgrade that changes `_releaseProgram` / `_releasePipeline` fails here (R14b).
import { describe, expect, it } from 'vitest';
import { RETAINED_IDLE_PIPELINES, RETAINED_IDLE_STAGES, installProgramRetention, retainPrograms, type RetainablePipelines } from '../../../src/render/engine/program-retention.ts';

interface Stage {
  id: number;
  code: string;
  stage: string;
  usedTimes: number;
}
interface Linked {
  cacheKey: string;
  usedTimes: number;
  vertexProgram: Stage;
  fragmentProgram: Stage;
}
interface ThreePipelines extends RetainablePipelines {
  programs: { vertex: Map<string, Stage>; fragment: Map<string, Stage> };
  caches: Map<string, Linked>;
  getForRender(renderObject: object): Linked;
  delete(renderObject: object): unknown;
}
type PipelinesCtor = new (backend: object, nodes: object, info: object) => ThreePipelines;

// a non-literal specifier: three's src modules have no typings, and the build bundles do not export `Pipelines`
const PIPELINES = 'three/src/renderers/common/Pipelines.js';
const { default: Pipelines } = (await import(/* @vite-ignore */ PIPELINES)) as { default: PipelinesCtor };

/** a three `Pipelines` over a backend that counts the compiles and links the WebGL2 backend would do */
function rig(): { p: ThreePipelines; compiles: () => number; links: () => number; released: () => number } {
  let compiles = 0;
  let links = 0;
  let released = 0;
  const backend = {
    needsRenderUpdate: () => false,
    getRenderCacheKey: () => '',
    createProgram: () => void compiles++,
    createRenderPipeline: () => void links++,
  };
  const info = { createProgram: () => undefined, destroyProgram: () => void released++ };
  return { p: new Pipelines(backend, {}, info), compiles: () => compiles, links: () => links, released: () => released };
}

/** a render object as `Pipelines.getForRender` reads it: its node builder state's text and its material's name */
const renderObject = (fragment: string, vertex = 'void main() { /* quad */ }'): object => ({
  material: { name: 'm' },
  getNodeBuilderState: () => ({ vertexShader: vertex, fragmentShader: fragment }),
});

describe('program retention (R14b)', () => {
  it('control: three alone forgets a program with its last user, and the next user of the same text compiles and links it again', () => {
    const r = rig();
    const a = renderObject('frag A');
    const first = r.p.getForRender(a);
    expect([r.compiles(), r.links()]).toEqual([2, 1]);
    // what RenderObjects.get does when a cache key changed (a rebuilt post graph, the shadow turned off): dispose, then build
    r.p.delete(a);
    expect(r.p.programs.fragment.has('frag A')).toBe(false);
    const again = r.p.getForRender(renderObject('frag A'));
    expect([r.compiles(), r.links()]).toEqual([4, 2]);
    expect(again).not.toBe(first);
  });

  it('retained: the next user of the same text takes the stages and the linked program back: no compile, no link', () => {
    const r = rig();
    const retention = retainPrograms(r.p);
    const a = renderObject('frag A');
    const first = r.p.getForRender(a);
    r.p.delete(a);
    expect(retention.idleStages).toBe(2);
    expect(retention.idlePipelines).toBe(1);
    expect(r.released()).toBe(0);
    const again = r.p.getForRender(renderObject('frag A'));
    expect(again).toBe(first);
    expect([r.compiles(), r.links()]).toEqual([2, 1]);
    // in use again: not idle
    expect(retention.idleStages).toBe(0);
    expect(retention.idlePipelines).toBe(0);
    expect(again.usedTimes).toBe(1);
    expect(again.fragmentProgram.usedTimes).toBe(1);
  });

  it('a tier switch and back: both states linked once, then any number of switches links nothing', () => {
    const r = rig();
    retainPrograms(r.p);
    // the warm-up linked the lit surface in both shadow states, and the frame's own object draws in one of them
    const states = ['lit + shadow', 'lit, no shadow'];
    for (const text of states) r.p.delete(((o) => (r.p.getForRender(o), o))(renderObject(text)));
    const before = [r.compiles(), r.links()];
    let drawn = renderObject(states[0]!);
    r.p.getForRender(drawn);
    for (let i = 1; i <= 20; i++) {
      r.p.delete(drawn);
      drawn = renderObject(states[i % 2]!);
      r.p.getForRender(drawn);
    }
    expect([r.compiles(), r.links()]).toEqual(before);
  });

  it('a stage or program in use is never released; a shared stage stays with its other users', () => {
    const r = rig();
    const retention = retainPrograms(r.p, { stages: 0, pipelines: 0 });
    const a = renderObject('frag A');
    const b = renderObject('frag B');
    r.p.getForRender(a);
    r.p.getForRender(b);
    // b keeps the shared vertex stage in use: only A's fragment stage and A's program go idle, and past a limit of 0 they go
    r.p.delete(a);
    expect(r.p.programs.vertex.size).toBe(1);
    expect(r.p.programs.fragment.has('frag A')).toBe(false);
    expect(r.p.programs.fragment.has('frag B')).toBe(true);
    expect(retention.evicted).toBe(2);
    expect(r.released()).toBe(1);
  });

  it('bounded: past the limit the stage idle the longest is released as three would have', () => {
    const r = rig();
    const retention = retainPrograms(r.p, { stages: 3, pipelines: 2 });
    const objects = ['f0', 'f1', 'f2', 'f3'].map((f) => renderObject(f, `vertex of ${f}`));
    for (const o of objects) r.p.getForRender(o);
    for (const o of objects) r.p.delete(o);
    // 8 stages and 4 programs went idle: the oldest are gone, the newest kept
    expect(retention.idleStages).toBe(3);
    expect(retention.idlePipelines).toBe(2);
    expect(retention.evicted).toBe(5 + 2);
    expect(r.p.programs.fragment.has('f0')).toBe(false);
    expect(r.p.programs.fragment.has('f3')).toBe(true);
    const links = r.links();
    r.p.getForRender(renderObject('f3', 'vertex of f3'));
    expect(r.links()).toBe(links);
    // a released one links again
    r.p.getForRender(renderObject('f0', 'vertex of f0'));
    expect(r.links()).toBe(links + 1);
  });

  it('installs once per renderer, does nothing on a stand-in without three’s Pipelines, and uninstalls', () => {
    expect(installProgramRetention({} as never)).toBeNull();
    expect(installProgramRetention({ _pipelines: {} } as never)).toBeNull();
    const r = rig();
    const renderer = { _pipelines: r.p };
    const first = installProgramRetention(renderer as never);
    expect(first).not.toBeNull();
    expect(installProgramRetention(renderer as never)).toBe(first);
    const a = renderObject('frag A');
    r.p.getForRender(a);
    first!.uninstall();
    // three's own release again: both stages of the program go with their last user
    r.p.delete(a);
    expect(r.released()).toBe(2);
    expect(r.p.programs.fragment.has('frag A')).toBe(false);
    expect(RETAINED_IDLE_STAGES).toBeGreaterThanOrEqual(2 * RETAINED_IDLE_PIPELINES);
    expect(() => retainPrograms(rig().p, { stages: -1, pipelines: 1 })).toThrow(RangeError);
  });
});
