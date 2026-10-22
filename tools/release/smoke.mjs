import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createFixtureExport } from '@spawn-standalone/testing';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { dependencyPaths } from './dependency-paths.ts';

const require = createRequire(import.meta.url);
const installed = dirname(fileURLToPath(import.meta.url));
const pkgFile = require.resolve('@spawn-standalone/cli/package.json');
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')); const bin = resolve(dirname(pkgFile), pkg.bin['spawn-standalone']);
assert.ok(bin.startsWith(join(installed, 'node_modules') + sep)); assert.ok(bin.endsWith('.js'));
assert.ok(existsSync(join(installed, 'node_modules/.bin', process.platform === 'win32' ? 'spawn-standalone.cmd' : 'spawn-standalone')));
for (const name of ['runtime','cli','vite','testing']) {
  const entry = fileURLToPath(import.meta.resolve(`@spawn-standalone/${name}`));
  assert.ok(realpathSync(entry).startsWith(join(installed, 'node_modules') + sep));
  assert.ok(entry.endsWith('.js')); assert.ok(!entry.includes('.claude'));
  const metadataPath = require.resolve(`@spawn-standalone/${name}/package.json`);
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  for (const dependency of dependencyPaths(metadataPath, Object.keys(metadata.dependencies ?? {}))) {
    assert.ok(dependency.path.startsWith(join(installed, 'node_modules') + sep), `ancestor dependency fallback: ${dependency.name}`);
  }
}
const cli = (args, expected = 0) => {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: installed, encoding: 'utf8', windowsHide: true, timeout: 300_000, maxBuffer: 16 << 20 });
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result;
};
const exp = createFixtureExport(join(installed, 'export'));
const game = join(installed, 'game');
cli(['init', exp, '--name', 'fixture-world', '--out', game]);
const generated = new Map(['standalone.config.json', 'src/main.js', 'src/geometry-worker.js', 'vite.config.js'].map((p) => [p, readFileSync(join(game, p))]));
for (const args of [['import',game], ['import',game,'--check'], ['coverage',game,'--check','--json'], ['assets','build',game], ['assets','verify',game], ['build',game,'--target','web']]) cli(args);
console.log('PASS installed executable: init/import/check/coverage/assets/build');
const sim = join(game,'game/sim.js'); const original = readFileSync(sim); writeFileSync(sim, '// drift\n'); cli(['import',game,'--check'],1); writeFileSync(sim,original);
cli(['import',game,'--check']);
for (const out of [game, join(game,'src'),join(game,'game'),join(exp,'source')]) cli(['build',game,'--out',out],1);
const unknown = join(installed,'unsupported');mkdirSync(unknown);writeFileSync(join(unknown,'sim.js'),'export function tick(ctx) { ctx.neverImplemented(); }\n');cli(['coverage',unknown,'--check','--json'],1);
const asset=join(exp,'assets/cdn/mark.svg');const assetBytes=readFileSync(asset);writeFileSync(asset,assetBytes.toString().replace('#9cf','#fc9'));cli(['assets','verify',game],1);writeFileSync(asset,assetBytes);cli(['assets','verify',game]);
console.log('PASS negative controls: drift, unsafe output, unknown capability, changed asset');

writeFileSync(join(installed,'public-types.ts'), `import type { ComposeGameOptions } from '@spawn-standalone/runtime/shell';\nimport type { SpawnStandaloneOptions } from '@spawn-standalone/vite';\nimport { createFixtureExport } from '@spawn-standalone/testing';\nimport { runBuild } from '@spawn-standalone/cli';\nconst options: ComposeGameOptions = { slug: 'typed', canvas: null };\nconst plugin: SpawnStandaloneOptions = { gameDir: '.' };\nvoid [options, plugin, createFixtureExport, runBuild];\n`);
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
writeFileSync(join(installed,'public-audio.ts'), `import { createAudioEngine } from '@spawn-standalone/runtime/shell';\nimport { createAudioMusicPort } from '@spawn-standalone/runtime';\nconst audio = createAudioEngine({ lazyZeroStreams: true });\nconst music = createAudioMusicPort(audio);\nmusic.dispose(); audio.dispose();\n`);
const types = spawnSync(process.execPath,[tsc,'--noEmit','--strict','--module','nodenext','--moduleResolution','nodenext','--target','es2022','public-types.ts','public-audio.ts'],{cwd:installed,encoding:'utf8',windowsHide:true});
assert.equal(types.status,0,types.stdout+types.stderr); console.log('PASS installed public declaration consumer');

