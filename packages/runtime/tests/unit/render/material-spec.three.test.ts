// WP R1a (render §7.4; contract §9.4): a row's `material` (`StandardMaterialSpec`) → `SurfaceParams`, and those through the
// variant cache to three.js material state. Node + three, no renderer.
import { BackSide, DoubleSide, FrontSide, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, PlaneGeometry } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { cssToLinear } from '../../../src/render/color/color.ts';
import {
  DRAWS_OVER_RENDER_ORDER,
  isScriptedMaterialSpec,
  surfaceParamsFromSpec,
  type StandardMaterialSpec,
  type SurfaceParams,
} from '../../../src/render/surface/material-spec.ts';
import { SurfaceMaterial, SurfaceMaterials, SurfaceVariant as V, UnlitSurfaceMaterial, describeVariant, setSurfacePaint } from '../../../src/render/surface/surface-material.ts';
import type { LightingScript } from '../../../src/render/surface/script-types.ts';

const script: LightingScript = { lighting: (_s, l) => l.ambient };
const has = (p: SurfaceParams, bit: number): boolean => (p.variant & bit) !== 0;
const close = (a: readonly number[], b: readonly number[]): void => {
  expect(a).toHaveLength(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 12));
};

describe('surfaceParamsFromSpec: defaults', () => {
  it('no material: a white, opaque, rough dielectric primitive with default state', () => {
    for (const spec of [undefined, null, {}]) {
      const p = surfaceParamsFromSpec(spec);
      expect(describeVariant(p.variant)).toBe('SRC_PRIM');
      expect(p.paint).toEqual({ color: [1, 1, 1], opacity: 1, emissive: [0, 0, 0], roughness: 1, metalness: 0, uvScale: [1, 1], ormRoughness: true, ormMetalness: true });
      expect(p.textures).toEqual({ albedo: null, normal: null, orm: null, wrap: 'repeat' });
      expect(p.state).toEqual({ depthWrite: true, depthTest: true, polygonOffset: false, polygonOffsetFactor: 0, polygonOffsetUnits: 0 });
      expect(p.renderOrder).toBe(0);
      expect(p.unsupported).toEqual([]);
    }
  });

  it('the source picks the SRC bit; packed geometry is flat unless smooth', () => {
    expect(describeVariant(surfaceParamsFromSpec({}, { source: 'prim' }).variant)).toBe('SRC_PRIM');
    expect(describeVariant(surfaceParamsFromSpec({}, { source: 'gltf' }).variant)).toBe('SRC_GLTF');
    expect(describeVariant(surfaceParamsFromSpec({}, { source: 'packed' }).variant)).toBe('SRC_PACKED');
    expect(describeVariant(surfaceParamsFromSpec({}, { source: 'packed', smooth: true }).variant)).toBe('SRC_PACKED|NORMALS');
    // a draw-only material still draws (the live GPU-harness quirk is not reproduced)
    expect(surfaceParamsFromSpec({ color: 'oklch(0.6 0.1 30)' }).variant).toBe(V.SRC_PRIM);
  });
});

