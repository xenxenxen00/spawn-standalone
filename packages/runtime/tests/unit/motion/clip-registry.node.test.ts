// MA1 acceptance: `clip-registry` resolves authored, library and model clips by name (docs/design/motion-physics-nav.md §3.2
// resolution order, §3.3.1 identities, §3.3.2 library addresses, §3.3.4 model clip name resolution).
import { describe, expect, it } from 'vitest';
import { makeTrack, type CompiledClip } from '../../../src/compat/motion/clip.ts';
import { ClipRegistry, resolveModelClipName, type LibraryClipSource, type ModelClipSource } from '../../../src/compat/motion/clip-registry.ts';
import { cookAuthoredFile, SS_COMPILED } from '../../../src/compat/motion/cook-authored.ts';

const clip = (id: string, kind: 'absolute' | 'delta' = 'absolute'): CompiledClip => ({
  id,
  kind,
  duration: 1,
  tracks: [makeTrack('Hips', 'rotation', 'linear', [0], [0, 0, 0, 1])],
});

const library = (loaded: Record<string, CompiledClip>, catalogue: readonly string[]): LibraryClipSource => ({
  get: (address) => loaded[address] ?? (catalogue.includes(address) ? 'pending' : undefined),
});

const models = (byModel: Record<string, readonly CompiledClip[]>): ModelClipSource => ({ clips: (modelId) => byModel[modelId] });

const viewmodel = ['dry', 'equip', 'fire', 'holster', 'idle', 'reload_empty', 'reload_tac', 'sprint'];

function registry(): ClipRegistry {
  const r = new ClipRegistry();
  r.addAuthored('anim/hollow.yml', cookAuthoredFile('anim/hollow.yml', {
    walk: { duration: 0.7, tracks: { Hips: { roll: [0, 2, 0] } } },
    bite: { duration: 0.9, tracks: { Head: { pitch: [0, 20, 0] } } },
  }));
  r.setLibrary(library({ 'cdn/clip-walk-loop.glb': clip('cdn/clip-walk-loop.glb') }, ['cdn/clip-walk-loop.glb', 'cdn/clip-die.glb']));
  r.setModelClips(models({
    'value.11db0683': viewmodel.map((n) => clip(`value.11db0683#${n}`)),
    'legacy.body': ['Armature|Walking', 'Armature|Idle', 'Armature|Run'].map((n) => clip(`legacy.body#${n}`)),
    'empty.model': [],
  }));
  r.addFunctionClip('scripts/humanoid-locomotion.js#sit', clip('scripts/humanoid-locomotion.js#sit', 'delta'));
  return r;
}

describe('ClipRegistry.resolve', () => {
  it('resolves an authored clip by its identity', () => {
    const r = registry().resolve('anim/hollow.yml#bite');
    expect(r).toMatchObject({ status: 'ready', source: 'authored' });
    expect(r.status === 'ready' && r.clip.kind).toBe('delta');
    expect(r.status === 'ready' && r.clip.duration).toBe(0.9);
  });

  it('resolves a library clip by its cdn address, pending while its group is not loaded', () => {
    const reg = registry();
    expect(reg.resolve('cdn/clip-walk-loop.glb')).toMatchObject({ status: 'ready', source: 'library', clip: { id: 'cdn/clip-walk-loop.glb' } });
    expect(reg.resolve('cdn/clip-die.glb')).toEqual({ status: 'pending', source: 'library', ref: 'cdn/clip-die.glb' });
    expect(reg.resolve('cdn/clip-nope.glb')).toEqual({ status: 'missing', ref: 'cdn/clip-nope.glb' });
  });

  it('resolves a clip function by its identity', () => {
    expect(registry().resolve('scripts/humanoid-locomotion.js#sit')).toMatchObject({ status: 'ready', source: 'function' });
  });

  it("resolves a model's own clips by name with the fuzzy rules", () => {
    const reg = registry();
    const vm = (name: string): string | null => {
      const r = reg.resolve(name, { modelId: 'value.11db0683' });
      return r.status === 'ready' ? r.clip.id : r.status;
    };
    expect(vm('fire')).toBe('value.11db0683#fire');
    expect(vm('RELOAD_TAC')).toBe('value.11db0683#reload_tac');
    expect(vm('reload')).toBe('value.11db0683#reload_empty'); // prefix: first clip whose name starts with it
    expect(vm('nothing-like-it')).toBe('value.11db0683#idle'); // fallback: the idle clip
    const legacy = (name: string): string | null => {
      const r = reg.resolve(name, { modelId: 'legacy.body' });
      return r.status === 'ready' ? r.clip.id : r.status;
    };
    expect(legacy('walk')).toBe('legacy.body#Armature|Walking');
    expect(legacy('Run')).toBe('legacy.body#Armature|Run');
  });

  it('is pending while the model is not loaded and missing when the model has no clips', () => {
    const reg = registry();
    expect(reg.resolve('fire', { modelId: 'not.loaded' })).toEqual({ status: 'pending', source: 'model', ref: 'fire' });
    expect(reg.resolve('fire', { modelId: 'empty.model' })).toEqual({ status: 'missing', ref: 'fire' });
    expect(reg.resolve('fire')).toEqual({ status: 'missing', ref: 'fire' });
  });

  it('prefers library, then authored, then function, then model names (motion §3.2 order)', () => {
    const reg = registry();
    reg.setModelClips(models({ m: [clip('m#anim/hollow.yml#walk'), clip('m#cdn/clip-walk-loop.glb')] }));
    expect(reg.resolve('cdn/clip-walk-loop.glb', { modelId: 'm' })).toMatchObject({ source: 'library' });
    expect(reg.resolve('anim/hollow.yml#walk', { modelId: 'm' })).toMatchObject({ source: 'authored' });
  });

  it('reports an authored identity of a file that is not registered as missing (the dormant archetypes)', () => {
    expect(registry().resolve('anim/suture.yml#walk')).toEqual({ status: 'missing', ref: 'anim/suture.yml#walk' });
  });

  it('accepts the virtual:ss/anim JSON form', () => {
    const reg = new ClipRegistry();
    reg.addAuthored('anim/rake.yml', [{ id: 'anim/rake.yml#idle', kind: 'delta', duration: 1, fps: 30, tracks: [] }]);
    expect(reg.resolve('anim/rake.yml#idle')).toMatchObject({ status: 'ready', source: 'authored' });
    expect(reg.authoredFiles()).toEqual(['anim/rake.yml']);
  });
});

