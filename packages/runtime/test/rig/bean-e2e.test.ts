// End to end (K3, INTEGRATION.md H1-H5): a toy-bean generator (`skeleton()` + `ctx.bone` parts) is recorded and packed in the
// in-process geometry worker, drawn by the map batcher as a skinned single row, bound to the motion presenter through the three
// skin adapter, and posed by an authored clip on its `gait` channel. Vertices of the bones the clip turns move to where the CPU
// rigid-skin reference puts them; vertices of every other bone stay exactly at rest (negative control). Also measures the CPU
// cost of posing 62 such rigs per frame.
import { Vector3 } from 'three/webgpu';
import type { SkinnedMesh } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { RowRec } from '../../src/compat/core/types.ts';
import type { AuthoredClipObject } from '../../src/compat/motion/clip.ts';
import { ClipRegistry } from '../../src/compat/motion/clip-registry.ts';
import { Pose } from '../../src/compat/motion/pose.ts';
import { createMotion } from '../../src/compat/motion/scheduler-hooks.ts';
import { threeSkin } from '../../src/compat/motion/three-skin.ts';
import { bindRiggedSingle } from '../../src/render/bridge/attach.ts';
import { createRigMixer, ScriptRigs, skinPoint } from '../../src/render/rig/index.ts';
import { RUN } from './fixtures.ts';
import { at, bean, BEAN_SPEC, buildBatcher, skinnedUnder } from './harness.ts';

/** turns the left leg and the right arm only */
const KICK: AuthoredClipObject = { name: 'kick', duration: 0.5, tracks: { legL: { pitch: [40, 40] }, armR: { roll: [-60, -60], y: [0.05, 0.05] } } };

function fakeRow(id: string, serial: number, clip: AuthoredClipObject): RowRec {
  return {
    id,
    serial,
    parentId: null,
    phase: 'alive',
    place: 'main',
    props: { mixer: { gait: { clip, loop: 'loop', speed: 1, blendIn: 0 } } },
    tf: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
  } as unknown as RowRec;
}

async function scene(n: number, clip: AuthoredClipObject) {
  const rows = new Map<string, RowRec>();
  const motion = createMotion({ registry: new ClipRegistry(), createMixer: createRigMixer, rows });
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const rigs = new ScriptRigs();
  const { batcher } = await buildBatcher(
    ids.map((id, i) => bean(id, (i % 8) * 3 - 10, { dynamic: true })),
    { rigs },
  );
  const presenter = motion.presenter({ skin: threeSkin });
  ids.forEach((id, i) => {
    const row = fakeRow(id, i + 1, clip);
    rows.set(id, row);
    motion.anim.rowSpawned(row);
    // the map host's bind (render/bridge/attach.ts): presenter.bind on the row's skeleton, which sets the script's rig
    expect(bindRiggedSingle(presenter, batcher.singles.find((s) => s.row.id === id)!)).toBe(true);
    expect(motion.anim.get(id)!.rig).toBe(rigs.get(BEAN_SPEC.script));
  });
  return { motion, batcher, presenter, ids, rigs };
}

/** rest (bind) world position of vertex v of a skinned packed level, and its skinned world position now */
function vertexWorld(mesh: SkinnedMesh, v: number): { rest: Vector3; posed: Vector3 } {
  const p = new Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position') as never, v);
  mesh.updateMatrixWorld(true); // attached bind mode: bindMatrixInverse = inverse(matrixWorld)
  const rest = p.clone().applyMatrix4(mesh.bindMatrix).applyMatrix4(mesh.matrixWorld);
  const posed = mesh.applyBoneTransform(v, p.clone()).applyMatrix4(mesh.matrixWorld);
  return { rest, posed };
}

