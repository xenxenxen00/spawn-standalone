// WP C4 acceptance for the PlaceBake reader (docs/architecture.md §3.2, §6.4, X-06; core §15.9): the binary form round-trips
// field by field (box / sphere / triangle keys, instance flags, runtime keys, the terrain soup, a nav grid, a terrain bake),
// re-encodes byte-identically, refuses corrupt, short, wrong-version and wrong-place input naming the place, and the fetching
// reader shares one request per place, retries a network failure and never re-requests an HTTP failure.
import { deflateSync, inflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { AssetIndex } from '../../../src/assets/index-types.ts';
import {
  PLACE_BAKE_FORMAT,
  createIndexPlaceBakeReader,
  createPlaceBakeReader,
  decodePlaceBake,
  encodePlaceBake,
  placeBakeUrl,
  type BakeFetch,
} from '../../../src/assets/place-bake.ts';
import { createAssetFactsPort, createAssetResolver } from '../../../src/assets/resolver.ts';
import { emptyPlaceBake } from '../../../src/compat/core/null-ports.ts';
import type { NavGridHeader, PlaceBake } from '../../../src/compat/core/ports.ts';
import { NavGridData } from '../../../src/compat/nav/navgrid.ts';

const PLACE = 'sable-junction';

function navGrid(place: string): NavGridData {
  // 2 × 2 columns: 2 spans, 0, 1, 1
  const h: NavGridHeader = { version: 1, place, cell: 0.25, originX: -4, originZ: 8, nx: 2, nz: 2, spanCount: 4, componentCount: 2, bakeStep: 0.45, bakeHash: 'abc123' };
  return new NavGridData(h, {
    colStart: Uint32Array.of(0, 2, 2, 3, 4),
    y: Int16Array.of(0, 320, -150, 12),
    clear: Uint8Array.of(60, 255, 40, 255),
    slope: Uint8Array.of(0, 3, 44, 12),
    wall: Uint8Array.of(255, 10, 0, 90),
    comp: Uint16Array.of(1, 2, 0, 1),
    linkStart: Uint32Array.of(0, 0, 0, 1),
    linkTo: Uint16Array.of(1),
  });
}

function fixtureBake(place = PLACE): PlaceBake {
  const m = (tx: number): Float32Array => Float32Array.of(1, 0, 0, tx, 0, 1, 0, 0.5, 0, 0, 1, -3.25);
  return {
    colliders: {
      place,
      keys: [
        { id: 'scripts/gen/kit/crate.js|{"w":1}|7', tris: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0.1, 0.2, 0.3, 4, 5, 6, -7, -8, -9) },
        { id: 'box:1x2x3', box: [0.5, 1, 1.5] },
        { id: 'sphere:0.4', sphere: 0.4 },
      ],
      instances: [
        { rowId: 'crate-a', key: 0, m: m(1), mutable: false, kinematic: false, noDecal: false },
        { rowId: 'door/leaf', key: 1, m: m(2.5), mutable: true, kinematic: true, noDecal: false },
        { rowId: 'bounds-n', key: 1, m: m(-40), mutable: false, kinematic: false, noDecal: true },
        { rowId: 'ball', key: 2, m: m(0), mutable: true, kinematic: false, noDecal: true },
      ],
      runtimeKeys: [
        { spec: 'doorwreck:shard:3', key: 0 },
        { spec: 'stump:door-a', key: 1 },
      ],
      terrain: { id: `terrain/${place}`, tris: Float32Array.of(0, 1, 0, 8, 1.5, 0, 0, 2, 8) },
    },
    navgrid: navGrid(place),
    terrain: {
      heights: Float32Array.of(0, 0.5, 1, 1.5, 2, 28.0000004),
      size: [3, 2],
      cell: 4,
      weights: Uint8Array.from({ length: 36 }, (_, i) => (i * 37) % 256),
      materials: [{ id: 'mud', roughness: 0.9 }, { id: 'rock', tint: [0.4, 0.4, 0.45] }],
    },
  };
}

