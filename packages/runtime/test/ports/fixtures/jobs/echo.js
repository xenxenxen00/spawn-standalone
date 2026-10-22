// Test jobs for the JobPort: plain modules in the shape of a game's jobs/<id>.js.
export function run(job, args) {
  return { echoed: args, job };
}
