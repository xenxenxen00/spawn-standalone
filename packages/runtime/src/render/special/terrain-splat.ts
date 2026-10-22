// Baked terrain rendered with six material weights per vertex. The fixed SPLAT6 layout packs those weights into
// two vec4 attributes, and blends six texture bindings. Texture scale and surface roughness are host configurable.
// Place bindings begin with white placeholders and rebind the same shader nodes as textures resolve.
import { attribute, float, normalFlat, texture, vec3 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, DataTexture, Mesh } from 'three/webgpu';
import type { Material, Texture } from 'three/webgpu';
import { SurfaceVariant, type SurfaceInputStage, type SurfaceInputs } from '../surface/surface-material.ts';
import type { Node } from 'three/webgpu';

/** the two weight attributes: `aSplat0` = materials 0–3, `aSplat1` = materials 4–5 (z, w unused) */
export const SPLAT_WEIGHT_ATTRIBUTE_0 = 'aSplat0';
export const SPLAT_WEIGHT_ATTRIBUTE_1 = 'aSplat1';
/** the SPLAT6 bake carries exactly six materials */
export const SPLAT_MATERIAL_COUNT = 6;
/** roughness of the splat surface (render §14.3) */
export const SPLAT_ROUGHNESS = 1;
/** metres per texture tile when the place config names none (render §14.3: 4–6 m) [I] */
export const DEFAULT_TEXTURE_SCALE = 1;

/** the variant of the terrain mesh: per-object paint (tint), the SPLAT6 inputs */
export function splatVariant(): number {
  return SurfaceVariant.SRC_PRIM | SurfaceVariant.SPLAT6;
}

/** `cdn/texture-terrain-<id>`: the albedo texture of a baked terrain material */
export function terrainTextureName(materialId: string): string {
  return `cdn/texture-terrain-${materialId}`;
}

/** the render-side view of MP1's terrain bake (a structural projection of `tools/maps/terrain.ts`'s `TerrainBake`) */
export interface SplatTerrainInput {
  grid: { originX: number; originZ: number; cell: number; nx: number; nz: number };
  /** `nx · nz` heights, row-major (iz · nx + ix) */
  heights: Float32Array;
  /** `nx · nz · 6` weights in [0, 255], six per vertex, summing to 255 */
  weights: Uint8Array | Uint8ClampedArray;
  /** six material ids, in weight order */
  materials: readonly string[];
  /**
   * the exact baked triangles (MP1 `bakeTerrain().tris`, pin-adjusted); when absent the mesh is rebuilt from the height
   * grid with the same two-triangles-per-cell split the bake uses (`terrainTriangles`)
   */
  tris?: Float32Array;
  /** metres per albedo tile; default `DEFAULT_TEXTURE_SCALE` */
  textureScale?: number;
}

/** grid vertex index of world (x, z), or null outside the grid */
export function gridIndexOf(grid: SplatTerrainInput['grid'], x: number, z: number): number | null {
  const fx = (x - grid.originX) / grid.cell;
  const fz = (z - grid.originZ) / grid.cell;
  const ix = Math.round(fx);
  const iz = Math.round(fz);
  if (Math.abs(fx - ix) > 1e-6 || Math.abs(fz - iz) > 1e-6) return null;
  if (ix < 0 || ix >= grid.nx || iz < 0 || iz >= grid.nz) return null;
  return iz * grid.nx + ix;
}

/** the k-th material weight of a vertex as a 0–1 fraction */
export function weightOf(weights: Uint8Array | Uint8ClampedArray, vertex: number, k: number): number {
  return weights[vertex * SPLAT_MATERIAL_COUNT + k]! / 255;
}

function whiteTexture(): DataTexture {
  const t = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.name = 'ss:splat:placeholder';
  return t;
}

export interface TerrainSplatBinding {
  /** the six albedo textures in material order; rebinds every built material's texture nodes */
  setTextures(textures: readonly [Texture, Texture, Texture, Texture, Texture, Texture]): void;
  readonly variant: number;
  /** the texture nodes the stage built so far (for tests and the texture cache's rebind checks) */
  readonly seen: readonly SplatTextureNode[];
}