/** field-by-field equality (typed arrays by type and content; the nav grid by its header and arrays) */
function expectSameBake(got: PlaceBake, want: PlaceBake): void {
  expect(got.colliders.place).toBe(want.colliders.place);
  expect(got.colliders.keys.length).toBe(want.colliders.keys.length);
  got.colliders.keys.forEach((k, i) => {
    const w = want.colliders.keys[i]!;
    expect(k.id).toBe(w.id);
    expect(k.box).toEqual(w.box);
    expect(k.sphere).toBe(w.sphere);
    if (w.tris) {
      expect(k.tris).toBeInstanceOf(Float32Array);
      expect(Array.from(k.tris!)).toEqual(Array.from(w.tris));
    } else expect(k.tris).toBeUndefined();
    expect(Object.keys(k).sort()).toEqual(Object.keys(w).sort());
  });
  expect(got.colliders.instances.length).toBe(want.colliders.instances.length);
  got.colliders.instances.forEach((inst, i) => {
    const w = want.colliders.instances[i]!;
    expect({ ...inst, m: Array.from(inst.m) }).toEqual({ ...w, m: Array.from(w.m) });
    expect(inst.m).toBeInstanceOf(Float32Array);
    expect(inst.m.length).toBe(12);
  });
  expect(got.colliders.runtimeKeys).toEqual(want.colliders.runtimeKeys);
  if (want.colliders.terrain) {
    expect(got.colliders.terrain!.id).toBe(want.colliders.terrain.id);
    expect(Array.from(got.colliders.terrain!.tris)).toEqual(Array.from(want.colliders.terrain.tris));
  } else expect('terrain' in got.colliders).toBe(false);
  if (want.navgrid === null) expect(got.navgrid).toBeNull();
  else {
    const g = got.navgrid!;
    expect(g.h).toEqual(want.navgrid.h);
    for (const f of ['colStart', 'y', 'clear', 'slope', 'wall', 'comp'] as const) {
      expect(g[f].constructor).toBe(want.navgrid[f].constructor);
      expect(Array.from(g[f])).toEqual(Array.from(want.navgrid[f]));
    }
    expect(g.spansAt(0, 0)).toEqual([0, 2]);
    expect(g.spansAt(1, 1)).toEqual([3, 4]);
    expect(g.locate({ x: -3.9, y: 3.1, z: 8.1 }, 0.5, 0.5)).toBe(1);
  }
  if (want.terrain === null) expect(got.terrain).toBeNull();
  else {
    const t = got.terrain!;
    expect(t.heights).toBeInstanceOf(Float32Array);
    expect(Array.from(t.heights)).toEqual(Array.from(want.terrain.heights));
    expect(t.size).toEqual(want.terrain.size);
    expect(t.cell).toBe(want.terrain.cell);
    expect(t.weights).toBeInstanceOf(Uint8Array);
    expect(Array.from(t.weights)).toEqual(Array.from(want.terrain.weights));
    expect(t.materials).toEqual(want.terrain.materials);
  }
}

/** the inflated container of an encoded bake, with its JSON header parsed */
function open(bytes: Uint8Array): { raw: Uint8Array; header: Record<string, unknown>; headerBytes: number } {
  const raw = inflateSync(bytes);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const headerBytes = dv.getUint32(8, true);
  return { raw, header: JSON.parse(new TextDecoder().decode(raw.subarray(12, 12 + headerBytes))) as Record<string, unknown>, headerBytes };
}

/** re-packs a container with an edited header (same sections) */
function withHeader(bytes: Uint8Array, edit: (h: Record<string, unknown>) => void): Uint8Array {
  const { raw, header, headerBytes } = open(bytes);
  edit(header);
  const json = new TextEncoder().encode(JSON.stringify(header));
  const pad = (n: number): number => (n + 3) & ~3;
  const data = raw.subarray(12 + pad(headerBytes));
  const out = new Uint8Array(12 + pad(json.length) + data.length);
  out.set(raw.subarray(0, 8), 0);
  new DataView(out.buffer).setUint32(8, json.length, true);
  out.set(json, 12);
  out.fill(0x20, 12 + json.length, 12 + pad(json.length));
  out.set(data, 12 + pad(json.length));
  return deflateSync(out, { level: 9 });
}

