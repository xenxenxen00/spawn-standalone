// @spawn-standalone/vite: Vite plugin that serves one converted Spawn game as virtual modules.
export { JOBS_ID, JOB_WORKER_ID, jobWorkerSource, jobsModuleSource, resolveJobEntries, ssJobs, type JobsPluginOptions } from './jobs.ts';
export { CDN_URL_PREFIX, EMPTY_ASSET_INDEX, GAME_CSS, GameModules, portFlagTable, spawnStandalone, SS_IDS, SS_PREFIX, ssName, VENDOR_URLS, type SpawnStandaloneOptions } from './game.ts';
export { ssSqlJs, stripSqlJsPrompt } from './sqljs.ts';
