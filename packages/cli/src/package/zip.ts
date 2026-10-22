// Copied from purge-protocol-web ebab692 tools/package/zip.ts (generic, unchanged in behaviour).
// Deterministic ZIP: fflate, entries sorted by path, a fixed mtime, STORE for already-compressed types and DEFLATE level 9 for
// the rest. The archive is produced as a stream of chunks, so a dry run can learn its size and sha256 without writing it.
import { createHash } from 'node:crypto';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

/** 2026-01-01T00:00:00 as the DOS date/time fields of the headers. ZIP stores local wall time, so the Date is built from local fields. */
export const FIXED_MTIME = new Date(2026, 0, 1, 0, 0, 0).getTime();

/** Already-compressed types are STOREd. */
export const STORED_EXTENSIONS: readonly string[] = ['.ktx2', '.glb', '.mp3', '.ogg', '.mp4', '.webm', '.webp', '.woff2', '.png', '.jpg', '.jpeg'];

export const isStored = (path: string): boolean => {
  const lower = path.toLowerCase();
  return STORED_EXTENSIONS.some((e) => lower.endsWith(e));
};

export interface ZipEntry {
  /** posix path relative to the dist root; the archive entry name */
  path: string;
  read: () => Uint8Array;
}

export interface ZipSummary {
  bytes: number;
  sha256: string;
  entries: Array<{ path: string; method: 'store' | 'deflate'; size: number }>;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Streams the archive to `sink` (if any) and returns its size, sha256 and entry list. Entries are sorted by path in byte order; a
 * duplicate path is an error. Same entries in, same bytes out, in any time zone and on any day.
 */
export function writeZip(entries: Iterable<ZipEntry>, sink?: (chunk: Uint8Array) => void): ZipSummary {
  const sorted = [...entries].sort((a, b) => cmp(a.path, b.path));
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.path === sorted[i - 1]!.path) throw new Error(`duplicate zip entry ${sorted[i]!.path}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const state: { failure: Error | null } = { failure: null };
  const zip = new Zip((err, chunk) => {
    if (err) {
      state.failure = err;
      return;
    }
    bytes += chunk.length;
    hash.update(chunk);
    sink?.(chunk);
  });
  const summary: ZipSummary['entries'] = [];
  for (const e of sorted) {
    const data = e.read();
    const stored = isStored(e.path);
    const file = stored ? new ZipPassThrough(e.path) : new ZipDeflate(e.path, { level: 9 });
    file.mtime = FIXED_MTIME;
    zip.add(file);
    file.push(data, true);
    if (state.failure) throw state.failure;
    summary.push({ path: e.path, method: stored ? 'store' : 'deflate', size: data.length });
  }
  zip.end();
  if (state.failure) throw state.failure;
  return { bytes, sha256: hash.digest('hex'), entries: summary };
}
