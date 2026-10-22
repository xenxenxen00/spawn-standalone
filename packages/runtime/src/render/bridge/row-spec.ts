// Reading a row for the render bridge (docs/design/rendering.md §16.1, §8.1; `spawn-engine-contract.md` §9.1, §9.2, §9.5;
// WP R13): the typed values behind the fields the bridge consumes. Plain data, no three.js; nothing here throws on content.
import type { RowSnapshot } from '../../compat/core/ports.ts';
import type { Vec3 } from '../../compat/core/types.ts';
import { cssToLinear, type Linear3 } from '../color/color.ts';
import type { ScriptedSpec } from '../geometry/generator-types.ts';
import type { PrimitiveSpec } from '../geometry/primitives.ts';
import type { LightKind } from '../lighting/light-table.ts';
import { isScriptedMaterialSpec, type StandardMaterialSpec } from '../surface/material-spec.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ── transform fields ────────────────────────────────────────────────────────────────────────────────────────────────────

/** `feetPosition: {attach: 'camera', …}` (contract §9.13): the row lives in the camera's frame (the viewmodel layer) */
export function isCameraAttached(props: Readonly<Record<string, unknown>>): boolean {
  const f = props['feetPosition'];
  return isObj(f) && f['attach'] === 'camera';
}

/** the bone (or rig socket) a row's `attachment` names; null when it rides none */
export function attachmentBoneOf(props: Readonly<Record<string, unknown>>): string | null {
  const att = props['attachment'];
  if (!isObj(att)) return null;
  const bone = att['bone'] ?? att['socket'];
  return typeof bone === 'string' && bone !== '' ? bone : null;
}

/**
 * `pivot` (contract §9.1): where the row's origin sits in its shape's box, as fractions `[u, v, w]` of the box from its
 * minimum corner. `"feet"` is the bottom centre, `"center"` the middle, `"top"` the top centre, `[0, .5, .5]` the left edge at
 * half height (a hinge). Null: the row names none (the shape stands on its own origin).
 */
export function pivotOf(pivot: unknown): [number, number, number] | null {
  if (pivot === 'feet') return [0.5, 0, 0.5];
  if (pivot === 'center') return [0.5, 0.5, 0.5];
  if (pivot === 'top') return [0.5, 1, 0.5];
  if (Array.isArray(pivot) && pivot.length === 3 && pivot.every(finite)) return [pivot[0] as number, pivot[1] as number, pivot[2] as number];
  if (isObj(pivot) && finite(pivot['x']) && finite(pivot['y']) && finite(pivot['z'])) return [pivot['x'], pivot['y'], pivot['z']];
  return null;
}

/**
 * The shift that puts a shape's pivot on the row's origin: `box` is the shape's box in its own frame
 * `[minX, minY, minZ, maxX, maxY, maxZ]` (already at the row's size). Writes `out` = −(the pivot point).
 */
export function pivotShift(pivot: readonly [number, number, number], box: ArrayLike<number>, out: [number, number, number]): [number, number, number] {
  out[0] = -(box[0]! + pivot[0] * (box[3]! - box[0]!)) + 0;
  out[1] = -(box[1]! + pivot[1] * (box[4]! - box[1]!)) + 0;
  out[2] = -(box[2]! + pivot[2] * (box[5]! - box[2]!)) + 0;
  return out;
}

/**
 * `layout: {minExtents?, maxExtents?}` (contract §9.1): the uniform scale that fits a model of `size` into the extents.
 * `maxExtents` shrinks or grows the model until its largest named axis touches its limit (the live use: `{maxExtents: {y:
 * height}}` makes the model exactly that tall); `minExtents` then grows it until every named axis reaches its minimum. 1 when
 * the row names no layout or the size is unknown.
 */
export function layoutScale(layout: unknown, size: Readonly<Vec3> | null): number {
  if (!isObj(layout) || size === null) return 1;
  const axes = ['x', 'y', 'z'] as const;
  let k = 1;
  const max = layout['maxExtents'];
  if (isObj(max)) {
    let fit = Infinity;
    for (const a of axes) {
      const limit = max[a];
      if (finite(limit) && limit > 0 && size[a] > 0) fit = Math.min(fit, limit / size[a]);
    }
    if (fit !== Infinity) k = fit;
  }
  const min = layout['minExtents'];
  if (isObj(min)) {
    for (const a of axes) {
      const limit = min[a];
      if (finite(limit) && limit > 0 && size[a] > 0) k = Math.max(k, limit / size[a]);
    }
  }
  return k;
}

/** `visibleRange: {min?, max?}` in metres from the camera; null: always in range */
export function visibleRangeOf(range: unknown): { min: number; max: number } | null {
  if (!isObj(range)) return null;
  const min = finite(range['min']) ? range['min'] : 0;
  const max = finite(range['max']) ? range['max'] : Infinity;
  return min <= 0 && max === Infinity ? null : { min, max };
}

/** `physics` as the body it asks for: `'dynamic'`, `'kinematic'`, `'static'`, or null for none */
export function physicsBodyOf(physics: unknown): string | null {
  if (physics === undefined || physics === null || physics === false || physics === 'none') return null;
  if (typeof physics === 'string') return physics;
  if (isObj(physics) && typeof physics['body'] === 'string') return physics['body'];
  return 'static';
}

// ── what the row draws ──────────────────────────────────────────────────────────────────────────────────────────────────

