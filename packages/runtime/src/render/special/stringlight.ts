// String lights (docs/design/rendering.md §14.5; WP R12a): a row's `spline: {kind: 'stringlight', bulbSpacing, points}`
// (grimland-park, 4 rows). Between each pair of points the cable hangs in a catenary, approximated by its parabola with a sag
// of `STRINGLIGHT_LOOK.sagFraction` of the span [I]; a thin tube draws the cable and an `InstancedMesh` of small spheres the
// bulbs, one every `bulbSpacing` metres along the hanging cable. The bulbs are unlit, in the row's colour (`material.color`,
// else `STRINGLIGHT_LOOK.color`) times `STRINGLIGHT_LOOK.bulbGain` (emissive ×2 [I]). No light records: whether the live
// lights emitted light is unknown (render §14.5, [CAL row 12-adjacent], a visual check).
//
// The bulbs' object-level `boundingSphere` is computed once after their matrices are written (three would otherwise compute
// it lazily at the first frustum test, render §6.5). The points are in the row's frame (the live rows stand at the origin).
//
// Programs: the cable material and one bulb material per colour, colours as uniforms, so every string draws with the two
// programs `warmObjects()` links before the LOADING gate (an InstancedMesh's text names no capacity,
// engine/stable-programs.ts).
import { Curve, InstancedMesh, Matrix4, Mesh, MeshBasicNodeMaterial, SphereGeometry, TubeGeometry, Vector3 } from 'three/webgpu';
import type { Object3D } from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { RowSnapshot } from '../../compat/core/ports.ts';
import type { RowExtensionBinding } from '../bridge/bridge-types.ts';
import { cssToLinear, type Linear3 } from '../color/color.ts';

/** [I] */
export const STRINGLIGHT_LOOK = Object.freeze({
  /** the sag at mid-span, as a fraction of the span */
  sagFraction: 0.03,
  cableRadius: 0.008,
  bulbRadius: 0.045,
  /** the bulbs' colour when the row names none: warm white */
  color: 'oklch(0.86 0.11 80)',
  bulbGain: 2,
  /** the cable's unlit colour, linear */
  cable: [0.012, 0.011, 0.01] as readonly number[],
  /** cable samples per metre of span */
  samplesPerM: 2,
});
/** at most this many bulbs on one row */
export const STRINGLIGHT_MAX_BULBS = 4096;

type P3 = readonly [number, number, number];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `{kind: 'stringlight', bulbSpacing, points}` of a row, validated; null for any other spline */
export function stringlightSpecOf(spline: unknown): { bulbSpacing: number; points: P3[] } | null {
  if (!isObj(spline) || spline['kind'] !== 'stringlight' || !Array.isArray(spline['points'])) return null;
  const points: P3[] = [];
  for (const p of spline['points'] as unknown[]) {
    if (Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v))) points.push([p[0] as number, p[1] as number, p[2] as number]);
    else if (isObj(p) && [p['x'], p['y'], p['z']].every((v) => typeof v === 'number' && Number.isFinite(v))) points.push([p['x'] as number, p['y'] as number, p['z'] as number]);
  }
  if (points.length < 2) return null;
  const s = spline['bulbSpacing'];
  return { bulbSpacing: typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 0.5, points };
}

/** The hanging cable as a polyline: each span sampled, lowered by the parabola 4·sag·t·(1 − t). */
export function stringlightPath(points: readonly P3[], sagFraction: number = STRINGLIGHT_LOOK.sagFraction, samplesPerM: number = STRINGLIGHT_LOOK.samplesPerM): Vector3[] {
  const out: Vector3[] = [new Vector3(...points[0]!)];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const span = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (span < 1e-6) continue;
    const sag = sagFraction * span;
    const n = Math.max(4, Math.ceil(span * samplesPerM));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push(new Vector3(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - 4 * sag * t * (1 - t), a[2] + (b[2] - a[2]) * t));
    }
  }
  return out;
}

/** Points every `spacing` metres along the polyline, starting half a spacing in. */
export function bulbPositions(path: readonly Vector3[], spacing: number, max = STRINGLIGHT_MAX_BULBS): Vector3[] {
  const out: Vector3[] = [];
  let next = spacing / 2;
  let walked = 0;
  for (let i = 1; i < path.length && out.length < max; i++) {
    const a = path[i - 1]!, b = path[i]!;
    const d = a.distanceTo(b);
    while (next <= walked + d && out.length < max) {
      out.push(new Vector3().lerpVectors(a, b, d > 0 ? (next - walked) / d : 0));
      next += spacing;
    }
    walked += d;
  }
  return out;
}

/** a polyline as a three `Curve`, parameterised by length */
class PolylineCurve extends Curve<Vector3> {
  readonly #pts: readonly Vector3[];
  readonly #acc: number[];

  constructor(pts: readonly Vector3[]) {
    super();
    this.#pts = pts;
    this.#acc = [0];
    for (let i = 1; i < pts.length; i++) this.#acc.push(this.#acc[i - 1]! + pts[i - 1]!.distanceTo(pts[i]!));
  }

