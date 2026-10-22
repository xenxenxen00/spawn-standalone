// A job with an init() that must run once per worker, before the first run().
let inited = 0;
export function init() { inited += 1; }
export function run() { return { inited }; }