describe('PlaceBake binary form (docs/architecture.md §6.4 step 5)', () => {
  it('round-trips a bake with every collider key kind, flags, runtime keys, a nav grid and a terrain, field by field', () => {
    const bake = fixtureBake();
    const bytes = encodePlaceBake(bake);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expectSameBake(decodePlaceBake(bytes, PLACE), bake);
    // the place check is optional
    expectSameBake(decodePlaceBake(bytes), bake);
  });

  it('is one deflate stream over a magic, a version, a JSON header with a section table and 4-byte aligned sections', () => {
    const { raw, header, headerBytes } = open(encodePlaceBake(fixtureBake()));
    expect(new TextDecoder().decode(raw.subarray(0, 4))).toBe('PPBK');
    expect(new DataView(raw.buffer, raw.byteOffset).getUint32(4, true)).toBe(PLACE_BAKE_FORMAT);
    expect(header['v']).toBe(PLACE_BAKE_FORMAT);
    expect(header['place']).toBe(PLACE);
    const sections = header['sections'] as Array<{ type: string; offset: number; length: number }>;
    expect(sections.length).toBeGreaterThan(5);
    const dataStart = 12 + ((headerBytes + 3) & ~3);
    for (const s of sections) {
      expect(s.offset % 4).toBe(0);
      expect(dataStart + s.offset).toBeLessThanOrEqual(raw.length);
    }
    expect(dataStart % 4).toBe(0);
  });

  it('re-encodes byte-identically (same input → same file; decode → encode is a fixed point)', () => {
    const a = encodePlaceBake(fixtureBake());
    const b = encodePlaceBake(fixtureBake());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const again = encodePlaceBake(decodePlaceBake(a));
    expect(Buffer.from(again).equals(Buffer.from(a))).toBe(true);
  });

  it('carries a null nav grid (X-31 bake at load), a null terrain and an empty pack', () => {
    const bake = fixtureBake();
    bake.navgrid = null;
    bake.terrain = null;
    delete bake.colliders.terrain;
    expectSameBake(decodePlaceBake(encodePlaceBake(bake), PLACE), bake);
    const empty = emptyPlaceBake('training');
    expectSameBake(decodePlaceBake(encodePlaceBake(empty), 'training'), empty);
  });

  it('decoded arrays are copies with their own aligned buffers, not views of the inflated file', () => {
    const d = decodePlaceBake(encodePlaceBake(fixtureBake()));
    const tris = d.colliders.keys[0]!.tris!;
    expect(tris.byteOffset).toBe(0);
    expect(tris.buffer.byteLength).toBe(tris.byteLength);
    expect(d.terrain!.heights.buffer).not.toBe(tris.buffer);
    // the instance transforms are views of one private copy (4 instances × 12 floats)
    expect(d.colliders.instances[0]!.m.buffer).toBe(d.colliders.instances[3]!.m.buffer);
    expect(d.colliders.instances[0]!.m.buffer.byteLength).toBe(4 * 12 * 4);
  });

  it('refuses the wrong place, naming both', () => {
    const bytes = encodePlaceBake(fixtureBake());
    expect(() => decodePlaceBake(bytes, 'gallow-farm')).toThrow(/PlaceBake gallow-farm.*sable-junction/);
  });

  it('refuses a wrong version, a bad magic and a stream that is not deflate, naming the place', () => {
    const bytes = encodePlaceBake(fixtureBake());
    const raw = inflateSync(bytes);
    const v2 = raw.slice();
    new DataView(v2.buffer).setUint32(4, PLACE_BAKE_FORMAT + 1, true);
    expect(() => decodePlaceBake(deflateSync(v2), PLACE)).toThrow(new RegExp(`PlaceBake ${PLACE}: format ${PLACE_BAKE_FORMAT + 1}`));
    const bad = raw.slice();
    bad[0] = 0x58;
    expect(() => decodePlaceBake(deflateSync(bad), PLACE)).toThrow(/PlaceBake sable-junction: bad magic/);
    expect(() => decodePlaceBake(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9), PLACE)).toThrow(/PlaceBake sable-junction: /);
    expect(() => decodePlaceBake(new Uint8Array(0), PLACE)).toThrow(/PlaceBake sable-junction: /);
    expect(() => decodePlaceBake(withHeader(bytes, (h) => (h['v'] = 9)), PLACE)).toThrow(/PlaceBake sable-junction: .*version/);
  });

  it('refuses a truncated file, a short section and a malformed header, naming the place', () => {
    const bytes = encodePlaceBake(fixtureBake());
    // a cut deflate stream
    expect(() => decodePlaceBake(bytes.subarray(0, bytes.length - 9), PLACE)).toThrow(/PlaceBake sable-junction: /);
    // a container cut inside its sections
    const raw = inflateSync(bytes);
    expect(() => decodePlaceBake(deflateSync(raw.subarray(0, raw.length - 16)), PLACE)).toThrow(/PlaceBake sable-junction: .*(short|truncated)/);
    // a container cut inside its header
    expect(() => decodePlaceBake(deflateSync(raw.subarray(0, 20)), PLACE)).toThrow(/PlaceBake sable-junction: .*(short|truncated)/);
    // a section table entry that reaches past the end, and one that is not aligned
    expect(() =>
      decodePlaceBake(withHeader(bytes, (h) => ((h['sections'] as Array<{ length: number }>)[0]!.length += 4096)), PLACE),
    ).toThrow(/PlaceBake sable-junction: .*section/);
    expect(() =>
      decodePlaceBake(withHeader(bytes, (h) => ((h['sections'] as Array<{ offset: number }>)[1]!.offset += 2)), PLACE),
    ).toThrow(/PlaceBake sable-junction: .*section/);
    // an instance that names a key the pack does not have
    expect(() => decodePlaceBake(withHeader(bytes, (h) => ((h['colliders'] as { keys: unknown[] }).keys.length = 1)), PLACE)).toThrow(
      /PlaceBake sable-junction: /,
    );
    expect(() => decodePlaceBake(withHeader(bytes, (h) => delete h['colliders']), PLACE)).toThrow(/PlaceBake sable-junction: /);
  });

  it('encode refuses what the format cannot carry (a transform that is not 3×4, a key index out of range, a non-finite box)', () => {
    const a = fixtureBake();
    a.colliders.instances[0]!.m = new Float32Array(16);
    expect(() => encodePlaceBake(a)).toThrow(/PlaceBake sable-junction: .*crate-a/);
    const b = fixtureBake();
    b.colliders.instances[1]!.key = 7;
    expect(() => encodePlaceBake(b)).toThrow(/PlaceBake sable-junction: .*door\/leaf/);
    const c = fixtureBake();
    c.colliders.keys[1]!.box = [1, Number.NaN, 1];
    expect(() => encodePlaceBake(c)).toThrow(/PlaceBake sable-junction: /);
    const d = fixtureBake();
    d.terrain!.weights = new Uint8Array(7);
    expect(() => encodePlaceBake(d)).toThrow(/PlaceBake sable-junction: .*weights/);
  });
});

