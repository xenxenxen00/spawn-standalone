// The wave-2 materials (outline hull, flash overlay, slash ribbon, dissolving surface) are real node graphs: build each one to GLSL
// with three's own GLSL node builder (no renderer, no GPU), so a typo in a TSL node or a missing import fails here and not at the
// first draw. The builder needs the few renderer members it reads; a stand-in supplies them.
import { BoxGeometry, GLSLNodeBuilder, Group, Mesh, PerspectiveCamera, Scene } from 'three/webgpu';
import type { BufferGeometry, Material } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { buildOutlineMaterial } from '../../../../src/render/special/highlight-outline.ts';
import { buildFlashMaterial } from '../../../../src/render/special/row-flash.ts';
import { SlashRenderer } from '../../../../src/render/special/slash.ts';
import { SurfaceMaterials, SurfaceVariant as V } from '../../../../src/render/surface/surface-material.ts';
import { testEnv } from '../models/model-fixtures.ts';

const renderer = {
  debug: { diagnostics: { keywords: false } },
  backend: { capabilities: { getUniformBufferLimit: () => 65_536 } },
  coordinateSystem: 2000,
  getRenderTarget: () => null,
  getMRT: () => null,
  toneMapping: 0,
  outputColorSpace: 'srgb',
  library: { fromMaterial: (m: unknown) => m },
  contextNode: { isContextNode: true, getFlowContextData: () => ({}) },
  shadowMap: { enabled: false },
  lighting: { enabled: false },
};

interface Built {
  vertexShader: string;
  fragmentShader: string;
}

function build(material: Material, geometry: BufferGeometry = new BoxGeometry()): Built {
  const mesh = new Mesh(geometry, material);
  const scene = new Scene();
  scene.add(mesh);
  const b = new GLSLNodeBuilder(mesh as never, renderer as never) as unknown as Built & { scene: unknown; camera: unknown; material: unknown; build(): void };
  b.scene = scene;
  b.camera = new PerspectiveCamera();
  b.material = material;
  b.build();
  return b;
}

describe('the wave-2 materials build to GLSL', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  it('the outline hull pushes along the geometric normal by the width uniform, scaled by clip w', () => {
    const { vertexShader, fragmentShader } = build(buildOutlineMaterial(testEnv().look));
    expect(vertexShader).toContain('ssOutlineWidth');
    expect(vertexShader).toContain('gl_Position');
    // the unflipped normal: three's `normalView` is multiplied by -1 on a back-face material
    expect(vertexShader).not.toContain('VERTEX_normalView = ( normalViewGeometry * vec3( -1.0 )');
    expect(fragmentShader).toContain('ssOutlineColor');
    expect(fragmentShader).toContain('ssOutlineAlpha');
  });

  it('the flash overlay mixes the per-object colour by the per-object amount', () => {
    const { fragmentShader } = build(buildFlashMaterial(testEnv().look));
    expect(fragmentShader).toContain('ssFlashColor');
    expect(fragmentShader).toContain('ssFlashMix');
  });

  it('the slash ribbon builds with its uniforms', () => {
    const slash = new SlashRenderer({ world: new Group() });
    const { fragmentShader } = build(slash.meshes[0]!.material as Material, slash.meshes[0]!.geometry);
    expect(fragmentShader.length).toBeGreaterThan(200);
    slash.dispose();
  });

  it('a dissolving surface discards in the fragment; the same variant without the cut does not (negative control)', () => {
    const materials = new SurfaceMaterials({ script: null });
    const cut = build(materials.get({ variant: V.SRC_PRIM, textures: {}, state: { dissolve: true } }));
    const plain = build(materials.get({ variant: V.SRC_PRIM, textures: {} }));
    expect(cut.fragmentShader).toContain('discard');
    expect(plain.fragmentShader).not.toContain('discard');
  });

  it('nothing above logged an error', () => {
    expect(error).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => /not compatible|not found on geometry/.test(String(c[0])) && !/'partPaint'/.test(String(c[0])))).toEqual([]);
  });
});
