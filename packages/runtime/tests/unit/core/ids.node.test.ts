// Id grammar and minting (docs/design/core-runtime.md §4.4, §11.8, §16.1 `ids.test.ts`; contract §1.4, §3.7).
import { describe, expect, it } from 'vitest';
import {
  ACT_ID_PREFIX,
  CAMERA_RIG_ID,
  HUMAN_BODY_ID,
  ID_SEGMENT,
  actId,
  actIdPrefixOf,
  cellKeyOf,
  childId,
  isActId,
  isMintedId,
  localSegment,
  mintId,
  objectIdOf,
  parentScopedId,
  parseCellKey,
  rowIdOfObjectId,
  validateId,
} from '../../../src/compat/core/ids.ts';

describe('id grammar (contract §1.4: [A-Za-z0-9][A-Za-z0-9_.-]* per "/" segment)', () => {
  it('accepts the segment shapes the live game uses', () => {
    for (const seg of ['a', 'Z', '0', 'bp-Head', 'gf-terminal-basement', 'en-7f3a-0042', 'x.y_z-1', 'wi-7f3a-0003', 'a..b', '9lives']) {
      expect(ID_SEGMENT.test(seg), seg).toBe(true);
    }
  });

  it('rejects segments that start with a separator or carry a character outside the grammar', () => {
    for (const seg of ['', '-a', '_a', '.a', 'a~b', 'a b', 'a/b', 'a:b', 'é', 'a\n', 'a#b', 'a+b']) {
      expect(ID_SEGMENT.test(seg), JSON.stringify(seg)).toBe(false);
    }
  });

  it('validates every "/"-separated segment', () => {
    for (const id of ['player/local', 'camera/local', 'en-7f3a-0042/bp-Head', 'music/bed-1/layer.2', 'o1z', 'a']) {
      expect(validateId(id), id).toBe(true);
    }
    // a "~" made every spawn fail silently on live (AGENTS.md:128)
    for (const id of ['', '/', '/a', 'a/', 'a//b', 'a/~b', 'row~1', 'a/-b', 'player/c_actor:pa_1', ' a']) {
      expect(validateId(id), JSON.stringify(id)).toBe(false);
    }
  });

  it('answers false for anything that is not a string', () => {
    for (const v of [undefined, null, 0, 12, true, {}, ['a'], Symbol('a')]) expect(validateId(v)).toBe(false);
  });
});

describe('fixed ids (core §4.4)', () => {
  it('names the human body and the camera rig', () => {
    expect(HUMAN_BODY_ID).toBe('player/local');
    expect(CAMERA_RIG_ID).toBe('camera/local');
    // the game recognises the human by id.startsWith('player/') (scripts/humanoid-locomotion.js:245)
    expect(HUMAN_BODY_ID.startsWith('player/')).toBe(true);
    expect(validateId(HUMAN_BODY_ID) && validateId(CAMERA_RIG_ID)).toBe(true);
  });
});

describe('child ids (core §4.4, contract §3.1 children)', () => {
  it('prefixes the parent id with "/"', () => {
    expect(childId('en-7f3a-0042', 'bp-Head')).toBe('en-7f3a-0042/bp-Head');
    expect(childId('music', 'bed')).toBe('music/bed');
  });

  it('names an unnamed child by its array index', () => {
    expect(childId('gore-1', 0)).toBe('gore-1/0');
    expect(childId('gore-1', 12)).toBe('gore-1/12');
  });

  it('keeps an explicit id already scoped to the parent, else scopes it (ctx.spawn(id, { parent }))', () => {
    expect(parentScopedId('en-1', 'bp-Head')).toBe('en-1/bp-Head');
    expect(parentScopedId('en-1', 'en-1/bp-Head')).toBe('en-1/bp-Head');
    expect(parentScopedId('a/b', 'a/b/c')).toBe('a/b/c');
    // a bare prefix without the separator is not the parent's scope
    expect(parentScopedId('en-1', 'en-1x')).toBe('en-1/en-1x');
    expect(parentScopedId('en-1', 'en-10/x')).toBe('en-1/en-10/x');
  });

  it('reads the local segment of an id (the child row name, core §3.2)', () => {
    expect(localSegment('gf-terminal/screen')).toBe('screen');
    expect(localSegment('a/b/c')).toBe('c');
    expect(localSegment('solo')).toBe('solo');
  });
});

describe('minted ids (core §4.4: o<base36 serial>)', () => {
  it('formats the serial in base 36', () => {
    expect(mintId(0)).toBe('o0');
    expect(mintId(1)).toBe('o1');
    expect(mintId(35)).toBe('oz');
    expect(mintId(36)).toBe('o10');
    expect(mintId(1295)).toBe('ozz');
    expect(mintId(Number.MAX_SAFE_INTEGER)).toBe(`o${Number.MAX_SAFE_INTEGER.toString(36)}`);
  });

  it('mints valid, distinct ids for distinct serials', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 5000; s++) {
      const id = mintId(s);
      expect(validateId(id)).toBe(true);
      expect(isMintedId(id)).toBe(true);
      seen.add(id);
    }
    expect(seen.size).toBe(5000);
  });

  it('refuses serials that are not non-negative safe integers', () => {
    for (const s of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => mintId(s), String(s)).toThrow(RangeError);
    }
  });

  it('recognises only the minted shape', () => {
    for (const id of ['o0', 'oz', 'o10']) expect(isMintedId(id)).toBe(true);
    // base 36 has no leading zeros, so o00 / o01 are never minted
    for (const id of ['o', 'O1', 'o-1', 'oZ', 'xo1', 'o1/2', 'o00', 'o01', 'player/local']) expect(isMintedId(id), id).toBe(false);
  });
});

