// Opt-in kernel extensions (spawn-standalone only; the snapshot source does not pass any, so every default below is the base runtime's
// behaviour). One options bag, read through `extOf(kernel)`, keeps the edits to the base runtime-synced files to a line or two each.
//
// The port-backed extensions (sql, jobs, music) are structural interfaces: this module imports no port. The adapters that
// build them from a SqlPort / JobPort live in src/ports/bind/.
import { EXTRA_ACT_NAMES, isExtraActName } from './rules.ts';
import type { ExtraActName, ModuleRegistry, SimModule } from './types.ts';
import { parseCadenceMs } from './modules/registry.ts';

/** `ctx.sql` for one caller: a template tag plus size/backup/restore (ports/sql/verb.ts `SqlVerb`) */
export interface SqlExtension {
  /** the verb for a caller (`@caller`): the local user's id for a player body's behavior, null where the docs give none */
  verb(caller: string | null): unknown;
  /** runs the game's `scripts/db.js` `migrate` (and anything else the port needs) before the first tick */
  prepare?(registry: ModuleRegistry): Promise<void>;
  /** the local user's id (`@caller` inside a player body); default: the row's own player record */
  localUserId?: (() => string | null) | undefined;
}

/** `ctx.job` / `ctx.awaitJob` (ports/jobs/verb.ts `bindJobVerb`) */
export interface JobExtension {
  /** warms the job pool (JobPort.init); awaited during boot before the first sim tick. A rejection is logged, never fatal */
  init?(): Promise<void>;
  bind(dispatchHook: (hookExport: string, result: unknown, payload: unknown) => void): { job: unknown; awaitJob: unknown };
}

/** the shape of the music port (ports/music/types.ts) */
export interface MusicExtension {
  play(clip: string, options?: Record<string, unknown>): void;
  stop(options?: Record<string, unknown>): void;
  duck(level: number, options?: Record<string, unknown>): void;
}

/** the part of the AchievementsPort (ports/achievements) the kernel uses; the port satisfies it */
export interface AchievementsExtension {
  /** feeds a `milestone` / `stat` act payload */
  handleAct(type: string, payload: unknown): Promise<unknown>;
  /** unlocked ids in unlock order: the value mirrored into `player.state.achievements` */
  unlockedIds(): string[];
  /** loads the stored document; awaited before the first mirror */
  init?(): Promise<void>;
}

/** the part of the LeaderboardPort (ports/leaderboards) the kernel uses; `submitScore(kernel, …)` is the game-side helper */
export interface LeaderboardsExtension {
  submit(boardId: string, playerId: string, score: number, name?: string): Promise<boolean>;
  init?(): Promise<void>;
}

export interface KernelExtensions {
  /**
   * Sim cadence grammar. `strict` (default): only `"100ms"` is accepted, anything else is a boot error.
   * `any`: any `"<n>ms|s|m"` string is accepted and honoured as a multiple of the 100 ms sim step (`"1s"` ticks every 10th
   * sim step); a string that does not parse runs at 100 ms.
   */
  simCadence?: 'strict' | 'any';
  /**
   * Installs `ctx.music` (play/stop/duck) on every game ctx. A MusicPort forwards to it; `true` installs a no-op that never
   * throws (a game that calls `ctx.music.duck()` unguarded). Default (omitted): `ctx.music` is undefined.
   */
  music?: MusicExtension | true | undefined;
  /** makes `ctx.place.gravity` writable (R-3); default off: a write is ignored with a warning */
  gravitySetter?: boolean;
  /**
   * Installs the read-only `ctx.place` on the UI ctx (`state`, `players`, and the rest of the UI realm's place handle) for the
   * place the viewer's body stands in (`ctx.place.players` is the local player only). Default off: the UI ctx has no `place`.
   */
  uiPlace?: boolean;
  /** installs `ctx.changed` (ctx/changed.ts); default off: it throws */
  changed?: boolean;
  /** installs `ctx.sql`; without it `ctx.sql` is today's throwing stub (or undefined, see `capabilities`) */
  sql?: SqlExtension | undefined;
  /** installs `ctx.job` and `ctx.awaitJob` */
  jobs?: JobExtension | undefined;
  /**
   * Device-local achievements (an AchievementsPort). The `milestone` act and the `stat` emit are forwarded to
   * `handleAct`, and `unlockedIds()` is mirrored into the human body's `player.state.achievements` (at spawn and after each
   * act). Default (omitted): both are ignored and `player.state` is untouched.
   */
  achievements?: AchievementsExtension | undefined;
  /** a LeaderboardPort for `submitScore(kernel, boardId, score)` (compat/core/achievements.ts); the kernel itself never submits */
  leaderboards?: LeaderboardsExtension | undefined;
  /**
   * R-7 / C-1: the kernel follows `ports.platform` pause events (`platformPause`, `adPause`, `adResume`) by itself and holds
   * the sim clock while they are set: `ctx.now()`, timers, updates and tweens stop and resume without a jump (compat/core/pause.ts).
   * Default off, where the composition root's PauseController does this.
   */
  pauseFreezesClock?: boolean;
  /**
   * Opt-in, for hosts that hold the clock (`pauseFreezesClock` or the shell's PauseController): `ctx.session.hostPaused` stays true
   * until the end of the first tick after the release, so game code (no tick runs during the hold) observes it once. Default off,
   *: it clears at the release (shell/host-state.ts).
   */
  hostPausedLinger?: boolean;
  /**
   * K8: the `slowMo` act `{ scale, duration, easing? }` scales the sim clock's speed for `duration` real seconds (semantics in
   * sched/slowmo.ts). Default off: the act is ignored and counted in `metrics.slowMoIgnored`.
   */
  slowMo?: boolean;
  /**
   * The acts `squash`, `flash` and `slash` (rules.ts EXTRA_ACT_NAMES) route as engine acts: `true` for all three, or a list of
   * the ones to route. They reach the act sink with their payload (no id) and need a handler registered on `kernel.acts`.
   * Default off: they are custom events.
   */
  extraActs?: boolean | readonly ExtraActName[];
  /**
   * `ctx.self.session` (and `session` on every row handle): a per-row plain object of local scratch data that is never saved,
   * synced or reset by state writes, and lives as long as the row (the docs: "ctx.session is local scratch data"; Crown & Clash
   * hands read `ctx.self.session.up`). Default off: `session` is undefined on a row handle.
   */
  rowSession?: boolean;
  capabilities?: {
    /**
     * Default false: `ctx.sql`, `ctx.job` and `ctx.awaitJob` are throwing stubs when their port is absent.
     * True: they are `undefined` instead, so a game's `if (!ctx.job)` feature test works.
     */
    absentAsUndefined?: boolean;
  };
}

