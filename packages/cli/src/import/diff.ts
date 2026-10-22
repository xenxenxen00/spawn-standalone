// Copied from purge-protocol-web ebab692 tools/import-live/diff.ts.
// Unified line diffs for game/.import/patches/<id>.diff (review only; never applied).
// Common prefix/suffix are trimmed first, so the LCS runs only over the edited middle of a file.

export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  // LCS table over the middle
  const n = am.length;
  const m = bm.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) row[j] = am[i] === bm[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
  }
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ t: ' ', s: a[k]!, ai: k, bi: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      ops.push({ t: ' ', s: am[i]!, ai: pre + i, bi: pre + j });
      i++;
      j++;
    } else if (j >= m || (i < n && dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      ops.push({ t: '-', s: am[i]!, ai: pre + i, bi: pre + j });
      i++;
    } else {
      ops.push({ t: '+', s: bm[j]!, ai: pre + i, bi: pre + j });
      j++;
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ t: ' ', s: a[a.length - suf + k]!, ai: a.length - suf + k, bi: b.length - suf + k });

  // group into hunks
  let out = `--- a/${path}\n+++ b/${path}\n`;
  const changed = ops.map((o, k) => (o.t !== ' ' ? k : -1)).filter((k) => k >= 0);
  let h = 0;
  while (h < changed.length) {
    const start = Math.max(0, changed[h]! - context);
    let end = Math.min(ops.length - 1, changed[h]! + context);
    while (h + 1 < changed.length && changed[h + 1]! - context <= end + 1) {
      h++;
      end = Math.min(ops.length - 1, changed[h]! + context);
    }
    h++;
    const hunk = ops.slice(start, end + 1);
    const aStart = hunk[0]!.ai;
    const bStart = hunk[0]!.bi;
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    out += `@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@\n`;
    for (const o of hunk) out += `${o.t}${o.s}\n`;
  }
  return out;
}