describe('act ids (core §8.6: snd-<n>, fx-<n>; never row ids)', () => {
  it('formats and recognises playSound and fx ids', () => {
    expect(ACT_ID_PREFIX).toEqual({ playSound: 'snd-', fx: 'fx-' });
    expect(actId('snd-', 1)).toBe('snd-1');
    expect(actId('fx-', 42)).toBe('fx-42');
    expect(isActId('snd-0')).toBe(true);
    expect(isActId('fx-12')).toBe(true);
    expect(actIdPrefixOf('snd-7')).toBe('snd-');
    expect(actIdPrefixOf('fx-7')).toBe('fx-');
  });

  it('rejects anything else', () => {
    for (const id of ['fx-', 'snd-', 'fx-1a', 'fx-01', 'fx--1', 'sfx-1', 'fx-1/2', 'player/local', 'o1', ' fx-1']) {
      expect(isActId(id), id).toBe(false);
      expect(actIdPrefixOf(id), id).toBe(null);
    }
  });

  it('refuses counters that are not non-negative safe integers', () => {
    for (const n of [-1, 0.5, Number.NaN]) expect(() => actId('fx-', n)).toThrow(RangeError);
  });
});

describe('cellKeyOf (core §11.8, contract §3.7: Math.round(x/128), round half up)', () => {
  it('puts the origin cell around 0', () => {
    expect(cellKeyOf({ x: 0, z: 0 })).toBe('x0z0');
    expect(cellKeyOf({ x: -10, z: 10 })).toBe('x0z0');
  });

  it('holds -64 <= x < 64 in x0 (the ±64 boundaries)', () => {
    expect(cellKeyOf({ x: -64, z: 0 })).toBe('x0z0');
    expect(cellKeyOf({ x: 63.999, z: 0 })).toBe('x0z0');
    expect(cellKeyOf({ x: 64, z: 0 })).toBe('x1z0');
    expect(cellKeyOf({ x: -64.001, z: 0 })).toBe('x-1z0');
    expect(cellKeyOf({ x: 0, z: -64 })).toBe('x0z0');
    expect(cellKeyOf({ x: 0, z: 64 })).toBe('x0z1');
    expect(cellKeyOf({ x: 0, z: -64.001 })).toBe('x0z-1');
  });

  it('rounds half up at the next boundaries too', () => {
    expect(cellKeyOf({ x: 191.999, z: 0 })).toBe('x1z0');
    expect(cellKeyOf({ x: 192, z: 0 })).toBe('x2z0');
    expect(cellKeyOf({ x: -192, z: -192 })).toBe('x-1z-1');
    expect(cellKeyOf({ x: -192.001, z: 0 })).toBe('x-2z0');
  });

  it('never writes a negative zero', () => {
    for (const x of [-0, -0.1, -32, -64]) expect(cellKeyOf({ x, z: x })).toBe('x0z0');
  });

  it('ignores y and refuses non-finite coordinates', () => {
    expect(cellKeyOf({ x: 130, z: -130, y: 999 } as { x: number; z: number })).toBe('x1z-1');
    expect(() => cellKeyOf({ x: Number.NaN, z: 0 })).toThrow(RangeError);
    expect(() => cellKeyOf({ x: 0, z: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it('parses canonical keys and refuses the non-standard cell files', () => {
    expect(parseCellKey('x0z0')).toEqual({ cx: 0, cz: 0 });
    expect(parseCellKey('x-1z1')).toEqual({ cx: -1, cz: 1 });
    expect(parseCellKey('x12z-3')).toEqual({ cx: 12, cz: -3 });
    // objects.scene and frostline-relay's dress.scene are cells without a plain key (core §11.2)
    for (const k of ['objects', 'dress', 'x0', 'x-0z0', 'x01z0', 'x0z', 'X0Z0', 'x0z0.scene', ' x0z0']) {
      expect(parseCellKey(k), k).toBe(null);
    }
  });

  it('round-trips through parseCellKey', () => {
    for (let x = -400; x <= 400; x += 37.5) {
      for (let z = -400; z <= 400; z += 41.25) {
        const key = cellKeyOf({ x, z });
        const cell = parseCellKey(key);
        expect(cell).toEqual({ cx: Math.round(x / 128) + 0, cz: Math.round(z / 128) + 0 });
      }
    }
  });
});

describe('objectId (core §3.3: world:#<id>)', () => {
  it('maps row ids to object ids and back', () => {
    expect(objectIdOf('gf-door-1')).toBe('world:#gf-door-1');
    expect(rowIdOfObjectId('world:#gf-door-1')).toBe('gf-door-1');
    expect(rowIdOfObjectId('world:#player/local')).toBe('player/local');
  });

  it('refuses other worlds and malformed ids', () => {
    for (const o of ['world:other#a', 'world:#', 'world:#a~b', 'ss#a', '']) expect(rowIdOfObjectId(o), o).toBe(null);
  });
});
