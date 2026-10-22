// WP R7 on R13's bridge (render §11.5, §11.6; X-20, X-40): the `handoff` seam. A claimed row (a batched gib) gets no model
// and its world matrix goes to the handoff; a placed row the handoff tracks (a corpse) is handed over once the handoff owns
// it: the mixer keeps its pose and lets go, the model is forgotten without a dispose, and the row's pose (× the model root's
// local matrix) goes to the handoff. `release` always comes before the bridge disposes a tracked model.
import { Group, Matrix4, Object3D } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { RowSnapshot } from '../../../src/compat/core/ports.ts';
import type { BridgeHandoff, BridgeModel, BridgeModels } from '../../../src/render/bridge/bridge-types.ts';
import { matrixDiff, rig, TestRow } from './bridge-fakes.ts';

type Model = BridgeModel & { disposed: boolean };

function fakeModel(log: string[], id: string): Model {
  const root = new Group();
  const m: Model = {
    root,
    bones: new Map<string, Object3D>(),
    disposed: false,
    setLayers: () => undefined,
    setVisible: () => undefined,
    dispose: () => {
      log.push(`dispose:${id}`);
      m.disposed = true;
      root.removeFromParent();
    },
  };
  return m;
}

interface Fake {
  handoff: BridgeHandoff;
  log: string[];
  poses: Map<string, number[]>;
  owned: Set<string>;
  claimTag: string;
  trackTag: string;
}

function fakeHandoff(log: string[]): Fake {
  const f: Fake = {
    log,
    poses: new Map(),
    owned: new Set(),
    claimTag: 'gib',
    trackTag: 'corpse',
    handoff: {
      claim: (row: RowSnapshot) => {
        const yes = row.tags.includes(f.claimTag);
        if (yes) log.push(`claim:${row.id}`);
        return yes;
      },
      placed: (row: RowSnapshot) => {
        const yes = row.tags.includes(f.trackTag);
        if (yes) log.push(`placed:${row.id}`);
        return yes;
      },
      owns: (rowId) => f.owned.has(rowId),
      pose: (rowId, world) => void f.poses.set(rowId, Array.from(world.elements)),
      release: (rowId) => void log.push(`release:${rowId}`),
    },
  };
  return f;
}

function setup() {
  const log: string[] = [];
  const made = new Map<string, Model>();
  const models: BridgeModels = {
    create(row) {
      if (row.props['model'] === undefined) return null;
      log.push(`create:${row.id}`);
      const m = fakeModel(log, row.id);
      made.set(row.id, m);
      return m;
    },
  };
  const fake = fakeHandoff(log);
  const mixer = {
    bind: () => true,
    unbind: (x: unknown) => void log.push(`unbind:${[...made].find(([, m]) => m === x)?.[0] ?? String(x)}`),
    release: (rowId: string) => void log.push(`mixer-release:${rowId}`),
  };
  const r = rig({ models, mixer, handoff: fake.handoff });
  return { r, log, made, fake };
}

const trs = (pos: [number, number, number]): Matrix4 => new Matrix4().makeTranslation(pos[0], pos[1], pos[2]);

