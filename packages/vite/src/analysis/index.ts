// The game-tree analysis shared by the converter (packages/cli import) and the Vite plugin: lexical scans, the reachability
// graph, module roles and preload sets, the place compiler, the YAML and scene parsers. Generic code copied from
// purge-protocol-web ebab692 (each file names its origin).
export { keyBefore, pathsIn, PATH_RE, scanJs, stripYamlComments, type JsScan, type JsStringLit } from './scan.ts';
export {
  Graph,
  reach,
  resolveRel,
  ROOT_FILES,
  ROSTER,
  RUNTIME_EDGES,
  type Dangling,
  type Edge,
  type EdgeKind,
  type ReachedFile,
  type ReachOptions,
  type ReachResult,
  type RosterOptions,
  type RuntimeEdge,
  type TreeReader,
} from './reach.ts';
export { computePreloadSets, findImportCycle, moduleRoles, RoleGraph, type ModuleRoles, type PreloadOptions, type PreloadSetId, type PreloadSets } from './preload-sets.ts';
export { cellFiles, compilePlace, compilePlaces, gameTreeReader, orderCells, type CompiledPlace, type CompiledRow, type CompileIssue, type GameTree, type PlaceCompile } from './places.ts';
export { jsLiteral, parseYaml, toModuleSource } from './yaml.ts';
export { parseScene, type SceneModule, type SceneRow } from './scene.ts';
