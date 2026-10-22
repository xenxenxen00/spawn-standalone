// Registry contracts exercised through explicitly injected namespaces; no host module map is required.
import { describe, expect, it, vi } from 'vitest';
import {
  SpawnRefused,
  asBehaviorModule,
  asSimModule,
  createRegistry,
  normalizeTreePath,
  parseCadenceMs,
  parseTemplateRef,
} from '../../src/compat/core/modules/registry.ts';
import type { RegistryInputs } from '../../src/compat/core/types.ts';

type Ns = Record<string, unknown>;

/** a fake module map: each loader counts its calls and resolves to the given namespace (or rejects) */
function fakeInputs(mods: Record<string, Ns | Error>, sets: Record<string, string[]> = {}, anim: Record<string, unknown> = {}) {
  const calls: Record<string, number> = {};
  const modules: Record<string, () => Promise<Ns>> = {};
  for (const [p, ns] of Object.entries(mods)) {
    modules[p] = async () => {
      calls[p] = (calls[p] ?? 0) + 1;
      await Promise.resolve();
      if (ns instanceof Error) throw ns;
      return ns;
    };
  }
  const animLoaders: Record<string, () => Promise<{ authored: unknown; compiled: unknown }>> = {};
  for (const [p, v] of Object.entries(anim)) animLoaders[p] = async () => ({ authored: v, compiled: [`cooked:${p}`] });
  const inputs: RegistryInputs = { modules, sets: sets as unknown as RegistryInputs['sets'], anim: animLoaders };
  return { inputs, calls };
}

const quiet = () => ({ warn: vi.fn<(m: string) => void>() });

describe('template refs and paths', () => {
  it('parses `templates/<file>.js#<identifier>` and nothing else', () => {
    expect(parseTemplateRef('templates/kit/bin.js#bin')).toEqual({ file: 'templates/kit/bin.js', exportName: 'bin' });
    expect(parseTemplateRef('templates/entities/sample-item.js#sampleItem')).toEqual({
      file: 'templates/entities/sample-item.js',
      exportName: 'sampleItem',
    });
    expect(parseTemplateRef('templates/entities/x.js#sample-item')).toBeNull(); // export names must be identifiers
    expect(parseTemplateRef('templates/x.js')).toBeNull();
    expect(parseTemplateRef('scripts/x.js#a')).toBeNull();
    expect(parseTemplateRef('templates/x.yml#a')).toBeNull();
  });
  it('normalises tree paths without a leading ./ or /', () => {
    expect(normalizeTreePath('./scripts/x.js')).toBe('scripts/x.js');
    expect(normalizeTreePath('/scripts/x.js')).toBe('scripts/x.js');
    expect(normalizeTreePath('scripts/x.js')).toBe('scripts/x.js');
  });
  it('parses the sim cadence grammar', () => {
    expect(parseCadenceMs('100ms')).toBe(100);
    expect(parseCadenceMs('1s')).toBe(1000);
    expect(parseCadenceMs('5m')).toBe(300_000);
    expect(parseCadenceMs('0.5s')).toBe(500);
    expect(parseCadenceMs('fast')).toBeNull();
    expect(parseCadenceMs('100')).toBeNull();
  });
});