const flags = ['--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'];
const browser = await chromium.launch({headless:true,args:flags});
const checkPage = async (url) => {
 const page = await browser.newPage();const errors=[];const requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
 page.on('console',m=>{if(/unknown generator|generator failed/i.test(m.text())) errors.push(m.text());});
 await page.route('**/*',r=>r.request().url().startsWith(new URL(url).origin)||/^(data|blob):/.test(r.request().url())?r.continue():r.abort());
 try {
  await page.goto(url,{waitUntil:'load'});
  await page.waitForFunction(()=>document.body.dataset.booted==='1'||document.body.dataset.bootError!==undefined,null,{timeout:90000});
  assert.equal(await page.getAttribute('body','data-boot-error'),null);
  await page.waitForSelector('#fixture-hud h1');assert.equal(await page.textContent('#fixture-hud h1'),'Fixture World');
  await page.waitForFunction(()=>document.querySelector('#fixture-job')?.textContent==='Job: 42'&&/^SQL: \d+$/.test(document.querySelector('#fixture-sql')?.textContent??''),null,{timeout:30000});
  assert.equal(await page.textContent('#fixture-error'),'');
  const clicks = Number(await page.textContent('#fixture-clicks'));
  assert.ok(Number.isInteger(clicks));
  await page.locator('#fixture-button').click();
  await page.waitForFunction((expected)=>Number(document.querySelector('#fixture-clicks')?.textContent)===expected,clicks+1,{timeout:10000});
  assert.equal(await page.locator('#fixture-hud img').evaluate(n=>n.naturalWidth),16);
  assert.ok(requests.some(u=>u.includes('geometry-worker')));assert.ok(requests.some(u=>u.includes('job-worker')));assert.ok(requests.some(u=>u.includes('.wasm')));
  assert.deepEqual(errors,[]);await page.screenshot({path:join(installed,'fixture-boot.png')});
 } finally {await page.close();}
};
try {
const dev = spawn(process.execPath,[bin,'dev',game],{cwd:installed,windowsHide:true,stdio:['ignore','pipe','pipe']});
let devOutput='';dev.stdout.on('data',b=>devOutput+=b);dev.stderr.on('data',b=>devOutput+=b);
try {
 const url = await new Promise((yes,no)=>{const timer=setInterval(()=>{const match=/http:\/\/localhost:\d+\//.exec(devOutput);if(match){clearInterval(timer);clearTimeout(timeout);yes(match[0]);}},50);const timeout=setTimeout(()=>{clearInterval(timer);no(new Error('dev server did not start: '+devOutput));},30000);dev.once('error',no);});
 await checkPage(url);console.log('PASS installed CLI dev: browser boot, UI action/state update, geometry/job workers, SQL, asset');
} finally { dev.kill(); await new Promise(r=>dev.exitCode!==null||dev.signalCode!==null?r():dev.once('exit',r)); }

{
 cli(['package',game,'--target','playgama','--json']);
 const output=join(game,'package/playgama');assert.equal(readdirSync(join(output,'covers')).length,3);assert.ok(readdirSync(join(output,'screenshots')).length>0);
 for(const image of readdirSync(join(output,'covers'))) {const metadata=await sharp(join(output,'covers',image)).metadata();assert.ok(metadata.width>0&&metadata.height>0);}
 const root=join(output,'dist');
 const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.wasm':'application/wasm','.svg':'image/svg+xml'};
 const server=createServer((req,res)=>{let p;try{p=resolve(root,'.'+new URL(req.url??'/','http://x').pathname.replace(/\/$/,'/index.html'));}catch{res.writeHead(400).end();return;}if(!p.startsWith(root+sep)||!existsSync(p)){res.writeHead(404).end();return;}res.setHeader('Content-Type',mime[extname(p)]??'application/octet-stream');createReadStream(p).pipe(res);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {await checkPage(`http://127.0.0.1:${server.address().port}/`);}finally{await new Promise(r=>server.close(r));}
 console.log('PASS installed Playgama package: archive checks, screenshots, three covers, offline browser boot');
}
} finally {await browser.close();}
for(const [p,bytes] of generated)assert.deepEqual(readFileSync(join(game,p)),bytes,`generated scaffold changed: ${p}`);
console.log('PASS generated fixture remained unedited');
