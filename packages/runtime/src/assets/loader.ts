// Asset loader (build §5.8, §5.9 rules; docs/architecture.md §3 module map, WP B8): warms the HTTP cache for names and groups.
//
// - `fetch(url, { cache: 'force-cache' })`, body read and dropped: three.js, the audio engine and the UI then load the same URLs
//   from the HTTP cache. Decoded assets are cached by their runtimes, not here.
// - Dedupe per absolute URL: every spelling of a name, a texture shared by several models, concurrent calls.
// - A model brings its dependencies (`d`, its textures) at the same priority; on the low tier a dependency's `low` variant.
// - Priorities: one queue per priority, at most `concurrency` (6) in flight per priority; a lower priority starts nothing while
//   a higher one has requests waiting. A queued request asked for again at a higher priority moves up.
// - Failures: an HTTP error status is final for the session (never re-requested: no 404 loop). A network error (fetch threw)
//   is not retried by the loader itself; a later `ensure` of the same URL may retry it, at most `maxNetworkAttempts` in all.
//   `ensure` never rejects: it resolves once every request it needs has settled; failures are in `stats()`.
import type { AssetEntry, GroupKey } from './index-types.ts';
import type { AssetResolver, Tier } from './resolver.ts';
import { normalizeCdnRef } from './resolver.ts';

export type Priority = 'critical' | 'high' | 'idle';

export interface LoadProgress {
  loaded: number;
  total: number;
}

export interface AssetLoader {
  /** fetch + dedupe; models include their deps */
  ensure(refs: readonly string[], prio: Priority): Promise<void>;
  prefetchGroup(key: GroupKey, prio: Priority): Promise<void>;
  /** bytes of the groups' files (with model deps, each URL once): settled / all */
  progress(keys: readonly GroupKey[]): LoadProgress;
  /** bytes of everything requested so far; called on every request added or settled */
  onProgress(cb: (p: LoadProgress) => void): () => void;
  stats(): { bytesByGroup: Readonly<Record<string, number>>; requests: number; failures: readonly string[] };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface AssetLoaderOptions {
  resolver: AssetResolver;
  /** default: globalThis.fetch */
  fetch?: FetchLike;
  /** in-flight requests per priority (build §5.9: 6) */
  concurrency?: number;
  /** 'low' on tier `minimum` (render §15.4): dependencies and names with a `low` variant load that */
  tier?: Tier;
  /** total attempts for a URL whose fetch threw, across separate `ensure` calls (default 3) */
  maxNetworkAttempts?: number;
  /** a URL that failed (HTTP status or network error), or a ref the index does not know */
  onError?: (subject: string, reason: string) => void;
}

const PRIORITIES: readonly Priority[] = ['critical', 'high', 'idle'];
const RANK: Readonly<Record<Priority, number>> = { critical: 0, high: 1, idle: 2 };

type JobState = 'queued' | 'inflight' | 'ok' | 'failed';

interface Job {
  readonly url: string;
  /** progress bytes: the entry's `b` (0 for a URL the index does not list) */
  readonly bytes: number;
  readonly groups: Set<string>;
  prio: Priority;
  state: JobState;
  /** HTTP failure: never requested again */
  final: boolean;
  attempts: number;
  done: Promise<void>;
  settle: () => void;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function createAssetLoader(o: AssetLoaderOptions): AssetLoader {
  const r = o.resolver;
  const doFetch: FetchLike = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const limit = Math.max(1, o.concurrency ?? 6);
  const tier: Tier = o.tier ?? 'full';
  const maxNet = Math.max(1, o.maxNetworkAttempts ?? 3);

  const jobs = new Map<string, Job>();
  const queues: Record<Priority, Job[]> = { critical: [], high: [], idle: [] };
  const inflight: Record<Priority, number> = { critical: 0, high: 0, idle: 0 };
  const bytesByGroup: Record<string, number> = {};
  const failures = new Set<string>();
  const listeners = new Set<(p: LoadProgress) => void>();
  const unknownReported = new Set<string>();
  let requests = 0;
  let pumpScheduled = false;

  // ── refs → URLs ──────────────────────────────────────────────────────────────────────────────────────────────────

  interface Target {
    url: string;
    bytes: number;
    groups: readonly string[];
  }

  const targetOf = (e: AssetEntry, key: string): Target | null => {
    const url = r.resolve(key, tier);
    return url === null ? null : { url, bytes: e.b, groups: e.g };
  };

  /** The files a ref needs: its own URL and, for a model, its dependencies. Silent names need nothing. */
  const targetsOf = (ref: string, report: boolean): Target[] => {
    const key = normalizeCdnRef(ref);
    const e = r.entry(key);
    if (!e) {
      if (report && !unknownReported.has(key)) {
        unknownReported.add(key);
        o.onError?.(key, 'not in the asset index');
      }
      return [];
    }
    const own = targetOf(e, key);
    if (!own) return [];
    const out = [own];
    // stage 8c: on the low tier the manifest's `dLow` names the low page set; the high/low sets pack independently
    // (their counts differ), so `dLow` replaces `d` instead of resolving each dep through a per-page `low`
    const deps = tier === 'low' && e.dLow !== undefined ? e.dLow : e.d;
    for (const d of deps ?? []) {
      const de = r.entry(d);
      if (!de) {
        out.push({ url: new URL(d, r.base).href, bytes: 0, groups: e.g });
        continue;
      }
      const t = targetOf(de, d);
      // stage 8c follow-up: atlas pages are intentionally ungrouped (`g: []`); they transfer with the manifest that
      // names them, so their bytes account to the manifest's groups (each URL still settles once per group)
      if (t) out.push({ url: t.url, bytes: t.bytes, groups: t.groups.length > 0 ? t.groups : e.g });
    }
    return out;
  };

  // ── progress ───────────────────────────────────────────────────────────────────────────────────────────────────

  const settled = (j: Job | undefined): boolean => j !== undefined && (j.state === 'ok' || j.state === 'failed');

  const overall = (): LoadProgress => {
    let loaded = 0;
    let total = 0;
    for (const j of jobs.values()) {
      total += j.bytes;
      if (settled(j)) loaded += j.bytes;
    }
    return { loaded, total };
  };

  const emit = (): void => {
    if (listeners.size === 0) return;
    const p = overall();
    for (const cb of [...listeners]) cb({ ...p });
  };

  // ── scheduling ─────────────────────────────────────────────────────────────────────────────────────────────────

  const schedulePump = (): void => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  };

