// WP X1b on R13's bridge: `model: { forward: '+z' }` (contract §9.8; the operators, `scripts/player/operators.js:67`). The file
// faces +Z and a row faces −Z, so the model root stands half a turn under the row's object, which stays the row's frame: the
// object is what the animation domain re-projects IK targets with (`ssBody`, three-skin.ts), and the turn reaches the skin
// through the root's own matrix. The same root matrix is what motion's bone attachments read as the model's normalisation
// (`GameWorld.rigFrame`, src/render/world/install.ts).
import { Group, Matrix4, Object3D } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { BridgeModel, BridgeModels } from '../../../src/render/bridge/bridge-types.ts';
import { rig, TestRow } from './bridge-fakes.ts';

function fakeModel(): BridgeModel {
  const root = new Group();
  return { root, bones: new Map<string, Object3D>(), setLayers: () => undefined, setVisible: () => undefined, dispose: () => root.removeFromParent() };
}

describe('the render bridge: a model that faces +Z', () => {
  it('stands half a turn under its row; the row\'s object carries the row\'s own transform', () => {
    const made: BridgeModel[] = [];
    const bound: Array<{ rowId: string | undefined; body: Object3D | undefined; root: Object3D }> = [];
    const models: BridgeModels = {
      create(row) {
        if (row.props['model'] === undefined) return null;
        const m = fakeModel();
        made.push(m);
        return m;
      },
    };
    const r = rig({ models, mixer: { bind: (instance, o) => void bound.push({ rowId: o?.rowId, body: o?.body, root: (instance as BridgeModel).root }) } });
    r.spawn(
      new TestRow('operator', { pos: [4, 0, 2], yaw: 90, props: { model: { id: 'cdn/soldier.glb', forward: '+z' } } }),
      new TestRow('zed', { pos: [0, 0, 0], props: { model: 'cdn/hollow.glb' } }),
    );
    const [operator, zed] = made as [BridgeModel, BridgeModel];
    expect(operator.root.rotation.y).toBe(Math.PI);
    expect(zed.root.rotation.y).toBe(0);

    // the body object is the row's frame, without the turn; the root's local matrix is the turn alone
    const body = r.bridge.node('operator')!.object!;
    expect(operator.root.parent).toBe(body);
    expect(bound.find((b) => b.rowId === 'operator')).toMatchObject({ body, root: operator.root });
    expect(operator.root.userData['ssBody']).toBe(body);
    const turn = new Matrix4().makeRotationY(Math.PI);
    operator.root.matrix.elements.forEach((v, i) => expect(v).toBeCloseTo(turn.elements[i]!, 12));

    // a point 1 m in front of the model's face (+Z in the file) lands on the row's forward (−Z of the row, turned by its yaw)
    r.frame(1);
    operator.root.updateWorldMatrix(true, false);
    const front = new Object3D().position.set(0, 0, 1).applyMatrix4(operator.root.matrixWorld);
    const rowForward = new Object3D().position.set(0, 0, -1).applyMatrix4(body.matrixWorld);
    expect(front.x).toBeCloseTo(rowForward.x, 9);
    expect(front.z).toBeCloseTo(rowForward.z, 9);
  });
});