// ── the fetching reader ──────────────────────────────────────────────────────────────────────────────────────────────

const URL_OF = (p: string): string => `https://game.example/assets/p/${p}.bin`;
const body = (bytes: Uint8Array, status = 200): Response => new Response(status === 200 ? (bytes.slice().buffer as ArrayBuffer) : null, { status });

describe('placeBake(place): fetch + inflate + parse (AssetFactsPort.placeBake)', () => {
  it('fetches the place URL once with force-cache and shares the result between concurrent and later calls', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch: BakeFetch = async (url, init) => {
      calls.push({ url, init });
      return body(encodePlaceBake(fixtureBake()));
    };
    const read = createPlaceBakeReader({ url: URL_OF, fetch });
    const [a, b] = await Promise.all([read(PLACE), read(PLACE)]);
    expect(a).toBe(b);
    expect(await read(PLACE)).toBe(a);
    expect(calls).toEqual([{ url: URL_OF(PLACE), init: { cache: 'force-cache' } }]);
    expectSameBake(a, fixtureBake());
  });

  it('checks that the file is the place asked for', async () => {
    const read = createPlaceBakeReader({ url: URL_OF, fetch: async () => body(encodePlaceBake(fixtureBake('gallow-farm'))) });
    await expect(read(PLACE)).rejects.toThrow(/PlaceBake sable-junction.*gallow-farm/);
  });

  it('retries after a network failure (the rejection is not cached), at most maxNetworkAttempts times in all', async () => {
    let n = 0;
    const fetch: BakeFetch = async () => {
      n++;
      if (n === 1) throw new TypeError('network down');
      return body(encodePlaceBake(fixtureBake()));
    };
    const read = createPlaceBakeReader({ url: URL_OF, fetch });
    await expect(read(PLACE)).rejects.toThrow(/PlaceBake sable-junction: .*network down/);
    expectSameBake(await read(PLACE), fixtureBake());
    expect(n).toBe(2);

    let m = 0;
    const dead = createPlaceBakeReader({
      url: URL_OF,
      maxNetworkAttempts: 2,
      fetch: async () => {
        m++;
        throw new TypeError('offline');
      },
    });
    for (let i = 0; i < 4; i++) await expect(dead(PLACE)).rejects.toThrow(/offline/);
    expect(m).toBe(2);
  });

  it('an HTTP failure rejects once and is never requested again (no 404 loop)', async () => {
    let n = 0;
    const read = createPlaceBakeReader({
      url: URL_OF,
      fetch: async () => {
        n++;
        return body(new Uint8Array(0), 404);
      },
    });
    await expect(read(PLACE)).rejects.toThrow(/PlaceBake sable-junction: HTTP 404/);
    await expect(read(PLACE)).rejects.toThrow(/PlaceBake sable-junction: HTTP 404/);
    await expect(read(PLACE)).rejects.toThrow(/HTTP 404/);
    expect(n).toBe(1);
  });

  it('takes bytes from an injected loader instead of fetch (Node tools read .cache/assets/out)', async () => {
    const asked: string[] = [];
    const read = createPlaceBakeReader({
      url: (p) => `assets/p/${p}.bin`,
      load: async (url, place) => {
        asked.push(`${place} ${url}`);
        return encodePlaceBake(fixtureBake(place));
      },
      fetch: () => {
        throw new Error('fetch must not be called');
      },
    });
    expectSameBake(await read('mire-island'), fixtureBake('mire-island'));
    expect(asked).toEqual(['mire-island assets/p/mire-island.bin']);
  });

  it('a place with no bake in the index rejects naming it, or answers an empty bake when asked to', async () => {
    const missing: string[] = [];
    const strict = createPlaceBakeReader({ url: () => null, fetch: async () => body(new Uint8Array(0)) });
    await expect(strict('training')).rejects.toThrow(/PlaceBake training: no bake/);
    const lax = createPlaceBakeReader({ url: () => null, allowMissing: true, onMissing: (p) => missing.push(p) });
    expect(await lax('training')).toEqual(emptyPlaceBake('training'));
    await lax('training');
    expect(missing).toEqual(['training']);
  });
});

