// A deterministic CPU job for worker, pool, and callback tests.
export function run(_job, args) {
  const values = args.state.values;
  if (values.length === 0) return null;
  let index = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[index]) index = i;
  return { index, value: values[index] };
}
