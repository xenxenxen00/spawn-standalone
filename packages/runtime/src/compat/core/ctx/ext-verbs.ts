// The ctx verbs that the kernel extensions (../ext.ts) install over the unavailable stubs, called once from the
// GameCtxBase constructor. With no extension configured this changes nothing.
import { extOf, type MusicExtension } from '../ext.ts';
import type { CtxKernel } from './common.ts';
import { createChangedCursor } from './changed.ts';
import type { HookOwner } from '../behaviors/invoke.ts';

export interface ExtVerbTarget {
  sql?: unknown;
  job?: unknown;
  awaitJob?: unknown;
  changed?: unknown;
  music?: unknown;
}

/** `ctx.music`: arguments are checked and a throwing port is reported once, never propagated */
function guardedMusic(port: MusicExtension, report: (m: string) => void): MusicExtension {
  let reported = false;
  const call = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      if (reported) return;
      reported = true;
      report(`ctx.music: the music port threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const opts = (o: unknown): Record<string, unknown> | undefined => (typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : undefined);
  return Object.freeze({
    play: (clip: string, o?: Record<string, unknown>) => {
      if (typeof clip === 'string' && clip !== '') call(() => port.play(clip, opts(o)));
    },
    stop: (o?: Record<string, unknown>) => call(() => port.stop(opts(o))),
    duck: (level: number, o?: Record<string, unknown>) => {
      if (typeof level === 'number' && Number.isFinite(level)) call(() => port.duck(level, opts(o)));
    },
  });
}

export function installExtVerbs(ctx: ExtVerbTarget, k: CtxKernel, owner: HookOwner, report: (m: string) => void): void {
  const ext = extOf(k);
  if (ext.music !== null) ctx.music = guardedMusic(ext.music, report);
  if (ext.changed) ctx.changed = createChangedCursor(ctx, report);
  if (ext.sql !== null) {
    const row = owner.kind === 'row' ? owner.row : null;
    const userId = row?.player?.userId ?? ext.sql.localUserId?.() ?? null;
    ctx.sql = ext.sql.verb(userId);
  } else if (ext.absentAsUndefined) ctx.sql = undefined;

  if (ext.jobs !== null) {
    const bound = ext.jobs.bind((hookExport, result, payload) => {
      const module = owner.kind === 'row' ? owner.inst.module : owner.sim.module;
      if (owner.kind === 'row' && owner.row.phase !== 'alive') return;
      const fn = module !== null ? (module as Record<string, unknown>)[hookExport] : undefined;
      if (typeof fn !== 'function') {
        report(`ctx.job(..., ${JSON.stringify(hookExport)}): the module exports no function of that name`);
        return;
      }
      try {
        (fn as (c: unknown, r: unknown, p: unknown) => void)(ctx, result, payload);
      } catch (err) {
        report(`ctx.job hook ${hookExport} threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    ctx.job = bound.job;
    ctx.awaitJob = bound.awaitJob;
  } else if (ext.absentAsUndefined) {
    ctx.job = undefined;
    ctx.awaitJob = undefined;
  }
}
