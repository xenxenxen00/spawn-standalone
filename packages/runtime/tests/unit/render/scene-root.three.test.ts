// WP R0: the scene root (render §4.1). One Scene, one FogExp2 that is mutated and never swapped, the five permanent three
// lights (one AmbientLight, one HemisphereLight, two DirectionalLights for the moon rows, the shadowCaster SpotLight) created once
// per renderer and never added or removed afterwards, because three's light cache key holds every light's id and castShadow and
// a change recompiles every lit material; the layer constants; the static-object helper. Node + three's scene graph; no renderer.
import { AmbientLight, DirectionalLight, FogExp2, Group, HemisphereLight, Light, Mesh, Object3D, Scene, SpotLight } from 'three';
import { describe, expect, it } from 'vitest';
import {
  LAYER_SHADOW_PROXY,
  LAYER_THIRD_PERSON_ONLY,
  LAYER_WORLD,
  VIEWMODEL_RENDER_ORDER,
  createSceneRoot,
  markStatic,
} from '../../../src/render/scene/scene-root.ts';

const lightsIn = (scene: Scene): Light[] => {
  const out: Light[] = [];
  scene.traverse((o) => {
    if ((o as Light).isLight) out.push(o as Light);
  });
  return out;
};

describe('layers and draw order (render §4.1)', () => {
  it('0 world, 1 third-person only, 2 shadow-only proxies; the viewmodel draws first among opaques', () => {
    expect([LAYER_WORLD, LAYER_THIRD_PERSON_ONLY, LAYER_SHADOW_PROXY]).toEqual([0, 1, 2]);
    expect(VIEWMODEL_RENDER_ORDER).toBe(-100);
  });
});