describe('surfaceParamsFromSpec: the §7.4 table', () => {
  it('colour is linear; a texture is tinted by it', () => {
    const p = surfaceParamsFromSpec({ color: 'oklch(0.7 0.19 55)', texture: 'cdn/texture-a.png' });
    close(p.paint.color, cssToLinear('oklch(0.7 0.19 55)')!);
    expect(p.textures.albedo).toBe('cdn/texture-a.png');
    expect(has(p, V.TEX_ALBEDO)).toBe(true);
    // a hex colour goes through the sRGB EOTF, never to three as a hex number
    close(surfaceParamsFromSpec({ color: '#808080' }).paint.color, cssToLinear('#808080')!);
    // an unparsable colour keeps the default
    expect(surfaceParamsFromSpec({ color: 'not-a-colour' }).paint.color).toEqual([1, 1, 1]);
  });

  it('emissive × emissiveIntensity, linear (HDR allowed)', () => {
    const e = cssToLinear('oklch(0.78 0.1 235)')!;
    close(surfaceParamsFromSpec({ emissive: 'oklch(0.78 0.1 235)' }).paint.emissive, e);
    close(surfaceParamsFromSpec({ emissive: 'oklch(0.78 0.1 235)', emissiveIntensity: 0.6 }).paint.emissive, [e[0] * 0.6, e[1] * 0.6, e[2] * 0.6]);
    close(surfaceParamsFromSpec({ emissive: 'oklch(0.78 0.1 235)', emissiveIntensity: 4 }).paint.emissive, [e[0] * 4, e[1] * 4, e[2] * 4]);
    // an intensity without a colour emits nothing
    expect(surfaceParamsFromSpec({ emissiveIntensity: 3 }).paint.emissive).toEqual([0, 0, 0]);
  });

  it('roughness, metalness and the packed ORM image (G roughness, B metalness)', () => {
    const p = surfaceParamsFromSpec({ roughness: 0.25, metalness: 0.9 });
    expect([p.paint.roughness, p.paint.metalness]).toEqual([0.25, 0.9]);
    expect(has(p, V.TEX_ORM)).toBe(false);

    // the kit preset of scripts/lib/mat/index.js: one ORM image for both, roughness 1, metalness 1
    const metal = surfaceParamsFromSpec({ texture: 'a.png', normalMap: 'n.png', roughnessMap: 'orm.png', metalnessMap: 'orm.png', roughness: 1, metalness: 1, wrap: 'repeat' });
    expect(metal.textures).toEqual({ albedo: 'a.png', normal: 'n.png', orm: 'orm.png', wrap: 'repeat' });
    expect(describeVariant(metal.variant)).toBe('SRC_PRIM|TEX_ALBEDO|TEX_NORMAL|TEX_ORM');
    expect([metal.paint.ormRoughness, metal.paint.ormMetalness]).toEqual([true, true]);
    expect(metal.unsupported).toEqual([]);

    // the non-metal preset maps the roughness only: the image's B channel must not scale the metalness
    const dielectric = surfaceParamsFromSpec({ texture: 'a.png', normalMap: 'n.png', roughnessMap: 'orm.png', roughness: 1 });
    expect([dielectric.paint.ormRoughness, dielectric.paint.ormMetalness]).toEqual([true, false]);
    expect(dielectric.textures.orm).toBe('orm.png');

    const onlyMetal = surfaceParamsFromSpec({ metalnessMap: 'm.png' });
    expect(onlyMetal.textures.orm).toBe('m.png');
    expect([onlyMetal.paint.ormRoughness, onlyMetal.paint.ormMetalness]).toEqual([false, true]);

    // two different images have no slot: the roughness image wins and the diagnostic says so
    const split = surfaceParamsFromSpec({ roughnessMap: 'r.png', metalnessMap: 'm.png' });
    expect(split.textures.orm).toBe('r.png');
    expect([split.paint.ormRoughness, split.paint.ormMetalness]).toEqual([true, false]);
    expect(split.unsupported).toEqual(['metalnessMap (a different image than roughnessMap)']);
  });

  it('`unlit: true` is the UNLIT variant with albedo and emissive kept', () => {
    // scripts/player/ordnance.js:178
    const p = surfaceParamsFromSpec({ color: 'oklch(0.7 0.19 55)', opacity: 0.4, transparent: true, emissive: 'oklch(0.7 0.19 55)', emissiveIntensity: 0.8, unlit: true });
    expect(describeVariant(p.variant)).toBe('SRC_PRIM|TRANSPARENT|UNLIT');
    expect(p.paint.opacity).toBe(0.4);
    const c = cssToLinear('oklch(0.7 0.19 55)')!;
    close(p.paint.color, c);
    close(p.paint.emissive, [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8]);
  });

  it('side: "double" and "back" are variant bits; "front" is the default', () => {
    expect(has(surfaceParamsFromSpec({ side: 'double' }), V.SIDE_DOUBLE)).toBe(true);
    expect(has(surfaceParamsFromSpec({ side: 'back' }), V.SIDE_BACK)).toBe(true);
    const front = surfaceParamsFromSpec({ side: 'front' });
    expect(has(front, V.SIDE_DOUBLE) || has(front, V.SIDE_BACK)).toBe(false);
  });

  it('opacity and transparent', () => {
    expect(has(surfaceParamsFromSpec({ transparent: true }), V.TRANSPARENT)).toBe(true);
    // an alpha below 1 with no `transparent` key blends
    const half = surfaceParamsFromSpec({ opacity: 0.5 });
    expect(has(half, V.TRANSPARENT)).toBe(true);
    expect(half.paint.opacity).toBe(0.5);
    // an explicit `transparent: false` keeps the material opaque (three's rule: opacity only blends when transparent)
    expect(has(surfaceParamsFromSpec({ opacity: 0.5, transparent: false }), V.TRANSPARENT)).toBe(false);
    // the alpha of the colour string counts; `opacity` overrides it
    expect(surfaceParamsFromSpec({ color: 'oklch(.3 .1 27 / .8)' }).paint.opacity).toBe(0.8);
    expect(has(surfaceParamsFromSpec({ color: 'oklch(.3 .1 27 / .8)' }), V.TRANSPARENT)).toBe(true);
    expect(surfaceParamsFromSpec({ color: 'oklch(.3 .1 27 / .8)', opacity: 0.25 }).paint.opacity).toBe(0.25);
    expect(surfaceParamsFromSpec({ opacity: 7 }).paint.opacity).toBe(1);
  });

  it('depthWrite, depthTest and polygon offset are material state; renderOrder is the mesh', () => {
    // scripts/gore/gunblood.js:98
    const p = surfaceParamsFromSpec({ texture: 'blood.png', transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, roughness: 0.25, metalness: 0 });
    expect(p.state).toEqual({ depthWrite: false, depthTest: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    expect(describeVariant(p.variant)).toBe('SRC_PRIM|TEX_ALBEDO|TRANSPARENT');
    expect(surfaceParamsFromSpec({ depthTest: false }).state.depthTest).toBe(false);
    // factor and units mean nothing without the switch
    expect(surfaceParamsFromSpec({ polygonOffsetFactor: -2, polygonOffsetUnits: -2 }).state).toMatchObject({ polygonOffset: false, polygonOffsetFactor: 0, polygonOffsetUnits: 0 });
    expect(surfaceParamsFromSpec({ renderOrder: 7 }).renderOrder).toBe(7);
  });

  it('drawsOver → a renderOrder above the world, drawn last', () => {
    expect(DRAWS_OVER_RENDER_ORDER).toBeGreaterThan(100);
    expect(surfaceParamsFromSpec({ drawsOver: ['body'] }).renderOrder).toBe(DRAWS_OVER_RENDER_ORDER);
    expect(surfaceParamsFromSpec({ drawsOver: { parts: ['body'], strength: 0.5 } }).renderOrder).toBe(DRAWS_OVER_RENDER_ORDER);
    expect(surfaceParamsFromSpec({ drawsOver: ['body'], renderOrder: 3 }).renderOrder).toBe(DRAWS_OVER_RENDER_ORDER);
    expect(surfaceParamsFromSpec({ drawsOver: ['body'], renderOrder: 5000 }).renderOrder).toBe(5000);
    expect(surfaceParamsFromSpec({ drawsOver: [] }).renderOrder).toBe(0);
  });

  it('repeat scales the uv of a textured material', () => {
    const p = surfaceParamsFromSpec({ texture: 'a.png', repeat: [2, 3] });
    expect(has(p, V.UV_TILE)).toBe(true);
    expect(p.paint.uvScale).toEqual([2, 3]);
    expect(has(surfaceParamsFromSpec({ texture: 'a.png', repeat: [1, 1] }), V.UV_TILE)).toBe(false);
    // no texture, nothing to tile
    expect(has(surfaceParamsFromSpec({ repeat: [2, 3] }), V.UV_TILE)).toBe(false);
    expect(surfaceParamsFromSpec({ texture: 'a.png', wrap: 'clamp' }).textures.wrap).toBe('clamp');
  });

  it('`pbr` asks for nothing; on a scripted row without a texture set the generator paints are the look (poly look)', () => {
    const plain = surfaceParamsFromSpec({}, { source: 'packed', scripted: true });
    expect(plain.paintSource).toBe('generator');
    expect(describeVariant(plain.variant)).toBe('SRC_PACKED');
    expect(surfaceParamsFromSpec({ pbr: true }, { source: 'packed', scripted: true })).toEqual(plain);
    expect(surfaceParamsFromSpec({ pbr: 'fal1' }, { source: 'packed', scripted: true })).toEqual(plain);
    // PBR numbers alone (no texture, no colour) do not replace the paints, nor does a colour that is not one
    expect(surfaceParamsFromSpec({ pbr: true, roughness: 0.1, metalness: 1 }, { source: 'packed', scripted: true })).toEqual(plain);
    expect(surfaceParamsFromSpec({ pbr: true, color: 'not-a-colour', roughness: 0.1 }, { source: 'packed', scripted: true })).toEqual(plain);
    // on a primitive row `pbr` changes nothing either: no derived maps are fetched
    expect(surfaceParamsFromSpec({ pbr: true, roughness: 0.4 })).toEqual(surfaceParamsFromSpec({ roughness: 0.4 }));
    expect(surfaceParamsFromSpec({ pbr: true }).unsupported).toEqual([]);
    expect(surfaceParamsFromSpec({ roughness: 0.4 }).paintSource).toBe('row');
  });

  it('a PBR texture set on a scripted row (range/bunker kit) replaces the paint albedo with the texture', () => {
    // scripts/lib/mat/index.js `set(name, over)`: the metal preset, and a tinted one
    const steel: StandardMaterialSpec = { texture: 'cdn/steel-a.png', normalMap: 'cdn/steel-n.png', roughnessMap: 'cdn/steel-orm.png', roughness: 1, wrap: 'repeat', metalnessMap: 'cdn/steel-orm.png', metalness: 1 };
    const p = surfaceParamsFromSpec(steel, { source: 'packed', scripted: true });
    expect(describeVariant(p.variant)).toBe('SRC_PACKED|TEX_ALBEDO|TEX_NORMAL|TEX_ORM');
    expect(p.paintSource).toBe('row');
    expect(p.textures).toEqual({ albedo: 'cdn/steel-a.png', normal: 'cdn/steel-n.png', orm: 'cdn/steel-orm.png', wrap: 'repeat' });
    expect([p.paint.roughness, p.paint.metalness, p.paint.ormRoughness, p.paint.ormMetalness]).toEqual([1, 1, true, true]);
    // untinted: the texel alone (the white default multiplies it)
    expect(p.paint.color).toEqual([1, 1, 1]);
    // the kit's UVs are in texture tiles already (`{uvs}`): no tiling stage unless the row asks for a repeat
    expect(has(p, V.UV_TILE)).toBe(false);

    const teal = surfaceParamsFromSpec({ texture: 'cdn/tile-a.png', normalMap: 'cdn/tile-n.png', roughnessMap: 'cdn/tile-orm.png', roughness: 1, color: 'oklch(0.62 0.075 200)' }, { source: 'packed', scripted: true });
    close(teal.paint.color, cssToLinear('oklch(0.62 0.075 200)')!);
    expect([teal.paint.ormRoughness, teal.paint.ormMetalness]).toEqual([true, false]);
    // `pbr` beside a texture set is still ignored
    expect(surfaceParamsFromSpec({ ...steel, pbr: true }, { source: 'packed', scripted: true })).toEqual(p);
    // smooth scripted pieces keep their NORMALS bit
    expect(describeVariant(surfaceParamsFromSpec(steel, { source: 'packed', scripted: true, smooth: true }).variant)).toBe('SRC_PACKED|NORMALS|TEX_ALBEDO|TEX_NORMAL|TEX_ORM');
  });

  it('a flat kit preset on a scripted row paints the zone: the kit generators paint nothing in kit mode (scripts/gen/kit/lib.js `paint`)', () => {
    // scripts/lib/mat/index.js `flat(color, rough)`; the live rows are places/training/cells/x0z0.scene (kit/pit.js part plastic-red,
    // kit/plate.js part plastic-white). Without the row colour these faces would keep the recorder's unpainted white.
    const red = surfaceParamsFromSpec({ color: 'oklch(0.42 0.17 28)', metalness: 0, roughness: 0.4 }, { source: 'packed', scripted: true });
    expect(describeVariant(red.variant)).toBe('SRC_PACKED|ROW_PAINT');
    expect(red.paintSource).toBe('row');
    close(red.paint.color, cssToLinear('oklch(0.42 0.17 28)')!);
    expect([red.paint.roughness, red.paint.metalness]).toEqual([0.4, 0]);
    expect(red.textures).toEqual({ albedo: null, normal: null, orm: null, wrap: 'repeat' });
    // the other flat presets of the kit: glass (blended) and the emissives
    const glass = surfaceParamsFromSpec({ color: 'oklch(0.82 0.04 215)', roughness: 0.05, metalness: 0.1, opacity: 0.3, transparent: true }, { source: 'packed', scripted: true });
    expect(describeVariant(glass.variant)).toBe('SRC_PACKED|TRANSPARENT|ROW_PAINT');
    expect(glass.paint.opacity).toBe(0.3);
    const lamp = surfaceParamsFromSpec({ color: 'oklch(0.30 0.05 65)', emissive: 'oklch(0.80 0.16 65)', emissiveIntensity: 5.5, roughness: 0.35, metalness: 0 }, { source: 'packed', scripted: true, smooth: true });
    expect(describeVariant(lamp.variant)).toBe('SRC_PACKED|NORMALS|ROW_PAINT');
    const glow = cssToLinear('oklch(0.80 0.16 65)')!;
    close(lamp.paint.emissive, [glow[0] * 5.5, glow[1] * 5.5, glow[2] * 5.5]);
    // a texture set needs no extra bit (TEX_ALBEDO already says the row paints), and a primitive row never carries it
    expect(surfaceParamsFromSpec({ texture: 'a.png', color: 'oklch(0.62 0.075 200)' }, { source: 'packed', scripted: true }).variant & V.ROW_PAINT).toBe(0);
    expect(surfaceParamsFromSpec({ color: 'oklch(0.42 0.17 28)' }).variant & V.ROW_PAINT).toBe(0);
    // the variant builds once the packed stage exists, and that stage is told the paint is the object's
    const c = new SurfaceMaterials({ script });
    const seen: string[] = [];
    c.registerStage(V.SRC_PACKED, (inputs, ctx) => {
      seen.push(ctx.paint);
      return inputs;
    });
    expect(c.get({ variant: red.variant, state: red.state })).toBeInstanceOf(SurfaceMaterial);
    expect(seen).toEqual(['object']);
  });

  it('names the fields it carries but does not implement, and never throws on content', () => {
    const p = surfaceParamsFromSpec({ alphaMap: 'a.png', textureScale: 4, dissolve: 0.5, view: { link: 'x' }, outline: true, overrides: {} });
    expect(p.unsupported).toEqual(['alphaMap', 'textureScale', 'dissolve', 'view', 'outline', 'overrides']);
    expect(surfaceParamsFromSpec({ textureScale: 1, dissolve: 0, outline: false }).unsupported).toEqual([]);
    const junk = { roughness: 'rough', metalness: Number.NaN, opacity: 'x', repeat: [1], emissive: 4, side: 'left', depthWrite: 'no' } as unknown as StandardMaterialSpec;
    expect(surfaceParamsFromSpec(junk)).toEqual(surfaceParamsFromSpec({}));
  });

  it('isScriptedMaterialSpec tells the two material forms apart', () => {
    expect(isScriptedMaterialSpec({ kind: 'scripted', script: 'scripts/trail/mat.js' })).toBe(true);
    expect(isScriptedMaterialSpec({ kind: 'scripted' })).toBe(false);
    expect(isScriptedMaterialSpec({ color: '#fff' })).toBe(false);
    expect(isScriptedMaterialSpec(null)).toBe(false);
  });
});

describe('SurfaceParams → three.js material state through the variant cache', () => {
  const materials = (): SurfaceMaterials => new SurfaceMaterials({ script });
  const build = (spec: StandardMaterialSpec): { p: SurfaceParams; m: ReturnType<SurfaceMaterials['get']> } => {
    const p = surfaceParamsFromSpec(spec);
    return { p, m: materials().get({ variant: p.variant, state: p.state }) };
  };

  it('a lit row is a SurfaceMaterial (a MeshStandardNodeMaterial) with the five node inputs', () => {
    const { m } = build({ color: 'oklch(0.6 0.1 30)', roughness: 0.4 });
    expect(m).toBeInstanceOf(SurfaceMaterial);
    expect(m).toBeInstanceOf(MeshStandardNodeMaterial);
    const lit = m as SurfaceMaterial;
    for (const n of [lit.colorNode, lit.emissiveNode, lit.roughnessNode, lit.metalnessNode]) expect((n as Node | null)?.isNode).toBe(true);
    expect(lit.opacityNode).toBeNull();
    expect(lit.lights).toBe(true);
    expect(lit.fog).toBe(true);
    expect(lit.transparent).toBe(false);
    expect(lit.side).toBe(FrontSide);
    expect(lit.flatShading).toBe(false);
  });

  it('`unlit` is a MeshBasicNodeMaterial with the same inputs: albedo + emissive, no lights, still fogged', () => {
    const { m } = build({ color: 'oklch(0.7 0.19 55)', emissive: 'oklch(0.7 0.19 55)', emissiveIntensity: 0.8, unlit: true });
    expect(m).toBeInstanceOf(UnlitSurfaceMaterial);
    expect(m).toBeInstanceOf(MeshBasicNodeMaterial);
    expect(m).not.toBeInstanceOf(MeshStandardNodeMaterial);
    expect(m.lights).toBe(false);
    expect(m.fog).toBe(true);
    expect((m.colorNode as Node | null)?.isNode).toBe(true);
  });

  it('side, transparency, depth state and polygon offset reach the material', () => {
    expect(build({ side: 'double' }).m.side).toBe(DoubleSide);
    expect(build({ side: 'back' }).m.side).toBe(BackSide);
    expect(build({}).m.side).toBe(FrontSide);

    const glass = build({ opacity: 0.4, transparent: true }).m;
    expect(glass.transparent).toBe(true);
    expect((glass.opacityNode as Node | null)?.isNode).toBe(true);

    const decal = build({ transparent: true, depthWrite: false, depthTest: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -3 }).m;
    expect([decal.depthWrite, decal.depthTest, decal.polygonOffset, decal.polygonOffsetFactor, decal.polygonOffsetUnits]).toEqual([false, false, true, -2, -3]);
    const plain = build({}).m;
    expect([plain.depthWrite, plain.depthTest, plain.polygonOffset, plain.polygonOffsetFactor, plain.polygonOffsetUnits]).toEqual([true, true, false, 0, 0]);
  });

  it('the paint goes on the object and renderOrder on the mesh, not into the material', () => {
    const p = surfaceParamsFromSpec({ color: 'oklch(0.6 0.1 30)', roughness: 0.4, metalness: 0.2, renderOrder: 4 });
    const mesh = new Mesh(new PlaneGeometry(1, 1), materials().get({ variant: p.variant, state: p.state }));
    setSurfacePaint(mesh, p.paint);
    mesh.renderOrder = p.renderOrder;
    expect(mesh.userData['ssPaint']).toEqual(p.paint);
    expect(mesh.renderOrder).toBe(4);
  });
});