  const pump = (): void => {
    for (const p of PRIORITIES) {
      const q = queues[p];
      while (q.length > 0 && inflight[p] < limit) start(q.shift()!, p);
      if (q.length > 0) return; // something of this priority still waits: lower priorities start nothing
    }
  };

  const start = (j: Job, lane: Priority): void => {
    j.state = 'inflight';
    j.attempts++;
    inflight[lane]++;
    requests++;
    const finish = (ok: boolean, got: number, reason?: string, final = false): void => {
      inflight[lane]--;
      j.state = ok ? 'ok' : 'failed';
      if (ok) {
        failures.delete(j.url);
        for (const g of j.groups) bytesByGroup[g] = (bytesByGroup[g] ?? 0) + got;
      } else {
        j.final = final;
        failures.add(j.url);
        o.onError?.(j.url, reason ?? 'failed');
      }
      j.settle();
      emit();
      schedulePump();
    };
    let p: Promise<Response>;
    try {
      p = doFetch(j.url, { cache: 'force-cache' });
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      async (res) => {
        if (!res.ok) {
          void res.body?.cancel().catch(() => undefined);
          finish(false, 0, `HTTP ${res.status}`, true);
          return;
        }
        let got = 0;
        try {
          got = (await res.arrayBuffer()).byteLength;
        } catch (err) {
          finish(false, 0, `body: ${String(err)}`);
          return;
        }
        finish(true, got);
      },
      (err: unknown) => finish(false, 0, `network: ${String(err)}`),
    );
  };

  const enqueue = (j: Job, prio: Priority): void => {
    j.prio = prio;
    j.state = 'queued';
    queues[prio].push(j);
  };

  /** The job for a target at `prio`, created, re-queued for a retry, or moved up; null when it needs nothing more. */
  const want = (t: Target, prio: Priority): Job => {
    let j = jobs.get(t.url);
    if (!j) {
      const d = deferred();
      j = { url: t.url, bytes: t.bytes, groups: new Set(t.groups), prio, state: 'queued', final: false, attempts: 0, done: d.promise, settle: d.resolve };
      jobs.set(t.url, j);
      enqueue(j, prio);
      return j;
    }
    for (const g of t.groups) j.groups.add(g);
    if (j.state === 'queued' && RANK[prio] < RANK[j.prio]) {
      const q = queues[j.prio];
      q.splice(q.indexOf(j), 1);
      enqueue(j, prio);
    } else if (j.state === 'failed' && !j.final && j.attempts < maxNet) {
      const d = deferred();
      j.done = d.promise;
      j.settle = d.resolve;
      enqueue(j, prio);
    }
    return j;
  };

  const ensure = (refs: readonly string[], prio: Priority): Promise<void> => {
    const waits: Promise<void>[] = [];
    const before = jobs.size;
    for (const ref of refs) for (const t of targetsOf(ref, true)) waits.push(want(t, prio).done);
    if (jobs.size !== before) emit();
    schedulePump();
    return Promise.all(waits).then(() => undefined);
  };

  const groupNames = (key: string): readonly string[] => {
    const g = Object.prototype.hasOwnProperty.call(r.index.groups, key) ? r.index.groups[key] : undefined;
    return g ? g.n : [];
  };

  return {
    ensure,
    prefetchGroup: (key, prio) => ensure(groupNames(key), prio),
    progress(keys) {
      const seen = new Map<string, number>();
      for (const k of keys) for (const n of groupNames(k)) for (const t of targetsOf(n, false)) seen.set(t.url, t.bytes);
      let loaded = 0;
      let total = 0;
      for (const [url, b] of seen) {
        total += b;
        if (settled(jobs.get(url))) loaded += b;
      }
      return { loaded, total };
    },
    onProgress(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    stats: () => ({ bytesByGroup: { ...bytesByGroup }, requests, failures: [...failures] }),
  };
}
