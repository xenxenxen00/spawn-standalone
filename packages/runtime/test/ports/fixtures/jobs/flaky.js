// Spins past any short deadline on its first attempt, answers on the second.
export function run(job) {
  if (job.attempt < 2) { const until = Date.now() + 60000; while (Date.now() < until) { /* spin */ } }
  return { attempt: job.attempt };
}
