// virtual:ss/anim: every anim/*.yml with its authored YAML and the clips cooked at build time by the runtime's cook rule.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cookAuthoredFile } from '../../runtime/src/compat/motion/cook-authored.ts';
import { clipToJson } from '../../runtime/src/compat/motion/clip.ts';
import { GameModules } from '../src/index.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ss-anim-')).split(String.fromCharCode(92)).join('/');
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function game(files: Record<string, string>): GameModules {
  const root = `${tmp}/game-${Object.keys(files).length}`;
  mkdirSync(`${root}/.import`, { recursive: true });
  mkdirSync(`${root}/anim`, { recursive: true });
  for (const [p, text] of Object.entries(files)) writeFileSync(`${root}/${p}`, text);
  writeFileSync(`${root}/.import/live-files.json`, JSON.stringify({ files: Object.keys(files).map((path) => ({ path })) }));
  writeFileSync(`${root}/.import/modules.json`, JSON.stringify({ registry: [], content: [] }));
  writeFileSync(`${root}/.import/preload-sets.json`, JSON.stringify({ sets: {} }));
  return new GameModules({ gameDir: tmp, gameRoot: root });
}

describe('virtual:ss/anim', () => {
  it('embeds the cooked clips of each anim file (CompiledClipJson[], the runtime cook rule)', () => {
    const yaml = 'wave:\n  duration: 1\n  tracks:\n    Arm:\n      pitch: [0, 45, 0]\n';
    const g = game({ 'anim/hop.yml': yaml, 'anim/bad.yml': 'wave: [unclosed\n' });
    const src = g.load('anim');
    const expected = JSON.stringify(cookAuthoredFile('anim/hop.yml', { wave: { duration: 1, tracks: { Arm: { pitch: [0, 45, 0] } } } }).map((c) => clipToJson(c)));
    expect(src).toContain(`"anim/hop.yml": () => import("@game/anim/hop.yml").then((m) => ({ authored: m.default, compiled: ${expected} })),`);
    expect(expected).toContain('"id":"anim/hop.yml#wave"');
    // a file that does not cook stays null: the runtime's anim host cooks it on use and reports the error there
    expect(g.cookedAnim('anim/bad.yml')).toBe('null');
  });
});
