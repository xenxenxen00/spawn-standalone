import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { repository } from './build.ts';
import { dependencyNotices } from './notices.ts';

describe('public release inventory and Windows workflow', () => {
  it('records actual non-MIT dependencies and keeps checkout paths private', () => {
    const notices = dependencyNotices();
    expect(notices).toBe(readFileSync(join(repository, 'THIRD_PARTY_NOTICES.md'), 'utf8'));
    expect(notices).toContain('| @playgama/bridge | 2.3.1 | LGPL-3.0-or-later |');
    expect(notices).toContain('| idiomorph | 0.8.0 | 0BSD |');
    expect(notices).toContain('| yaml | 2.9.1 | ISC |');
    const threeLicense = readFileSync(join(repository, 'node_modules/three/LICENSE'), 'utf8').trim();
    expect(notices).toContain('## Vendored three.js code');
    expect(notices).toContain(threeLicense);
    expect(notices).toContain('Copyright © 2010-2026 three.js authors');
    expect(notices).toContain('Permission is hereby granted, free of charge');
    expect(notices).toContain('THE SOFTWARE IS PROVIDED \"AS IS\"');
    expect(notices).not.toContain(repository);
  });
  it('runs build and checks before the external install gate without publishing', () => {
    const text = readFileSync(join(repository, '.github/workflows/local-release-check.yml'), 'utf8');
    const workflow = load(text) as { permissions: Record<string, string>; jobs: Record<string, { 'runs-on': string; steps: { run?: string }[] }> };
    const job = workflow.jobs['windows-node24']!;
    expect(job['runs-on']).toBe('windows-latest');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const commands = job.steps.map((s) => s.run).filter((s): s is string => s !== undefined);
    expect(commands).toContain('npm ci --no-audit --no-fund');
    expect(commands).toContain('npx --no-install playwright install chromium');
    expect(commands.indexOf('npm run build:packages')).toBeLessThan(commands.indexOf('npm run check'));
    expect(commands.at(-1)).toContain('npm run release:check -- --out');
    expect(text).not.toMatch(/npm publish|git push|secrets\./);
  });
});