/** one texture node of a stage build, with its material slot, for `setTextures` to rebind */
export interface SplatTextureNode {
  node: { value: Texture };
  slot: number;
}

/** the SPLAT6 input stage: six albedo textures blended by the two weight attributes, tinted, roughness 0.9, flat. */
export function splatStage(bound: { textures: () => readonly Texture[]; seen: SplatTextureNode[]; roughness?: number }): SurfaceInputStage {
  return (inputs: SurfaceInputs): SurfaceInputs => {
    const textures = bound.textures();
    if (textures.length !== SPLAT_MATERIAL_COUNT) throw new Error(`splat stage: six albedo textures, got ${textures.length}`);
    const w0 = attribute(SPLAT_WEIGHT_ATTRIBUTE_0, 'vec4').div(255);
    const w1 = attribute(SPLAT_WEIGHT_ATTRIBUTE_1, 'vec4').div(255);
    const w = [w0.x, w0.y, w0.z, w0.w, w1.x, w1.y];
    let albedo: Node<'vec3'> = vec3(0);
    for (let i = 0; i < SPLAT_MATERIAL_COUNT; i++) {
      const node = texture(textures[i]!, inputs.uv);
      // recorded per binding (mirrors `PackedPaintSource`): `setTextures` rebinds every built material's nodes
      bound.seen.push({ node: node as unknown as { value: Texture }, slot: i });
      albedo = albedo.add(node.rgb.mul(w[i]!));
    }
    return {
      ...inputs,
      // the tint (the object paint) multiplies the blended texel, like TEX_ALBEDO (§7.4)
      color: inputs.color.mul(albedo),
      roughness: float(bound.roughness ?? SPLAT_ROUGHNESS),
      metalness: float(0),
      // flat like the rest of the world: the face normal from the position derivatives (no normal attribute)
      normal: normalFlat,
    };
  };
}

/**
 * Registers the SPLAT6 stage on a variant cache. Once per place `SurfaceMaterials`, before the first `get` of a SPLAT6
 * variant — the same once-per-place rule as R3's `registerPackedSurface`.
 */
/** the variant-cache surface the splat package needs (a structural view of `SurfaceMaterials`) */
export interface SplatSurfaceHost {
  registerStage(bit: number, stage: SurfaceInputStage): void;
}

export function registerTerrainSplat(materials: SplatSurfaceHost, options: { roughness?: number } = {}): TerrainSplatBinding {
  let current: [Texture, Texture, Texture, Texture, Texture, Texture] = [whiteTexture(), whiteTexture(), whiteTexture(), whiteTexture(), whiteTexture(), whiteTexture()];
  const seen: SplatTextureNode[] = [];
  materials.registerStage(SurfaceVariant.SPLAT6, splatStage({ textures: () => current, seen, ...options }));
  return {
    variant: splatVariant(),
    seen,
    setTextures(textures: readonly [Texture, Texture, Texture, Texture, Texture, Texture]): void {
      if (textures.length !== 6) throw new RangeError(`terrain splat: six textures, got ${textures.length}`);
      current = [textures[0], textures[1], textures[2], textures[3], textures[4], textures[5]];
      for (const s of seen) s.node.value = current[s.slot]!;
    },
  };
}

/**
 * Builds the terrain geometry: positions from the baked triangles (or the grid), uv = world (x, z) / textureScale, and
 * the two `vec4` weight attributes. No normal attribute: the stage shades flat.
 */