describe('K3 end to end: a rigged bean recorded, packed, instanced and posed by a clip', () => {
  it('moves the vertices of the clip\'s bones to the CPU reference and leaves every other vertex at rest', async () => {
    const { motion, batcher, presenter } = await scene(1, KICK);
    const rig = batcher.rowRig('p0')!;
    const mesh = skinnedUnder(rig.root).find((m) => m.name.endsWith(':lod1'))!;
    expect(mesh).toBeDefined();
    motion.advanceTick(0.1);
    presenter.update({ alpha: 0, dt: 1 / 60, frameIndex: 0, paused: false });
    expect(presenter.stats.bonesWritten).toBeGreaterThan(0);

    // the CPU reference pose of the same mixer
    const pose = new Pose(rig.rig);
    motion.anim.get('p0')!.evaluate(pose, 0);
    pose.updateModel();
    const skin = mesh.geometry.getAttribute('skinIndex');
    const legL = rig.rig.index('legL'), armR = rig.rig.index('armR');
    const rowX = at(-10, 0)[12]!;
    let moved = 0, still = 0, worstRef = 0, worstStill = 0, maxMove = 0;
    const movedBones = new Set<string>();
    for (let v = 0; v < skin.count; v++) {
      const b = skin.getX(v);
      const { rest, posed } = vertexWorld(mesh, v);
      const d = posed.distanceTo(rest);
      if (b === legL || b === armR) {
        moved++;
        maxMove = Math.max(maxMove, d);
        // rest in the row frame → the reference's posed model frame → world (the row only translates)
        const ref = skinPoint(pose, rig.rig.bones[b]!, [rest.x - rowX, rest.y, rest.z])!;
        worstRef = Math.max(worstRef, Math.hypot(ref[0] + rowX - posed.x, ref[1] - posed.y, ref[2] - posed.z));
        if (d > 1e-3) movedBones.add(rig.rig.bones[b]!);
      } else {
        still++;
        worstStill = Math.max(worstStill, d);
      }
    }
    expect(moved).toBeGreaterThan(50);
    expect(still).toBeGreaterThan(200);
    expect(movedBones).toEqual(new Set(['legL', 'armR']));
    expect(maxMove).toBeGreaterThan(0.05); // a 40° kick and a 60° arm roll plus 5 cm lift
    expect(worstRef).toBeLessThan(1e-4); // GPU-path maths (three's applyBoneTransform) = the rigid-skin reference
    expect(worstStill).toBeLessThan(1e-5); // negative control: body, eyes, legR, armL do not move
    batcher.dispose();
  });

  it('follows the row: moving the row moves every vertex with it, posed or not', async () => {
    const { motion, batcher, presenter } = await scene(1, KICK);
    const rig = batcher.rowRig('p0')!;
    const mesh = skinnedUnder(rig.root).find((m) => m.name.endsWith(':lod1'))!;
    motion.advanceTick(0.1);
    presenter.update({ alpha: 0, dt: 1 / 60, frameIndex: 0, paused: false });
    const before = vertexWorld(mesh, 0).posed;
    batcher.setRowMatrix('p0', at(5, 7));
    presenter.update({ alpha: 0, dt: 1 / 60, frameIndex: 1, paused: false });
    const after = vertexWorld(mesh, 0).posed;
    expect(after.x - before.x).toBeCloseTo(15, 5);
    expect(after.z - before.z).toBeCloseTo(7, 5);
    batcher.dispose();
  });
});

describe('K3 budget: posing 62 rigs per frame on the CPU', () => {
  it('measures clip evaluation + FK + bone writes + skeleton.update for 62 running beans', async () => {
    const N = 62;
    const { motion, batcher, presenter, ids } = await scene(N, RUN);
    const skeletons = ids.map((id) => batcher.rowRig(id)!.skeleton);
    const frame = (i: number, moveRoots: boolean): void => {
      motion.advanceTick(1 / 60);
      if (moveRoots) for (let r = 0; r < N; r++) batcher.setRowMatrix(ids[r]!, at((r % 8) * 3 - 10 + i * 0.01, r));
      presenter.update({ alpha: 0.5, dt: 1 / 60, frameIndex: i, paused: false });
      for (const s of skeletons) s.update(); // what three does per skinned draw before upload (bone matrices × inverses)
    };
    const measure = (moveRoots: boolean): number => {
      for (let i = 0; i < 120; i++) frame(i, moveRoots);
      const frames = 600;
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) frame(120 + i, moveRoots);
      return (performance.now() - t0) / frames;
    };
    const posing = measure(false);
    const walking = measure(true);
    expect(presenter.stats.rows).toBe(N);
    expect(presenter.stats.evaluated).toBe(N);
    console.log(`[K3 budget] 62 rigs × 7 bones, RUN clip: ${posing.toFixed(3)} ms/frame posing in place, ${walking.toFixed(3)} ms/frame with every root moving`);
    expect(walking).toBeLessThan(16); // a generous ceiling; the number is reported, not tuned
    batcher.dispose();
  });
});
