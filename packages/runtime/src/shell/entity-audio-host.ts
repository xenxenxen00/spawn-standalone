// Copied from purge-protocol-web ebab692 (src/app or src/platform, same file name; web-platform.ts is platform/web.ts).
// Row-backed entity audio belongs to the app shell: audio exists before the renderer and music rows can spawn behind the menu.
import type { CoreKernel } from '../compat/core/kernel.ts';
import { worldPose } from '../compat/core/store/transform.ts';
import type { RowRec, Vec3 } from '../compat/core/types.ts';
import type { AudioEngineCore } from '../runtime/audio/audio-engine.ts';
import type { EntityAudioHandle, EntityAudioSpec } from '../runtime/audio/types.ts';

interface EntityAudioEntry {
  row: RowRec;
  handle: EntityAudioHandle;
  spec: EntityAudioSpec;
  position: Vec3 | null;
}

const specOf = (value: unknown): EntityAudioSpec | null => {
  if (typeof value !== 'object' || value === null || typeof (value as Record<string, unknown>)['clip'] !== 'string') return null;
  return { ...(value as EntityAudioSpec) };
};

const samePosition = (a: Vec3 | null, b: Vec3 | null): boolean =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.z === b.z);

/** Connects row `audio` components to the app-owned audio engine, including scene rows and carried music beds. */
export function installEntityAudioHost(
  kernel: Pick<CoreKernel, 'store' | 'on'>,
  audio: Pick<AudioEngineCore, 'createEntityAudio'>,
): { frame(): void; dispose(): void } {
  const entries = new Map<string, EntityAudioEntry>();

  const stop = (row: RowRec): void => {
    const entry = entries.get(row.id);
    if (!entry || entry.row !== row) return;
    entries.delete(row.id);
    entry.handle.stop();
  };

  const sync = (row: RowRec, value: unknown): void => {
    let entry = entries.get(row.id);
    if (entry && entry.row !== row) {
      entries.delete(row.id);
      entry.handle.stop();
      entry = undefined;
    }
    const spec = row.phase === 'alive' ? specOf(value) : null;
    if (!spec) {
      if (entry) stop(row);
      return;
    }
    const position = spec.spatial === true ? worldPose(kernel.store, row).pos : null;
    if (!entry) {
      const handle = audio.createEntityAudio(row.id, spec);
      entry = { row, handle, spec, position };
      entries.set(row.id, entry);
    } else {
      entry.spec = spec;
      entry.position = position;
    }
    entry.handle.update(spec, position);
  };

  const offChannel = kernel.store.channels.register({ field: 'audio', onWrite: (row, value) => sync(row, value) });
  const offSpawn = kernel.on('rowSpawned', (row) => sync(row, row.props['audio']));
  const offDestroy = kernel.on('rowDestroyed', stop);
  let disposed = false;

  return {
    frame(): void {
      if (disposed) return;
      kernel.store.channels.flush(['audio']);
      for (const entry of entries.values()) {
        if (kernel.store.get(entry.row.id) !== entry.row) {
          stop(entry.row);
          continue;
        }
        if (entry.spec.spatial !== true) continue;
        const position = worldPose(kernel.store, entry.row).pos;
        if (samePosition(entry.position, position)) continue;
        entry.position = position;
        entry.handle.update(entry.spec, position);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      offChannel();
      offSpawn();
      offDestroy();
      for (const entry of entries.values()) entry.handle.stop();
      entries.clear();
    },
  };
}