describe('the bake of a place in the asset index (group map:<p>, kind bake)', () => {
  const index: AssetIndex = {
    v: 1,
    build: 't',
    origin: 't',
    entries: {
      'floor.glb': { u: 'assets/m/floor.glb', b: 10, k: 'model', x: 'glb', g: ['map:sable-junction'] },
      'bake/sable-junction': { u: 'assets/p/0123abcd.bin', b: 2048, k: 'bake', x: 'bin', g: ['map:sable-junction'] },
      'bake/silent': { u: null, b: 0, k: 'bake', x: 'bin', g: ['map:silent'] },
    },
    groups: { 'map:sable-junction': { n: ['floor.glb', 'bake/sable-junction'], b: 2058 }, 'map:silent': { n: ['bake/silent'], b: 0 } },
    facts: {},
  };
  const resolver = createAssetResolver(index, { base: 'https://game.example/play/' });

  it('placeBakeUrl finds the bake entry of the group and resolves it against the page', () => {
    expect(placeBakeUrl(resolver, 'sable-junction')).toBe('https://game.example/play/assets/p/0123abcd.bin');
    expect(placeBakeUrl(resolver, 'gallow-farm')).toBeNull();
    expect(placeBakeUrl(resolver, 'silent')).toBeNull();
  });

  it('createIndexPlaceBakeReader plugs into createAssetFactsPort', async () => {
    const urls: string[] = [];
    const port = createAssetFactsPort(
      resolver,
      createIndexPlaceBakeReader(resolver, {
        fetch: async (url) => {
          urls.push(url);
          return body(encodePlaceBake(fixtureBake()));
        },
      }),
    );
    expectSameBake(await port.placeBake('sable-junction'), fixtureBake());
    expect(urls).toEqual(['https://game.example/play/assets/p/0123abcd.bin']);
    await expect(port.placeBake('gallow-farm')).rejects.toThrow(/PlaceBake gallow-farm: no bake/);
  });
});