describe('ClipRegistry.resolveRef (non-string refs)', () => {
  it('cooks an authored clip object once, or uses the compiled clip attached to it', () => {
    const reg = registry();
    const obj = { name: 'wave', duration: 1, tracks: { A: { yaw: [0, 30] } } };
    const a = reg.resolveRef(obj);
    expect(a).toMatchObject({ status: 'ready', source: 'authored', clip: { id: 'inline#wave', kind: 'delta' } });
    expect(reg.resolveRef(obj)).toEqual(a);
    const pre = clip('anim/hollow.yml#walk', 'delta');
    const tagged = Object.defineProperty({ ...obj }, SS_COMPILED, { value: pre, enumerable: false });
    expect(reg.resolveRef(tagged)).toEqual({ status: 'ready', source: 'authored', clip: pre });
  });

  it('bakes clip functions through the injected baker (clip-function.ts), missing without one', () => {
    const fn = Object.assign((_t: number) => ({ Hips: { rotation: [0, 0, 10] as [number, number, number] } }), { duration: 1 });
    const bare = new ClipRegistry();
    expect(bare.resolveRef(fn)).toEqual({ status: 'missing', ref: 'function' });
    const baked = clip('fn#x', 'delta');
    bare.setFunctionBaker(() => baked);
    expect(bare.resolveRef(fn)).toEqual({ status: 'ready', source: 'function', clip: baked });
  });

  it('routes strings through resolve()', () => {
    expect(registry().resolveRef('anim/hollow.yml#walk')).toMatchObject({ status: 'ready', source: 'authored' });
  });
});

describe('resolveModelClipName (motion §3.3.4)', () => {
  it('exact → case-insensitive → prefix-stripped → prefix → contains → idle → first', () => {
    const names = ['Armature|Walking', 'IDLE_A', 'Idle', 'jump_start', 'big_jump'];
    expect(resolveModelClipName(names, 'Idle')).toBe('Idle');
    expect(resolveModelClipName(names, 'idle')).toBe('Idle');
    expect(resolveModelClipName(names, 'armature|walking')).toBe('Armature|Walking');
    expect(resolveModelClipName(names, 'walking')).toBe('Armature|Walking');
    expect(resolveModelClipName(names, 'Walk')).toBe('Armature|Walking');
    expect(resolveModelClipName(names, 'jump')).toBe('jump_start');
    expect(resolveModelClipName(names, 'g_ju')).toBe('big_jump');
    expect(resolveModelClipName(names, 'swim')).toBe('Idle');
    expect(resolveModelClipName(['run', 'walk'], 'swim')).toBe('run');
    expect(resolveModelClipName([], 'swim')).toBeNull();
  });
});
