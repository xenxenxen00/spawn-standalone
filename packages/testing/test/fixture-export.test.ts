import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { createFixtureExport } from '../src/fixture-export.ts';
import { createInputPort } from '../../runtime/src/runtime/input/action-sink.ts';
import type { InputsDef } from '../../runtime/src/compat/core/types.ts';
import { ctxWorld } from '../../runtime/tests/unit/core/fakes/ctx-world.ts';

const temp = mkdtempSync(join(tmpdir(), 'ss-interactive-fixture-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe('generated interactive fixture', () => {
  it('routes the declared button action through the real input port and kernel into rendered world state', async () => {
    const root = createFixtureExport(join(temp, 'export'));
    const config = load(readFileSync(join(root, 'source/world.config.yaml'), 'utf8')) as { inputs: InputsDef };
    const input = createInputPort({ map: config.inputs });
    const modules = Object.fromEntries(await Promise.all(['scripts/player.js', 'templates/player.js'].map(async (path) => [path, await import(pathToFileURL(join(root, 'source', path)).href)])));
    const world = await ctxWorld({ modules, worldConfig: { inputs: config.inputs }, ports: { input: input.port } });
    world.human();
    const ui = await import(pathToFileURL(join(root, 'source/scripts/ui.js')).href);
    const render = (): string => ui.default(world.k.createUiCtx());
    expect(render()).toContain('onclick="sendAction(\'bump\')"');
    expect(render()).toContain('id="fixture-clicks">0</output>');
    expect(input.sink.inject('undeclared')).toBe(false);
    world.ticks(1);
    expect(render()).toContain('id="fixture-clicks">0</output>');
    expect(input.sink.inject('bump')).toBe(true);
    world.ticks(1);
    expect(render()).toContain('id="fixture-clicks">1</output>');
    world.ticks(1);
    expect(render()).toContain('id="fixture-clicks">1</output>');
    expect(world.k.metrics.hookErrors).toBe(0);
  });
});
