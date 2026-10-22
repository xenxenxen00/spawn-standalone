// Matching a usage id against the capability manifest.
//
// Ids split on `.` into segments. The longest manifest entry whose segments are a prefix of the usage wins; `*` in an entry
// matches any one segment (including `[*]`, a computed key). An entry `id=value` refines an id by the literal value the game
// wrote. A usage that stops short of every entry (`ctx.world`, passed on as a value) is a container and matches nothing.
import type { CapabilityEntry, CapabilityManifest } from '@spawn-standalone/runtime/capabilities';

const segmentsOf = (id: string): string[] => id.split('.');

interface Wild {
  segs: string[];
  literals: number;
  entry: CapabilityEntry;
}

export class ManifestIndex {
  private readonly exact = new Map<string, CapabilityEntry>();
  private readonly valued = new Map<string, CapabilityEntry>();
  private readonly wild = new Map<number, Wild[]>();
  private readonly containers = new Set<string>();

  readonly manifest: CapabilityManifest;

  constructor(manifest: CapabilityManifest) {
    this.manifest = manifest;
    for (const entry of manifest.entries) {
      const eq = entry.id.indexOf('=');
      const base = eq < 0 ? entry.id : entry.id.slice(0, eq);
      const segs = segmentsOf(base);
      if (eq >= 0) this.valued.set(entry.id, entry);
      else if (segs.includes('*')) {
        const list = this.wild.get(segs.length) ?? [];
        list.push({ segs, literals: segs.filter((s) => s !== '*').length, entry });
        this.wild.set(segs.length, list);
      } else this.exact.set(base, entry);
      for (let n = 1; n < segs.length; n++) this.containers.add(segs.slice(0, n).join('.'));
    }
  }

  private lookup(segs: readonly string[], value: string | undefined): CapabilityEntry | null {
    for (let k = segs.length; k > 0; k--) {
      const prefix = segs.slice(0, k);
      const key = prefix.join('.');
      if (k === segs.length && value !== undefined) {
        const hit = this.valued.get(`${key}=${value}`);
        if (hit) return hit;
      }
      const hit = this.exact.get(key);
      if (hit) return hit;
      let best: Wild | null = null;
      for (const w of this.wild.get(k) ?? []) {
        if (w.segs.every((s, i) => s === '*' || s === prefix[i]) && (best === null || w.literals > best.literals)) best = w;
      }
      if (best) return best.entry;
    }
    return null;
  }

  /** The entry for a usage, or null. A computed key (`[*]`) that no entry names is cut off and the rest retried. */
  match(id: string, value?: string): CapabilityEntry | null {
    const segs = segmentsOf(id);
    const hit = this.lookup(segs, value);
    if (hit) return hit;
    const cut = segs.indexOf('[*]');
    return cut > 0 ? this.lookup(segs.slice(0, cut), undefined) : null;
  }

  /** True when the usage is a strict prefix of some entry, such as `ctx.world` or `config:atmosphere`. */
  isContainer(id: string): boolean {
    const segs = segmentsOf(id);
    const cut = segs.indexOf('[*]');
    return this.containers.has((cut > 0 ? segs.slice(0, cut) : segs).join('.'));
  }
}
