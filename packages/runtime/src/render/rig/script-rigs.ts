// The main thread's rigs of rigged generator scripts (plan item K3; INTEGRATION.md H4). A packed key of a rigged module carries
// its parsed `skeleton()` (`PackedKey.skeleton`, built once per script in the geometry worker); this cache turns it into ONE
// RigDef per script, shared by every row, LOD and params variant of that script. A re-skin (new `primitive.params`) therefore
// hands the row's mixer the very same rig object, and `Mixer.setRig` is not called again: clip phases survive.
import type { RigDef } from '../../compat/motion/rig.ts';
import type { PoseRig } from '../../compat/motion/pose.ts';
import { rigFromSkeleton, type SkeletonSpec } from './skeleton.ts';

/** what the cache reads of a packed key */
export interface RiggedKeyLike {
  readonly script: string;
  readonly skeleton?: SkeletonSpec | undefined;
}

export class ScriptRigs {
  readonly #byScript = new Map<string, RigDef>();

  /** The rig of a key's script; null for a key without a skeleton. Built at the first key of the script. */
  rigOf(key: RiggedKeyLike): RigDef | null {
    const known = this.#byScript.get(key.script);
    if (known !== undefined) return known;
    if (key.skeleton === undefined) return null;
    const rig = rigFromSkeleton(key.script, key.skeleton);
    this.#byScript.set(key.script, rig);
    return rig;
  }

  /** the rig built for a script, if any */
  get(script: string): RigDef | undefined {
    return this.#byScript.get(script);
  }

  get size(): number {
    return this.#byScript.size;
  }
}

/** what `adoptRowRig` needs of the motion domain (`AnimChannels` satisfies it: `ensure` makes the row's mixer if it has none) */
export interface RigHost<Row> {
  ensure(row: Row): { readonly rig: PoseRig | null; setRig(rig: PoseRig): void };
}

/**
 * A rigged row's mesh appeared (INTEGRATION.md H4): its script's rig goes to the row's mixer. A mixer that already has this
 * rig (a re-skin, a LOD swap) is left alone. Returns the rig, or null for a key without a skeleton (nothing is done).
 */
export function adoptRowRig<Row>(host: RigHost<Row>, row: Row, key: RiggedKeyLike, rigs: ScriptRigs): RigDef | null {
  const rig = rigs.rigOf(key);
  if (rig === null) return null;
  const mixer = host.ensure(row);
  if (mixer.rig !== rig) mixer.setRig(rig);
  return rig;
}
