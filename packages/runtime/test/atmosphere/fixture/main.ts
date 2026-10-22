// The daylight fixture page: a ground plane and a box under the daylight sky, sun and fill of createAtmosphere({ model: 'daylight' }),
// drawn by three's WebGPURenderer on its WebGL2 backend. `?hour=` picks the time of day, `?clouds=1` turns the cloud layer on.
// The test (daylight-screenshot.test.ts) builds this page with Vite, loads it in headless Chromium (SwiftShader) and screenshots it.
import { BoxGeometry, Mesh, MeshStandardNodeMaterial, PerspectiveCamera, PlaneGeometry, WebGPURenderer } from 'three/webgpu';
import { createAtmosphere } from '../../../src/render/atmosphere/atmosphere.ts';
import { createSceneRoot } from '../../../src/render/scene/scene-root.ts';

interface FixtureState { done: boolean; error: string | null; kind: string | null; sun: number }
const w = window as unknown as { __daylight?: FixtureState };
const state: FixtureState = (w.__daylight = { done: false, error: null, kind: null, sun: 0 });

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const hour = Number(q.get('hour') ?? '12');
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ canvas, forceWebGL: true, antialias: false });
  await renderer.init();
  renderer.setSize(640, 360, false);

  const root = createSceneRoot({ sunShadow: true });
  const atmosphere = createAtmosphere({ root, model: 'daylight' });
  atmosphere.load({
    sky: { kind: 'realistic', model: 'hosek' },
    timeOfDay: hour,
    clouds: q.get('clouds') === '1' ? { enabled: true, density: 0.5, opacity: 0.85, altitude: 400 } : { enabled: false },
    fog: { kind: 'exp2', density: 0.004 },
  });
  atmosphere.update({ now: 0, dt: 0.016 });

  const ground = new Mesh(new PlaneGeometry(200, 200), new MeshStandardNodeMaterial({ color: 0x4f8a3a }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  const box = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardNodeMaterial({ color: 0xc9b79c }));
  box.position.set(0, 1, -8);
  box.castShadow = true;
  box.receiveShadow = true;
  root.world.add(ground, box);

  renderer.shadowMap.enabled = true;
  const camera = new PerspectiveCamera(70, 640 / 360, 0.1, 1000);
  camera.position.set(0, 1.7, 0);
  camera.lookAt(0, 6, -20);

  for (let i = 0; i < 3; i++) {
    atmosphere.update({ now: i * 16, dt: 0.016 });
    await renderer.renderAsync(root.scene, camera);
  }
  state.kind = atmosphere.state.sky.kind;
  state.sun = root.lights.directionals[0].intensity;
  state.done = true;
}

main().catch((e: unknown) => {
  state.error = String((e as Error)?.stack ?? e);
  console.error(e);
});