  override getPoint(t: number, target = new Vector3()): Vector3 {
    const total = this.#acc[this.#acc.length - 1]!;
    const s = Math.min(1, Math.max(0, t)) * total;
    let i = 1;
    while (i < this.#acc.length - 1 && this.#acc[i]! < s) i++;
    const s0 = this.#acc[i - 1]!, s1 = this.#acc[i]!;
    return target.lerpVectors(this.#pts[i - 1]!, this.#pts[i]!, s1 > s0 ? (s - s0) / (s1 - s0) : 0);
  }
}

export interface StringLightsOptions {
  log?: (message: string) => void;
}

export interface StringLightStats {
  strings: number;
  bulbs: number;
}

interface BulbMaterial {
  material: MeshBasicNodeMaterial;
  users: number;
}

/** the `spline` rows' renderer: `extension` is the bridge's `spline` row extension */
export class StringLights {
  readonly #opts: StringLightsOptions;
  readonly #bulbGeometry = new SphereGeometry(STRINGLIGHT_LOOK.bulbRadius, 8, 6);
  readonly #cable: MeshBasicNodeMaterial;
  readonly #bulbs = new Map<string, BulbMaterial>();
  readonly #live = new Set<{ dispose(): void; bulbs: number }>();
  readonly #warmGeometries: TubeGeometry[] = [];
  #disposed = false;

  constructor(opts: StringLightsOptions = {}) {
    this.#opts = opts;
    this.#cable = new MeshBasicNodeMaterial();
    this.#cable.name = 'ss:stringlight:cable';
    const c = STRINGLIGHT_LOOK.cable;
    this.#cable.colorNode = uniform(new Vector3(c[0], c[1], c[2]));
  }

  #bulbMaterial(color: Linear3): BulbMaterial {
    const key = color.map((v) => v.toFixed(4)).join(',');
    let m = this.#bulbs.get(key);
    if (m === undefined) {
      const material = new MeshBasicNodeMaterial();
      material.name = 'ss:stringlight:bulb';
      const g = STRINGLIGHT_LOOK.bulbGain;
      material.colorNode = uniform(new Vector3(color[0] * g, color[1] * g, color[2] * g));
      m = { material, users: 0 };
      this.#bulbs.set(key, m);
    }
    return m;
  }

  #release(m: BulbMaterial): void {
    if (--m.users > 0) return;
    for (const [k, v] of this.#bulbs) if (v === m) this.#bulbs.delete(k);
    m.material.dispose();
  }

  readonly extension = (row: RowSnapshot, node: Object3D): RowExtensionBinding | null => {
    if (this.#disposed) return null;
    const spec = stringlightSpecOf(row.props['spline']);
    if (spec === null) {
      this.#opts.log?.(`[stringlight] ${row.id}: a spline that is not a stringlight with two points or more is not drawn`);
      return null;
    }
    const material = row.props['material'];
    const css = isObj(material) && typeof material['color'] === 'string' ? material['color'] : STRINGLIGHT_LOOK.color;
    const color = cssToLinear(css) ?? cssToLinear(STRINGLIGHT_LOOK.color)!;
    const path = stringlightPath(spec.points);
    const tube = new TubeGeometry(new PolylineCurve(path), Math.max(1, path.length - 1), STRINGLIGHT_LOOK.cableRadius, 4, false);
    const cable = new Mesh(tube, this.#cable);
    cable.name = `ss:stringlight:cable:${row.id}`;
    cable.castShadow = false;
    const at = bulbPositions(path, spec.bulbSpacing);
    const bulbMat = this.#bulbMaterial(color);
    bulbMat.users++;
    const bulbs = new InstancedMesh(this.#bulbGeometry, bulbMat.material, Math.max(1, at.length));
    bulbs.name = `ss:stringlight:bulbs:${row.id}`;
    bulbs.castShadow = false;
    const m = new Matrix4();
    at.forEach((p, i) => bulbs.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
    bulbs.count = at.length;
    bulbs.instanceMatrix.needsUpdate = true;
    // after the bulbs are written (render §6.5)
    bulbs.computeBoundingSphere();
    node.add(cable, bulbs);
    let gone = false;
    const binding = {
      bulbs: at.length,
      dispose: (): void => {
        if (gone) return;
        gone = true;
        this.#live.delete(binding);
        cable.removeFromParent();
        bulbs.removeFromParent();
        tube.dispose();
        bulbs.dispose();
        this.#release(bulbMat);
      },
    };
    this.#live.add(binding);
    return binding;
  };

  /** the cable and a one-bulb InstancedMesh of the default colour, for the engine-load warm-up */
  warmObjects(): Object3D[] {
    if (this.#disposed) return [];
    const tube = new TubeGeometry(new PolylineCurve([new Vector3(0, 0, 0), new Vector3(0.01, 0, 0)]), 1, STRINGLIGHT_LOOK.cableRadius, 4, false);
    this.#warmGeometries.push(tube);
    const cable = new Mesh(tube, this.#cable);
    cable.name = 'ss:warm-up:stringlight:cable';
    const mat = this.#bulbMaterial(cssToLinear(STRINGLIGHT_LOOK.color)!);
    mat.users++;
    const bulbs = new InstancedMesh(this.#bulbGeometry, mat.material, 1);
    bulbs.name = 'ss:warm-up:stringlight:bulbs';
    bulbs.setMatrixAt(0, new Matrix4());
    return [cable, bulbs];
  }

  stats(): StringLightStats {
    let bulbs = 0;
    for (const b of this.#live) bulbs += b.bulbs;
    return { strings: this.#live.size, bulbs };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const b of [...this.#live]) b.dispose();
    for (const m of this.#bulbs.values()) m.material.dispose();
    this.#bulbs.clear();
    this.#cable.dispose();
    this.#bulbGeometry.dispose();
    for (const g of this.#warmGeometries.splice(0)) g.dispose();
  }
}
