import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A tiny local export with UI, a generator outside scripts/gen/, SQL and a job. No game workspace or Git is required. */
export function createFixtureExport(dir: string): string {
  const files: Record<string, string> = {
    'source/world.config.yaml': 'name: Fixture World\ncamera: templates/camera.js#camera\nplayer: templates/player.js#player\ndefaultPlace: main\nui:\n  render: scripts/ui.js\ninputs:\n  actions:\n    bump: {}\n',
    'source/sim.js': [
      'export const cadence = "100ms";',
      'export function tick(ctx) {',
      '  const state = ctx.world.state; state.ticks = (state.ticks ?? 0) + 1;',
      '  if (state.started) return; state.started = true;',
      '  ctx.sql`INSERT INTO scores (score) VALUES (21); SELECT SUM(score) AS total FROM scores`.then((r) => { state.sql = r.rows[0].total; }).catch((e) => { state.error = String(e); });',
      '  ctx.job("double", { value: 21 }, (r) => { if (r.ok) state.job = r.data; else state.error = r.error.message; });',
      '}',
    ].join('\n') + '\n',
    'source/templates/player.js': 'export const player = { behavior: "scripts/player.js", tags: ["player"], state: {} };\n',
    'source/scripts/player.js': 'export function onInput(ctx, input) { if (input.pressed.bump) ctx.world.state.clicks = (ctx.world.state.clicks ?? 0) + 1; }\n',
    'source/templates/camera.js': 'export const camera = { kind: "custom", state: { pitch: 0, yaw: 0 } };\n',
    'source/places/main/config.yaml': 'defaultSpawnPoint: { x: 0, y: 1, z: 0 }\natmosphere:\n  sky: { kind: gradient, zenith: "#123060", horizon: "#6090b0" }\n  ambient:\n    light: { color: "#ffffff", intensity: 1 }\n',
    'source/places/main/cells/x0z0.scene': '# spawn-scene v2 yaml x0z0\ntriangle:\n  feetPosition: { x: 0, y: 0, z: -4 }\n  primitive: { kind: scripted, script: scripts/art/triangle.js }\n',
    'source/scripts/art/triangle.js': 'export function geometry(ctx) { ctx.tri(-1,0,0, 1,0,0, 0,2,0); }\n',
    'source/scripts/ui.js': "export default function render(ctx) { return `<main id=\"fixture-hud\"><h1>Fixture World</h1><img alt=\"Fixture mark\" src=\"/cdn/mark.svg\"><button id=\"fixture-button\" type=\"button\" onclick=\"sendAction('bump')\">Add one</button><output id=\"fixture-clicks\">${ctx.world.state.clicks ?? 0}</output><p>Ticks: ${ctx.world.state.ticks ?? 0}</p><p id=\"fixture-sql\">SQL: ${ctx.world.state.sql ?? \"pending\"}</p><p id=\"fixture-job\">Job: ${ctx.world.state.job ?? \"pending\"}</p><p id=\"fixture-error\">${ctx.world.state.error ?? \"\"}</p></main>`; }\n",
    'source/scripts/db.js': 'export async function migrate(sql) { await sql`CREATE TABLE IF NOT EXISTS scores (score INTEGER)`; }\n',
    'source/jobs/double.js': 'export function run(job, args) { return args.value * 2; }\n',
    'source/.spawn/engine.yaml': 'version: 6.0.0\n',
    'assets/cdn/mark.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="#9cf" d="M0 0h16v16H0z"/></svg>\n',
    'export-info.json': JSON.stringify({ name: 'Fixture World', commit: 'fixture-v1', engineVersion: '6.0.0' }) + '\n',
  };
  files['asset-manifest.json'] = JSON.stringify([{ reference: '/cdn/mark.svg', sha256: createHash('sha256').update(files['assets/cdn/mark.svg']!).digest('hex') }]) + '\n';
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { flag: 'wx' });
  }
  return dir;
}