describe('render bridge: the R7 handoff seam (render §11.5, §11.6)', () => {
  it('a claimed row gets no model; its world matrix goes to the handoff when it moves; removal releases it', () => {
    const { r, log, fake } = setup();
    const gib = new TestRow('gib-1', { tags: ['gib', 'gore'], pos: [1, 2, 3], props: { model: 'cdn/gore-heart.glb', physics: { body: 'dynamic' } } });
    r.spawn(gib);
    expect(log).toEqual(['claim:gib-1']);
    expect(r.bridge.node('gib-1')!.model).toBeNull();
    expect(r.bridge.stats().models).toBe(0);
    expect(matrixDiff(fake.poses.get('gib-1')!, trs([1, 2, 3]).elements)).toBeLessThan(1e-6);

    gib.tick({ pos: [4, 2, 3] });
    r.frame(1);
    expect(matrixDiff(fake.poses.get('gib-1')!, trs([4, 2, 3]).elements)).toBeLessThan(1e-6);

    r.feed.remove('gib-1');
    r.frame(1);
    expect(log).toEqual(['claim:gib-1', 'release:gib-1']);
  });

  it('a `model` write on a claimed row ends the claim before the new one', () => {
    const { r, log } = setup();
    const gib = new TestRow('gib-2', { tags: ['gib'], props: { model: 'cdn/a.glb' } });
    r.spawn(gib);
    gib.set('model', 'cdn/b.glb');
    r.feed.change(gib, 'model');
    r.frame(1);
    expect(log).toEqual(['claim:gib-2', 'release:gib-2', 'claim:gib-2']);
  });

  it('hands a tracked model over once the handoff owns it: mixer pose kept and released, no dispose, root-local pose', () => {
    const { r, log, made, fake } = setup();
    const corpse = new TestRow('corpse-1', { tags: ['corpse', 'gore'], pos: [2, 0, -1], yaw: 90, props: { model: { id: 'cdn/hollow.glb', forward: '+z' } } });
    r.spawn(corpse);
    expect(log).toEqual(['create:corpse-1', 'placed:corpse-1']);
    const model = made.get('corpse-1')!;
    expect(r.bridge.node('corpse-1')!.model).toBe(model);

    // not owned yet (baking): the bridge keeps the model
    r.frame(1);
    expect(r.bridge.node('corpse-1')!.model).toBe(model);
    expect(fake.poses.has('corpse-1')).toBe(false);

    const rootLocal = model.root.matrix.clone();
    fake.owned.add('corpse-1');
    r.frame(1);
    expect(log).toEqual(['create:corpse-1', 'placed:corpse-1', 'mixer-release:corpse-1', 'unbind:corpse-1']);
    expect(model.disposed).toBe(false);
    expect(r.bridge.node('corpse-1')!.model).toBeNull();
    expect(r.bridge.stats().models).toBe(0);
    const world = new Matrix4().fromArray(Array.from(r.bridge.node('corpse-1')!.world));
    expect(matrixDiff(fake.poses.get('corpse-1')!, world.clone().multiply(rootLocal).elements)).toBeLessThan(1e-6);

    // the fade sink: a move of the row reaches the handoff
    corpse.tick({ pos: [2, -0.3, -1], yaw: 90 });
    r.frame(1);
    const sunk = new Matrix4().fromArray(Array.from(r.bridge.node('corpse-1')!.world));
    expect(sunk.elements[13]).toBeCloseTo(-0.3, 6);
    expect(matrixDiff(fake.poses.get('corpse-1')!, sunk.clone().multiply(rootLocal).elements)).toBeLessThan(1e-6);

    // removal releases; the handed-over model is never disposed by the bridge
    r.feed.remove('corpse-1');
    r.frame(1);
    expect(log.at(-1)).toBe('release:corpse-1');
    expect(model.disposed).toBe(false);
  });

  it('a tracked model the handoff does not own yet is released before the bridge disposes it', () => {
    const { r, log } = setup();
    r.spawn(new TestRow('corpse-2', { tags: ['corpse'], props: { model: 'cdn/hollow.glb' } }));
    r.feed.remove('corpse-2');
    r.frame(1);
    expect(log).toEqual(['create:corpse-2', 'placed:corpse-2', 'release:corpse-2', 'unbind:corpse-2', 'dispose:corpse-2']);
  });

  it('rows the handoff neither claims nor tracks keep the plain model path', () => {
    const { r, log, made } = setup();
    r.spawn(new TestRow('crate', { props: { model: 'cdn/crate.glb' } }));
    r.feed.remove('crate');
    r.frame(1);
    expect(log).toEqual(['create:crate', 'unbind:crate', 'dispose:crate']);
    expect(made.get('crate')!.disposed).toBe(true);
  });
});
