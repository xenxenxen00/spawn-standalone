// Procedural rigs must match an independent matrix FK oracle; a wrong rotation order is the negative control.
import { Matrix4, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { Pose } from '../../src/compat/motion/pose.ts';
import { qFromEulerXYZDeg } from '../../src/compat/motion/quat.ts';
import { applyPose } from '../../src/compat/motion/three-skin.ts';
import { RigMixer, type RigMixerOptions, parseSkeleton, rigFromSkeleton, skinPoint } from '../../src/render/rig/index.ts';
import { createRigidGeometry, createRigidRigInstance } from '../../src/render/rig/three-rig.ts';
import { MARKERS, PIECES, type Vec3, bonesProp, dist, randomPose, referenceFk, rng } from './fixtures.ts';

const TOL = 0.02;
const POSES = 25;

function posed(cls: 'P' | 'N', pose: Record<string, number>, opts: RigMixerOptions = {}): Pose {
  const rig = rigFromSkeleton(`piece-${cls}`, parseSkeleton(PIECES[cls]));
  const mixer = new RigMixer('row', rig, opts);
  mixer.setBoneChannels(bonesProp(pose));
  const p = new Pose(rig);
  mixer.evaluate(p, 0);
  p.updateModel();
  return p;
}

function worstError(cls: 'P' | 'N', opts: RigMixerOptions = {}): number {
  const r = rng(cls === 'P' ? 7 : 11);
  let worst = 0;
  for (let i = 0; i < POSES; i++) {
    const pose = randomPose(PIECES[cls], r);
    const p = posed(cls, pose, opts);
    for (const [bone, pt] of Object.values(MARKERS[cls])) {
      const want = referenceFk(PIECES[cls], pose, bone, pt);
      const got = skinPoint(p, bone, pt)!;
      worst = Math.max(worst, dist(got, want));
    }
  }
  return worst;
}

describe('procedural rig FK = the matrix FK oracle (roll, then pitch, then yaw about pivots)', () => {
  for (const cls of ['P', 'N'] as const) {
    it(`class ${cls}: ${POSES} random poses, every marker within 2 cm`, () => {
      const worst = worstError(cls);
      expect(worst).toBeLessThan(TOL);
      expect(worst).toBeLessThan(1e-4); // float32 pose storage, nothing else
    });

    it(`class ${cls}: negative control, the authored-clip X·Y·Z order misses by far more than 2 cm`, () => {
      const wrong: RigMixerOptions = { rotation: (out, pitch, yaw, roll) => void qFromEulerXYZDeg(out, 0, pitch, yaw, roll) };
      expect(worstError(cls, wrong)).toBeGreaterThan(0.1);
    });
  }

  for (const quantised of [false, true]) {
    it(`the three SkinnedMesh draws the markers at the matrix oracle positions (moved root${quantised ? ', quantised positions' : ''})`, () => {
      const cls = 'N';
      // packed LODs store positions over the bbox with a dequantisation matrix; as the bind matrix it applies before the bones
      const dequant = quantised ? new Matrix4().makeScale(0.5, 0.8, 0.6).setPosition(0.1, 0.6, -0.2) : undefined;
      const encode = dequant ? dequant.clone().invert() : new Matrix4();
      const rig = rigFromSkeleton('piece-N', parseSkeleton(PIECES[cls]));
      const markers = Object.values(MARKERS[cls]);
      // one degenerate triangle per marker, bound to the marker's bone
      const positions: number[] = [];
      const triBone: number[] = [];
      for (const [bone, pt] of markers) {
        const q = new Vector3(...pt).applyMatrix4(encode).toArray();
        positions.push(...q, ...q, ...q);
        triBone.push(rig.index(bone));
      }
      const { mesh, target } = createRigidRigInstance(rig, createRigidGeometry(positions, triBone), undefined, dequant);
      mesh.position.set(3, 0.5, -2);
      mesh.rotation.set(0, 0.7, 0);
      mesh.updateMatrixWorld(true);
      const mixer = new RigMixer('row', rig);
      const pose = randomPose(PIECES[cls], rng(99));
      mixer.setBoneChannels(bonesProp(pose));
      const p = new Pose(rig);
      mixer.evaluate(p, 0);
      p.updateModel();
      expect(applyPose(target, p, p.modelDirty)).toBe(rig.bones.length);
      mesh.skeleton.update();
      markers.forEach(([bone, pt], i) => {
        const v = new Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position') as never, i * 3);
        mesh.applyBoneTransform(i * 3, v);
        v.applyMatrix4(mesh.matrixWorld);
        const want = new Vector3(...(referenceFk(PIECES[cls], pose, bone, pt) as Vec3)).applyMatrix4(mesh.matrixWorld);
        expect(v.distanceTo(want)).toBeLessThan(TOL);
      });
    });
  }

  it('a tween of one arm turns only the arm and its children about the shoulder pivot', () => {
    const rig = rigFromSkeleton('piece-P', parseSkeleton(PIECES.P));
    const mixer = new RigMixer('row', rig);
    const p = new Pose(rig);
    mixer.evaluate(p, 0);
    p.updateModel();
    p.clearDirty();
    mixer.setBoneChannels({ armR: { pitch: 90 } });
    mixer.evaluate(p, 0);
    p.updateModel();
    const moved = rig.bones.filter((_, b) => p.modelDirty[b] === 1);
    expect(moved.sort()).toEqual(['armR', 'weapon']);
    const shoulder = PIECES.P.armR!.pivot;
    expect(dist(skinPoint(p, 'armR', shoulder)!, shoulder)).toBeLessThan(1e-6);
    // a held value marks nothing; removing it marks the bone again and restores the rest pose
    p.clearDirty();
    mixer.evaluate(p, 0);
    expect([...p.dirty].every((d) => d === 0)).toBe(true);
    mixer.setBoneChannels({});
    mixer.evaluate(p, 0);
    p.updateModel();
    const tip = MARKERS.P.tip![1];
    expect(dist(skinPoint(p, 'weapon', tip)!, tip)).toBeLessThan(1e-6);
  });

  it('bones.weapon.y = -4 drops the weapon 4 m and leaves the arm', () => {
    const p = posed('P', { 'weapon.y': -4 });
    const tip = MARKERS.P.tip![1];
    expect(skinPoint(p, 'weapon', tip)![1]).toBeCloseTo(tip[1] - 4, 5);
    const palm = MARKERS.P.palm![1];
    expect(dist(skinPoint(p, 'armL', palm)!, palm)).toBeLessThan(1e-6);
  });
});
