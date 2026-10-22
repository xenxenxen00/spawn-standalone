// The package entry points other workspaces import.
import { describe, expect, it } from 'vitest';

describe('package exports', () => {
  it('@spawn-standalone/runtime/shell is composeGame', async () => {
    const shell = await import('@spawn-standalone/runtime/shell');
    expect(typeof shell.composeGame).toBe('function');
    expect(typeof Reflect.get(shell, 'createAudioEngine')).toBe('function');
  });
  it('@spawn-standalone/cli re-exports the import stage', async () => {
    const cli = await import('@spawn-standalone/cli');
    expect(typeof cli.runImport).toBe('function');
    expect(typeof cli.runInit).toBe('function');
    expect(typeof cli.scanJs).toBe('function');
    expect(cli.defineGame({ name: 'G', slug: 'g', source: { dir: '.' } }).slug).toBe('g');
  });
});
