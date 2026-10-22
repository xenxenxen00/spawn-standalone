// ModelLibrary (docs/design/rendering.md §11.2; WP R6): model templates by CDN name, loaded once and disposed by asset group.
//
//   load(name, group)   resolves the name through the asset index (never a hand-built URL: the pipeline renames
//                       `value.<sha>.glb`), loads the glTF, builds the `ModelTemplate` with the index's facts as its
//                       normalisation target. Concurrent loads of a name share one request. A name can be held by several
//                       groups (`match` and `enemy:hollow`).
//   get(name)           the template, or undefined while it loads (the game holds bone reads until it lands)
//   disposeGroup(group) map change, enemy-set change: a template no group holds any more is disposed; its textures go only
//                       when no other live template uses them (texture-cache.ts)
//   facts(name)         the live `ctx.world.assets[ref]` shape (bounds, clips, gait, skinned, triangles)
//
// Tier `minimum` loads the 512² texture variants (`AssetEntry.low`, build §5.2 stage 8): a glTF names its textures by URL, so
// `lowTierUrlModifier` goes on the loaders' `LoadingManager` and redirects those URLs.
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { normalizeCdnRef, type AssetResolver } from '../../assets/resolver.ts';
import type { AssetFacts } from '../../compat/core/types.ts';
import { buildModelTemplate, modelSourceFromGltf, type ModelTemplate, type ModelTemplateEnv } from './model-template.ts';

export type AssetGroup = string;

/** render §11.2 */
export interface ModelLibrary {
  load(cdnName: string, group: AssetGroup): Promise<ModelTemplate>;
  get(cdnName: string): ModelTemplate | undefined;
  disposeGroup(group: AssetGroup): void;
  facts(cdnName: string): AssetFacts;
}

/** The load of a model ended with no group holding it (its group was disposed meanwhile). */
export class ModelLoadCancelled extends Error {
  constructor(name: string) {
    super(`model ${name}: its asset group was disposed while it loaded`);
    this.name = 'ModelLoadCancelled';
  }
}

export interface ModelLibraryOptions {
  resolver: Pick<AssetResolver, 'resolve' | 'facts' | 'liveFacts'>;
  /** `loaders.gltf.loadAsync` */
  loadGltf: (url: string) => Promise<GLTF>;
  env: ModelTemplateEnv;
  /** extra `SurfaceVariant` bits of a model's materials (the viewmodel pass); default none */
  variantOf?: (cdnName: string, group: AssetGroup) => number;
  /** one line per thing a template read but does not carry; default `console.warn` */
  log?: (message: string) => void;
}

export interface ModelLibraryControl extends ModelLibrary {
  /** names with a live template */
  loaded(): string[];
  /** groups holding a name (loaded or loading) */
  groupsOf(cdnName: string): AssetGroup[];
  dispose(): void;
}

interface Slot {
  groups: Set<AssetGroup>;
  job: Promise<ModelTemplate>;
  template: ModelTemplate | undefined;
}

const NO_FACTS: AssetFacts = Object.freeze({});

export function createModelLibrary(opts: ModelLibraryOptions): ModelLibraryControl {
  const { resolver, env } = opts;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const slots = new Map<string, Slot>();

  const start = (cdnName: string, group: AssetGroup): Slot => {
    const slot: Slot = { groups: new Set([group]), template: undefined, job: undefined as unknown as Promise<ModelTemplate> };
    slot.job = (async () => {
      const url = resolver.resolve(cdnName);
      if (url === null) throw new Error(`model ${cdnName}: not in the asset index (or silent)`);
      const gltf = await opts.loadGltf(url);
      // a failed or cancelled load leaves no slot behind; the texture clones of its scene are never uploaded
      if (slots.get(cdnName) !== slot || slot.groups.size === 0) throw new ModelLoadCancelled(cdnName);
      const extra = opts.variantOf?.(cdnName, group) ?? 0;
      const template = buildModelTemplate(modelSourceFromGltf(cdnName, gltf, resolver.facts(cdnName)?.bounds ?? null), extra === 0 ? env : { ...env, variant: (env.variant ?? 0) | extra });
      for (const w of template.warnings) log(`model ${cdnName}: ${w}`);
      slot.template = template;
      return template;
    })();
    slot.job.catch(() => {
      if (slots.get(cdnName) === slot) slots.delete(cdnName);
    });
    slots.set(cdnName, slot);
    return slot;
  };

  const drop = (cdnName: string, slot: Slot): void => {
    slots.delete(cdnName);
    slot.template?.dispose();
  };

  return {
    load(ref, group) {
      const cdnName = normalizeCdnRef(ref);
      const slot = slots.get(cdnName);
      if (slot === undefined) return start(cdnName, group).job;
      slot.groups.add(group);
      return slot.job;
    },
    get(cdnName) {
      return slots.get(normalizeCdnRef(cdnName))?.template;
    },
    disposeGroup(group) {
      for (const [name, slot] of [...slots]) {
        if (!slot.groups.delete(group) || slot.groups.size > 0) continue;
        drop(name, slot);
      }
    },
    facts(cdnName) {
      return resolver.liveFacts(cdnName) ?? NO_FACTS;
    },
    loaded() {
      return [...slots].filter(([, s]) => s.template !== undefined).map(([n]) => n);
    },
    groupsOf(cdnName) {
      return [...(slots.get(normalizeCdnRef(cdnName))?.groups ?? [])];
    },
    dispose() {
      for (const [name, slot] of [...slots]) {
        slot.groups.clear();
        drop(name, slot);
      }
    },
  };
}

/**
 * A `LoadingManager.setURLModifier` function for tier `minimum`: a texture URL of the asset index with a `low` variant is
 * answered with that variant's URL; every other URL is returned unchanged.
 */
export function lowTierUrlModifier(resolver: Pick<AssetResolver, 'index' | 'base'>): (url: string) => string {
  const low = new Map<string, string>();
  for (const e of Object.values(resolver.index.entries)) {
    if (e.u === null || e.low === undefined) continue;
    low.set(new URL(e.u, resolver.base).href, new URL(e.low, resolver.base).href);
  }
  return (url) => {
    if (low.size === 0) return url;
    let abs: string;
    try {
      abs = new URL(url, resolver.base).href;
    } catch {
      return url;
    }
    return low.get(abs) ?? url;
  };
}
