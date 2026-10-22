// Never finishes in time: a busy loop the watchdog has to terminate.
export function run(job, args) {
  const until = Date.now() + (args.ms ?? 60000);
  while (Date.now() < until) { /* spin */ }
  return "late";
}