describe('ModuleRegistry over a fake map', () => {
  const sample = { sample: { tags: ['entity', 'sample'], state: { hp: 10, nested: { a: 1 } }, behavior: ['scripts/entity.js'] } };
  const mods = () => ({
    'templates/sample.js': sample,
    'scripts/entity.js': { onSpawn() {}, update() {} },
    'scripts/a.js': { a: 1 },
    'scripts/b.js': { b: 2 },
    'scripts/broken.js': new Error('boom'),
  });

  it('knows exactly the injected paths; get answers only once loaded', async () => {
    const { inputs } = fakeInputs(mods(), { boot: ['scripts/a.js'] });
    const reg = createRegistry(inputs, { log: quiet() });
    expect(reg.knows('scripts/a.js')).toBe(true);
    expect(reg.knows('./scripts/a.js')).toBe(true);
    expect(reg.knows('scripts/zzz.js')).toBe(false);
    expect(reg.get('scripts/a.js')).toBeUndefined();
    await reg.ensure('boot');
    expect(reg.get('scripts/a.js')).toEqual({ a: 1 });
    expect(reg.get('scripts/b.js')).toBeUndefined();
  });

  it('ensure loads a set or explicit paths once, reports progress and ends at 1', async () => {
    const { inputs, calls } = fakeInputs(mods(), { boot: ['scripts/a.js', 'scripts/b.js'], empty: [] });
    const reg = createRegistry(inputs, { log: quiet() });
    const progress: number[] = [];
    await Promise.all([reg.ensure('boot', (f) => progress.push(f)), reg.ensure(['scripts/a.js'])]);
    expect(calls).toEqual({ 'scripts/a.js': 1, 'scripts/b.js': 1 });
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((x, y) => x - y));
    const again: number[] = [];
    await reg.ensure('boot', (f) => again.push(f));
    expect(again).toEqual([1]);
    expect(calls).toEqual({ 'scripts/a.js': 1, 'scripts/b.js': 1 });
    const none: number[] = [];
    await reg.ensure('empty', (f) => none.push(f));
    expect(none).toEqual([1]);
    expect(reg.lateBinds).toBe(0);
  });

  it('ensure refuses an unknown set and a set naming unknown paths, before loading anything', async () => {
    const { inputs, calls } = fakeInputs(mods(), { bad: ['scripts/a.js', 'scripts/nope.js'] });
    const reg = createRegistry(inputs, { log: quiet() });
    await expect(reg.ensure('place:nowhere')).rejects.toThrow(/unknown preload set "place:nowhere"/);
    await expect(reg.ensure('bad')).rejects.toThrow(/scripts\/nope\.js/);
    await expect(reg.ensure(['scripts/nope.js'])).rejects.toThrow(/scripts\/nope\.js/);
    expect(calls).toEqual({});
  });

  it('a failing module rejects ensure and load, and can be retried', async () => {
    const m = mods();
    const { inputs, calls } = fakeInputs(m, { boot: ['scripts/broken.js'] });
    const reg = createRegistry(inputs, { log: quiet() });
    await expect(reg.ensure('boot')).rejects.toThrow(/scripts\/broken\.js.*boom/);
    expect(reg.get('scripts/broken.js')).toBeUndefined();
    await expect(reg.ensure('boot')).rejects.toThrow(/boom/);
    expect(calls['scripts/broken.js']).toBe(2);
    await expect(reg.load('scripts/broken.js')).rejects.toThrow(/boom/);
    expect(calls['scripts/broken.js']).toBe(3);
    expect(reg.get('scripts/broken.js')).toBeUndefined();
  });

  it('load is the late-binding path: every call that finds its module unloaded counts and warns; loaded ones do not', async () => {
    const log = quiet();
    const { inputs } = fakeInputs(mods(), { boot: ['scripts/a.js'] });
    const reg = createRegistry(inputs, { log });
    await reg.ensure('boot');
    expect(await reg.load('scripts/a.js')).toEqual({ a: 1 });
    expect(reg.lateBinds).toBe(0);
    const [x, y] = await Promise.all([reg.load('scripts/b.js', 'row r1'), reg.load('scripts/b.js', 'row r2')]);
    expect(x).toBe(y);
    expect(reg.lateBinds).toBe(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/late bind scripts\/b\.js for row r1/));
    await expect(reg.load('scripts/zzz.js')).rejects.toThrow(/unknown module scripts\/zzz\.js/);
    expect(reg.lateBinds).toBe(2);
  });

  it('template(): synchronous, frozen deep clone cached per ref; SpawnRefused otherwise', async () => {
    const { inputs } = fakeInputs({ ...mods(), 'templates/str.js': { str: 'not an object' } });
    const reg = createRegistry(inputs, { log: quiet() });
    const refused = (ref: string, re: RegExp) => {
      let err: unknown;
      try {
        reg.template(ref);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SpawnRefused);
      expect((err as Error).name).toBe('SpawnRefused');
      expect((err as Error).message).toMatch(re);
    };
    refused('templates/sample.js', /bad template ref/);
    refused('templates/nope.js#nope', /unknown template file: templates\/nope\.js/);
    refused('templates/sample.js#sample', /template not loaded: templates\/sample\.js/);
    await reg.ensure(['templates/sample.js', 'templates/str.js']);
    refused('templates/sample.js#ghost', /template export missing: templates\/sample\.js#ghost/);
    refused('templates/str.js#str', /not an object/);

    const t = reg.template('templates/sample.js#sample');
    expect(t).toEqual(sample.sample);
    expect(t).not.toBe(sample.sample); // a copy: the module's own object is never handed out
    expect(Object.isFrozen(t)).toBe(true);
    expect(Object.isFrozen(t.state)).toBe(true);
    expect(Object.isFrozen((t.state as { nested: object }).nested)).toBe(true);
    expect(Object.isFrozen(t.tags)).toBe(true);
    expect(reg.template('templates/sample.js#sample')).toBe(t);
    sample.sample.state.hp = 99; // a later mutation of the module object does not leak into the cache
    expect((reg.template('templates/sample.js#sample').state as { hp: number }).hp).toBe(10);
  });

  it('anim entries load through ensure and are readable synchronously', async () => {
    const { inputs } = fakeInputs(mods(), { actors: ['scripts/a.js', 'anim/sample.yml'] }, { 'anim/sample.yml': { clips: { idle: {} } } });
    const reg = createRegistry(inputs, { log: quiet() });
    expect(reg.knowsAnim('anim/sample.yml')).toBe(true);
    expect(reg.knows('anim/sample.yml')).toBe(false); // not a module namespace
    expect(reg.anim('anim/sample.yml')).toBeUndefined();
    await reg.ensure('actors');
    expect(reg.anim('anim/sample.yml')).toEqual({ authored: { clips: { idle: {} } }, compiled: ['cooked:anim/sample.yml'] });
  });
});

describe('module shape guards', () => {
  it('asBehaviorModule accepts hook functions and refuses wrong shapes, naming the path', () => {
    const ok = { onSpawn() {}, update() {}, ears: { 'custom:event'() {} }, updateSchedule: { every: 3 }, helper() {} };
    expect(asBehaviorModule(ok, 'scripts/x.js')).toBe(ok);
    expect(asBehaviorModule({}, 'scripts/empty.js')).toEqual({});
    expect(() => asBehaviorModule({ update: 3 }, 'scripts/x.js')).toThrow(/scripts\/x\.js.*update/);
    expect(() => asBehaviorModule({ ears: { a: 1 } }, 'scripts/x.js')).toThrow(/ears\.a/);
    expect(() => asBehaviorModule({ updateSchedule: 'often' }, 'scripts/x.js')).toThrow(/updateSchedule/);
  });
  it('asSimModule needs tick and a 100 ms cadence', () => {
    const sim = { tick() {}, cadence: '100ms' };
    expect(asSimModule(sim, 'sim.js')).toBe(sim);
    expect(asSimModule({ tick() {} }, 'places/p/sim.js').tick).toBeTypeOf('function');
    expect(() => asSimModule({}, 'sim.js')).toThrow(/sim\.js.*tick/);
    expect(() => asSimModule({ tick() {}, cadence: '1s' }, 'sim.js')).toThrow(/cadence "1s"/);
  });
});
