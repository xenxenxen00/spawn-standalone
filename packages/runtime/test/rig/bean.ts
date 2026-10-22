// A rigged generator module in the shape of a ported toy-bean generator (a `skeleton()` export of 7 bones with pivots in the
// model rest frame; `geometry(ctx)` calls `ctx.bone` before each part, smooth lathes, flat face discs, fewer segments at far
// LODs). Written for the tests: no game code is imported.
import type { GeneratorModule, GeometryContext } from '../../src/render/geometry/generator-types.ts';
import { TOY7 } from './fixtures.ts';

type Ctx = GeometryContext & { bone(name: string): void };
type V3 = [number, number, number];

/** a surface of revolution about the vertical axis through (x, y, z): profile [radius, height] pairs */
function lathe(ctx: Ctx, x: number, y: number, z: number, profile: [number, number][], seg: number): void {
  const P = (r: number, h: number, t: number): V3 => [x + Math.sin(t) * r, y + h, z - Math.cos(t) * r];
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, y0] = profile[i]!;
    const [r1, y1] = profile[i + 1]!;
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const b = ((s + 1) / seg) * Math.PI * 2;
      ctx.quad(...P(r0, y0, a), ...P(r1, y1, a), ...P(r1, y1, b), ...P(r0, y0, b));
    }
  }
}

/** a flat disc facing −Z */
function disc(ctx: Ctx, c: V3, r: number, seg: number): void {
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    const b = ((s + 1) / seg) * Math.PI * 2;
    ctx.tri(c[0], c[1], c[2], c[0] + Math.cos(b) * r, c[1] + Math.sin(b) * r, c[2], c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, c[2]);
  }
}

const BODY: [number, number][] = [[0, 0.1], [0.22, 0.12], [0.36, 0.2], [0.43, 0.34], [0.45, 0.5], [0.44, 0.66], [0.4, 0.82], [0.32, 0.96], [0.2, 1.05], [0.08, 1.09], [0, 1.1]];
const FOOT: [number, number][] = [[0, 0], [0.11, 0.015], [0.14, 0.07], [0.11, 0.135], [0, 0.16]];
const NUB = (r: number): [number, number][] => [[0, -r], [r * 0.7, -r * 0.7], [r, 0], [r * 0.7, r * 0.7], [0, r]];

export const BEAN: GeneratorModule & { skeleton(): unknown } = {
  skeleton: () => structuredClone(TOY7),
  geometry(c) {
    const ctx = c as Ctx;
    const h = Number(ctx.params['hue'] ?? 190);
    const seg = ctx.lod <= 2 ? 22 : ctx.lod <= 3 ? 14 : 8;
    ctx.smooth();
    ctx.bone('legL');
    ctx.color(`oklch(0.42 0.11 ${h})`);
    lathe(ctx, -0.17, 0, -0.04, FOOT, Math.max(8, seg - 6));
    ctx.bone('legR');
    lathe(ctx, 0.17, 0, -0.04, FOOT, Math.max(8, seg - 6));
    ctx.bone('body');
    ctx.color(`oklch(0.76 0.16 ${h})`);
    lathe(ctx, 0, 0, 0, BODY, seg);
    ctx.bone('armL');
    ctx.color(`oklch(0.7 0.16 ${h})`);
    lathe(ctx, -0.46, 0.46, 0, NUB(0.1), Math.max(8, seg - 8));
    ctx.bone('armR');
    lathe(ctx, 0.46, 0.46, 0, NUB(0.1), Math.max(8, seg - 8));
    ctx.flat();
    ctx.bone('body');
    ctx.color('oklch(0.99 0 0)');
    disc(ctx, [-0.14, 0.71, -0.418], 0.105, 16);
    disc(ctx, [0.14, 0.71, -0.418], 0.105, 16);
    ctx.bone('eyes');
    ctx.color('oklch(0.18 0.03 280)');
    disc(ctx, [-0.13, 0.7, -0.428], 0.062, 14);
    disc(ctx, [0.13, 0.7, -0.428], 0.062, 14);
  },
};
