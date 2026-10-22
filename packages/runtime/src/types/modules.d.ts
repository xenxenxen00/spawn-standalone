// Ambient declarations for the data modules of the carried tree (build §2.2, §3.3; WP B4a).
//   *.yml / *.yaml   tools/vite/plugin-yaml.ts: the parsed document (YAML 1.2 core schema); `unknown` until a facade narrows it
//   *.scene          tools/vite/plugin-scene.ts: { header, rows } in file order (contract §3.7)
//   ?raw             the file text (Vite); the 11 power-grid places read raw cells through ctx.files.read (core §12.5)
// The same transforms serve headless Node runs through tools/node/register.ts (B4c).

declare module '*.yml' {
  const data: unknown;
  export default data;
}

declare module '*.yaml' {
  const data: unknown;
  export default data;
}

declare module '*.scene' {
  /** One authored row: `id` is the mapping key, `spec` the ObjectSpec as written (template merge happens at runtime). */
  export interface SceneRow {
    readonly id: string;
    readonly spec: Readonly<Record<string, unknown>>;
  }
  /** From the first line `# spawn-scene v2 yaml <cellKey>`; the key equals the file's base name. */
  export interface SceneHeader {
    readonly version: 2;
    readonly format: 'yaml';
    readonly cellKey: string;
  }
  export interface SceneModule {
    readonly header: SceneHeader;
    readonly rows: readonly SceneRow[];
  }
  const scene: SceneModule;
  export default scene;
}

declare module '*.yml?raw' {
  const text: string;
  export default text;
}

declare module '*.yaml?raw' {
  const text: string;
  export default text;
}

declare module '*.scene?raw' {
  const text: string;
  export default text;
}
