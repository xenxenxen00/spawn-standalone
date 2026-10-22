// A camera row's rig fields (`hideLocalPlayer`, `fov`, …) reach the render bridge as ordinary field writes: the camera presenter
// owns them, so the bridge no longer warns "has no renderer". An unknown field still does (negative control).
import { describe, expect, it } from 'vitest';
import { rig, TestRow } from './bridge-fakes.ts';

describe('render bridge: rig field writes', () => {
  it('stay silent for hideLocalPlayer and the other rig fields; a stray field still warns', () => {
    const r = rig();
    const row = new TestRow('cam', { props: { hideLocalPlayer: true } });
    r.spawn(row);
    for (const field of ['hideLocalPlayer', 'fov', 'clip', 'orientation', 'pointerLock', 'sensitivity', 'pixelSnap']) {
      row.set(field, field === 'hideLocalPlayer' ? false : 1);
      r.feed.change(row, field);
    }
    r.frame(1);
    expect(r.logs.filter((l) => l.includes('has no renderer'))).toEqual([]);
    row.set('bogusField', 1);
    r.feed.change(row, 'bogusField');
    r.frame(1);
    expect(r.logs.filter((l) => l.includes('has no renderer'))).toHaveLength(1);
  });
});
