import { describe, expect, it } from 'vitest';
import { normalFlat } from 'three/tsl';
import { DataTexture, MeshStandardNodeMaterial } from 'three/webgpu';
import { SurfaceMaterials } from '../../../../src/render/surface/surface-material.ts';
import { registerTerrainSplat, type TerrainSplatBinding } from '../../../../src/render/special/terrain-splat.ts';
import { registerWaterSurface, waterTime } from '../../../../src/render/special/water.ts';

const lighting = { lighting: (_surface: unknown, lights: { ambient: unknown }) => lights.ambient };

describe('R12b real surface-material contracts', () => {
  it('builds the registered water stage into a transparent lit material driven by the shared scroll uniform', () => {
    const surfaces = new SurfaceMaterials({ script: lighting as never });
    try {
      const binding = registerWaterSurface(surfaces);
      const material = surfaces.get({ variant: binding.variant, state: { depthWrite: false } });

      expect(material).toBeInstanceOf(MeshStandardNodeMaterial);
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
      expect(material.normalNode).not.toBeNull();
      expect(material.opacityNode).not.toBeNull();
      let readsScrollClock = false;
      material.normalNode!.traverse((node) => {
        if (node === waterTime) readsScrollClock = true;
      });
      expect(readsScrollClock).toBe(true);
    } finally {
      surfaces.dispose();
    }
  });

  it('builds all six splat texture inputs into a flat terrain material and rebinds those nodes', () => {
    const surfaces = new SurfaceMaterials({ script: lighting as never });
    let binding: TerrainSplatBinding | undefined;
    try {
      binding = registerTerrainSplat(surfaces);
      const material = surfaces.get({ variant: binding.variant });
      const textures = Array.from({ length: 6 }, (_, index) => {
        const texture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
        texture.name = `terrain-${index}`;
        return texture;
      }) as [DataTexture, DataTexture, DataTexture, DataTexture, DataTexture, DataTexture];

      expect(material).toBeInstanceOf(MeshStandardNodeMaterial);
      expect(material.normalNode).toBe(normalFlat);
      expect(binding.seen).toHaveLength(6);
      binding.setTextures(textures);
      expect(binding.seen.map((entry) => entry.node.value)).toEqual(textures);
    } finally {
      surfaces.dispose();
    }
  });
});
