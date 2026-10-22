// A feed: every yield is a part for onPart, the return value is the answer.
export async function* run(job, args) {
  for (let i = 0; i < args.n; i += 1) yield { i };
  return { done: args.n };
}
