// Tree data for the carried code (docs/design/core-runtime.md §12.5): ctx.world.files, ctx.files.read, parsed anim YAML.
import { describe, expect, it, vi } from 'vitest';
import { createTreeStore } from '../../../src/compat/core/modules/tree.ts';

const files = [
  'templates/bot.js',
  'places/gallow-farm/cells/x0z0.scene',
  'places/gallow-farm/cells/x1z0.scene',
  'anim/hollow.yml',
  'scripts/lib/data/talents.yml',
  'places/training/cells/x0z0.scene',
];

describe('TreeStore', () => {
  it('files is the sorted, frozen carried list', () => {
    const t = createTreeStore({ files });
    expect(t.files).toEqual([...files].sort());
    expect(Object.isFrozen(t.files)).toBe(true);
    expect(t.files.filter((p) => p.startsWith('places/gallow-farm/cells/') && p.endsWith('.scene'))).toHaveLength(2);
  });

  it('readText: shipped text; null outside the tree; null and one warning for a tree path whose text was not shipped', () => {
    const warn = vi.fn<(m: string) => void>();
    const t = createTreeStore({ files, log: { warn } });
    expect(t.readText('scripts/none.js')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(t.readText('places/gallow-farm/cells/x0z0.scene')).toBeNull();
    expect(t.readText('places/gallow-farm/cells/x0z0.scene')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/places\/gallow-farm\/cells\/x0z0\.scene/);
    t.addTexts({ 'places/gallow-farm/cells/x0z0.scene': '# spawn-scene v2 yaml x0z0\nlamp: {}\n' });
    expect(t.readText('places/gallow-farm/cells/x0z0.scene')).toBe('# spawn-scene v2 yaml x0z0\nlamp: {}\n');
    expect(t.readText('./places/gallow-farm/cells/x0z0.scene')).toBe('# spawn-scene v2 yaml x0z0\nlamp: {}\n');
  });

  it('addTexts refuses a path outside the carried tree', () => {
    const t = createTreeStore({ files });
    expect(() => t.addTexts({ 'places/nowhere/cells/x0z0.scene': '' })).toThrow(/places\/nowhere/);
  });

  it('readParsed: anim entries from the registry source (authored YAML), other preloaded YAML by addParsed', () => {
    const anim = new Map([['anim/hollow.yml', { authored: { clips: { idle: 1 } }, compiled: ['c'] }]]);
    const warn = vi.fn<(m: string) => void>();
    const t = createTreeStore({ files, anim: (p) => anim.get(p), log: { warn } });
    expect(t.readParsed('anim/hollow.yml')).toEqual({ clips: { idle: 1 } });
    expect(t.readParsed('scripts/lib/data/talents.yml')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    t.addParsed('scripts/lib/data/talents.yml', { perks: [] });
    expect(t.readParsed('scripts/lib/data/talents.yml')).toEqual({ perks: [] });
    expect(t.readParsed('anim/none.yml')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1); // not in the tree: no warning
  });
});