/** `primitive: {kind: 'scripted', script, …}` */
export function scriptedSpecOf(props: Readonly<Record<string, unknown>>): ScriptedSpec | null {
  const p = props['primitive'];
  if (!isObj(p) || p['kind'] !== 'scripted' || typeof p['script'] !== 'string' || p['script'] === '') return null;
  return p as unknown as ScriptedSpec;
}

/**
 * A built-in primitive (contract §9.2): the row's `primitive` (an object, or just the kind's name) with the row's `anchor`,
 * which is where a flat kind stands. Null for a scripted primitive and for a row without one.
 */
export function primitiveSpecOf(props: Readonly<Record<string, unknown>>): PrimitiveSpec | null {
  const p = props['primitive'];
  const anchor = props['anchor'];
  let spec: PrimitiveSpec | null = null;
  if (typeof p === 'string' && p !== '' && p !== 'scripted') spec = { kind: p };
  else if (isObj(p) && typeof p['kind'] === 'string' && p['kind'] !== 'scripted') spec = { ...(p as unknown as PrimitiveSpec) };
  if (spec === null) return null;
  if (typeof anchor === 'string' && spec.anchor === undefined) spec.anchor = anchor;
  return spec;
}

/** the row's standard material; null for none and for a scripted material (R12a's) */
export function standardMaterialOf(props: Readonly<Record<string, unknown>>): StandardMaterialSpec | null {
  const m = props['material'];
  if (!isObj(m) || isScriptedMaterialSpec(m)) return null;
  return m as StandardMaterialSpec;
}

/** `visibleTo: 'editors'` rows are debug rows of the editor: never created (render §16.1) */
export function isEditorOnly(row: Pick<RowSnapshot, 'props' | 'spec'>): boolean {
  return (row.props['visibleTo'] ?? row.spec['visibleTo']) === 'editors';
}

// ── lights (render §8.1) ────────────────────────────────────────────────────────────────────────────────────────────────

/** `aim: 'forward'`: the row's own −Z; a point: a target in the row's PARENT space (world for an unparented row) */
export type LightAim = 'forward' | Vec3;

export interface RowLight {
  kind: LightKind;
  color: Linear3;
  intensity: number;
  /** 0: the table's implicit radius */
  distance: number;
  decay: number;
  /** spot, radians, AS WRITTEN (FX-25: the map spots written 38 and 40 are used raw, never clamped or converted) */
  angle: number;
  penumbra: number;
  /** spot and directional rows; null on a point light */
  aim: LightAim | null;
  shadow: boolean;
}

/** three's `SpotLight` default cone */
export const DEFAULT_SPOT_ANGLE: number = Math.PI / 3;

/**
 * A row's `light` as a record's values. Null: the row has no light (or names a kind the engine does not have). A spot or
 * directional row without an `aim` points straight down [I: three's own default target is the world origin, which is a zero
 * vector for a light standing there; no live row leaves `aim` out].
 */
export function rowLightOf(light: unknown): RowLight | null {
  if (!isObj(light)) return null;
  const kind = light['kind'] === undefined ? 'point' : light['kind'];
  if (kind !== 'point' && kind !== 'spot' && kind !== 'directional') return null;
  const color = (typeof light['color'] === 'string' ? cssToLinear(light['color']) : null) ?? [1, 1, 1];
  let aim: LightAim | null = null;
  if (kind !== 'point') {
    const a = light['aim'];
    if (a === 'forward') aim = 'forward';
    else if (isObj(a) && finite(a['x']) && finite(a['y']) && finite(a['z'])) aim = { x: a['x'], y: a['y'], z: a['z'] };
  }
  return {
    kind,
    color,
    intensity: finite(light['intensity']) ? light['intensity'] : 1,
    distance: finite(light['distance']) ? light['distance'] : 0,
    decay: finite(light['decay']) ? light['decay'] : 2,
    angle: finite(light['angle']) ? light['angle'] : DEFAULT_SPOT_ANGLE,
    penumbra: finite(light['penumbra']) ? light['penumbra'] : 0,
    aim,
    shadow: light['shadow'] === true,
  };
}

/** whether two lights differ in something the table has no setter for (a new record is needed) */
export function lightShapeDiffers(a: Readonly<RowLight>, b: Readonly<RowLight>): boolean {
  return a.kind !== b.kind || a.distance !== b.distance || a.decay !== b.decay || a.angle !== b.angle || a.penumbra !== b.penumbra || a.shadow !== b.shadow;
}

export const sameColor = (a: Readonly<Linear3>, b: Readonly<Linear3>): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** fields of a row the render bridge consumes (render §16.1; core §15.1) */
export const BRIDGE_FIELDS: ReadonlySet<string> = new Set([
  'feetPosition', 'rotation', 'yaw', 'scale', 'pivot', 'anchor', 'layout', 'interpolation', 'parent', 'place', 'attachment',
  'visible', 'render', 'visibleInFirstPerson', 'visibleRange', 'visibleTo', 'castShadow', 'receiveShadow',
  'primitive', 'material', 'model', 'light', 'fx', 'ui', 'spline', 'scatter', 'physics', 'velocity', 'angularVelocity',
]);

/** fields other domains own (core §15.1): written often, nothing to do here, never logged */
export const FOREIGN_FIELDS: ReadonlySet<string> = new Set([
  'state', 'anim', 'mixer', 'ik', 'audio', 'forces', 'spectating', 'name', 'lifetime', 'behavior', 'tags', 'sprite', 'controller', 'input', 'look', 'trigger', 'sensor',
]);