export function buildTerrainGeometry(input: SplatTerrainInput): BufferGeometry {
  const { grid } = input;
  if (input.materials.length !== SPLAT_MATERIAL_COUNT) throw new RangeError(`buildTerrainGeometry: six materials, got ${input.materials.length}`);
  if (input.heights.length !== grid.nx * grid.nz) throw new RangeError(`buildTerrainGeometry: heights ${input.heights.length} ≠ ${grid.nx * grid.nz}`);
  if (input.weights.length !== grid.nx * grid.nz * SPLAT_MATERIAL_COUNT) throw new RangeError(`buildTerrainGeometry: weights ${input.weights.length} ≠ ${grid.nx * grid.nz * SPLAT_MATERIAL_COUNT}`);
  const scale = input.textureScale ?? DEFAULT_TEXTURE_SCALE;
  // the triangle soup: the bake's own (pin-adjusted) when given, else the grid's two-triangles-per-cell split
  let tris = input.tris;
  if (tris === undefined) {
    const out = new Float32Array((grid.nx - 1) * (grid.nz - 1) * 2 * 9);
    let o = 0;
    const y = (ix: number, iz: number): number => input.heights[iz * grid.nx + ix]!;
    for (let iz = 0; iz < grid.nz - 1; iz++) {
      for (let ix = 0; ix < grid.nx - 1; ix++) {
        const x0 = grid.originX + ix * grid.cell, x1 = x0 + grid.cell;
        const z0 = grid.originZ + iz * grid.cell, z1 = z0 + grid.cell;
        // the same diagonal as `terrainTriangles`: (ix,iz) → (ix+1,iz+1)
        const quad: Array<[number, number, number, number, number]> = [
          [x0, y(ix, iz), z0, ix, iz], [x1, y(ix + 1, iz), z0, ix + 1, iz], [x1, y(ix + 1, iz + 1), z1, ix + 1, iz + 1],
          [x0, y(ix, iz), z0, ix, iz], [x1, y(ix + 1, iz + 1), z1, ix + 1, iz + 1], [x0, y(ix, iz + 1), z1, ix, iz + 1],
        ];
        for (const [x, yy, z] of quad) {
          out[o++] = x;
          out[o++] = yy;
          out[o++] = z;
        }
      }
    }
    tris = out;
  }
  const verts = tris.length / 3;
  const positions = new Float32Array(tris);
  const uvs = new Float32Array(verts * 2);
  const w0 = new Float32Array(verts * 4);
  const w1 = new Float32Array(verts * 4);
  for (let v = 0; v < verts; v++) {
    const x = tris[v * 3]!;
    const z = tris[v * 3 + 2]!;
    uvs[v * 2] = x / scale;
    uvs[v * 2 + 1] = z / scale;
    const gi = gridIndexOf(grid, x, z);
    if (gi === null) throw new Error(`buildTerrainGeometry: triangle vertex (${x}, ${z}) is off the weight grid`);
    for (let k = 0; k < 4; k++) w0[v * 4 + k] = input.weights[gi * SPLAT_MATERIAL_COUNT + k]!;
    w1[v * 4] = input.weights[gi * SPLAT_MATERIAL_COUNT + 4]!;
    w1[v * 4 + 1] = input.weights[gi * SPLAT_MATERIAL_COUNT + 5]!;
    w1[v * 4 + 2] = 0;
    w1[v * 4 + 3] = 0;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setAttribute('uv', new BufferAttribute(uvs, 2));
  g.setAttribute(SPLAT_WEIGHT_ATTRIBUTE_0, new BufferAttribute(w0, 4));
  g.setAttribute(SPLAT_WEIGHT_ATTRIBUTE_1, new BufferAttribute(w1, 4));
  // explicit bounds (§6.5 "Culling"): the mesh is drawn by the identity matrix, so the sphere is the soup's own
  g.computeBoundingSphere();
  return g;
}

export interface TerrainMesh {
  mesh: Mesh;
  geometry: BufferGeometry;
  dispose(): void;
}

/** one mesh over the splat geometry with the place's SPLAT6 material; tint via `setSurfacePaint(mesh, …)` */
export function buildTerrainMesh(input: SplatTerrainInput, material: Material): TerrainMesh {
  const geometry = buildTerrainGeometry(input);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'ss:terrain-splat';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return {
    mesh,
    geometry,
    dispose(): void {
      geometry.dispose();
    },
  };
}