export interface ResolvedExtensions {
  readonly simCadence: 'strict' | 'any';
  readonly changed: boolean;
  readonly gravitySetter: boolean;
  readonly uiPlace: boolean;
  readonly music: MusicExtension | null;
  readonly sql: SqlExtension | null;
  readonly jobs: JobExtension | null;
  readonly achievements: AchievementsExtension | null;
  readonly leaderboards: LeaderboardsExtension | null;
  readonly pauseFreezesClock: boolean;
  readonly hostPausedLinger: boolean;
  readonly slowMo: boolean;
  readonly extraActs: ReadonlySet<ExtraActName>;
  readonly rowSession: boolean;
  readonly absentAsUndefined: boolean;
}

const NOOP_MUSIC: MusicExtension = Object.freeze({ play() {}, stop() {}, duck() {} });

export const DEFAULT_EXTENSIONS: Readonly<ResolvedExtensions> = Object.freeze({
  simCadence: 'strict',
  changed: false,
  gravitySetter: false,
  uiPlace: false,
  music: null,
  sql: null,
  jobs: null,
  achievements: null,
  leaderboards: null,
  pauseFreezesClock: false,
  hostPausedLinger: false,
  slowMo: false,
  extraActs: new Set<ExtraActName>(),
  rowSession: false,
  absentAsUndefined: false,
});

export function resolveExtensions(ext?: KernelExtensions): Readonly<ResolvedExtensions> {
  return Object.freeze({
    simCadence: ext?.simCadence ?? 'strict',
    changed: ext?.changed === true,
    gravitySetter: ext?.gravitySetter === true,
    uiPlace: ext?.uiPlace === true,
    music: ext?.music === undefined ? null : ext.music === true ? NOOP_MUSIC : ext.music,
    sql: ext?.sql ?? null,
    jobs: ext?.jobs ?? null,
    achievements: ext?.achievements ?? null,
    leaderboards: ext?.leaderboards ?? null,
    pauseFreezesClock: ext?.pauseFreezesClock === true,
    hostPausedLinger: ext?.hostPausedLinger === true,
    slowMo: ext?.slowMo === true,
    extraActs: new Set<ExtraActName>(ext?.extraActs === true ? EXTRA_ACT_NAMES : Array.isArray(ext?.extraActs) ? (ext.extraActs as readonly ExtraActName[]).filter(isExtraActName) : []),
    rowSession: ext?.rowSession === true,
    absentAsUndefined: ext?.capabilities?.absentAsUndefined === true,
  });
}

/** the extensions of a kernel (a test kernel without them reads as the defaults) */
export function extOf(k: object): Readonly<ResolvedExtensions> {
  return (k as { ext?: Readonly<ResolvedExtensions> }).ext ?? DEFAULT_EXTENSIONS;
}

const GRAVITY_OVERRIDES = new WeakMap<object, Map<string, { x: number; y: number; z: number }>>();

/** the gravity a game wrote with `ctx.place.gravity = …` (R-3), per place; empty unless `ext.gravitySetter` */
export function gravityOverrides(k: object): Map<string, { x: number; y: number; z: number }> {
  let m = GRAVITY_OVERRIDES.get(k);
  if (!m) GRAVITY_OVERRIDES.set(k, (m = new Map()));
  return m;
}

/** ticks between two runs of a sim with this module under `simCadence: 'any'`; a multiple of 3 (the 100 ms sim step) */
export function simEveryTicks(module: Pick<SimModule, 'cadence'> | null): number {
  const c = module?.cadence;
  const ms = typeof c === 'string' ? parseCadenceMs(c) : null;
  if (ms === null || !(ms > 0)) return 3;
  return 3 * Math.max(1, Math.round(ms / 100));
}

/**
 * Boot step between kernel creation and the first tick: `ext.sql` migrates, then `ext.jobs` warms its pool (`init()`, when
 * the port has one). A failed warm-up is reported and boot goes on: the first job call then pays the cold start.
 */
export async function prepareExtensions(k: object, registry: ModuleRegistry, report: (message: string, error: unknown) => void = (m, e) => console.error(m, e)): Promise<void> {
  const ext = extOf(k);
  await ext.sql?.prepare?.(registry);
  if (ext.jobs?.init) {
    try {
      await ext.jobs.init();
    } catch (err) {
      report('[jobs] pool warm-up failed', err);
    }
  }
}