describe('createSceneRoot', () => {
  it('creates exactly five permanent lights, once: ambient, hemisphere, two moons, the shadowCaster', () => {
    const root = createSceneRoot();
    const lights = lightsIn(root.scene);
    expect(lights).toHaveLength(5);
    expect(lights.filter((l) => l instanceof AmbientLight)).toEqual([root.lights.ambient]);
    expect(lights.filter((l) => l instanceof HemisphereLight)).toEqual([root.lights.hemisphere]);
    expect(lights.filter((l) => l instanceof DirectionalLight)).toEqual([...root.lights.directionals]);
    expect(lights.filter((l) => l instanceof SpotLight)).toEqual([root.lights.shadowCaster]);
    expect(root.lights.directionals).toHaveLength(2);
    expect(root.lights.directionals[0]).not.toBe(root.lights.directionals[1]);
    expect(root.lights.all).toEqual(lights);
    expect(new Set(lights.map((l) => l.id)).size).toBe(5);
  });

  it('every permanent light starts dark and casts no shadow: a map only writes values', () => {
    const { lights } = createSceneRoot();
    for (const l of lights.all) {
      expect(l.intensity, l.name).toBe(0);
      expect(l.castShadow, l.name).toBe(false);
      expect(l.name, l.type).toMatch(/^ss:/);
    }
  });

  it('the light set is the same object set for the whole life of the root (ids and castShadow are the cache key)', () => {
    const root = createSceneRoot();
    const before = lightsIn(root.scene).map((l) => `${l.id}:${l.castShadow}`);
    // what a map does: write values, never add or remove
    root.lights.ambient.intensity = 0.4;
    root.lights.hemisphere.intensity = 0.2;
    root.lights.directionals[0].intensity = 1.5;
    root.lights.directionals[0].position.set(10, 30, -5);
    root.lights.shadowCaster.intensity = 800;
    root.fog.density = 0.016;
    root.fog.color.setRGB(0.02, 0.03, 0.05);
    expect(lightsIn(root.scene).map((l) => `${l.id}:${l.castShadow}`)).toEqual(before);
    expect(root.scene.fog).toBe(root.fog);
  });

  it('two roots (a second renderer) have separate lights', () => {
    const a = createSceneRoot();
    const b = createSceneRoot();
    expect(a.lights.ambient).not.toBe(b.lights.ambient);
    expect(a.scene).not.toBe(b.scene);
  });

  it('the targets of the directional and spot lights are in the scene, so their world matrices update', () => {
    const root = createSceneRoot();
    for (const l of [...root.lights.directionals, root.lights.shadowCaster]) {
      let o: Object3D | null = l.target;
      while (o !== null && o !== root.scene) o = o.parent;
      expect(o, l.name).toBe(root.scene);
    }
  });

  it('one FogExp2, off at start (density 0), linear black', () => {
    const { scene, fog } = createSceneRoot();
    expect(fog).toBeInstanceOf(FogExp2);
    expect(scene.fog).toBe(fog);
    expect(fog.density).toBe(0);
    expect(fog.color.toArray()).toEqual([0, 0, 0]);
  });

  it('no background node until the sky lands (R4); setBackgroundNode installs and clears one', () => {
    const root = createSceneRoot();
    expect(root.scene.backgroundNode ?? null).toBeNull();
    const node = { isNode: true } as never;
    root.setBackgroundNode(node);
    expect(root.scene.backgroundNode).toBe(node);
    root.setBackgroundNode(null);
    expect(root.scene.backgroundNode).toBeNull();
  });

  it('the shadowCaster’s shadow camera sees layers 0, 1 and 2 (the local body and the shadow proxies cast)', () => {
    const { lights } = createSceneRoot();
    expect(lights.shadowCaster.shadow.camera.layers.mask).toBe(0b111);
  });

  it('the world group is the parent of the place content, beside the lights', () => {
    const root = createSceneRoot();
    expect(root.world).toBeInstanceOf(Group);
    expect(root.world.parent).toBe(root.scene);
    expect(root.scene.name).toBe('ss:scene');
  });

  it('installLighting is the seam of the grid lighting (R1b): it sets renderer.lighting once per renderer', () => {
    const root = createSceneRoot();
    const lighting = { createNode: () => null } as never;
    const renderer = { lighting: null as unknown };
    root.installLighting(renderer as never, lighting);
    expect(renderer.lighting).toBe(lighting);
    expect(root.lighting).toBe(lighting);
    // a rebuilt renderer gets the same lighting again (X3)
    const rebuilt = { lighting: null as unknown };
    root.installLighting(rebuilt as never);
    expect(rebuilt.lighting).toBe(lighting);
  });

  it('dispose removes nothing from the light set but detaches the content', () => {
    const root = createSceneRoot();
    root.world.add(new Mesh());
    root.dispose();
    expect(root.world.children).toEqual([]);
    expect(lightsIn(root.scene)).toHaveLength(5);
  });
});

describe('markStatic (render §4.1: static objects)', () => {
  it('freezes the local matrix after one updateMatrix()', () => {
    const o = new Object3D();
    o.position.set(1, 2, 3);
    markStatic(o);
    expect(o.matrixAutoUpdate).toBe(false);
    expect(o.matrix.elements.slice(12, 15)).toEqual([1, 2, 3]);
  });

  it('freezes a subtree’s world matrices after their first world update', () => {
    const parent = new Group();
    parent.position.set(10, 0, 0);
    const child = new Mesh();
    child.position.set(0, 5, 0);
    parent.add(child);
    markStatic(parent);
    for (const o of [parent, child]) {
      expect(o.matrixAutoUpdate).toBe(false);
      expect(o.matrixWorldAutoUpdate).toBe(false);
    }
    expect(child.matrixWorld.elements.slice(12, 15)).toEqual([10, 5, 0]);

    // a later traversal leaves them alone
    child.position.set(99, 99, 99);
    parent.updateMatrixWorld(true);
    expect(child.matrixWorld.elements.slice(12, 15)).toEqual([10, 5, 0]);
  });

  it('respects the parent’s world matrix', () => {
    const scene = new Scene();
    const mover = new Group();
    mover.position.set(0, 0, 7);
    scene.add(mover);
    const fixed = new Mesh();
    fixed.position.set(1, 0, 0);
    mover.add(fixed);
    markStatic(fixed);
    expect(fixed.matrixWorld.elements.slice(12, 15)).toEqual([1, 0, 7]);
  });
});
