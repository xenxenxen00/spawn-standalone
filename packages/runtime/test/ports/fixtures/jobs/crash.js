// Kills the worker thread outright (an uncaught error outside run's promise chain).
export function run() {
  setTimeout(() => { throw new Error("worker went down"); }, 0);
  return new Promise(() => {});
}
