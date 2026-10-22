// The `bones` property channel (plan item K3; INTEGRATION.md hook H3): forwards a row's `bones` prop to its RigMixer. The
// store keeps the value (`read` stays undefined: a read returns what was written); the channel only notifies. Deduplicated
// per tick like any plain channel: the mixer reads the prop as the row stores it, so the last write of a tick wins.
import type { Kernel, PropChannel, RowRec } from '../../compat/core/types.ts';
import type { Mixer } from '../../compat/motion/mixer.ts';
import { RigMixer } from './rig-mixer.ts';

export interface BonesChannelHost {
  /** the row's mixer, made when it has none (`AnimChannels.ensure`); a plain Mixer is skipped */
  ensure(row: RowRec): Mixer;
}

export function createBonesChannel(host: BonesChannelHost): PropChannel {
  return {
    field: 'bones',
    onWrite: (row) => {
      if (row.phase !== 'alive') return;
      const mixer = host.ensure(row);
      if (mixer instanceof RigMixer) mixer.setBoneChannels(row.props['bones']);
    },
  };
}

/** A row spawned with a `bones` spec: its channels apply from the first evaluation. */
export function adoptBoneChannels(host: BonesChannelHost, row: RowRec): void {
  if (row.props['bones'] === undefined) return;
  const mixer = host.ensure(row);
  if (mixer instanceof RigMixer) mixer.setBoneChannels(row.props['bones']);
}

/**
 * H3 in one call, for the boot that installs motion (`motion.install(kernel)`): registers the `bones` channel on the kernel's
 * store and adopts a spawn-time `bones` spec of every row spawned from now on. The mixers must be RigMixers
 * (`createMotion({ …, createMixer: createRigMixer })`); a plain Mixer is skipped. Returns an uninstall.
 */
export function installBoneChannels(host: BonesChannelHost, kernel: Pick<Kernel, 'store' | 'on'>): () => void {
  const offChannel = kernel.store.channels.register(createBonesChannel(host));
  const offSpawn = kernel.on('rowSpawned', (row) => adoptBoneChannels(host, row));
  return () => {
    offChannel();
    offSpawn();
  };
}
