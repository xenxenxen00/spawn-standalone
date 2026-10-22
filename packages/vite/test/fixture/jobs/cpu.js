import { think } from '../lib/think.js';
export function init() {}
export function run(job, args) { return think(args.n); }
