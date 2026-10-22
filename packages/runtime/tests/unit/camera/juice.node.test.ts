// CA2 camera juice: screen shake + camera punch (docs/design/audio-ui-input.md §5.5).
// Deterministic time/noise tests; no browser/GPU. Run under vitest in the repo.
import { describe, expect, it } from 'vitest';
import { createJuice, type Juice, type JuiceTune, type Vec3Like } from '../../../src/runtime/camera/juice.ts';

// Synthetic calibration exercises the envelope and critically damped response.
const TUNE: JuiceTune = {
  shakeNoiseHz: [7, 19],
  shakeRotDeg: 4,
  shakePosM: 0.04,
  shakeDurationS: 0.3,
  shakeDecay: 4,
  punchKickDeg: 12,
  punchOmega: 32,
  punchZeta: 1,
  punchEyeM: 0.025,
};

const DT = 1 / 60;
const ROT_MAX = (TUNE.shakeRotDeg * Math.PI) / 180;
const POS_MAX = TUNE.shakePosM;

const ZERO = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0 };

const juice = (effShake = 1): Juice => createJuice({ tune: TUNE, effShake });

function frames(j: Juice, n: number, dt = DT): void {
  for (let i = 0; i < n; i++) j.offsets(dt);
}

describe('camera juice', () => {
  it('is exactly zero at rest', () => {
    const j = juice();
    expect(j.offsets(DT)).toEqual(ZERO);
    expect(j.offsets(DT)).toEqual(ZERO);
  });

  it('shake follows its configured exponential envelope and fades to zero at duration', () => {
    const j = juice();
    j.emitScreenShake(1);
    const d = TUNE.shakeDurationS;
    const decay = TUNE.shakeDecay;
    const steps = Math.ceil(d / DT) + 3;
    let peak = 0;
    let t = 0;
    for (let i = 1; i <= steps; i++) {
      const o = j.offsets(DT);
      t += DT; // same sequential accumulation as the implementation
      if (t < d) {
        const env = Math.exp(-decay * t) * (1 - t / d);
        expect(Math.abs(o.yaw)).toBeLessThanOrEqual(ROT_MAX * env + 1e-12);
        expect(Math.abs(o.pitch)).toBeLessThanOrEqual(ROT_MAX * env + 1e-12);
        expect(Math.abs(o.roll)).toBeLessThanOrEqual(ROT_MAX * env + 1e-12);
        expect(Math.abs(o.pos.x)).toBeLessThanOrEqual(POS_MAX * env + 1e-12);
        expect(Math.abs(o.pos.y)).toBeLessThanOrEqual(POS_MAX * env + 1e-12);
        expect(Math.abs(o.pos.z)).toBeLessThanOrEqual(POS_MAX * env + 1e-12);
        peak = Math.max(peak, Math.abs(o.yaw), Math.abs(o.pitch), Math.abs(o.roll));
      } else {
        // past duration: the shake is gone, exactly
        expect(o).toEqual(ZERO);
      }
    }
    // the noise actually shakes (not a flat zero masquerading as an envelope)
    expect(peak).toBeGreaterThan(ROT_MAX * 0.2);
  });

  it('concurrent shakes add', () => {
    const two = juice();
    two.emitScreenShake(0.3);
    two.emitScreenShake(0.3);
    const one = juice();
    one.emitScreenShake(0.3);
    let peakTwo = 0;
    let peakOne = 0;
    for (let i = 0; i < 30; i++) {
      peakTwo = Math.max(peakTwo, Math.abs(two.offsets(DT).pitch));
      peakOne = Math.max(peakOne, Math.abs(one.offsets(DT).pitch));
    }
    expect(peakTwo).toBeGreaterThan(peakOne);
  });

  it('total shake intensity is clamped to 1', () => {
    const j = juice();
    j.emitScreenShake(1);
    j.emitScreenShake(1);
    j.emitScreenShake(1);
    for (let i = 0; i < 40; i++) {
      const o = j.offsets(DT);
      expect(Math.abs(o.yaw)).toBeLessThanOrEqual(ROT_MAX + 1e-12);
      expect(Math.abs(o.pitch)).toBeLessThanOrEqual(ROT_MAX + 1e-12);
      expect(Math.abs(o.roll)).toBeLessThanOrEqual(ROT_MAX + 1e-12);
      expect(Math.abs(o.pos.x)).toBeLessThanOrEqual(POS_MAX + 1e-12);
      expect(Math.abs(o.pos.y)).toBeLessThanOrEqual(POS_MAX + 1e-12);
      expect(Math.abs(o.pos.z)).toBeLessThanOrEqual(POS_MAX + 1e-12);
    }
  });

  it('shake intensity is clamped into [0, 1]', () => {
    const over = juice();
    over.emitScreenShake(5);
    const one = juice();
    one.emitScreenShake(1);
    for (let i = 0; i < 10; i++) expect(over.offsets(DT)).toEqual(one.offsets(DT));
    const neg = juice();
    neg.emitScreenShake(-2);
    expect(neg.offsets(DT)).toEqual(ZERO);
  });

  it('effShake=0 removes all shake and punch', () => {
    const j = juice(0);
    j.emitScreenShake(1);
    j.emitCameraPunch({ x: 0, y: 0, z: -1 }, 1);
    for (let i = 0; i < 60; i++) expect(j.offsets(DT)).toEqual(ZERO);
  });

  it('every emit is multiplied by effShake', () => {
    const half = juice(0.5);
    half.emitScreenShake(1);
    const scaled = juice(1);
    scaled.emitScreenShake(0.5);
    for (let i = 0; i < 10; i++) expect(half.offsets(DT)).toEqual(scaled.offsets(DT));
  });

  it('punch kicks pitch/yaw velocity along -direction.y / direction.x', () => {
    const yaw = juice();
    yaw.emitCameraPunch({ x: 1, y: 0, z: 0 }, 1);
    const oy = yaw.offsets(DT);
    expect(oy.yaw).toBeGreaterThan(0);
    expect(oy.pitch).toBe(0);
    expect(oy.roll).toBe(0);

    const pitch = juice();
    pitch.emitCameraPunch({ x: 0, y: -1, z: 0 }, 1);
    const op = pitch.offsets(DT);
    expect(op.pitch).toBeGreaterThan(0);
    expect(op.yaw).toBe(0);
  });

  it('punch displaces the eye by the configured impulse along direction.z', () => {
    const j = juice();
    j.emitCameraPunch({ x: 0, y: 0, z: -1 }, 1);
    const o = j.offsets(DT);
    const wt = TUNE.punchOmega * DT;
    expect(o.pos.z).toBeCloseTo(-TUNE.punchEyeM * (1 + wt) * Math.exp(-wt), 12);
    expect(o.yaw).toBe(0);
    expect(o.pitch).toBe(0);
  });

  it('punch peaks at the configured spring time constant and settles to zero', () => {
    const j = juice();
    j.emitCameraPunch({ x: 1, y: 0, z: 0 }, 1);
    const dt = 1 / 240;
    let t = 0;
    let tPeak = 0;
    let peak = 0;
    let ampAt03 = 0;
    for (let i = 0; i < 240; i++) {
      t += dt;
      const o = j.offsets(dt);
      const a = Math.abs(o.yaw);
      if (a > peak) {
        peak = a;
        tPeak = t;
      }
      if (i === 71) ampAt03 = a; // t = 0.3s
    }
    expect(peak).toBeGreaterThan(0);
    expect(Math.abs(tPeak - 1 / TUNE.punchOmega)).toBeLessThanOrEqual(dt);
    expect(ampAt03).toBeLessThan(peak * 0.05);
    // fully settled after 1s: snapped exactly to zero
    expect(j.offsets(dt)).toEqual(ZERO);
  });

  it('register wires only the screenShake and cameraPunch acts', () => {
    const seen: string[] = [];
    const handlers = new Map<string, (p: never) => void>();
    const j = juice();
    j.register({
      on: (act: 'screenShake' | 'cameraPunch', h: (p: never) => void): void => {
        seen.push(act);
        handlers.set(act, h);
      },
    });
    expect(seen).toEqual(['screenShake', 'cameraPunch']);

    handlers.get('screenShake')?.({ intensity: 0.5 } as never);
    const os = j.offsets(DT);
    expect(Math.abs(os.yaw) + Math.abs(os.pitch) + Math.abs(os.roll)).toBeGreaterThan(0);

    handlers.get('cameraPunch')?.({ direction: { x: 0, y: 0, z: -1 }, intensity: 1 } as never);
    const op = j.offsets(DT);
    expect(op.pos.z).toBeLessThan(0);
  });

  it('is deterministic across instances', () => {
    const mk = (): Juice => {
      const j = juice();
      j.emitScreenShake(0.7);
      j.emitCameraPunch({ x: 0.3, y: -0.4, z: -0.86 }, 0.9);
      return j;
    };
    const a = mk();
    const b = mk();
    for (let i = 0; i < 20; i++) expect(a.offsets(DT)).toEqual(b.offsets(DT));
  });

  it('clear drops shakes and zeroes the punch', () => {
    const j = juice();
    j.emitScreenShake(1);
    j.emitCameraPunch({ x: 1, y: 0, z: 0 }, 1);
    expect(j.offsets(DT)).not.toEqual(ZERO);
    j.clear();
    expect(j.offsets(DT)).toEqual(ZERO);
  });
});
